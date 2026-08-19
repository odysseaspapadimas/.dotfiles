use std::{
    collections::{BTreeMap, BTreeSet},
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, bail};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use tokio::{
    process::{Child, Command},
    sync::{Mutex, RwLock, mpsc},
};

use crate::protocol::{DaemonStatus, ReverseTunnelStatus, TunnelState, TunnelStatus};

#[derive(Debug)]
pub struct Config {
    pub host: String,
    pub api_port: u16,
    pub interval_secs: u64,
    pub idle_interval_secs: u64,
    pub max_backoff_secs: u64,
    pub max_auto_port: u16,
    pub reverse_forwards: Vec<(u16, u16)>,
    pub control_path: Option<PathBuf>,
}

#[derive(Debug, Clone)]
struct Listener {
    port: u16,
    process: String,
}

#[derive(Debug, Clone)]
struct ManagedTunnel {
    listener: Listener,
    local_port: Option<u16>,
    state: TunnelState,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct Preferences {
    disabled: BTreeSet<u16>,
    manual: BTreeSet<u16>,
    labels: BTreeMap<u16, String>,
    groups: BTreeMap<u16, String>,
    group_order: Vec<String>,
    port_order: BTreeMap<String, Vec<u16>>,
    reverse_forwards: BTreeMap<u16, u16>,
}

#[derive(Debug, Deserialize)]
struct LabelPayload {
    label: String,
}

#[derive(Debug, Deserialize)]
struct GroupPayload {
    group: String,
}

#[derive(Debug, Deserialize)]
struct MovePayload {
    scope: String,
    direction: i8,
}

struct Runtime {
    host: String,
    api_port: u16,
    max_auto_port: u16,
    control_path: PathBuf,
    preferences_path: PathBuf,
    preferences: Preferences,
    tunnels: BTreeMap<u16, ManagedTunnel>,
    local_listeners: BTreeMap<u16, Listener>,
    master: Option<Child>,
    reverse_ready: bool,
    reverse_error: Option<String>,
    last_reverse_attempt: Option<tokio::time::Instant>,
    service_reverse_ready: BTreeSet<(u16, u16)>,
    last_service_reverse_attempt: Option<tokio::time::Instant>,
    connected: bool,
    last_error: Option<String>,
    last_scan_ms: Option<u128>,
}

#[derive(Clone)]
struct AppState {
    runtime: Arc<Mutex<Runtime>>,
    status: Arc<RwLock<DaemonStatus>>,
    wake: mpsc::Sender<()>,
}

pub async fn run(config: Config) -> anyhow::Result<()> {
    let home = std::env::var_os("HOME").context("HOME is not set")?;
    let config_dir = PathBuf::from(home).join(".config/portd");
    std::fs::create_dir_all(&config_dir)?;
    let control_path = config
        .control_path
        .unwrap_or_else(|| config_dir.join("ssh-control"));
    let preferences_path = config_dir.join("state.json");
    let mut preferences = read_preferences(&preferences_path);
    let mut preferences_changed = false;
    for (remote_port, local_port) in config.reverse_forwards {
        if preferences.reverse_forwards.insert(remote_port, local_port) != Some(local_port) {
            preferences_changed = true;
        }
    }
    if preferences_changed {
        write_preferences(&preferences_path, &preferences)?;
    }

    let status = Arc::new(RwLock::new(DaemonStatus {
        host: config.host.clone(),
        connected: false,
        last_error: None,
        last_scan_ms: None,
        tunnels: Vec::new(),
        reverse_tunnels: Vec::new(),
    }));
    let runtime = Arc::new(Mutex::new(Runtime {
        host: config.host,
        api_port: config.api_port,
        max_auto_port: config.max_auto_port,
        control_path,
        preferences_path,
        preferences,
        tunnels: BTreeMap::new(),
        local_listeners: BTreeMap::new(),
        master: None,
        reverse_ready: false,
        reverse_error: None,
        last_reverse_attempt: None,
        service_reverse_ready: BTreeSet::new(),
        last_service_reverse_attempt: None,
        connected: false,
        last_error: None,
        last_scan_ms: None,
    }));
    let (wake_tx, mut wake_rx) = mpsc::channel::<()>(4);
    let state = AppState {
        runtime: runtime.clone(),
        status: status.clone(),
        wake: wake_tx,
    };

    let app = Router::new()
        .route("/api/status", get(api_status))
        .route("/api/refresh", post(api_refresh))
        .route("/api/tunnels/{port}/toggle", post(api_toggle))
        .route("/api/tunnels/{port}/label", post(api_label))
        .route("/api/tunnels/{port}/group", post(api_group))
        .route("/api/tunnels/{port}/move", post(api_move))
        .route("/api/tunnels/{port}/open", post(api_open))
        .route(
            "/api/reverse/{remote_port}/{local_port}/toggle",
            post(api_reverse_toggle),
        )
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", config.api_port))
        .await
        .with_context(|| format!("failed to bind portd API on 127.0.0.1:{}", config.api_port))?;

    let api = tokio::spawn(async move { axum::serve(listener, app).await });
    let worker_runtime = runtime.clone();
    let worker_status = status.clone();
    let interval = Duration::from_secs(config.interval_secs.max(1));
    let idle_interval = Duration::from_secs(config.idle_interval_secs.max(config.interval_secs));
    let max_backoff = Duration::from_secs(config.max_backoff_secs.max(config.interval_secs));
    let worker = tokio::spawn(async move {
        let mut consecutive_failures = 0;
        loop {
            let succeeded = match reconcile(worker_runtime.clone(), worker_status.clone()).await {
                Ok(()) => {
                    consecutive_failures = 0;
                    true
                }
                Err(error) => {
                    consecutive_failures += 1;
                    set_error(&worker_runtime, &worker_status, error.to_string()).await;
                    false
                }
            };
            let delay = if succeeded {
                let runtime = worker_runtime.lock().await;
                if runtime
                    .tunnels
                    .values()
                    .any(|tunnel| tunnel.local_port.is_some())
                {
                    interval
                } else {
                    idle_interval
                }
            } else {
                retry_delay(interval, max_backoff, consecutive_failures)
            };
            tokio::select! {
                _ = tokio::time::sleep(delay) => {}
                message = wake_rx.recv() => {
                    if message.is_none() {
                        break;
                    }
                }
            }
        }
    });

    println!("portd API listening on 127.0.0.1:{}", config.api_port);
    shutdown_signal().await?;
    worker.abort();
    api.abort();
    cleanup(runtime).await;
    Ok(())
}

async fn reconcile(
    runtime: Arc<Mutex<Runtime>>,
    status: Arc<RwLock<DaemonStatus>>,
) -> anyhow::Result<()> {
    let mut runtime = runtime.lock().await;
    ensure_master(&mut runtime).await?;
    let mut reverse_error = ensure_reverse_forward(&mut runtime).await;
    if let Some(error) = ensure_service_reverse_forwards(&mut runtime).await {
        reverse_error = Some(error);
    }
    runtime.local_listeners = discover_local_listeners().await;
    let api_port = runtime.api_port;
    runtime.local_listeners.remove(&api_port);
    let forwarded_local_ports = runtime
        .tunnels
        .values()
        .filter_map(|tunnel| tunnel.local_port)
        .collect::<Vec<_>>();
    for port in forwarded_local_ports {
        runtime.local_listeners.remove(&port);
    }
    let output = ssh_output(&runtime, &["ss", "-H", "-ltnp"]).await?;
    let mut listeners = parse_listeners(&output);
    for port in &runtime.preferences.manual {
        listeners.entry(*port).or_insert_with(|| Listener {
            port: *port,
            process: String::new(),
        });
    }
    for (port, _) in &runtime.service_reverse_ready {
        listeners.remove(port);
    }
    listeners.retain(|port, _| {
        *port <= runtime.max_auto_port || runtime.preferences.manual.contains(port)
    });
    let present: BTreeSet<u16> = listeners.keys().copied().collect();

    let removed: Vec<u16> = runtime
        .tunnels
        .keys()
        .copied()
        .filter(|port| !present.contains(port))
        .collect();
    for port in removed {
        if let Some(tunnel) = runtime.tunnels.remove(&port) {
            if let Some(local_port) = tunnel.local_port {
                let _ = cancel_forward(&runtime, local_port, port).await;
            }
        }
    }

    for listener in listeners.values() {
        let port = listener.port;
        if let Some(tunnel) = runtime.tunnels.get_mut(&port) {
            tunnel.listener = listener.clone();
            continue;
        }
        let state = if runtime.preferences.disabled.contains(&port) {
            TunnelState::Disabled
        } else if port <= runtime.max_auto_port || runtime.preferences.manual.contains(&port) {
            TunnelState::Available
        } else {
            TunnelState::Available
        };
        runtime.tunnels.insert(
            port,
            ManagedTunnel {
                listener: listener.clone(),
                local_port: None,
                state,
            },
        );
    }

    let to_start: Vec<u16> = runtime
        .tunnels
        .iter()
        .filter_map(|(port, tunnel)| {
            let enabled = !runtime.preferences.disabled.contains(port)
                && (*port <= runtime.max_auto_port || runtime.preferences.manual.contains(port));
            (enabled && tunnel.local_port.is_none()).then_some(*port)
        })
        .collect();
    let mut cycle_error = reverse_error;
    for remote_port in to_start {
        match start_forward(&runtime, remote_port).await {
            Ok(local_port) => {
                if let Some(tunnel) = runtime.tunnels.get_mut(&remote_port) {
                    tunnel.local_port = Some(local_port);
                    tunnel.state = TunnelState::Active;
                }
                println!(
                    "forwarded localhost:{local_port} -> {}:{remote_port}",
                    runtime.host
                );
            }
            Err(error) => {
                if let Some(tunnel) = runtime.tunnels.get_mut(&remote_port) {
                    tunnel.state = TunnelState::Error;
                }
                cycle_error = Some(error.to_string());
            }
        }
    }

    if !runtime.connected {
        println!("connected to {}", runtime.host);
    }
    runtime.connected = true;
    if runtime.last_error != cycle_error {
        if let Some(error) = &cycle_error {
            eprintln!("portd warning: {error}");
        }
    }
    runtime.last_error = cycle_error;
    runtime.last_scan_ms = Some(now_ms());
    publish_status(&runtime, &status).await;
    Ok(())
}

async fn ensure_master(runtime: &mut Runtime) -> anyhow::Result<()> {
    if let Some(master) = runtime.master.as_mut() {
        if master.try_wait()?.is_none() && runtime.control_path.exists() {
            return Ok(());
        }
    }
    for (port, tunnel) in &mut runtime.tunnels {
        tunnel.local_port = None;
        tunnel.state = if runtime.preferences.disabled.contains(port) {
            TunnelState::Disabled
        } else {
            TunnelState::Available
        };
    }
    if let Some(mut child) = runtime.master.take() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    let _ = std::fs::remove_file(&runtime.control_path);
    runtime.reverse_ready = false;
    runtime.reverse_error = None;
    runtime.last_reverse_attempt = None;
    runtime.service_reverse_ready.clear();
    runtime.last_service_reverse_attempt = None;

    let child = Command::new("ssh")
        .args(["-M", "-N", "-T"])
        .arg("-S")
        .arg(&runtime.control_path)
        .args([
            "-o",
            "ControlMaster=yes",
            "-o",
            "ControlPersist=no",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=5",
            "-o",
            "ConnectionAttempts=1",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
        ])
        .arg(&runtime.host)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("failed to start SSH master for {}", runtime.host))?;
    runtime.master = Some(child);

