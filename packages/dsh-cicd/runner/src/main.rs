use clap::Parser;
use dsh_cicd_runner::{app, cli};

#[tokio::main]
async fn main() {
    let args = cli::Args::parse();
    let code = app::run(args).await;
    if code != 0 {
        eprintln!("[runner] exiting with code {code}");
    }
    std::process::exit(code);
}
