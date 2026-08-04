use std::{
    env, fs,
    io::{self, Stdout},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{self, Command},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, anyhow, bail};
use chrono::Utc;
use crossterm::{
    event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{
    Frame, Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tui_textarea::{CursorMove, TextArea};
use unicode_width::UnicodeWidthChar;

const AUTOSAVE_DELAY: Duration = Duration::from_millis(750);
const ACCENT: Color = Color::Rgb(198, 160, 246);
const BLUE: Color = Color::Rgb(138, 173, 244);
const GREEN: Color = Color::Rgb(166, 218, 149);
const RED: Color = Color::Rgb(237, 135, 150);
const YELLOW: Color = Color::Rgb(238, 212, 159);
const MUTED: Color = Color::Rgb(165, 173, 203);
const SURFACE: Color = Color::Rgb(54, 58, 79);

#[derive(Debug)]
struct ProjectPaths {
    root: PathBuf,
    git: bool,
    key: String,
    directory: PathBuf,
    scratch: PathBuf,
    metadata: PathBuf,
    legacy_scratch: Option<PathBuf>,
}

#[derive(Serialize)]
struct ProjectMetadata<'a> {
    version: u8,
    root: &'a Path,
    git: bool,
    key: &'a str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SaveState {
    Saved,
    Modified,
    Error,
}

impl SaveState {
    fn label(self) -> &'static str {
        match self {
            Self::Saved => "saved",
            Self::Modified => "modified",
            Self::Error => "save error",
        }
    }

    fn color(self) -> Color {
        match self {
            Self::Saved => GREEN,
            Self::Modified => YELLOW,
            Self::Error => RED,
        }
    }
}

enum Mode {
    Edit,
    ClearScratch,
    Preview { append: String, offset: u16 },
    ClearAfterPromotion,
}

struct App {
    paths: ProjectPaths,
    textarea: TextArea<'static>,
    mode: Mode,
    save_state: SaveState,
    last_edit: Option<Instant>,
    message: String,
    editor_scroll: usize,
    editor_horizontal: usize,
    editor_height: usize,
}

fn canonical(path: &Path) -> Result<PathBuf> {
    path.canonicalize()
        .with_context(|| format!("resolve {}", path.display()))
}

fn project_root(cwd: &Path) -> Result<(PathBuf, bool)> {
    let cwd = canonical(cwd)?;
    let output = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&cwd)
        .output();
    if let Ok(output) = output
        && output.status.success()
    {
        let root = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if !root.is_empty() {
            return Ok((canonical(Path::new(&root))?, true));
        }
    }
    Ok((cwd, false))
}

fn project_key(root: &Path) -> String {
    let mut digest = Sha256::new();
    digest.update(root.as_os_str().as_encoded_bytes());
    format!("{:x}", digest.finalize())
}

fn user_home() -> Result<PathBuf> {
    env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("HOME is not set"))
}

fn state_root(home: &Path) -> PathBuf {
    env::var_os("XDG_STATE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.join(".local/state"))
        .join("herdr/project-scratch")
}

fn resolve_paths(cwd: &Path) -> Result<ProjectPaths> {
    let (root, git) = project_root(cwd)?;
    let key = project_key(&root);
    let home = user_home()?;
    let directory = state_root(&home).join(&key);
    let legacy_scratch = home
        .join(".pi/agent/project-state")
        .join(&key)
        .join("scratch.md");
    Ok(ProjectPaths {
        root,
        git,
        key,
        scratch: directory.join("scratch.md"),
        metadata: directory.join("project.json"),
        directory,
        legacy_scratch: Some(legacy_scratch),
    })
}

fn set_private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path).with_context(|| format!("create {}", path.display()))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("protect {}", path.display()))
}

fn temporary_path(path: &Path) -> Result<PathBuf> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("{} has no parent directory", path.display()))?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    Ok(parent.join(format!(
        ".{}-{}-{stamp}.tmp",
        process::id(),
        path.file_name().unwrap_or_default().to_string_lossy()
    )))
}