    for _ in 0..40 {
        if master_healthy(runtime).await {
            return Ok(());
        }
        if runtime
            .master
            .as_mut()
            .and_then(|child| child.try_wait().ok())
            .flatten()
            .is_some()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    bail!("SSH master for {} did not become ready", runtime.host)
}

async fn ensure_reverse_forward(runtime: &mut Runtime) -> Option<String> {
    if runtime.reverse_ready {
        return None;
    }
    let now = tokio::time::Instant::now();
    if runtime
        .last_reverse_attempt
        .is_some_and(|last| now.duration_since(last) < Duration::from_secs(30))
    {
        return runtime.reverse_error.clone();
    }
    runtime.last_reverse_attempt = Some(now);
    let reverse = format!("127.0.0.1:{0}:127.0.0.1:{0}", runtime.api_port);
    let output = match Command::new("ssh")
        .arg("-S")
        .arg(&runtime.control_path)
        .args(["-O", "forward", "-R", &reverse])
        .arg(&runtime.host)
        .stdin(Stdio::null())
        .output()
        .await
    {
        Ok(output) => output,
        Err(error) => {
            let message = format!("remote control channel unavailable: {error}");
            runtime.reverse_error = Some(message.clone());
            return Some(message);
        }
    };
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let message = format!(
            "remote control channel unavailable{}",
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        );
        runtime.reverse_error = Some(message.clone());
        return Some(message);
    }
    runtime.reverse_ready = true;
    runtime.reverse_error = None;
    None
}

