use std::{io::Stdout, panic, time::Duration};

use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{
    Frame, Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Paragraph, Row, Table, TableState},
};

use crate::protocol::{DaemonStatus, TunnelState, TunnelStatus};

#[derive(Debug)]
pub struct Config {
    pub server: String,
}

pub async fn run(config: Config) -> anyhow::Result<()> {
    install_panic_cleanup_hook();
    enable_raw_mode()?;
    execute!(std::io::stdout(), EnterAlternateScreen, EnableMouseCapture)?;
    let _cleanup = TerminalCleanup;
    let mut terminal = Terminal::new(CrosstermBackend::new(std::io::stdout()))?;
    let result = App::new(config).run(&mut terminal).await;
    cleanup_terminal();
    terminal.show_cursor()?;
    result
}

struct TerminalCleanup;

impl Drop for TerminalCleanup {
    fn drop(&mut self) {
        cleanup_terminal();
    }
}

fn cleanup_terminal() {
    let _ = disable_raw_mode();
    let _ = execute!(std::io::stdout(), DisableMouseCapture, LeaveAlternateScreen);
}

fn install_panic_cleanup_hook() {
    static INSTALLED: std::sync::Once = std::sync::Once::new();
    INSTALLED.call_once(|| {
        let previous = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            cleanup_terminal();
            previous(info);
        }));
    });
}

struct App {
    client: reqwest::Client,
    server: String,
    status: Option<DaemonStatus>,
    table: TableState,
    message: String,
    label_input: Option<(u16, String)>,
    group_input: Option<(u16, String)>,
}

#[derive(Debug, Clone)]
enum DisplayRow {
    Group { name: String, count: usize },
    Tunnel(TunnelStatus),
}

impl App {
    fn new(config: Config) -> Self {
        let mut table = TableState::default();
        table.select(Some(0));
        Self {
            client: reqwest::Client::new(),
            server: config.server.trim_end_matches('/').to_string(),
            status: None,
            table,
            message: "connecting to portd".to_string(),
            label_input: None,
            group_input: None,
        }
    }