fn atomic_private_write(path: &Path, content: &str) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("{} has no parent directory", path.display()))?;
    set_private_directory(parent)?;
    let temporary = temporary_path(path)?;
    let result = (|| -> Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true).mode(0o600);
        let mut file = options
            .open(&temporary)
            .with_context(|| format!("create {}", temporary.display()))?;
        io::Write::write_all(&mut file, content.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path).with_context(|| format!("replace {}", path.display()))?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn prepare_paths(paths: &ProjectPaths) -> Result<()> {
    set_private_directory(&paths.directory)?;
    if !paths.scratch.exists()
        && let Some(legacy) = &paths.legacy_scratch
        && legacy.is_file()
    {
        let content = fs::read_to_string(legacy)
            .with_context(|| format!("read legacy scratch {}", legacy.display()))?;
        atomic_private_write(&paths.scratch, &content)?;
    }
    let metadata = serde_json::to_string_pretty(&ProjectMetadata {
        version: 1,
        root: &paths.root,
        git: paths.git,
        key: &paths.key,
    })? + "\n";
    atomic_private_write(&paths.metadata, &metadata)
}

fn read_scratch(path: &Path) -> Result<String> {
    match fs::read_to_string(path) {
        Ok(content) => Ok(content),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error).with_context(|| format!("read {}", path.display())),
    }
}

fn content_lines(content: &str) -> Vec<String> {
    content.split('\n').map(str::to_owned).collect()
}

fn textarea(content: &str) -> TextArea<'static> {
    let mut textarea = TextArea::from(content_lines(content));
    textarea.set_block(
        Block::default()
            .title(" private Markdown scratch ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(SURFACE)),
    );
    textarea.set_cursor_line_style(Style::default().bg(Color::Rgb(36, 39, 58)));
    textarea.set_cursor_style(
        Style::default()
            .fg(Color::Rgb(36, 39, 58))
            .bg(ACCENT)
            .add_modifier(Modifier::BOLD),
    );
    textarea.set_selection_style(Style::default().fg(Color::Black).bg(BLUE));
    textarea.set_placeholder_text("Private notes for this project…");
    textarea.set_placeholder_style(Style::default().fg(MUTED));
    textarea.move_cursor(CursorMove::Bottom);
    textarea.move_cursor(CursorMove::End);
    textarea
}

fn textarea_content(textarea: &TextArea<'_>) -> String {
    textarea.lines().join("\n")
}

fn chars(value: &str, start: usize, end: Option<usize>) -> String {
    value
        .chars()
        .skip(start)
        .take(end.map_or(usize::MAX, |end| end.saturating_sub(start)))
        .collect()
}

fn selected_or_all(textarea: &TextArea<'_>) -> String {
    let Some(((start_row, start_col), (end_row, end_col))) = textarea.selection_range() else {
        return textarea_content(textarea);
    };
    if (start_row, start_col) == (end_row, end_col) {
        return textarea_content(textarea);
    }
    let lines = textarea.lines();
    if start_row == end_row {
        return chars(&lines[start_row], start_col, Some(end_col));
    }
    let mut selected = Vec::with_capacity(end_row - start_row + 1);
    selected.push(chars(&lines[start_row], start_col, None));
    selected.extend(lines[start_row + 1..end_row].iter().cloned());
    selected.push(chars(&lines[end_row], 0, Some(end_col)));
    selected.join("\n")
}

fn selected_text(textarea: &TextArea<'_>) -> Option<String> {
    let ((start_row, start_col), (end_row, end_col)) = textarea.selection_range()?;
    if (start_row, start_col) == (end_row, end_col) {
        return None;
    }
    let lines = textarea.lines();
    if start_row == end_row {
        return Some(chars(&lines[start_row], start_col, Some(end_col)));
    }
    let mut selected = Vec::with_capacity(end_row - start_row + 1);
    selected.push(chars(&lines[start_row], start_col, None));
    selected.extend(lines[start_row + 1..end_row].iter().cloned());
    selected.push(chars(&lines[end_row], 0, Some(end_col)));
    Some(selected.join("\n"))
}

fn selected_rows(textarea: &TextArea<'_>) -> (usize, usize) {
    let current = textarea.cursor().0;
    let Some(((start_row, start_col), (end_row, end_col))) = textarea.selection_range() else {
        return (current, current);
    };
    if (start_row, start_col) == (end_row, end_col) {
        return (current, current);
    }
    let inclusive_end = if end_col == 0 && end_row > start_row {
        end_row - 1
    } else {
        end_row
    };
    (start_row, inclusive_end)
}