async fn ensure_service_reverse_forwards(runtime: &mut Runtime) -> Option<String> {
    if runtime.service_reverse_ready.len() == runtime.preferences.reverse_forwards.len() {
        return None;
    }
    let now = tokio::time::Instant::now();
    if runtime
        .last_service_reverse_attempt
        .is_some_and(|last| now.duration_since(last) < Duration::from_secs(30))
    {
        return Some("configured reverse forward unavailable; retry pending".to_string());
    }
    runtime.last_service_reverse_attempt = Some(now);

    let pending = runtime
        .preferences
        .reverse_forwards
        .iter()
        .map(|(&remote_port, &local_port)| (remote_port, local_port))
        .filter(|forward| !runtime.service_reverse_ready.contains(forward))
        .collect::<Vec<_>>();
    let mut first_error = None;
    for (remote_port, local_port) in pending {
        if let Err(error) = start_reverse_forward(runtime, remote_port, local_port).await {
            first_error.get_or_insert_with(|| error.to_string());
            continue;
        }
        runtime
            .service_reverse_ready
            .insert((remote_port, local_port));
        println!(
            "reverse forwarded {} localhost:{remote_port} -> local localhost:{local_port}",
            runtime.host
        );
    }
    first_error
}

async fn start_reverse_forward(
    runtime: &Runtime,
    remote_port: u16,
    local_port: u16,
) -> anyhow::Result<()> {
    let spec = format!("127.0.0.1:{remote_port}:127.0.0.1:{local_port}");
    let output = Command::new("ssh")
        .arg("-S")
        .arg(&runtime.control_path)
        .args(["-O", "forward", "-R", &spec])
        .arg(&runtime.host)
        .stdin(Stdio::null())
        .output()
        .await?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        bail!(
            "reverse forward localhost:{remote_port} -> local:{local_port} unavailable{}",
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        );
    }
    Ok(())
}

