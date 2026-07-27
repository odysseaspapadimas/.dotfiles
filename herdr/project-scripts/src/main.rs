use std::{
    env, fs,
    io::Stdout,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail};
use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{
    Frame, Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Paragraph, Row, Table, TableState, Wrap},
};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const SERVICE_PREFIX: &str = "Project services · ";

#[derive(Clone, Debug)]
struct Script {
    root: PathBuf,
    name: String,
    body: String,
    invocation: String,
    command: String,
    key: String,
}
#[derive(Clone, Debug, Deserialize)]
struct Pane {
    pane_id: String,
    tab_id: String,
    workspace_id: String,
    label: Option<String>,
    cwd: Option<String>,
    foreground_cwd: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
struct Tab {
    tab_id: String,
    label: Option<String>,
}
#[derive(Clone, Debug, Deserialize)]
struct Rect {
    x: u16,
    y: u16,
    width: u16,
    height: u16,
}
#[derive(Clone, Debug, Deserialize)]
struct LayoutPane {
    pane_id: String,
    rect: Rect,
}
#[derive(Clone, Debug, Deserialize)]
struct PaneLayout {
    focused_pane_id: Option<String>,
    panes: Vec<LayoutPane>,
}
#[derive(Clone, Debug)]
struct Entry {
    script: Script,
    running: bool,
    pane: Option<Pane>,
}

fn herdr(args: &[&str]) -> Result<Value> {
    let output = Command::new("herdr")
        .args(args)
        .output()
        .context("run herdr")?;
    if !output.status.success() {
        bail!("{}", String::from_utf8_lossy(&output.stderr).trim());
    }
    if output.stdout.iter().all(u8::is_ascii_whitespace) {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&output.stdout).context("parse herdr response")
}
fn result_array<T: for<'de> Deserialize<'de>>(value: &Value, name: &str) -> Result<Vec<T>> {
    serde_json::from_value(
        value
            .pointer(&format!("/result/{name}"))
            .cloned()
            .ok_or_else(|| anyhow!("missing {name}"))?,
    )
    .context(format!("parse {name}"))
}
fn hash(parts: &[&str], len: usize) -> String {
    let mut hash = Sha256::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            hash.update([0]);
        }
        hash.update(part.as_bytes());
    }
    format!("{:x}", hash.finalize())[..len].to_string()
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn shell_word(value: &str) -> String {
    if !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_:@./+-".contains(c))
    {
        value.to_string()
    } else {
        quote(value)
    }
}
fn git_boundary(start: &Path) -> Option<PathBuf> {
    let mut path = start.to_path_buf();
    loop {
        if path.join(".git").exists() {
            return Some(path);
        }
        if !path.pop() {
            return None;
        }
    }
}
fn manifest_between(start: &Path, boundary: &Path, name: &str) -> Option<PathBuf> {
    let mut path = start.to_path_buf();
    loop {
        let candidate = path.join(name);
        if candidate.exists() {
            return Some(candidate);
        }
        if path == boundary || !path.pop() {
            return None;
        }
    }
}
fn manager(root: &Path, boundary: &Path) -> &'static str {
    let mut path = root.to_path_buf();
    loop {
        if path.join("pnpm-lock.yaml").exists() {
            return "pnpm";
        }
        if path.join("yarn.lock").exists() {
            return "yarn";
        }
        if path.join("bun.lock").exists() || path.join("bun.lockb").exists() {
            return "bun";
        }
        if path.join("package-lock.json").exists() {
            return "npm";
        }
        if path == boundary || !path.pop() {
            return "npm";
        }
    }
}
fn read_manifest(path: &Path, boundary: &Path, label: &str, composer: bool) -> Result<Vec<Script>> {
    let value: Value = serde_json::from_slice(
        &fs::read(path).with_context(|| format!("read {}", path.display()))?,
    )?;
    let Some(scripts) = value.get("scripts").and_then(Value::as_object) else {
        return Ok(vec![]);
    };
    let root = path.parent().unwrap().to_path_buf();
    let manager = if composer {
        "composer"
    } else {
        manager(&root, boundary)
    };
    let mut names: Vec<_> = scripts.keys().cloned().collect();
    names.sort();
    let mut found = vec![];
    for name in names {
        let body = match &scripts[&name] {
            Value::String(body) => body.clone(),
            Value::Array(items) if composer && items.iter().all(Value::is_string) => items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" → "),
            _ => continue,
        };
        let invocation = if composer {
            format!("composer run-script {}", shell_word(&name))
        } else {
            format!("{manager} run {}", shell_word(&name))
        };
        let command = format!("cd -- {} && {invocation}", quote(&root.to_string_lossy()));
        let display = format!(
            "{}{}/{}",
            label,
            if composer { ":composer" } else { "" },
            name
        );
        let key = hash(&[&root.to_string_lossy(), &invocation], 12);
        found.push(Script {
            root: root.clone(),
            name: display,
            body,
            invocation,
            command,
            key,
        });
    }
    Ok(found)
}
fn discover(start: &Path) -> Result<(PathBuf, Vec<Script>)> {
    let start = start.canonicalize()?;
    if let Some(boundary) = git_boundary(&start) {
        let mut scripts = vec![];
        if let Some(path) = manifest_between(&start, &boundary, "package.json") {
            let label = path
                .parent()
                .unwrap()
                .strip_prefix(&boundary)
                .ok()
                .filter(|p| !p.as_os_str().is_empty())
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| {
                    path.parent()
                        .unwrap()
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .into()
                });
            scripts.extend(read_manifest(&path, &boundary, &label, false)?);
        }
        if let Some(path) = manifest_between(&start, &boundary, "composer.json") {
            let label = path
                .parent()
                .unwrap()
                .strip_prefix(&boundary)
                .ok()
                .filter(|p| !p.as_os_str().is_empty())
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| {
                    path.parent()
                        .unwrap()
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .into()
                });
            scripts.extend(read_manifest(&path, &boundary, &label, true)?);
        }
        return Ok((boundary, scripts));
    }
    let mut scripts = vec![];
    let label = start.file_name().unwrap_or_default().to_string_lossy();
    for (name, composer) in [("package.json", false), ("composer.json", true)] {
        let path = start.join(name);
        if path.exists() {
            scripts.extend(read_manifest(&path, &start, &label, composer)?);
        }
    }
    let mut children: Vec<_> = fs::read_dir(&start)?
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir() && e.path().join(".git").exists())
        .collect();
    children.sort_by_key(|e| e.file_name());
    for child in children {
        let root = child.path();
        let label = child.file_name().to_string_lossy().into_owned();
        for (name, composer) in [("package.json", false), ("composer.json", true)] {
            let path = root.join(name);
            if path.exists() {
                scripts.extend(read_manifest(&path, &root, &label, composer)?);
            }
        }
    }
    Ok((start, scripts))
}
fn invoking_workspace(panes: &[Pane], cwd: &Path) -> Result<String> {
    if let Ok(id) = env::var("HERDR_WORKSPACE_ID") {
        if !id.is_empty() {
            return Ok(id);
        }
    }
    let mut best: Option<(usize, String)> = None;
    for pane in panes {
        let pane_cwd = pane
            .foreground_cwd
            .as_deref()
            .or(pane.cwd.as_deref())
            .map(PathBuf::from);
        let Some(pane_cwd) = pane_cwd else {
            continue;
        };
        if cwd.starts_with(&pane_cwd) || pane_cwd.starts_with(cwd) {
            let score = cwd
                .components()
                .zip(pane_cwd.components())
                .take_while(|(a, b)| a == b)
                .count();
            if best.as_ref().is_none_or(|b| score > b.0) {
                best = Some((score, pane.workspace_id.clone()));
            }
        }
    }
    best.map(|(_, id)| id)
        .ok_or_else(|| anyhow!("could not resolve current Herdr workspace"))
}
fn process_count(pane: &str) -> Result<usize> {
    let value = herdr(&["pane", "process-info", "--pane", pane])?;
    let shell = value
        .pointer("/result/process_info/shell_pid")
        .and_then(Value::as_i64);
    Ok(value
        .pointer("/result/process_info/foreground_processes")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|p| p.get("pid").and_then(Value::as_i64) != shell)
                .count()
        })
        .unwrap_or(0))
}

