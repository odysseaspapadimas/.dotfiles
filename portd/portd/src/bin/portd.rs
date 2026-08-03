use std::path::PathBuf;

use clap::Parser;
use portd::daemon;

#[derive(Debug, Parser)]
#[command(
    name = "portd",
    about = "Automatic SSH development-port forwarding daemon"
)]
struct Args {
    #[arg(long, default_value = "ubuntu", env = "PORTD_HOST")]
    host: String,

    #[arg(long, default_value_t = 43117, env = "PORTD_API_PORT")]
    api_port: u16,

    #[arg(long, default_value_t = 2, env = "PORTD_INTERVAL")]
    interval: u64,

    #[arg(long, default_value_t = 15, env = "PORTD_IDLE_INTERVAL")]
    idle_interval: u64,

    #[arg(long, default_value_t = 300, env = "PORTD_MAX_BACKOFF")]
    max_backoff: u64,

    #[arg(long, default_value_t = 10000, env = "PORTD_MAX_AUTO_PORT")]
    max_auto_port: u16,

    /// Persistent reverse-forward seeds as UBUNTU_PORT:MAC_PORT. Repeat the
    /// flag or use a comma-separated PORTD_REVERSE_FORWARDS value.
    #[arg(
        long = "reverse-forward",
        env = "PORTD_REVERSE_FORWARDS",
        value_delimiter = ',',
        value_parser = parse_reverse_forward
    )]
    reverse_forwards: Vec<(u16, u16)>,

    #[arg(long)]
    control_path: Option<PathBuf>,
}

fn parse_reverse_forward(value: &str) -> Result<(u16, u16), String> {
    let (remote, local) = value
        .split_once(':')
        .ok_or_else(|| "expected REMOTE_PORT:LOCAL_PORT".to_string())?;
    let remote = remote
        .parse::<u16>()
        .map_err(|_| format!("invalid remote port: {remote}"))?;
    let local = local
        .parse::<u16>()
        .map_err(|_| format!("invalid local port: {local}"))?;
    if remote == 0 || local == 0 {
        return Err("ports must be greater than zero".to_string());
    }
    Ok((remote, local))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    daemon::run(daemon::Config {
        host: args.host,
        api_port: args.api_port,
        interval_secs: args.interval,
        idle_interval_secs: args.idle_interval,
        max_backoff_secs: args.max_backoff,
        max_auto_port: args.max_auto_port,
        reverse_forwards: args.reverse_forwards,
        control_path: args.control_path,
    })
    .await
}
