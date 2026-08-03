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

use crate::protocol::{DaemonStatus, ReverseTunnelStatus, TunnelState, TunnelStatus};

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
    port_input: Option<String>,
    reverse_mode: bool,
}

#[derive(Debug, Clone)]
enum DisplayRow {
    Group { name: String, count: usize },
    Tunnel(TunnelStatus),
    Reverse(ReverseTunnelStatus),
}

fn parse_reverse_spec(input: &str) -> Option<(u16, u16)> {
    let (remote, local) = input.split_once(':').unwrap_or((input, input));
    let remote = remote.parse::<u16>().ok()?;
    let local = local.parse::<u16>().ok()?;
    (remote >= 1024 && local >= 1024).then_some((remote, local))
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
            port_input: None,
            reverse_mode: false,
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
                    if self.port_input.is_some() {
                        self.handle_port_key(key.code).await;
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
                        KeyCode::Tab | KeyCode::Char('1') | KeyCode::Char('2') => {
                            self.switch_mode(key.code)
                        }
                        KeyCode::Down | KeyCode::Char('j') => self.move_selection(1),
                        KeyCode::Up | KeyCode::Char('k') => self.move_selection(-1),
                        KeyCode::Char('x') | KeyCode::Enter => self.toggle().await,
                        KeyCode::Char('m') => self.port_input = Some(String::new()),
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
            DisplayRow::Reverse(tunnel) => Some(tunnel.remote_port),
            DisplayRow::Group { .. } => None,
        }
    }

    fn selected_tunnel(&self) -> Option<TunnelStatus> {
        if self.reverse_mode {
            return None;
        }
        let port = self.selected_port()?;
        self.status
            .as_ref()?
            .tunnels
            .iter()
            .find(|tunnel| tunnel.remote_port == port)
            .cloned()
    }

    fn selected_reverse(&self) -> Option<ReverseTunnelStatus> {
        if !self.reverse_mode {
            return None;
        }
        let port = self.selected_port()?;
        self.status
            .as_ref()?
            .reverse_tunnels
            .iter()
            .find(|tunnel| tunnel.remote_port == port)
            .cloned()
    }

    fn display_rows(&self) -> Vec<DisplayRow> {
        let Some(status) = &self.status else {
            return Vec::new();
        };
        if self.reverse_mode {
            return status
                .reverse_tunnels
                .iter()
                .cloned()
                .map(DisplayRow::Reverse)
                .collect();
        }

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
            .filter_map(|(index, row)| {
                matches!(row, DisplayRow::Tunnel(_) | DisplayRow::Reverse(_)).then_some(index)
            })
            .collect()
    }

    fn restore_selection(&mut self, port: Option<u16>) {
        let rows = self.display_rows();
        let selected = port
            .and_then(|port| {
                rows.iter().position(|row| match row {
                    DisplayRow::Tunnel(tunnel) => tunnel.remote_port == port,
                    DisplayRow::Reverse(tunnel) => tunnel.remote_port == port,
                    DisplayRow::Group { .. } => false,
                })
            })
            .or_else(|| {
                rows.iter()
                    .position(|row| matches!(row, DisplayRow::Tunnel(_) | DisplayRow::Reverse(_)))
            });
        self.table.select(selected);
    }

    fn switch_mode(&mut self, key: KeyCode) {
        self.reverse_mode = match key {
            KeyCode::Char('1') => false,
            KeyCode::Char('2') => true,
            _ => !self.reverse_mode,
        };
        self.table.select(None);
        self.restore_selection(None);
        self.message = if self.reverse_mode {
            "Mac services exposed on Ubuntu".to_string()
        } else {
            "Ubuntu services available on Mac".to_string()
        };
    }

    async fn toggle(&mut self) {
        if let Some(tunnel) = self.selected_reverse() {
            self.post(&format!(
                "/api/reverse/{}/{}/toggle",
                tunnel.remote_port, tunnel.local_port
            ))
            .await;
            self.refresh().await;
        } else if let Some(port) = self.selected_port() {
            self.post(&format!("/api/tunnels/{port}/toggle")).await;
            self.refresh().await;
        }
    }

    async fn open(&mut self) {
        if self.reverse_mode {
            self.message = "open is only available for Mac-facing forwards".to_string();
        } else if let Some(port) = self.selected_port() {
            self.post(&format!("/api/tunnels/{port}/open")).await;
        }
    }

    async fn handle_port_key(&mut self, code: KeyCode) {
        match code {
            KeyCode::Esc => {
                self.port_input = None;
                self.message = "manual port cancelled".to_string();
            }
            KeyCode::Enter => {
                let input = self.port_input.take().unwrap_or_default();
                if self.reverse_mode {
                    match parse_reverse_spec(&input) {
                        Some((remote_port, local_port)) => {
                            self.post(&format!("/api/reverse/{remote_port}/{local_port}/toggle"))
                                .await;
                            self.refresh().await;
                            self.restore_selection(Some(remote_port));
                        }
                        None => {
                            self.message = "enter UBUNTU_PORT or UBUNTU_PORT:MAC_PORT".to_string()
                        }
                    }
                } else {
                    match input.parse::<u16>() {
                        Ok(port) if port >= 1024 => {
                            self.post(&format!("/api/tunnels/{port}/toggle")).await;
                            self.refresh().await;
                            self.restore_selection(Some(port));
                        }
                        _ => self.message = "port must be between 1024 and 65535".to_string(),
                    }
                }
            }
            KeyCode::Backspace => {
                if let Some(input) = &mut self.port_input {
                    input.pop();
                }
            }
            KeyCode::Char(character)
                if character.is_ascii_digit() || (self.reverse_mode && character == ':') =>
            {
                if let Some(input) = &mut self.port_input
                    && input.len() < 11
                    && (character != ':' || !input.contains(':'))
                {
                    input.push(character);
                }
            }
            _ => {}
        }
    }

    fn begin_label(&mut self) {
        let Some(tunnel) = self.selected_tunnel() else {
            self.message = "labels currently apply to Mac-facing forwards".to_string();
            return;
        };
        self.label_input = Some((tunnel.remote_port, tunnel.label.clone()));
    }

    fn begin_group(&mut self) {
        let Some(tunnel) = self.selected_tunnel() else {
            self.message = "groups currently apply to Mac-facing forwards".to_string();
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
        if self.reverse_mode {
            self.message = "ordering currently applies to Mac-facing forwards".to_string();
            return;
        }
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
        let active_tab = Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(" ports  ", active_tab),
                Span::styled(
                    "[1] Mac → Ubuntu",
                    if self.reverse_mode {
                        Style::default()
                    } else {
                        active_tab
                    },
                ),
                Span::raw("  "),
                Span::styled(
                    "[2] Ubuntu → Mac",
                    if self.reverse_mode {
                        active_tab
                    } else {
                        Style::default()
                    },
                ),
                Span::raw(format!("    {host}  ")),
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
                DisplayRow::Reverse(tunnel) => {
                    let color = match tunnel.state {
                        TunnelState::Active => Color::Green,
                        TunnelState::Disabled => Color::DarkGray,
                        TunnelState::Error => Color::Red,
                        TunnelState::Available => Color::Yellow,
                    };
                    Row::new(vec![
                        Cell::from(tunnel.state.label()).style(Style::default().fg(color)),
                        Cell::from(tunnel.remote_port.to_string()),
                        Cell::from(tunnel.local_port.to_string()),
                        Cell::from("-"),
                        Cell::from(if tunnel.process.is_empty() {
                            "-".to_string()
                        } else {
                            tunnel.process
                        }),
                        Cell::from(format!("localhost:{}", tunnel.remote_port)),
                    ])
                }
            })
            .collect::<Vec<_>>();
        let header = Row::new(["STATE", "UBUNTU", "MAC", "LABEL", "PROCESS", "ADDRESS"]).style(
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
        .block(
            Block::default()
                .title(if self.reverse_mode {
                    " Mac services exposed on Ubuntu "
                } else {
                    " Ubuntu services available on Mac "
                })
                .borders(Borders::ALL),
        );
        frame.render_stateful_widget(table, areas[1], &mut self.table);

        let footer = if let Some(port) = &self.port_input {
            vec![Line::from(vec![
                Span::styled(
                    if self.reverse_mode {
                        "Ubuntu[:Mac] ports: "
                    } else {
                        "manual Ubuntu port: "
                    },
                    Style::default().fg(Color::Cyan),
                ),
                Span::styled(port, Style::default().add_modifier(Modifier::BOLD)),
                Span::raw("  enter toggle  esc cancel"),
            ])]
        } else if let Some((port, group)) = &self.group_input {
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
        } else if self.reverse_mode {
            vec![
                Line::from(vec![
                    Span::styled("j/k", Style::default().fg(Color::Cyan)),
                    Span::raw(" move  "),
                    Span::styled("x", Style::default().fg(Color::Cyan)),
                    Span::raw(" expose/remove  "),
                    Span::styled("m", Style::default().fg(Color::Cyan)),
                    Span::raw(" manual  "),
                    Span::styled("tab", Style::default().fg(Color::Cyan)),
                    Span::raw(" direction  "),
                    Span::styled("r", Style::default().fg(Color::Cyan)),
                    Span::raw(" refresh  "),
                    Span::styled("q", Style::default().fg(Color::Cyan)),
                    Span::raw(" quit"),
                ]),
                Line::from(self.message.clone()),
            ]
        } else {
            vec![
                Line::from(vec![
                    Span::styled("j/k", Style::default().fg(Color::Cyan)),
                    Span::raw(" move  "),
                    Span::styled("x", Style::default().fg(Color::Cyan)),
                    Span::raw(" toggle  "),
                    Span::styled("m", Style::default().fg(Color::Cyan)),
                    Span::raw(" manual  "),
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

#[cfg(test)]
mod tests {
    use super::parse_reverse_spec;

    #[test]
    fn parses_same_and_distinct_reverse_ports() {
        assert_eq!(parse_reverse_spec("5037"), Some((5037, 5037)));
        assert_eq!(parse_reverse_spec("5038:5037"), Some((5038, 5037)));
        assert_eq!(parse_reverse_spec("22"), None);
        assert_eq!(parse_reverse_spec("5037:"), None);
    }
}