fn indentation(value: &str) -> (&str, &str, usize) {
    let bytes = value
        .char_indices()
        .find_map(|(index, character)| (!character.is_whitespace()).then_some(index))
        .unwrap_or(value.len());
    let (indent, body) = value.split_at(bytes);
    (indent, body, indent.chars().count())
}

fn cycle_todo_line(value: &str) -> (String, usize, usize) {
    let (indent, body, indent_chars) = indentation(value);
    if let Some(content) = body.strip_prefix("- [ ] ") {
        return (
            format!("{indent}- [x] {content}"),
            indent_chars + 6,
            indent_chars + 6,
        );
    }
    if let Some(content) = body
        .strip_prefix("- [x] ")
        .or_else(|| body.strip_prefix("- [X] "))
    {
        return (format!("{indent}{content}"), indent_chars + 6, indent_chars);
    }
    if let Some(content) = body.strip_prefix("- ") {
        return (
            format!("{indent}- [ ] {content}"),
            indent_chars + 2,
            indent_chars + 6,
        );
    }
    (
        format!("{indent}- [ ] {body}"),
        indent_chars,
        indent_chars + 6,
    )
}

#[derive(Debug, Eq, PartialEq)]
struct RichGlyph {
    character: char,
    source_column: usize,
    struck: bool,
}

#[derive(Debug, Eq, PartialEq)]
struct RichLine {
    glyphs: Vec<RichGlyph>,
    source_to_display: Vec<usize>,
}

fn rich_line(value: &str) -> RichLine {
    let source: Vec<char> = value.chars().collect();
    let mut marker_starts = Vec::new();
    let mut index = 0;
    while index + 1 < source.len() {
        if source[index] == '~'
            && source[index + 1] == '~'
            && (index == 0 || source[index - 1] != '\\')
        {
            marker_starts.push(index);
            index += 2;
        } else {
            index += 1;
        }
    }
    marker_starts.truncate(marker_starts.len() / 2 * 2);

    let mut glyphs = Vec::new();
    let mut source_to_display = vec![0; source.len() + 1];
    let mut marker_index = 0;
    let mut display_column = 0;
    let mut struck = false;
    index = 0;
    while index < source.len() {
        source_to_display[index] = display_column;
        if marker_starts.get(marker_index).copied() == Some(index) {
            source_to_display[index + 1] = display_column;
            source_to_display[index + 2] = display_column;
            struck = !struck;
            marker_index += 1;
            index += 2;
            continue;
        }
        let character = source[index];
        glyphs.push(RichGlyph {
            character,
            source_column: index,
            struck,
        });
        display_column += UnicodeWidthChar::width(character).unwrap_or(0);
        source_to_display[index + 1] = display_column;
        index += 1;
    }
    RichLine {
        glyphs,
        source_to_display,
    }
}

fn position_selected(
    selection: Option<((usize, usize), (usize, usize))>,
    row: usize,
    column: usize,
) -> bool {
    selection.is_some_and(|(start, end)| (row, column) >= start && (row, column) < end)
}

fn toggle_strikethrough_text(value: &str) -> String {
    if value.contains('\n') {
        return value
            .split('\n')
            .map(toggle_strikethrough_text)
            .collect::<Vec<_>>()
            .join("\n");
    }
    if value.len() >= 4
        && let Some(content) = value
            .strip_prefix("~~")
            .and_then(|value| value.strip_suffix("~~"))
    {
        content.to_owned()
    } else {
        format!("~~{value}~~")
    }
}

fn toggle_strikethrough_line(value: &str) -> (String, usize, usize) {
    let (indent, body, indent_chars) = indentation(value);
    if let Some(content) = body
        .strip_prefix("~~")
        .and_then(|value| value.strip_suffix("~~"))
    {
        (format!("{indent}{content}"), indent_chars + 2, indent_chars)
    } else {
        (
            format!("{indent}~~{body}~~"),
            indent_chars,
            indent_chars + 2,
        )
    }
}

fn adjusted_cursor_col(column: usize, old_content_start: usize, new_content_start: usize) -> usize {
    if old_content_start == new_content_start {
        column
    } else if column >= old_content_start {
        new_content_start + column - old_content_start
    } else {
        new_content_start
    }
}

fn jump_to(textarea: &mut TextArea<'_>, row: usize, column: usize) {
    textarea.move_cursor(CursorMove::Jump(
        row.min(u16::MAX as usize) as u16,
        column.min(u16::MAX as usize) as u16,
    ));
}

