//! HTTP client for Runner Protocol v2 endpoints.

use std::fmt;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::protocol::*;

/// Long-poll wait used for every /claim request.
pub const CLAIM_WAIT_MS: u64 = 25_000;

/// Extra time granted to /claim on top of its waitMs before the HTTP call fails.
pub const CLAIM_TIMEOUT_MARGIN: Duration = Duration::from_secs(15);
/// 缓存字节端点（lookup/blob）的单次请求上限：缓存是加速层，不能把任务拖住。
pub const CACHE_HTTP_TIMEOUT: Duration = Duration::from_secs(120);

/// 制品上传回执（宿主 PUT /artifacts 的响应；protocol.rs 冻结，DTO 放在客户端侧）。
#[derive(Debug, Clone, Deserialize)]
pub struct ArtifactSaveResponse {
    #[allow(dead_code)]
    pub ok: bool,
    #[allow(dead_code)]
    pub name: String,
    pub digest: String,
    pub bytes: u64,
    #[allow(dead_code)]
    #[serde(default)]
    pub deduped: bool,
}

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
            Err(api_error(status, &bytes))
        }
    }

    /// 字节端点的 GET：2xx 回裸字节，非 2xx 走同一套 api 错误映射。
    async fn get_bytes(&self, endpoint: &str, query: &[(&str, &str)]) -> Result<Vec<u8>, ClientError> {
        let url = format!("{}/{endpoint}", self.base);
        let resp = self
            .http
            .get(&url)
            .query(query)
            .bearer_auth(self.token.as_deref().unwrap_or(""))
            .timeout(CACHE_HTTP_TIMEOUT)
            .send()
            .await
            .map_err(|e| ClientError::Network(e.to_string()))?;
        let status = resp.status().as_u16();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| ClientError::Network(e.to_string()))?;
        if (200..300).contains(&status) {
            Ok(bytes.to_vec())
        } else {
            Err(api_error(status, &bytes))
        }
    }

    /// 字节端点的 PUT（裸 body）：2xx 解析 JSON 回执，非 2xx 走同一套映射。
    async fn put_bytes<T: DeserializeOwned>(
        &self,
        endpoint: &str,
        query: &[(&str, &str)],
        body: Vec<u8>,
    ) -> Result<T, ClientError> {
        let url = format!("{}/{endpoint}", self.base);
        let resp = self
            .http
            .put(&url)
            .query(query)
            .bearer_auth(self.token.as_deref().unwrap_or(""))
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .timeout(CACHE_HTTP_TIMEOUT)
            .body(body)
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
            Err(api_error(status, &bytes))
        }
    }

    pub async fn register(&self, req: &RegisterRequest) -> Result<RegisterResponse, ClientError> {
        self.post("register", req, false).await
    }

    pub async fn heartbeat(&self, stats: Option<RunnerStats>) -> Result<HeartbeatResponse, ClientError> {
        self.post(
            "heartbeat",
            &HeartbeatRequest {
                runner_id: self.runner_id.clone(),
                stats,
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

    /// M3 缓存查询：命中回指针，未命中回 hit=false（缓存层自行 fail-open）。
    pub async fn cache_lookup(
        &self,
        req: &CacheLookupRequest,
    ) -> Result<CacheLookupResponse, ClientError> {
        self.post("cache/lookup", req, true).await
    }

    /// GET /cache/blob：下载缓存 tar.gz 裸字节。
    pub async fn cache_download(
        &self,
        runner_id: &str,
        task_id: &str,
        digest: &str,
    ) -> Result<Vec<u8>, ClientError> {
        self.get_bytes(
            "cache/blob",
            &[("runnerId", runner_id), ("taskId", task_id), ("digest", digest)],
        )
        .await
    }

    /// PUT /cache/blob：上传缓存 tar.gz 裸字节。
    pub async fn cache_upload(
        &self,
        runner_id: &str,
        task_id: &str,
        key: &str,
        bytes: Vec<u8>,
    ) -> Result<CacheSaveResponse, ClientError> {
        self.put_bytes(
            "cache/blob",
            &[("runnerId", runner_id), ("taskId", task_id), ("key", key)],
            bytes,
        )
        .await
    }

    /// PUT /artifacts/:taskId/:name：上传制品 tar.gz 裸字节，回执带 digest。
    pub async fn artifact_upload(
        &self,
        runner_id: &str,
        task_id: &str,
        name: &str,
        bytes: Vec<u8>,
    ) -> Result<ArtifactSaveResponse, ClientError> {
        self.put_bytes(
            &format!("artifacts/{task_id}/{name}"),
            &[("runnerId", runner_id)],
            bytes,
        )
        .await
    }

    /// M3 短期凭据：用名字换值。ok=false 时合成一个 Api 错误（这个响应体没有
    /// code/error 字段），调用方据此 fail closed，并停止重试 token 失效类错误。
    pub async fn credentials(
        &self,
        req: &CredentialsRequest,
    ) -> Result<CredentialsResponse, ClientError> {
        let resp: CredentialsResponse = self.post("credentials", req, true).await?;
        if !resp.ok {
            return Err(ClientError::Api {
                status: 200,
                code: "CREDENTIALS_REJECTED".to_string(),
                error: "credentials request rejected".to_string(),
            });
        }
        Ok(resp)
    }
}

/// 统一把非 2xx 的响应体映射成 Api 错误（json 端点与字节端点共用）。
fn api_error(status: u16, bytes: &[u8]) -> ClientError {
    let api: ApiErrorBody = serde_json::from_slice(bytes).unwrap_or_default();
    ClientError::Api {
        status,
        code: api.code.unwrap_or_default(),
        error: api.error.unwrap_or_default(),
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