struct App {
    root: PathBuf,
    workspace: String,
    scripts: Vec<Script>,
    entries: Vec<Entry>,
    table: TableState,
    query: String,
    searching: bool,
    running_first: bool,
    message: String,
}
impl App {
    fn new(root: PathBuf, workspace: String, scripts: Vec<Script>) -> Result<Self> {
        let mut app = Self {
            root,
            workspace,
            scripts,
            entries: vec![],
            table: TableState::default(),
            query: String::new(),
            searching: false,
            running_first: true,
            message: String::new(),
        };
        app.refresh()?;
        app.table.select(Some(0));
        Ok(app)
    }
    fn refresh(&mut self) -> Result<()> {
        let value = herdr(&["pane", "list", "--workspace", &self.workspace])?;
        let panes: Vec<Pane> = result_array(&value, "panes")?;
        self.entries = self
            .scripts
            .iter()
            .cloned()
            .map(|script| {
                let prefix = format!(" · service · {} · ", script.key);
                let pane = panes
                    .iter()
                    .find(|p| {
                        p.label
                            .as_deref()
                            .is_some_and(|l| l.starts_with(SERVICE_PREFIX) && l.contains(&prefix))
                    })
                    .cloned();
                let running = pane
                    .as_ref()
                    .is_some_and(|p| process_count(&p.pane_id).unwrap_or(0) > 0);
                Entry {
                    script,
                    running,
                    pane,
                }
            })
            .collect();
        Ok(())
    }
    fn visible(&self) -> Vec<usize> {
        let terms: Vec<_> = self
            .query
            .to_lowercase()
            .split_whitespace()
            .map(str::to_string)
            .collect();
        let mut found: Vec<_> = self
            .entries
            .iter()
            .enumerate()
            .filter(|(_, e)| {
                terms.iter().all(|t| {
                    format!(
                        "{} {} {}",
                        e.script.name, e.script.body, e.script.invocation
                    )
                    .to_lowercase()
                    .contains(t)
                })
            })
            .map(|(i, _)| i)
            .collect();
        if self.running_first {
            found.sort_by_key(|i| !self.entries[*i].running);
        }
        found
    }
    fn selected(&self) -> Option<usize> {
        let visible = self.visible();
        self.table.selected().and_then(|i| visible.get(i).copied())
    }
    fn move_by(&mut self, delta: isize) {
        let count = self.visible().len();
        if count == 0 {
            return;
        }
        let current = self.table.selected().unwrap_or(0) as isize;
        self.table
            .select(Some((current + delta).rem_euclid(count as isize) as usize));
    }
    fn services_label(&self) -> String {
        format!(
            "Project services · {} · {}",
            self.root.file_name().unwrap_or_default().to_string_lossy(),
            hash(&[&self.root.to_string_lossy()], 8)
        )
    }
    fn service_label(&self, script: &Script) -> String {
        format!(
            "{} · service · {} · {}",
            self.services_label(),
            script.key,
            script.name
        )
    }
    fn target(&mut self, index: usize) -> Result<Pane> {
        if let Some(pane) = self.entries[index].pane.clone() {
            return Ok(pane);
        }
        let label = self.services_label();
        let panes_val = herdr(&["pane", "list", "--workspace", &self.workspace])?;
        let panes: Vec<Pane> = result_array(&panes_val, "panes")?;
        for pane in panes.iter().filter(|p| {
            p.label
                .as_deref()
                .is_some_and(|l| l.starts_with(&format!("{label} · service · ")))
        }) {
            if process_count(&pane.pane_id)? == 0 {
                herdr(&[
                    "pane",
                    "rename",
                    &pane.pane_id,
                    &self.service_label(&self.entries[index].script),
                ])?;
                return Ok(pane.clone());
            }
        }
        let tabs_val = herdr(&["tab", "list", "--workspace", &self.workspace])?;
        let tabs: Vec<Tab> = result_array(&tabs_val, "tabs")?;
        let created: Pane =
            if let Some(tab) = tabs.iter().find(|t| t.label.as_deref() == Some(&label)) {
                let anchor = panes
                    .iter()
                    .find(|p| p.tab_id == tab.tab_id)
                    .ok_or_else(|| anyhow!("services tab has no pane"))?;
                let value = herdr(&[
                    "pane",
                    "split",
                    &anchor.pane_id,
                    "--direction",
                    "down",
                    "--cwd",
                    self.entries[index].script.root.to_str().unwrap(),
                    "--no-focus",
                ])?;
                serde_json::from_value(
                    value
                        .pointer("/result/pane")
                        .cloned()
                        .ok_or_else(|| anyhow!("missing pane"))?,
                )?
            } else {
                let value = herdr(&[
                    "tab",
                    "create",
                    "--workspace",
                    &self.workspace,
                    "--cwd",
                    self.entries[index].script.root.to_str().unwrap(),
                    "--label",
                    &label,
                    "--no-focus",
                ])?;
                serde_json::from_value(
                    value
                        .pointer("/result/pane")
                        .or_else(|| value.pointer("/result/root_pane"))
                        .cloned()
                        .ok_or_else(|| anyhow!("missing pane"))?,
                )?
            };
        herdr(&[
            "pane",
            "rename",
            &created.pane_id,
            &self.service_label(&self.entries[index].script),
        ])?;
        std::thread::sleep(Duration::from_millis(300));
        Ok(created)
    }
    fn focus(&self, pane: &Pane) -> Result<()> {
        herdr(&["tab", "focus", &pane.tab_id])?;
        for _ in 0..12 {
            let value = herdr(&["pane", "layout", "--pane", &pane.pane_id])?;
            let layout: PaneLayout = serde_json::from_value(
                value
                    .pointer("/result/layout")
                    .cloned()
                    .ok_or_else(|| anyhow!("missing pane layout"))?,
            )?;
            let Some(current) = layout.focused_pane_id else {
                return Ok(());
            };
            if current == pane.pane_id {
                return Ok(());
            }
            let source = layout
                .panes
                .iter()
                .find(|entry| entry.pane_id == current)
                .map(|entry| &entry.rect);
            let target = layout
                .panes
                .iter()
                .find(|entry| entry.pane_id == pane.pane_id)
                .map(|entry| &entry.rect);
            let (Some(source), Some(target)) = (source, target) else {
                return Ok(());
            };
            let horizontal = ((target.x as i32 + target.width as i32 / 2)
                - (source.x as i32 + source.width as i32 / 2))
                .abs();
            let vertical = ((target.y as i32 + target.height as i32 / 2)
                - (source.y as i32 + source.height as i32 / 2))
                .abs();
            let direction = if horizontal >= vertical {
                if target.x >= source.x {
                    "right"
                } else {
                    "left"
                }
            } else if target.y >= source.y {
                "down"
            } else {
                "up"
            };
            herdr(&[
                "pane",
                "focus",
                "--direction",
                direction,
                "--pane",
                &current,
            ])?;
        }
        Ok(())
    }
    fn focus_selected(&mut self) -> Result<bool> {
        let Some(i) = self.selected() else {
            return Ok(false);
        };
        let Some(pane) = self.entries[i]
            .pane
            .clone()
            .filter(|_| self.entries[i].running)
        else {
            self.message = format!("{} is not running", self.entries[i].script.name);
            return Ok(false);
        };
        self.focus(&pane)?;
        Ok(true)
    }
    fn run_selected(&mut self, restart: bool) -> Result<()> {
        let Some(i) = self.selected() else {
            return Ok(());
        };
        if self.entries[i].running && !restart {
            self.message = format!(
                "{} is already running · f focus · r restart",
                self.entries[i].script.name
            );
            return Ok(());
        }
        let pane = self.target(i)?;
        if process_count(&pane.pane_id)? > 0 {
            herdr(&["pane", "send-keys", &pane.pane_id, "ctrl+c"])?;
            for _ in 0..40 {
                std::thread::sleep(Duration::from_millis(100));
                if process_count(&pane.pane_id)? == 0 {
                    break;
                }
            }
            if process_count(&pane.pane_id)? > 0 {
                bail!("process did not stop")
            }
        }
        herdr(&[
            "pane",
            "run",
            &pane.pane_id,
            &self.entries[i].script.command,
        ])?;
        self.message = format!(
            "{} {}",
            if restart { "restarted" } else { "started" },
            self.entries[i].script.name
        );
        std::thread::sleep(Duration::from_millis(100));
        self.refresh()?;
        Ok(())
    }
    fn stop(&mut self) -> Result<()> {
        let Some(i) = self.selected() else {
            return Ok(());
        };
        if let Some(p) = self.entries[i].pane.clone() {
            if process_count(&p.pane_id)? > 0 {
                herdr(&["pane", "send-keys", &p.pane_id, "ctrl+c"])?;
                self.message = format!("stopped {}", self.entries[i].script.name);
            }
        }
        self.refresh()
    }
    fn run(mut self, terminal: &mut Terminal<CrosstermBackend<Stdout>>) -> Result<()> {
        loop {
            terminal.draw(|f| self.draw(f))?;
            if !event::poll(Duration::from_millis(100))? {
                continue;
            }
            let Event::Key(key) = event::read()? else {
                continue;
            };
            if key.kind != KeyEventKind::Press {
                continue;
            }
            if self.searching {
                match key.code {
                    KeyCode::Esc => self.searching = false,
                    KeyCode::Enter => self.run_selected(false)?,
                    KeyCode::Up => self.move_by(-1),
                    KeyCode::Down => self.move_by(1),
                    KeyCode::Backspace => {
                        self.query.pop();
                        self.table.select(Some(0));
                    }
                    KeyCode::Char(c) => {
                        self.query.push(c);
                        self.table.select(Some(0));
                    }
                    _ => {}
                }
            } else {
                match key.code {
                    KeyCode::Char('q') | KeyCode::Esc => return Ok(()),
                    KeyCode::Char('s') => self.searching = true,
                    KeyCode::Char('j') | KeyCode::Down => self.move_by(1),
                    KeyCode::Char('k') | KeyCode::Up => self.move_by(-1),
                    KeyCode::Char('o') => {
                        self.running_first = !self.running_first;
                        self.table.select(Some(0));
                    }
                    KeyCode::Enter => self.run_selected(false)?,
                    KeyCode::Char('f') => {
                        if self.focus_selected()? {
                            return Ok(());
                        }
                    }
                    KeyCode::Char('r') => self.run_selected(true)?,
                    KeyCode::Char('x') => {
                        if let Err(e) = self.stop() {
                            self.message = e.to_string()
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    fn draw(&mut self, frame: &mut Frame) {
        let areas = Layout::vertical([
            Constraint::Length(3),
            Constraint::Min(5),
            Constraint::Length(5),
            Constraint::Length(3),
        ])
        .split(frame.area());
        let mode = if self.searching { "SEARCH" } else { "BROWSE" };
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    " project scripts ",
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(format!("{}  {mode}", self.root.display())),
            ]))
            .block(Block::default().borders(Borders::ALL)),
            areas[0],
        );
        let visible = self.visible();
        let rows = visible
            .iter()
            .map(|i| {
                let e = &self.entries[*i];
                Row::new(vec![
                    Cell::from(if e.running {
                        "● running"
                    } else {
                        "○ stopped"
                    })
                    .style(Style::default().fg(if e.running {
                        Color::Green
                    } else {
                        Color::DarkGray
                    })),
                    Cell::from(e.script.name.clone()),
                    Cell::from(e.script.invocation.clone()),
                ])
            })
            .collect::<Vec<_>>();
        let table = Table::new(
            rows,
            [
                Constraint::Length(11),
                Constraint::Length(30),
                Constraint::Min(24),
            ],
        )
        .header(
            Row::new(["STATE", "SCRIPT", "COMMAND"]).style(
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
        )
        .row_highlight_style(
            Style::default()
                .bg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("› ")
        .block(
            Block::default()
                .title(if self.query.is_empty() {
                    " scripts ".into()
                } else {
                    format!(" search: {} ", self.query)
                })
                .borders(Borders::ALL),
        );
        frame.render_stateful_widget(table, areas[1], &mut self.table);
        let detail = self
            .selected()
            .map(|i| {
                format!(
                    "Command: {}\nScript: {}",
                    self.entries[i].script.command, self.entries[i].script.body
                )
            })
            .unwrap_or_else(|| "No matching scripts".into());
        frame.render_widget(
            Paragraph::new(detail)
                .wrap(Wrap { trim: true })
                .block(Block::default().title(" selection ").borders(Borders::ALL)),
            areas[2],
        );
        let help = if self.searching {
            "type to filter  ↑/↓ move  Enter start  Esc browse"
        } else {
            "j/k move  s search  o order  Enter start  f focus  r restart  x stop  q quit"
        };
        frame.render_widget(
            Paragraph::new(format!("{help}    {}", self.message)),
            areas[3],
        );
    }
}
fn cleanup() {
    let _ = disable_raw_mode();
    let _ = execute!(std::io::stdout(), LeaveAlternateScreen);
}
fn main() -> Result<()> {
    let cwd = env::current_dir()?.canonicalize()?;
    let (root, scripts) = discover(&cwd)?;
    if scripts.is_empty() {
        bail!("no package.json or composer.json scripts found")
    };
    let all_val = herdr(&["pane", "list"])?;
    let all: Vec<Pane> = result_array(&all_val, "panes")?;
    let workspace = invoking_workspace(&all, &cwd)?;
    let app = App::new(root, workspace, scripts)?;
    enable_raw_mode()?;
    execute!(std::io::stdout(), EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(std::io::stdout()))?;
    let result = app.run(&mut terminal);
    cleanup();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_keys_match_the_former_extension() {
        assert_eq!(hash(&["/workspace/app", "npm run dev"], 12), "ac338571c18b");
    }

    #[test]
    fn shell_quote_handles_apostrophes() {
        assert_eq!(quote("it's fine"), "'it'\\''s fine'");
    }
}
