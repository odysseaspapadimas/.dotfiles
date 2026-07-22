use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonStatus {
    pub host: String,
    pub connected: bool,
    pub last_error: Option<String>,
    pub last_scan_ms: Option<u128>,
    pub tunnels: Vec<TunnelStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TunnelStatus {
    pub remote_port: u16,
    pub local_port: Option<u16>,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub group: String,
    pub process: String,
    pub state: TunnelState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TunnelState {
    Active,
    Available,
    Disabled,
    Error,
}

impl TunnelState {
    pub fn label(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Available => "manual",
            Self::Disabled => "disabled",
            Self::Error => "error",
        }
    }
}
