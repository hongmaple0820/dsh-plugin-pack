use std::path::PathBuf;

use clap::Parser;

#[derive(Debug, Parser)]
#[command(name = "dsh-cicd-runner", version, about = "dsh-cicd remote build runner (Runner Protocol v2)")]
pub struct Args {
    /// Base URL of the dsh-cicd server, e.g. https://cicd.example.com
    #[arg(long)]
    pub server: String,

    /// Runner id to register as
    #[arg(long = "runner")]
    pub runner_id: String,

    /// Join token issued by the server
    #[arg(long = "join-token")]
    pub join_token: String,

    /// Comma-separated labels, e.g. "linux,docker"
    #[arg(long, default_value = "")]
    pub labels: String,

    /// How many tasks this runner may accept in parallel (M1: 1 slot used)
    #[arg(long, default_value_t = 1)]
    pub capacity: u32,

    /// Working directory for task workspaces, credentials and journal
    #[arg(long, default_value = "./runner-work")]
    pub workdir: PathBuf,

    /// Accept self-signed / invalid TLS certificates
    #[arg(long)]
    pub insecure: bool,

    /// Claim and run a single task, then exit (for testing)
    #[arg(long)]
    pub once: bool,
}