    async fn run(
        mut self,
        terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    ) -> anyhow::Result<()> {
        let mut last_refresh = tokio::time::Instant::now() - Duration::from_secs(2);
        loop {
            if last_refresh.elapsed() >= Duration::from_millis(600) {
                self.refresh().await;
                last_refresh = tokio::time::Instant::now();
            }
            terminal.draw(|frame| self.draw(frame))?;
            if event::poll(Duration::from_millis(100))? {
                if let Event::Key(key) = event::read()? {
                    if key.kind != KeyEventKind::Press {
                        continue;
                    }
                    if self.group_input.is_some() {
                        self.handle_group_key(key.code).await;
                        continue;
                    }
                    if self.label_input.is_some() {
                        self.handle_label_key(key.code).await;
                        continue;
                    }
                    match key.code {
                        KeyCode::Char('q') | KeyCode::Esc => return Ok(()),
                        KeyCode::Down | KeyCode::Char('j') => self.move_selection(1),
                        KeyCode::Up | KeyCode::Char('k') => self.move_selection(-1),
                        KeyCode::Char('x') | KeyCode::Enter => self.toggle().await,
                        KeyCode::Char('o') => self.open().await,
                        KeyCode::Char('l') => self.begin_label(),
                        KeyCode::Char('g') => self.begin_group(),
                        KeyCode::Char('[') => self.move_selected("port", -1).await,
                        KeyCode::Char(']') => self.move_selected("port", 1).await,
                        KeyCode::Char('{') => self.move_selected("group", -1).await,
                        KeyCode::Char('}') => self.move_selected("group", 1).await,
                        KeyCode::Char('r') => {
                            self.post("/api/refresh").await;
                            last_refresh = tokio::time::Instant::now() - Duration::from_secs(2);
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    async fn refresh(&mut self) {
        match self
            .client
            .get(format!("{}/api/status", self.server))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                match response.json::<DaemonStatus>().await {
                    Ok(status) => {
                        let selected_port = self.selected_port();
                        self.message = if status.connected {
                            "auto-discovery active".to_string()
                        } else {
                            status
                                .last_error
                                .clone()
                                .unwrap_or_else(|| "reconnecting".to_string())
                        };
                        self.status = Some(status);
                        self.restore_selection(selected_port);
                    }
                    Err(error) => self.message = format!("invalid daemon response: {error}"),
                }
            }
            Ok(response) => self.message = format!("portd returned {}", response.status()),
            Err(_) => self.message = "waiting for portd on localhost:43117".to_string(),
        }
    }

    fn move_selection(&mut self, delta: isize) {
        let selectable = self.selectable_rows();
        if selectable.is_empty() {
            return;
        }
        let current_row = self.table.selected().unwrap_or(selectable[0]);
        let current = selectable
            .iter()
            .position(|row| *row == current_row)
            .unwrap_or(0) as isize;
        let next = (current + delta).clamp(0, selectable.len() as isize - 1) as usize;
        self.table.select(Some(selectable[next]));
    }

    fn selected_port(&self) -> Option<u16> {
        let index = self.table.selected()?;
        match self.display_rows().get(index)? {
            DisplayRow::Tunnel(tunnel) => Some(tunnel.remote_port),
            DisplayRow::Group { .. } => None,
        }
    }

    fn selected_tunnel(&self) -> Option<TunnelStatus> {
        let port = self.selected_port()?;
        self.status
            .as_ref()?
            .tunnels
            .iter()
            .find(|tunnel| tunnel.remote_port == port)
            .cloned()
    }

    fn display_rows(&self) -> Vec<DisplayRow> {
        let Some(status) = &self.status else {
            return Vec::new();
        };
        let mut rows = Vec::new();
        let mut current_group: Option<&str> = None;
        for tunnel in &status.tunnels {
            if current_group != Some(tunnel.group.as_str()) {
                current_group = Some(tunnel.group.as_str());
                let count = status
                    .tunnels
                    .iter()
                    .filter(|candidate| candidate.group == tunnel.group)
                    .count();
                rows.push(DisplayRow::Group {
                    name: if tunnel.group.is_empty() {
                        "Ungrouped".to_string()
                    } else {
                        tunnel.group.clone()
                    },
                    count,
                });
            }
            rows.push(DisplayRow::Tunnel(tunnel.clone()));
        }
        rows
    }

    fn selectable_rows(&self) -> Vec<usize> {
        self.display_rows()
            .iter()
            .enumerate()
            .filter_map(|(index, row)| matches!(row, DisplayRow::Tunnel(_)).then_some(index))
            .collect()
    }

    fn restore_selection(&mut self, port: Option<u16>) {
        let rows = self.display_rows();
        let selected = port
            .and_then(|port| {
                rows.iter().position(
                    |row| matches!(row, DisplayRow::Tunnel(tunnel) if tunnel.remote_port == port),
                )
            })
            .or_else(|| {
                rows.iter()
                    .position(|row| matches!(row, DisplayRow::Tunnel(_)))
            });
        self.table.select(selected);
    }

    async fn toggle(&mut self) {
        if let Some(port) = self.selected_port() {
            self.post(&format!("/api/tunnels/{port}/toggle")).await;
            self.refresh().await;
        }
    }

    async fn open(&mut self) {
        if let Some(port) = self.selected_port() {
            self.post(&format!("/api/tunnels/{port}/open")).await;
        }
    }

    fn begin_label(&mut self) {
        let Some(tunnel) = self.selected_tunnel() else {
            return;
        };
        self.label_input = Some((tunnel.remote_port, tunnel.label.clone()));
    }

    fn begin_group(&mut self) {
        let Some(tunnel) = self.selected_tunnel() else {
            return;
        };
        self.group_input = Some((tunnel.remote_port, tunnel.group));
    }

    async fn handle_label_key(&mut self, code: KeyCode) {
        match code {
            KeyCode::Esc => {
                self.label_input = None;
                self.message = "label edit cancelled".to_string();
            }
            KeyCode::Enter => {
                if let Some((port, label)) = self.label_input.take() {
                    self.save_label(port, label).await;
                    self.refresh().await;
                }
            }
            KeyCode::Backspace => {
                if let Some((_, label)) = &mut self.label_input {
                    label.pop();
                }
            }
            KeyCode::Char(character) => {
                if let Some((_, label)) = &mut self.label_input {
                    if label.chars().count() < 48 && !character.is_control() {
                        label.push(character);
                    }
                }
            }
            _ => {}
        }
    }

    async fn save_label(&mut self, port: u16, label: String) {
        match self
            .client
            .post(format!("{}/api/tunnels/{port}/label", self.server))
            .json(&serde_json::json!({ "label": label }))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                self.message = "label saved".to_string()
            }
            Ok(response) => {
                let status = response.status();
                let detail = response.text().await.unwrap_or_default();
                self.message = format!("{status}: {detail}");
            }
            Err(error) => self.message = error.to_string(),
        }
    }

    async fn handle_group_key(&mut self, code: KeyCode) {
        match code {
            KeyCode::Esc => {
                self.group_input = None;
                self.message = "group edit cancelled".to_string();
            }
            KeyCode::Enter => {
                if let Some((port, group)) = self.group_input.take() {
                    self.save_group(port, group).await;
                    self.refresh().await;
                }
            }
            KeyCode::Backspace => {
                if let Some((_, group)) = &mut self.group_input {
                    group.pop();
                }
            }
            KeyCode::Char(character) => {
                if let Some((_, group)) = &mut self.group_input {
                    if group.chars().count() < 32 && !character.is_control() {
                        group.push(character);
                    }
                }
            }
            _ => {}
        }
    }

    async fn save_group(&mut self, port: u16, group: String) {
        match self
            .client
            .post(format!("{}/api/tunnels/{port}/group", self.server))
            .json(&serde_json::json!({ "group": group }))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                self.message = "group saved".to_string()
            }
            Ok(response) => {
                let status = response.status();
                let detail = response.text().await.unwrap_or_default();
                self.message = format!("{status}: {detail}");
            }
            Err(error) => self.message = error.to_string(),
        }
    }