fn promotion_append(content: &str, date: &str) -> Result<String> {
    let body = content.trim();
    if body.is_empty() {
        bail!("nothing selected to promote")
    }
    Ok(format!("\n\n## {date}\n\n{body}\n"))
}

fn append_journal(project_root: &Path, append: &str) -> Result<PathBuf> {
    let path = project_root.join(".agents/project-journal.md");
    let current = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    let parent = path.parent().unwrap();
    fs::create_dir_all(parent)?;
    let temporary = temporary_path(&path)?;
    let result = (|| -> Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true).mode(0o600);
        let mut file = options.open(&temporary)?;
        io::Write::write_all(&mut file, current.as_bytes())?;
        io::Write::write_all(&mut file, append.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(path)
}

impl App {
    fn new(paths: ProjectPaths, content: &str) -> Self {
        Self {
            paths,
            textarea: textarea(content),
            mode: Mode::Edit,
            save_state: SaveState::Saved,
            last_edit: None,
            message: String::new(),
            editor_scroll: 0,
            editor_horizontal: 0,
            editor_height: 1,
        }
    }

    fn content(&self) -> String {
        textarea_content(&self.textarea)
    }

    fn save(&mut self) -> Result<()> {
        match atomic_private_write(&self.paths.scratch, &self.content()) {
            Ok(()) => {
                self.save_state = SaveState::Saved;
                self.last_edit = None;
                Ok(())
            }
            Err(error) => {
                self.save_state = SaveState::Error;
                self.message = error.to_string();
                Err(error)
            }
        }
    }

    fn changed(&mut self) {
        self.save_state = SaveState::Modified;
        self.last_edit = Some(Instant::now());
        self.message.clear();
    }

    fn replace_lines(&mut self, lines: Vec<String>, cursor: (usize, usize)) {
        self.textarea = textarea(&lines.join("\n"));
        jump_to(&mut self.textarea, cursor.0, cursor.1);
        self.changed();
    }

    fn move_page(&mut self, down: bool, selecting: bool) {
        if selecting {
            if !self.textarea.is_selecting() {
                self.textarea.start_selection();
            }
        } else {
            self.textarea.cancel_selection();
        }
        let (row, column) = self.textarea.cursor();
        let distance = self.editor_height.max(1);
        let target = if down {
            row.saturating_add(distance)
        } else {
            row.saturating_sub(distance)
        };
        jump_to(&mut self.textarea, target, column);
    }

    fn cycle_todos(&mut self) {
        let (first, last) = selected_rows(&self.textarea);
        let mut lines = self.textarea.lines().to_vec();
        let mut cursor = self.textarea.cursor();
        for row in first..=last {
            let (next, old_content_start, new_content_start) = cycle_todo_line(&lines[row]);
            lines[row] = next;
            if cursor.0 == row {
                cursor.1 = adjusted_cursor_col(cursor.1, old_content_start, new_content_start);
            }
        }
        self.replace_lines(lines, cursor);
        self.message = if first == last {
            "cycled todo state".to_owned()
        } else {
            format!("cycled {} todo lines", last - first + 1)
        };
    }

    fn toggle_strikethrough(&mut self) {
        if let Some(selected) = selected_text(&self.textarea) {
            let replacement = toggle_strikethrough_text(&selected);
            if self.textarea.insert_str(replacement) {
                self.changed();
                self.message = "toggled strikethrough selection".to_owned();
            }
            return;
        }
        let mut lines = self.textarea.lines().to_vec();
        let mut cursor = self.textarea.cursor();
        let (next, old_content_start, new_content_start) =
            toggle_strikethrough_line(&lines[cursor.0]);
        lines[cursor.0] = next;
        cursor.1 = adjusted_cursor_col(cursor.1, old_content_start, new_content_start);
        self.replace_lines(lines, cursor);
        self.message = "toggled strikethrough line".to_owned();
    }

    fn autosave(&mut self) {
        if self.save_state == SaveState::Modified
            && self
                .last_edit
                .is_some_and(|edited| edited.elapsed() >= AUTOSAVE_DELAY)
        {
            let _ = self.save();
        }
    }

    fn begin_promotion(&mut self) {
        match promotion_append(
            &selected_or_all(&self.textarea),
            &Utc::now().format("%Y-%m-%d").to_string(),
        ) {
            Ok(append) => self.mode = Mode::Preview { append, offset: 0 },
            Err(error) => self.message = error.to_string(),
        }
    }

    fn handle_edit_key(&mut self, key: KeyEvent) -> bool {
        if key.code == KeyCode::Esc {
            return self.save().is_ok();
        }
        if matches!(key.code, KeyCode::PageUp | KeyCode::PageDown) {
            self.move_page(
                key.code == KeyCode::PageDown,
                key.modifiers.contains(KeyModifiers::SHIFT),
            );
            return false;
        }
        if key.modifiers.contains(KeyModifiers::ALT)
            && !key.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(key.code, KeyCode::Char('t' | 'T'))
        {
            self.cycle_todos();
            return false;
        }
        if key.modifiers.contains(KeyModifiers::ALT)
            && !key.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(key.code, KeyCode::Char('s' | 'S'))
        {
            self.toggle_strikethrough();
            return false;
        }
        if key.code == KeyCode::F(2) {
            self.begin_promotion();
            return false;
        }
        if key.code == KeyCode::F(8) {
            self.mode = Mode::ClearScratch;
            return false;
        }
        if key.code == KeyCode::Char('s') && key.modifiers.contains(KeyModifiers::CONTROL) {
            if self.save().is_ok() {
                self.message = "saved private scratch".to_owned();
            }
            return false;
        }
        if self.textarea.input(key) {
            self.changed();
        }
        false
    }

    fn handle_preview_key(&mut self, key: KeyEvent) {
        let Mode::Preview { append, offset } = &mut self.mode else {
            return;
        };
        match key.code {
            KeyCode::Esc => self.mode = Mode::Edit,
            KeyCode::Up | KeyCode::Char('k') => *offset = offset.saturating_sub(1),
            KeyCode::Down | KeyCode::Char('j') => *offset = offset.saturating_add(1),
            KeyCode::PageUp => *offset = offset.saturating_sub(12),
            KeyCode::PageDown => *offset = offset.saturating_add(12),
            KeyCode::Enter => match append_journal(&self.paths.root, append) {
                Ok(path) => {
                    self.message = format!("promoted to {}", path.display());
                    self.mode = Mode::ClearAfterPromotion;
                }
                Err(error) => {
                    self.message = error.to_string();
                    self.mode = Mode::Edit;
                }
            },
            _ => {}
        }
    }

    fn clear_scratch(&mut self) -> Result<()> {
        self.textarea = textarea("");
        self.changed();
        self.save()?;
        self.message = "private scratch cleared".to_owned();
        Ok(())
    }

    fn handle_modal_key(&mut self, key: KeyEvent) {
        match self.mode {
            Mode::ClearScratch => match key.code {
                KeyCode::Char('y' | 'Y') | KeyCode::Enter => {
                    let _ = self.clear_scratch();
                    self.mode = Mode::Edit;
                }
                KeyCode::Char('n' | 'N') | KeyCode::Esc => self.mode = Mode::Edit,
                _ => {}
            },
            Mode::ClearAfterPromotion => match key.code {
                KeyCode::Char('y' | 'Y') | KeyCode::Enter => {
                    let _ = self.clear_scratch();
                    self.mode = Mode::Edit;
                }
                KeyCode::Char('n' | 'N') | KeyCode::Esc => self.mode = Mode::Edit,
                _ => {}
            },
            _ => {}
        }
    }

    fn run(mut self, terminal: &mut Terminal<CrosstermBackend<Stdout>>) -> Result<()> {
        loop {
            self.autosave();
            terminal.draw(|frame| self.draw(frame))?;
            if !event::poll(Duration::from_millis(100))? {
                continue;
            }
            match event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => {
                    let close = match self.mode {
                        Mode::Edit => self.handle_edit_key(key),
                        Mode::Preview { .. } => {
                            self.handle_preview_key(key);
                            false
                        }
                        Mode::ClearScratch | Mode::ClearAfterPromotion => {
                            self.handle_modal_key(key);
                            false
                        }
                    };
                    if close {
                        return Ok(());
                    }
                }
                Event::Paste(content) if matches!(self.mode, Mode::Edit) => {
                    if self.textarea.insert_str(content) {
                        self.changed();
                    }
                }
                _ => {}
            }
        }
    }

    fn draw_rich_editor(&mut self, frame: &mut Frame, area: Rect) -> Option<(u16, u16)> {
        let block = Block::default()
            .title(" private Markdown scratch ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(SURFACE));
        let inner = block.inner(area);
        frame.render_widget(block, area);
        if inner.width == 0 || inner.height == 0 {
            return None;
        }

        self.editor_height = inner.height as usize;
        let (cursor_row, cursor_column) = self.textarea.cursor();
        if cursor_row < self.editor_scroll {
            self.editor_scroll = cursor_row;
        } else if cursor_row >= self.editor_scroll + self.editor_height {
            self.editor_scroll = cursor_row + 1 - self.editor_height;
        }

        let rich_lines: Vec<_> = self
            .textarea
            .lines()
            .iter()
            .map(|line| rich_line(line))
            .collect();
        let cursor_display = rich_lines[cursor_row]
            .source_to_display
            .get(cursor_column)
            .copied()
            .unwrap_or_else(|| {
                *rich_lines[cursor_row]
                    .source_to_display
                    .last()
                    .unwrap_or(&0)
            });
        let editor_width = inner.width as usize;
        if cursor_display < self.editor_horizontal {
            self.editor_horizontal = cursor_display;
        } else if cursor_display >= self.editor_horizontal + editor_width {
            self.editor_horizontal = cursor_display + 1 - editor_width;
        }

        let selection = self.textarea.selection_range();
        let rendered: Vec<Line<'static>> = rich_lines
            .iter()
            .enumerate()
            .map(|(row, rich)| {
                let spans = rich
                    .glyphs
                    .iter()
                    .map(|glyph| {
                        let mut style = Style::default();
                        if glyph.struck {
                            style = style.add_modifier(Modifier::CROSSED_OUT);
                        }
                        if position_selected(selection, row, glyph.source_column) {
                            style = style.fg(Color::Black).bg(BLUE);
                        }
                        Span::styled(glyph.character.to_string(), style)
                    })
                    .collect::<Vec<_>>();
                Line::from(spans)
            })
            .collect();
        let empty = self.textarea.lines().len() == 1 && self.textarea.lines()[0].is_empty();
        if empty {
            frame.render_widget(
                Paragraph::new("Private notes for this project…").style(Style::default().fg(MUTED)),
                inner,
            );
        } else {
            frame.render_widget(
                Paragraph::new(rendered).scroll((
                    self.editor_scroll.min(u16::MAX as usize) as u16,
                    self.editor_horizontal.min(u16::MAX as usize) as u16,
                )),
                inner,
            );
        }

        let cursor_x = inner.x + cursor_display.saturating_sub(self.editor_horizontal) as u16;
        let cursor_y = inner.y + cursor_row.saturating_sub(self.editor_scroll) as u16;
        Some((
            cursor_x.min(inner.x + inner.width.saturating_sub(1)),
            cursor_y.min(inner.y + inner.height.saturating_sub(1)),
        ))
    }

    fn draw(&mut self, frame: &mut Frame) {
        let areas = Layout::vertical([
            Constraint::Length(3),
            Constraint::Min(5),
            Constraint::Length(3),
        ])
        .split(frame.area());
        let kind = if self.paths.git { "Git" } else { "cwd" };
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    " private project scratch ",
                    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                ),
                Span::styled(format!("{kind}: "), Style::default().fg(MUTED)),
                Span::styled(
                    self.paths.root.display().to_string(),
                    Style::default().fg(BLUE),
                ),
            ]))
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(SURFACE)),
            ),
            areas[0],
        );
        let editor_cursor = self.draw_rich_editor(frame, areas[1]);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    self.save_state.label(),
                    Style::default()
                        .fg(self.save_state.color())
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    " · private · Ctrl+S save · Alt+T todo · Alt+S strike · F2 promote · F8 clear · Esc close",
                    Style::default().fg(MUTED),
                ),
                Span::raw(if self.message.is_empty() {
                    String::new()
                } else {
                    format!("    {}", self.message)
                }),
            ]))
            .block(
                Block::default()
                    .borders(Borders::TOP)
                    .border_style(Style::default().fg(SURFACE)),
            ),
            areas[2],
        );

        match &mut self.mode {
            Mode::Edit => {
                if let Some(cursor) = editor_cursor {
                    frame.set_cursor_position(cursor);
                }
            }
            Mode::ClearScratch => draw_confirmation(
                frame,
                " clear private scratch? ",
                "Erase the private scratch for this project?",
                "Enter/y clear · Esc/n cancel",
            ),
            Mode::ClearAfterPromotion => draw_confirmation(
                frame,
                " promotion complete ",
                "Clear the private scratch now?",
                "Enter/y clear · Esc/n keep",
            ),
            Mode::Preview { append, offset } => {
                let area = centered(frame.area(), 88, 82, 66, 14);
                let visible = area.height.saturating_sub(4).max(1);
                let line_count = append.lines().count().max(1) as u16;
                *offset = (*offset).min(line_count.saturating_sub(visible));
                frame.render_widget(Clear, area);
                frame.render_widget(
                    Paragraph::new(append.as_str()).scroll((*offset, 0)).block(
                        Block::default()
                            .title(" exact project-journal append preview ")
                            .title_style(Style::default().fg(ACCENT).add_modifier(Modifier::BOLD))
                            .borders(Borders::ALL)
                            .border_style(Style::default().fg(BLUE)),
                    ),
                    area,
                );
                let footer = Rect {
                    x: area.x + 1,
                    y: area.y + area.height.saturating_sub(2),
                    width: area.width.saturating_sub(2),
                    height: 1,
                };
                frame.render_widget(
                    Paragraph::new("↑↓/PgUp/PgDn scroll · Enter append · Esc cancel")
                        .style(Style::default().fg(MUTED).bg(Color::Black)),
                    footer,
                );
            }
        }
    }
}