async fn cancel_reverse_forward(
    runtime: &Runtime,
    remote_port: u16,
    local_port: u16,
) -> anyhow::Result<()> {
    let spec = format!("127.0.0.1:{remote_port}:127.0.0.1:{local_port}");
    let output = Command::new("ssh")
        .arg("-S")
        .arg(&runtime.control_path)
        .args(["-O", "cancel", "-R", &spec])
        .arg(&runtime.host)
        .stdin(Stdio::null())
        .output()
        .await?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        bail!("failed to cancel reverse localhost:{remote_port}: {detail}");
    }
    Ok(())
}

async fn master_healthy(runtime: &Runtime) -> bool {
    Command::new("ssh")
        .arg("-S")
        .arg(&runtime.control_path)
        .args(["-O", "check"])
        .arg(&runtime.host)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|status| status.success())
        .unwrap_or(false)
}

async fn ssh_output(runtime: &Runtime, remote_args: &[&str]) -> anyhow::Result<String> {
    let output = Command::new("ssh")
        .arg("-S")
        .arg(&runtime.control_path)
        .arg(&runtime.host)
        .args(remote_args)
        .output()
        .await?;
    if !output.status.success() {
        bail!(
            "remote listener scan failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

async fn start_forward(runtime: &Runtime, remote_port: u16) -> anyhow::Result<u16> {
    let reserved: BTreeSet<u16> = runtime
        .tunnels
        .values()
        .filter_map(|tunnel| tunnel.local_port)
        .collect();
    for local_port in candidate_ports(remote_port) {
        if reserved.contains(&local_port) || !port_available(local_port) {
            continue;
        }
        let spec = format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}");
        let output = Command::new("ssh")
            .arg("-S")
            .arg(&runtime.control_path)
            .args(["-O", "forward", "-L", &spec])
            .arg(&runtime.host)
            .stdin(Stdio::null())
            .output()
            .await?;
        if output.status.success() {
            return Ok(local_port);
        }
    }
    bail!("no available local port for remote port {remote_port}")
}

async fn cancel_forward(
    runtime: &Runtime,
    local_port: u16,
    remote_port: u16,
) -> anyhow::Result<()> {
    let spec = format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}");
    let output = Command::new("ssh")
        .arg("-S")
        .arg(&runtime.control_path)
        .args(["-O", "cancel", "-L", &spec])
        .arg(&runtime.host)
        .stdin(Stdio::null())
        .output()
        .await?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        bail!("failed to cancel localhost:{local_port}: {}", detail.trim())
    }
    Ok(())
}

fn candidate_ports(preferred: u16) -> impl Iterator<Item = u16> {
    (preferred..=u16::MAX).chain(3000..preferred)
}

fn port_available(port: u16) -> bool {
    let addresses = [
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port),
    ];
    for address in addresses {
        if TcpStream::connect_timeout(&address, Duration::from_millis(40)).is_ok() {
            return false;
        }
    }

    let Ok(_ipv4) = TcpListener::bind((Ipv4Addr::LOCALHOST, port)) else {
        return false;
    };
    TcpListener::bind((Ipv6Addr::LOCALHOST, port)).is_ok()
}

async fn discover_local_listeners() -> BTreeMap<u16, Listener> {
    let lsof = if std::path::Path::new("/usr/sbin/lsof").exists() {
        "/usr/sbin/lsof"
    } else {
        "lsof"
    };
    let Ok(output) = Command::new(lsof)
        .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])
        .stdin(Stdio::null())
        .output()
        .await
    else {
        return BTreeMap::new();
    };
    parse_lsof_listeners(&String::from_utf8_lossy(&output.stdout))
}