    async fn move_selected(&mut self, scope: &str, direction: i8) {
        let Some(port) = self.selected_port() else {
            return;
        };
        match self
            .client
            .post(format!("{}/api/tunnels/{port}/move", self.server))
            .json(&serde_json::json!({ "scope": scope, "direction": direction }))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                self.message = format!("{scope} order updated");
                self.refresh().await;
            }
            Ok(response) => {
                let status = response.status();
                let detail = response.text().await.unwrap_or_default();
                self.message = format!("{status}: {detail}");
            }
            Err(error) => self.message = error.to_string(),
        }
    }

    async fn post(&mut self, path: &str) {
        match self
            .client
            .post(format!("{}{path}", self.server))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => self.message = "done".to_string(),
            Ok(response) => {
                let status = response.status();
                let detail = response.text().await.unwrap_or_default();
                self.message = format!("{status}: {detail}");
            }
            Err(error) => self.message = error.to_string(),
        }
    }

    fn draw(&mut self, frame: &mut Frame) {
        let areas = Layout::vertical([
            Constraint::Length(3),
            Constraint::Min(5),
            Constraint::Length(3),
        ])
        .split(frame.area());
        let (host, connected) = self
            .status
            .as_ref()
            .map(|status| (status.host.as_str(), status.connected))
            .unwrap_or(("ubuntu", false));
        let indicator = if connected {
            "● connected"
        } else {
            "○ reconnecting"
        };
        let indicator_color = if connected {
            Color::Green
        } else {
            Color::Yellow
        };
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    " ports ",
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::raw(format!("{host}  ")),
                Span::styled(indicator, Style::default().fg(indicator_color)),
            ]))
            .block(Block::default().borders(Borders::ALL)),
            areas[0],
        );

        let rows = self
            .display_rows()
            .into_iter()
            .map(|display_row| match display_row {
                DisplayRow::Group { name, count } => Row::new(vec![
                    Cell::from(""),
                    Cell::from(""),
                    Cell::from(""),
                    Cell::from(format!("{name} ({count})")),
                    Cell::from(""),
                    Cell::from(""),
                ])
                .style(
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                ),
                DisplayRow::Tunnel(tunnel) => {
                    let color = match tunnel.state {
                        TunnelState::Active => Color::Green,
                        TunnelState::Disabled => Color::DarkGray,
                        TunnelState::Error => Color::Red,
                        TunnelState::Available => Color::Yellow,
                    };
                    let local = tunnel
                        .local_port
                        .map(|port| port.to_string())
                        .unwrap_or_else(|| "-".to_string());
                    let url = tunnel
                        .local_port
                        .map(|port| format!("http://localhost:{port}"))
                        .unwrap_or_default();
                    Row::new(vec![
                        Cell::from(tunnel.state.label()).style(Style::default().fg(color)),
                        Cell::from(tunnel.remote_port.to_string()),
                        Cell::from(local),
                        Cell::from(if tunnel.label.is_empty() {
                            "-".to_string()
                        } else {
                            tunnel.label
                        }),
                        Cell::from(if tunnel.process.is_empty() {
                            "-".to_string()
                        } else {
                            tunnel.process
                        }),
                        Cell::from(url),
                    ])
                }
            })
            .collect::<Vec<_>>();
        let header = Row::new(["STATE", "REMOTE", "LOCAL", "LABEL", "PROCESS", "ADDRESS"]).style(
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        );
        let table = Table::new(
            rows,
            [
                Constraint::Length(9),
                Constraint::Length(8),
                Constraint::Length(8),
                Constraint::Length(15),
                Constraint::Length(13),
                Constraint::Min(22),
            ],
        )
        .header(header)
        .row_highlight_style(
            Style::default()
                .bg(Color::DarkGray)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("› ")
        .block(Block::default().title(" listeners ").borders(Borders::ALL));
        frame.render_stateful_widget(table, areas[1], &mut self.table);

        let footer = if let Some((port, group)) = &self.group_input {
            vec![Line::from(vec![
                Span::styled(format!("group {port}: "), Style::default().fg(Color::Cyan)),
                Span::styled(group, Style::default().add_modifier(Modifier::BOLD)),
                Span::raw("  enter save  esc cancel"),
            ])]
        } else if let Some((port, label)) = &self.label_input {
            vec![Line::from(vec![
                Span::styled(format!("label {port}: "), Style::default().fg(Color::Cyan)),
                Span::styled(label, Style::default().add_modifier(Modifier::BOLD)),
                Span::raw("  enter save  esc cancel"),
            ])]
        } else {
            vec![
                Line::from(vec![
                    Span::styled("j/k", Style::default().fg(Color::Cyan)),
                    Span::raw(" move  "),
                    Span::styled("x", Style::default().fg(Color::Cyan)),
                    Span::raw(" toggle  "),
                    Span::styled("l", Style::default().fg(Color::Cyan)),
                    Span::raw(" label  "),
                    Span::styled("g", Style::default().fg(Color::Cyan)),
                    Span::raw(" group  "),
                    Span::styled("o", Style::default().fg(Color::Cyan)),
                    Span::raw(" open  "),
                    Span::styled("r", Style::default().fg(Color::Cyan)),
                    Span::raw(" refresh  "),
                    Span::styled("q", Style::default().fg(Color::Cyan)),
                    Span::raw(" quit"),
                ]),
                Line::from(vec![
                    Span::styled("[/]", Style::default().fg(Color::Cyan)),
                    Span::raw(" order port  "),
                    Span::styled("{/}", Style::default().fg(Color::Cyan)),
                    Span::raw(format!(" order group    {}", self.message)),
                ]),
            ]
        };
        frame.render_widget(Paragraph::new(footer), areas[2]);
    }
}