fn centered(
    parent: Rect,
    width_percent: u16,
    height_percent: u16,
    min_width: u16,
    min_height: u16,
) -> Rect {
    let width = (parent.width.saturating_mul(width_percent) / 100)
        .max(min_width.min(parent.width))
        .min(parent.width);
    let height = (parent.height.saturating_mul(height_percent) / 100)
        .max(min_height.min(parent.height))
        .min(parent.height);
    Rect {
        x: parent.x + parent.width.saturating_sub(width) / 2,
        y: parent.y + parent.height.saturating_sub(height) / 2,
        width,
        height,
    }
}

fn draw_confirmation(frame: &mut Frame, title: &str, prompt: &str, help: &str) {
    let area = centered(frame.area(), 60, 28, 42, 7);
    frame.render_widget(Clear, area);
    frame.render_widget(
        Paragraph::new(vec![
            Line::from(""),
            Line::from(Span::styled(
                prompt,
                Style::default().fg(YELLOW).add_modifier(Modifier::BOLD),
            )),
            Line::from(""),
            Line::from(Span::styled(help, Style::default().fg(MUTED))),
        ])
        .block(
            Block::default()
                .title(title)
                .title_style(Style::default().fg(ACCENT).add_modifier(Modifier::BOLD))
                .borders(Borders::ALL)
                .border_style(Style::default().fg(BLUE)),
        ),
        area,
    );
}