fn parse_lsof_listeners(output: &str) -> BTreeMap<u16, Listener> {
    let mut listeners = BTreeMap::new();
    let mut process = String::new();
    for line in output.lines() {
        let Some((field, value)) = line.split_at_checked(1) else {
            continue;
        };
        match field {
            "p" => process.clear(),
            "c" => process = value.to_string(),
            "n" => {
                let ipv4_reachable = value.starts_with("127.0.0.1:")
                    || value.starts_with("0.0.0.0:")
                    || value.starts_with("*:");
                if !ipv4_reachable {
                    continue;
                }
                let Some(port) = value
                    .rsplit(':')
                    .next()
                    .and_then(|value| value.parse::<u16>().ok())
                else {
                    continue;
                };
                if port < 1024 {
                    continue;
                }
                listeners.entry(port).or_insert_with(|| Listener {
                    port,
                    process: process.clone(),
                });
            }
            _ => {}
        }
    }
    listeners
}

fn parse_listeners(output: &str) -> BTreeMap<u16, Listener> {
    let mut listeners = BTreeMap::new();
    for line in output.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let Some(address) = fields.get(3) else {
            continue;
        };
        let Some(port) = address
            .rsplit(':')
            .next()
            .and_then(|value| value.parse::<u16>().ok())
        else {
            continue;
        };
        if port < 1024 {
            continue;
        }
        let process = line
            .split("users:((\"")
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .unwrap_or("")
            .to_string();
        listeners
            .entry(port)
            .and_modify(|listener: &mut Listener| {
                if listener.process.is_empty() {
                    listener.process = process.clone();
                }
            })
            .or_insert(Listener { port, process });
    }
    listeners
}

async fn api_status(State(state): State<AppState>) -> Json<DaemonStatus> {
    Json(state.status.read().await.clone())
}

async fn api_refresh(State(state): State<AppState>) -> StatusCode {
    let _ = state.wake.try_send(());
    StatusCode::NO_CONTENT
}

async fn api_toggle(State(state): State<AppState>, Path(port): Path<u16>) -> Response {
    if port < 1024 {
        return (
            StatusCode::BAD_REQUEST,
            "port must be between 1024 and 65535",
        )
            .into_response();
    }
    let mut runtime = state.runtime.lock().await;
    let existing = runtime
        .tunnels
        .entry(port)
        .or_insert_with(|| ManagedTunnel {
            listener: Listener {
                port,
                process: String::new(),
            },
            local_port: None,
            state: TunnelState::Available,
        })
        .clone();
    if let Some(local_port) = existing.local_port {
        if let Err(error) = cancel_forward(&runtime, local_port, port).await {
            return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
        }
        runtime.preferences.disabled.insert(port);
        runtime.preferences.manual.remove(&port);
        if let Some(tunnel) = runtime.tunnels.get_mut(&port) {
            tunnel.local_port = None;
            tunnel.state = TunnelState::Disabled;
        }
    } else {
        runtime.preferences.disabled.remove(&port);
        runtime.preferences.manual.insert(port);
        match start_forward(&runtime, port).await {
            Ok(local_port) => {
                if let Some(tunnel) = runtime.tunnels.get_mut(&port) {
                    tunnel.local_port = Some(local_port);
                    tunnel.state = TunnelState::Active;
                }
            }
            Err(error) => return (StatusCode::CONFLICT, error.to_string()).into_response(),
        }
    }
    if let Err(error) = write_preferences(&runtime.preferences_path, &runtime.preferences) {
        return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
    }
    publish_status(&runtime, &state.status).await;
    StatusCode::NO_CONTENT.into_response()
}

async fn api_reverse_toggle(
    State(state): State<AppState>,
    Path((remote_port, local_port)): Path<(u16, u16)>,
) -> Response {
    if remote_port < 1024 || local_port < 1024 {
        return (
            StatusCode::BAD_REQUEST,
            "ports must be between 1024 and 65535",
        )
            .into_response();
    }
    let mut runtime = state.runtime.lock().await;
    if remote_port == runtime.api_port {
        return (
            StatusCode::BAD_REQUEST,
            "the portd control port cannot be managed as a service reverse",
        )
            .into_response();
    }

    match runtime
        .preferences
        .reverse_forwards
        .get(&remote_port)
        .copied()
    {
        Some(existing_local) if existing_local == local_port => {
            let was_ready = runtime
                .service_reverse_ready
                .contains(&(remote_port, local_port));
            if was_ready
                && let Err(error) = cancel_reverse_forward(&runtime, remote_port, local_port).await
            {
                return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
            }
            let mut next = runtime.preferences.clone();
            next.reverse_forwards.remove(&remote_port);
            if let Err(error) = write_preferences(&runtime.preferences_path, &next) {
                if was_ready
                    && start_reverse_forward(&runtime, remote_port, local_port)
                        .await
                        .is_err()
                {
                    runtime
                        .service_reverse_ready
                        .remove(&(remote_port, local_port));
                }
                return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
            }
            runtime.preferences = next;
            runtime
                .service_reverse_ready
                .remove(&(remote_port, local_port));
        }
        Some(existing_local) => {
            return (
                StatusCode::CONFLICT,
                format!("Ubuntu port {remote_port} is already mapped to Mac port {existing_local}"),
            )
                .into_response();
        }
        None => {
            let mut next = runtime.preferences.clone();
            next.reverse_forwards.insert(remote_port, local_port);
            if let Err(error) = write_preferences(&runtime.preferences_path, &next) {
                return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
            }
            runtime.preferences = next;
        }
    }
    runtime.last_service_reverse_attempt = None;
    publish_status(&runtime, &state.status).await;
    let _ = state.wake.try_send(());
    StatusCode::NO_CONTENT.into_response()
}

