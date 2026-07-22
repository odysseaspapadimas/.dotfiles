use clap::Parser;
use portd::tui;

#[derive(Debug, Parser)]
#[command(name = "ports", about = "View and control portd tunnels")]
struct Args {
    #[arg(long, default_value = "http://127.0.0.1:43117", env = "PORTD_URL")]
    server: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tui::run(tui::Config {
        server: args().server,
    })
    .await
}

fn args() -> Args {
    Args::parse()
}