struct TerminalGuard;

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
    }
}

fn interactive(paths: ProjectPaths, content: &str) -> Result<()> {
    enable_raw_mode()?;
    execute!(io::stdout(), EnterAlternateScreen)?;
    let _guard = TerminalGuard;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout()))?;
    terminal.clear()?;
    let result = App::new(paths, content).run(&mut terminal);
    let _ = terminal.show_cursor();
    result
}

fn main() -> Result<()> {
    let paths = resolve_paths(&env::current_dir()?)?;
    prepare_paths(&paths)?;
    let content = read_scratch(&paths.scratch)?;
    match env::args().nth(1).as_deref() {
        None => interactive(paths, &content),
        Some("--path") => {
            println!("{}", paths.scratch.display());
            Ok(())
        }
        Some("--show") => {
            print!("{content}");
            Ok(())
        }
        Some(argument) => {
            bail!("unknown argument {argument:?}; use --path, --show, or no argument")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;

    #[test]
    fn project_keys_match_the_former_pi_extension() {
        assert_eq!(
            project_key(Path::new("/workspace/app")),
            "af7e243d70b1613d780683967f922c564c184de46ee2602f376510d67458f427"
        );
    }

    #[test]
    fn editor_starts_at_the_end_of_existing_content() {
        assert_eq!(textarea("one\ntwo").cursor(), (1, 3));
    }

    #[test]
    fn todo_lines_cycle_through_plain_unchecked_and_checked() {
        let (unchecked, old_start, new_start) = cycle_todo_line("  write tests");
        assert_eq!(unchecked, "  - [ ] write tests");
        assert_eq!((old_start, new_start), (2, 8));
        assert_eq!(cycle_todo_line(&unchecked).0, "  - [x] write tests");
        assert_eq!(cycle_todo_line("  - [x] write tests").0, "  write tests");
        assert_eq!(cycle_todo_line("- existing list").0, "- [ ] existing list");
    }

    #[test]
    fn rich_lines_hide_markers_and_cross_only_the_enclosed_text() {
        let rich = rich_line("before ~~gone~~ after");
        assert_eq!(
            rich.glyphs
                .iter()
                .map(|glyph| glyph.character)
                .collect::<String>(),
            "before gone after"
        );
        assert_eq!(
            rich.glyphs
                .iter()
                .filter(|glyph| glyph.struck)
                .map(|glyph| glyph.character)
                .collect::<String>(),
            "gone"
        );
        assert_eq!(rich.source_to_display[7], 7);
        assert_eq!(rich.source_to_display[9], 7);
        assert_eq!(
            rich_line("unmatched ~~ marker")
                .glyphs
                .iter()
                .map(|glyph| glyph.character)
                .collect::<String>(),
            "unmatched ~~ marker"
        );
    }

    #[test]
    fn editor_renders_hidden_markers_as_crossed_out_cells() {
        let paths = ProjectPaths {
            root: PathBuf::from("/project"),
            git: false,
            key: "key".to_owned(),
            directory: PathBuf::from("/state"),
            scratch: PathBuf::from("/state/scratch.md"),
            metadata: PathBuf::from("/state/project.json"),
            legacy_scratch: None,
        };
        let mut app = App::new(paths, "~~gone~~");
        let backend = TestBackend::new(30, 6);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal
            .draw(|frame| {
                app.draw_rich_editor(frame, Rect::new(0, 0, 30, 6));
            })
            .unwrap();
        let buffer = terminal.backend().buffer();
        assert_eq!(
            (1..5)
                .map(|column| buffer[(column, 1)].symbol())
                .collect::<String>(),
            "gone"
        );
        assert!((1..5).all(|column| buffer[(column, 1)].modifier.contains(Modifier::CROSSED_OUT)));
        assert!(!(1..8).any(|column| buffer[(column, 1)].symbol() == "~"));
    }

    #[test]
    fn strikethrough_toggles_text_and_indented_lines() {
        assert_eq!(toggle_strikethrough_text("chosen"), "~~chosen~~");
        assert_eq!(toggle_strikethrough_text("~~chosen~~"), "chosen");
        assert_eq!(toggle_strikethrough_text("one\ntwo"), "~~one~~\n~~two~~");
        assert_eq!(
            toggle_strikethrough_line("  whole line").0,
            "  ~~whole line~~"
        );
        assert_eq!(
            toggle_strikethrough_line("  ~~whole line~~").0,
            "  whole line"
        );
    }

    #[test]
    fn exact_promotion_append_uses_trimmed_selection() {
        assert_eq!(
            promotion_append(" chosen text\n", "2026-04-05").unwrap(),
            "\n\n## 2026-04-05\n\nchosen text\n"
        );
        assert!(promotion_append(" \n", "2026-04-05").is_err());
    }

    #[test]
    fn multiline_unicode_selection_is_extracted_by_character() {
        let mut area = TextArea::from(["αβγ", "middle", "δεζ"]);
        area.move_cursor(tui_textarea::CursorMove::Forward);
        area.start_selection();
        area.move_cursor(tui_textarea::CursorMove::Down);
        area.move_cursor(tui_textarea::CursorMove::Down);
        area.move_cursor(tui_textarea::CursorMove::Forward);
        assert_eq!(selected_or_all(&area), "βγ\nmiddle\nδε");
    }

    #[test]
    fn private_write_replaces_content_and_permissions() {
        let base = env::temp_dir().join(format!("project-scratch-test-{}", process::id()));
        let path = base.join("nested/scratch.md");
        let _ = fs::remove_dir_all(&base);
        atomic_private_write(&path, "first").unwrap();
        atomic_private_write(&path, "second").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        fs::remove_dir_all(base).unwrap();
    }
}