async fn api_open(State(state): State<AppState>, Path(port): Path<u16>) -> Response {
    let runtime = state.runtime.lock().await;
    let Some(local_port) = runtime
        .tunnels
        .get(&port)
        .and_then(|tunnel| tunnel.local_port)
    else {
        return (StatusCode::NOT_FOUND, "port is not forwarded").into_response();
    };
    let url = format!("http://127.0.0.1:{local_port}");
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    match Command::new(opener).arg(&url).status().await {
        Ok(status) if status.success() => StatusCode::NO_CONTENT.into_response(),
        Ok(_) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "browser open command failed",
        )
            .into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

async fn api_label(
    State(state): State<AppState>,
    Path(port): Path<u16>,
    Json(payload): Json<LabelPayload>,
) -> Response {
    let mut runtime = state.runtime.lock().await;
    if !runtime.tunnels.contains_key(&port) {
        return (StatusCode::NOT_FOUND, "remote port is not listening").into_response();
    }
    let label = payload.label.trim();
    if label.chars().count() > 48 {
        return (
            StatusCode::BAD_REQUEST,
            "label must be 48 characters or fewer",
        )
            .into_response();
    }
    if label.is_empty() {
        runtime.preferences.labels.remove(&port);
    } else {
        runtime.preferences.labels.insert(port, label.to_string());
    }
    if let Err(error) = write_preferences(&runtime.preferences_path, &runtime.preferences) {
        return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
    }
    publish_status(&runtime, &state.status).await;
    StatusCode::NO_CONTENT.into_response()
}

async fn api_group(
    State(state): State<AppState>,
    Path(port): Path<u16>,
    Json(payload): Json<GroupPayload>,
) -> Response {
    let mut runtime = state.runtime.lock().await;
    if !runtime.tunnels.contains_key(&port) {
        return (StatusCode::NOT_FOUND, "remote port is not listening").into_response();
    }
    let group = payload.group.trim();
    if group.chars().count() > 32 {
        return (
            StatusCode::BAD_REQUEST,
            "group must be 32 characters or fewer",
        )
            .into_response();
    }

    let old_group = runtime
        .preferences
        .groups
        .get(&port)
        .cloned()
        .unwrap_or_default();
    if let Some(order) = runtime.preferences.port_order.get_mut(&old_group) {
        order.retain(|ordered_port| *ordered_port != port);
    }
    if group.is_empty() {
        runtime.preferences.groups.remove(&port);
    } else {
        runtime.preferences.groups.insert(port, group.to_string());
        if !runtime
            .preferences
            .group_order
            .iter()
            .any(|name| name == group)
        {
            runtime.preferences.group_order.push(group.to_string());
        }
    }
    let new_group = group.to_string();
    let order = runtime.preferences.port_order.entry(new_group).or_default();
    if !order.contains(&port) {
        order.push(port);
    }
    normalize_group_order(&mut runtime.preferences);

    if let Err(error) = write_preferences(&runtime.preferences_path, &runtime.preferences) {
        return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
    }
    publish_status(&runtime, &state.status).await;
    StatusCode::NO_CONTENT.into_response()
}

async fn api_move(
    State(state): State<AppState>,
    Path(port): Path<u16>,
    Json(payload): Json<MovePayload>,
) -> Response {
    let mut runtime = state.runtime.lock().await;
    if !runtime.tunnels.contains_key(&port) {
        return (StatusCode::NOT_FOUND, "remote port is not listening").into_response();
    }
    let direction = payload.direction.signum();
    if direction == 0 {
        return (StatusCode::BAD_REQUEST, "direction must be -1 or 1").into_response();
    }
    let result = match payload.scope.as_str() {
        "port" => move_port(&mut runtime, port, direction),
        "group" => move_group(&mut runtime.preferences, port, direction),
        _ => Err("scope must be port or group"),
    };
    if let Err(error) = result {
        return (StatusCode::BAD_REQUEST, error).into_response();
    }
    if let Err(error) = write_preferences(&runtime.preferences_path, &runtime.preferences) {
        return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
    }
    publish_status(&runtime, &state.status).await;
    StatusCode::NO_CONTENT.into_response()
}

async fn publish_status(runtime: &Runtime, status: &RwLock<DaemonStatus>) {
    let mut tunnels = runtime
        .tunnels
        .values()
        .map(|tunnel| TunnelStatus {
            remote_port: tunnel.listener.port,
            local_port: tunnel.local_port,
            label: runtime
                .preferences
                .labels
                .get(&tunnel.listener.port)
                .cloned()
                .unwrap_or_default(),
            group: runtime
                .preferences
                .groups
                .get(&tunnel.listener.port)
                .cloned()
                .unwrap_or_default(),
            process: tunnel.listener.process.clone(),
            state: tunnel.state,
        })
        .collect::<Vec<_>>();
    tunnels.sort_by_key(|tunnel| tunnel_sort_key(&runtime.preferences, tunnel));

    let configured_remote_ports = runtime
        .preferences
        .reverse_forwards
        .keys()
        .copied()
        .collect::<BTreeSet<_>>();
    let configured_local_ports = runtime
        .preferences
        .reverse_forwards
        .values()
        .copied()
        .collect::<BTreeSet<_>>();
    let mut reverse_tunnels = runtime
        .preferences
        .reverse_forwards
        .iter()
        .map(|(&remote_port, &local_port)| ReverseTunnelStatus {
            remote_port,
            local_port,
            process: runtime
                .local_listeners
                .get(&local_port)
                .map(|listener| listener.process.clone())
                .unwrap_or_default(),
            state: if runtime
                .service_reverse_ready
                .contains(&(remote_port, local_port))
            {
                TunnelState::Active
            } else {
                TunnelState::Error
            },
        })
        .collect::<Vec<_>>();
    reverse_tunnels.extend(
        runtime
            .local_listeners
            .values()
            .filter(|listener| {
                !configured_remote_ports.contains(&listener.port)
                    && !configured_local_ports.contains(&listener.port)
            })
            .map(|listener| ReverseTunnelStatus {
                remote_port: listener.port,
                local_port: listener.port,
                process: listener.process.clone(),
                state: TunnelState::Available,
            }),
    );
    reverse_tunnels.sort_by_key(|tunnel| (tunnel.remote_port, tunnel.local_port));

    *status.write().await = DaemonStatus {
        host: runtime.host.clone(),
        connected: runtime.connected,
        last_error: runtime.last_error.clone(),
        last_scan_ms: runtime.last_scan_ms,
        tunnels,
        reverse_tunnels,
    };
}

fn tunnel_sort_key(preferences: &Preferences, tunnel: &TunnelStatus) -> (usize, usize, u16) {
    let group_rank = if tunnel.group.is_empty() {
        usize::MAX
    } else {
        preferences
            .group_order
            .iter()
            .position(|group| group == &tunnel.group)
            .unwrap_or(usize::MAX - 1)
    };
    let port_rank = preferences
        .port_order
        .get(&tunnel.group)
        .and_then(|ports| ports.iter().position(|port| *port == tunnel.remote_port))
        .unwrap_or(usize::MAX);
    (group_rank, port_rank, tunnel.remote_port)
}

fn move_port(runtime: &mut Runtime, port: u16, direction: i8) -> Result<(), &'static str> {
    let group = runtime
        .preferences
        .groups
        .get(&port)
        .cloned()
        .unwrap_or_default();
    let mut visible_ports = runtime
        .tunnels
        .keys()
        .copied()
        .filter(|candidate| {
            runtime
                .preferences
                .groups
                .get(candidate)
                .map(String::as_str)
                .unwrap_or("")
                == group
        })
        .collect::<Vec<_>>();
    visible_ports.sort_by_key(|candidate| {
        runtime
            .preferences
            .port_order
            .get(&group)
            .and_then(|ports| ports.iter().position(|ordered| ordered == candidate))
            .unwrap_or(usize::MAX)
    });
    let order = runtime.preferences.port_order.entry(group).or_default();
    for visible_port in visible_ports {
        if !order.contains(&visible_port) {
            order.push(visible_port);
        }
    }
    let Some(index) = order.iter().position(|ordered| *ordered == port) else {
        return Err("port is not in its group order");
    };
    let target = index as isize + direction as isize;
    if target >= 0 && target < order.len() as isize {
        order.swap(index, target as usize);
    }
    Ok(())
}

