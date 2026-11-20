//! HTTP client for Runner Protocol v2 endpoints.

use std::fmt;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::protocol::*;

/// Long-poll wait used for every /claim request.
pub const CLAIM_WAIT_MS: u64 = 25_000;

/// Extra time granted to /claim on top of its waitMs before the HTTP call fails.
pub const CLAIM_TIMEOUT_MARGIN: Duration = Duration::from_secs(15);

#[derive(Debug)]
pub enum ClientError {
    Network(String),
    Api { status: u16, code: String, error: String },
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClientError::Network(m) => write!(f, "network error: {m}"),
            ClientError::Api { status, code, error } => {
                write!(f, "api error {status} code={code}: {error}")
            }
        }
    }
}
impl std::error::Error for ClientError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    /// Transient (network / 5xx): retry with backoff.
    Retryable,
    /// Server answered definitively (400/401/403): retrying cannot help.
    Fatal,
}

pub fn classify(err: &ClientError) -> FailureKind {
    match err {
        ClientError::Network(_) => FailureKind::Retryable,
        ClientError::Api { status, .. } => {
            if *status >= 500 {
                FailureKind::Retryable
            } else {
                FailureKind::Fatal
            }
        }
    }
}

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    base: String,
    runner_id: String,
    token: Option<String>,
}

impl Client {
    pub fn new(server: &str, runner_id: String, insecure: bool) -> anyhow::Result<Self> {
        // NOTE: this build of reqwest has no TLS feature enabled (see Cargo.toml),
        // so the runner speaks plain HTTP only. `insecure` is accepted and ignored.
        let _ = insecure;
        let builder = reqwest::Client::builder();
        let http = builder.build()?;
        let base = format!(
            "{}/{}",
            server.trim_end_matches('/'),
            PROTOCOL_BASE_SUFFIX.trim_start_matches('/')
        );
        Ok(Self {
            http,
            base,
            runner_id,
            token: None,
        })
    }

    pub fn set_token(&mut self, token: String) {
        self.token = Some(token);
    }

    /// Clone sharing the same HTTP connection pool and credentials (for worker tasks).
    pub fn clone_for_task(&self) -> Client {
        self.clone()
    }

    pub fn runner_id(&self) -> &str {
        &self.runner_id
    }

    async fn post<T: DeserializeOwned>(
        &self,
        endpoint: &str,
        body: &impl Serialize,
        auth: bool,
    ) -> Result<T, ClientError> {
        self.post_with_timeout(endpoint, body, auth, None).await
    }

    async fn post_with_timeout<T: DeserializeOwned>(
        &self,
        endpoint: &str,
        body: &impl Serialize,
        auth: bool,
        timeout: Option<Duration>,
    ) -> Result<T, ClientError> {
        let url = format!("{}/{endpoint}", self.base);
        let mut req = self.http.post(&url).json(body);
        if let Some(t) = timeout {
            req = req.timeout(t);
        }
        if auth {
            req = req.bearer_auth(self.token.as_deref().unwrap_or(""));
        }
        let resp = req
            .send()
            .await
            .map_err(|e| ClientError::Network(e.to_string()))?;
        let status = resp.status().as_u16();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ClientError::Network(e.to_string()))?;
        if (200..300).contains(&status) {
            serde_json::from_slice(&bytes)
                .map_err(|e| ClientError::Network(format!("invalid response body: {e}")))
        } else {
            let api: ApiErrorBody =
                serde_json::from_slice(&bytes).unwrap_or_default();
            Err(ClientError::Api {
                status,
                code: api.code.unwrap_or_default(),
                error: api.error.unwrap_or_default(),
            })
        }
    }

    pub async fn register(&self, req: &RegisterRequest) -> Result<RegisterResponse, ClientError> {
        self.post("register", req, false).await
    }

    pub async fn heartbeat(&self) -> Result<HeartbeatResponse, ClientError> {
        self.post(
            "heartbeat",
            &HeartbeatRequest {
                runner_id: self.runner_id.clone(),
            },
            true,
        )
        .await
    }

    /// Long-poll claim. The HTTP timeout must outlive the server-side long poll,
    /// so it is derived from `wait_ms` here instead of on the shared client.
    pub async fn claim(&self, wait_ms: u64) -> Result<ClaimResponse, ClientError> {
        self.post_with_timeout(
            "claim",
            &ClaimRequest {
                runner_id: self.runner_id.clone(),
                wait_ms,
            },
            true,
            Some(Duration::from_millis(wait_ms) + CLAIM_TIMEOUT_MARGIN),
        )
        .await
    }

    pub async fn logs(&self, req: &LogsRequest) -> Result<LogsResponse, ClientError> {
        self.post("logs", req, true).await
    }

    pub async fn complete(&self, req: &CompleteRequest) -> Result<CompleteResponse, ClientError> {
        self.post("complete", req, true).await
    }
}

/// Exponential backoff: 1s, 2s, 4s ... capped at 30s.
pub struct Backoff {
    delay: Duration,
    max: Duration,
}

impl Backoff {
    pub fn new() -> Self {
        Self {
            delay: Duration::from_secs(1),
            max: Duration::from_secs(30),
        }
    }

    pub fn reset(&mut self) {
        self.delay = Duration::from_secs(1);
    }

    pub async fn sleep(&mut self) {
        let d = self.delay;
        tokio::time::sleep(d).await;
        self.delay = std::cmp::min(self.delay.saturating_mul(2), self.max);
    }
}

impl Default for Backoff {
    fn default() -> Self {
        Self::new()
    }
}