fn move_group(preferences: &mut Preferences, port: u16, direction: i8) -> Result<(), &'static str> {
    let Some(group) = preferences.groups.get(&port).cloned() else {
        return Err("ungrouped ports do not have a movable group");
    };
    normalize_group_order(preferences);
    let Some(index) = preferences
        .group_order
        .iter()
        .position(|name| name == &group)
    else {
        return Err("group is not in the group order");
    };
    let target = index as isize + direction as isize;
    if target >= 0 && target < preferences.group_order.len() as isize {
        preferences.group_order.swap(index, target as usize);
    }
    Ok(())
}

fn normalize_group_order(preferences: &mut Preferences) {
    let used = preferences
        .groups
        .values()
        .cloned()
        .collect::<BTreeSet<_>>();
    preferences.group_order.retain(|group| used.contains(group));
    for group in used {
        if !preferences.group_order.contains(&group) {
            preferences.group_order.push(group);
        }
    }
}

async fn set_error(runtime: &Mutex<Runtime>, status: &RwLock<DaemonStatus>, error: String) {
    let mut runtime = runtime.lock().await;
    if runtime.connected || runtime.last_error.as_deref() != Some(error.as_str()) {
        eprintln!("portd disconnected from {}: {error}", runtime.host);
    }
    runtime.connected = false;
    runtime.last_error = Some(error);
    publish_status(&runtime, status).await;
}

fn retry_delay(base: Duration, maximum: Duration, failures: u32) -> Duration {
    let exponent = failures.saturating_sub(1).min(8);
    base.saturating_mul(1_u32 << exponent).min(maximum)
}

fn read_preferences(path: &PathBuf) -> Preferences {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|value| serde_json::from_str(&value).ok())
        .unwrap_or_default()
}

fn write_preferences(path: &PathBuf, preferences: &Preferences) -> anyhow::Result<()> {
    let content = serde_json::to_string_pretty(preferences)?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, content)?;
    std::fs::rename(temporary, path)?;
    Ok(())
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

async fn cleanup(runtime: Arc<Mutex<Runtime>>) {
    let mut runtime = runtime.lock().await;
    if master_healthy(&runtime).await {
        let _ = Command::new("ssh")
            .arg("-S")
            .arg(&runtime.control_path)
            .args(["-O", "exit"])
            .arg(&runtime.host)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    if let Some(mut child) = runtime.master.take() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    let _ = std::fs::remove_file(&runtime.control_path);
}

async fn shutdown_signal() -> anyhow::Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result?,
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ipv4_ipv6_and_processes() {
        let output = concat!(
            "LISTEN 0 511 127.0.0.1:6379 0.0.0.0:*\n",
            "LISTEN 0 4096 0.0.0.0:8000 0.0.0.0:* users:((\"php8.5\",pid=1,fd=7))\n",
            "LISTEN 0 4096 [::]:5173 [::]:* users:((\"node\",pid=2,fd=8))\n",
            "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*\n",
        );
        let ports = parse_listeners(output);
        assert_eq!(
            ports.keys().copied().collect::<Vec<_>>(),
            vec![5173, 6379, 8000]
        );
        assert_eq!(ports[&5173].process, "node");
        assert_eq!(ports[&8000].process, "php8.5");
    }

    #[test]
    fn parses_lsof_listener_fields() {
        let output = concat!(
            "p123\n",
            "cBrowser Control\n",
            "n127.0.0.1:19989\n",
            "p456\n",
            "cadb\n",
            "n127.0.0.1:5037\n",
            "n[::1]:5037\n",
            "p789\n",
            "cipv6-only\n",
            "n[::1]:6000\n",
            "p790\n",
            "clan-only\n",
            "n192.168.1.12:7000\n",
            "p791\n",
            "csshd\n",
            "n*:22\n",
        );
        let ports = parse_lsof_listeners(output);
        assert_eq!(ports.keys().copied().collect::<Vec<_>>(), vec![5037, 19989]);
        assert_eq!(ports[&5037].process, "adb");
        assert_eq!(ports[&19989].process, "Browser Control");
    }

    #[test]
    fn rejects_a_port_with_an_existing_listener() {
        let listener = TcpListener::bind(("0.0.0.0", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!port_available(port));
    }

    #[test]
    fn rejects_a_port_with_an_ipv6_listener() {
        let listener = TcpListener::bind((Ipv6Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(!port_available(port));
    }

    #[test]
    fn retry_delay_backs_off_and_caps() {
        let base = Duration::from_secs(2);
        let maximum = Duration::from_secs(30);
        assert_eq!(retry_delay(base, maximum, 1), Duration::from_secs(2));
        assert_eq!(retry_delay(base, maximum, 4), Duration::from_secs(16));
        assert_eq!(retry_delay(base, maximum, 20), Duration::from_secs(30));
    }
}
