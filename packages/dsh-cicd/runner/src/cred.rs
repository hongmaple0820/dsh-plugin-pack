//! M3 短期凭据：任务体只带名字（secretRefs / secretEnv），值走 POST /credentials，
//! 只并入子进程 env —— 不落盘、不进日志、不进 complete 的 error 文本。

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::client::{Client, ClientError};
use crate::protocol::{CredentialsRequest, SecretEnvRef};

/// 过期时刻早于「下一步开始时刻 + 这个余量」时就重换。
pub const REFRESH_MARGIN_MS: i64 = 30_000;

/// 当前时间：epoch 毫秒。
pub fn now_ms() -> i64 {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    dur.as_millis() as i64
}

/// YYYY-MM-DDTHH:MM:SS[.fff]Z -> epoch 毫秒。只接受 UTC（Z 或无后缀）；
/// 解析不了返回 None，调用方按「服务端没给过期时刻」处理。
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    if b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let y: i64 = s.get(0..4)?.parse().ok()?;
    let mo: i64 = s.get(5..7)?.parse().ok()?;
    let d: i64 = s.get(8..10)?.parse().ok()?;
    let h: i64 = s.get(11..13)?.parse().ok()?;
    let mi: i64 = s.get(14..16)?.parse().ok()?;
    let se: i64 = s.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }

    let mut rest = &s[19..];
    let mut frac_ms = 0i64;
    if let Some(after) = rest.strip_prefix('.') {
        let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            return None;
        }
        let mut ms = digits.chars().take(3).collect::<String>();
        while ms.len() < 3 {
            ms.push('0');
        }
        frac_ms = ms.parse().ok()?;
        rest = &after[digits.len()..];
    }
    if !matches!(rest, "" | "Z" | "z") {
        return None;
    }

    let days = days_from_civil(y, mo, d);
    Some(days * 86_400_000 + (h * 3600 + mi * 60 + se) * 1000 + frac_ms)
}

/// Howard Hinnant 的 days_from_civil：与 util::civil_from_days 互逆。
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 一个任务的凭据：名字 -> 值，外加过期时刻。换任务必须丢弃旧值。
#[derive(Debug, Default)]
pub struct CredCache {
    task_id: String,
    values: HashMap<String, String>,
    expires_at_ms: Option<i64>,
    loaded: bool,
}

impl CredCache {
    pub fn new(task_id: &str) -> Self {
        Self {
            task_id: task_id.to_string(),
            ..Default::default()
        }
    }

    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    /// 换任务就清空：上一个任务的值绝不能被下一个任务复用。
    pub fn bind_task(&mut self, task_id: &str) {
        if self.task_id != task_id {
            *self = Self::new(task_id);
        }
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded
    }

    /// 值在这个时刻还有效吗：剩的 TTL 不到 REFRESH_MARGIN_MS 就算该换。
    pub fn needs_refresh(&self, now_ms: i64) -> bool {
        if !self.loaded {
            return true;
        }
        match self.expires_at_ms {
            Some(exp) => exp <= now_ms + REFRESH_MARGIN_MS,
            // 服务端没给过期时刻：本任务内不再重换。
            None => false,
        }
    }

    pub fn store(&mut self, values: HashMap<String, String>, expires_at: &str) {
        self.values = values;
        self.expires_at_ms = parse_iso_ms(expires_at);
        self.loaded = true;
    }

    /// 只注入被声明过的键：先 secretRefs 同名注入，再按 secretEnv 映射注入
    /// （同名时以映射的 ref 值为准）。没拿到值的键一律移除，绝不留下旧值。
    pub fn apply(
        &self,
        refs: &[String],
        secret_env: &[SecretEnvRef],
        env: &mut HashMap<String, String>,
    ) {
        for name in refs {
            match self.values.get(name) {
                Some(v) => {
                    env.insert(name.clone(), v.clone());
                }
                None => {
                    env.remove(name);
                }
            }
        }
        for entry in secret_env {
            match self.values.get(&entry.reference) {
                Some(v) => {
                    env.insert(entry.env.clone(), v.clone());
                }
                None => {
                    env.remove(&entry.env);
                }
            }
        }
    }

    /// /credentials 的 names：secretRefs 加上 secretEnv 引用到的名字（保序去重）。
    pub fn request_names(refs: &[String], secret_env: &[SecretEnvRef]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let all = refs
            .iter()
            .map(|n| n.as_str())
            .chain(secret_env.iter().map(|e| e.reference.as_str()));
        for n in all {
            if !out.iter().any(|x| x == n) {
                out.push(n.to_string());
            }
        }
        out
    }

    /// 需要时换一次值，并把它落进 env。返回 true 表示这次真的换了。
    /// 失败返回「凭据获取失败：<code>」，调用方必须让任务 failed（fail closed）。
    pub async fn ensure(
        &mut self,
        client: &Client,
        refs: &[String],
        secret_env: &[SecretEnvRef],
        env: &mut HashMap<String, String>,
    ) -> Result<bool, String> {
        let names = Self::request_names(refs, secret_env);
        if names.is_empty() {
            return Ok(false);
        }
        if !self.needs_refresh(now_ms()) {
            return Ok(false);
        }
        let req = CredentialsRequest {
            runner_id: client.runner_id().to_string(),
            task_id: self.task_id.clone(),
            names,
        };
        let resp = client
            .credentials(&req)
            .await
            .map_err(|e| format!("凭据获取失败：{}", failure_code(&e)))?;
        self.store(resp.values, &resp.expires_at);
        self.apply(refs, secret_env, env);
        Ok(true)
    }
}

/// 失败原因里的 code：优先用协议里的 code，没有就退到 HTTP 状态 / NETWORK。
pub fn failure_code(err: &ClientError) -> String {
    match err {
        ClientError::Api { code, .. } if !code.is_empty() => code.clone(),
        ClientError::Api { status, .. } => format!("HTTP_{status}"),
        ClientError::Network(_) => "NETWORK".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXPIRES: &str = "2026-11-21T10:00:00.000Z";

    fn vals(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn map(env: &str, reference: &str) -> SecretEnvRef {
        SecretEnvRef {
            env: env.to_string(),
            reference: reference.to_string(),
        }
    }

    #[test]
    fn iso_parses_to_epoch_ms() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_iso_ms("2024-02-29T12:34:56.789Z"),
            Some(1_709_210_096_789)
        );
        assert_eq!(parse_iso_ms("2026-11-21T10:00:00Z"), parse_iso_ms(EXPIRES));
        assert_eq!(
            parse_iso_ms("2026-11-21T10:00:00.5Z"),
            parse_iso_ms("2026-11-21T10:00:00.500Z")
        );
        assert_eq!(parse_iso_ms(""), None);
        assert_eq!(parse_iso_ms("not-a-time"), None);
        assert_eq!(parse_iso_ms("2026-11-21T10:00:00.000+08:00"), None);
    }

    /// 与 util::iso_now 对账：civil 天数换算必须和 runner 自己的时钟一致。
    #[test]
    fn iso_now_round_trips() {
        let now = now_ms();
        let parsed = parse_iso_ms(&crate::util::iso_now()).expect("iso_now parses");
        assert!((parsed - now).abs() < 5_000, "parsed={parsed} now={now}");
    }

    /// TTL 内不重换；只剩不到 30s 余量（含边界）就重换。
    #[test]
    fn ttl_decides_refresh() {
        let exp = parse_iso_ms(EXPIRES).expect("expires");
        let mut cache = CredCache::new("t-1");
        assert!(cache.needs_refresh(0), "未加载时必须换一次");

        cache.store(vals(&[("TOKEN", "s3cr3t")]), EXPIRES);
        // 还有 10 分钟：不重换。
        assert!(!cache.needs_refresh(exp - 600_000));
        // 余量边界：剩 30.001s 不换；剩 30s / 29.999s 换。
        assert!(!cache.needs_refresh(exp - REFRESH_MARGIN_MS - 1));
        assert!(cache.needs_refresh(exp - REFRESH_MARGIN_MS));
        assert!(cache.needs_refresh(exp - REFRESH_MARGIN_MS + 1));
        // 已过期：换。
        assert!(cache.needs_refresh(exp + 1));
    }

    #[test]
    fn missing_expires_at_never_refreshes() {
        let mut cache = CredCache::new("t-1");
        cache.store(vals(&[("TOKEN", "v")]), "");
        assert!(!cache.needs_refresh(i64::MAX / 2));
    }

    #[test]
    fn values_are_scoped_to_one_task() {
        let mut cache = CredCache::new("t-1");
        cache.store(vals(&[("TOKEN", "v1")]), EXPIRES);
        assert!(cache.is_loaded());

        cache.bind_task("t-2");
        assert!(!cache.is_loaded(), "换任务必须丢弃上一个任务的值");
        assert_eq!(cache.task_id(), "t-2");

        cache.store(vals(&[("TOKEN", "v2")]), EXPIRES);
        cache.bind_task("t-2");
        assert!(cache.is_loaded(), "同一任务再 bind 不清空");
    }

    /// /credentials 的 names 是 secretRefs 与 secretEnv 引用的并集。
    #[test]
    fn request_names_is_the_union() {
        let refs = vec!["TOKEN".to_string(), "API_KEY".to_string()];
        let secret_env = vec![map("DB_PASSWORD", "DB_PASSWORD"), map("X", "TOKEN")];
        assert_eq!(
            CredCache::request_names(&refs, &secret_env),
            vec![
                "TOKEN".to_string(),
                "API_KEY".to_string(),
                "DB_PASSWORD".to_string()
            ]
        );
        assert!(CredCache::request_names(&[], &[]).is_empty());
    }

    /// 先同名注入、再按映射注入；未声明 / 未拿到的键不进 env，旧值要清掉。
    #[test]
    fn apply_injects_only_declared_keys() {
        let mut cache = CredCache::new("t-1");
        cache.store(
            vals(&[
                ("TOKEN", "v1"),
                ("DB_PASSWORD", "pw"),
                ("OTHER", "secret"),
            ]),
            EXPIRES,
        );

        let mut env = vals(&[("CI", "1"), ("STALE", "old")]);
        let refs = vec!["TOKEN".to_string(), "STALE".to_string()];
        let secret_env = vec![map("DB_PASSWORD", "DB_PASSWORD")];
        cache.apply(&refs, &secret_env, &mut env);

        assert_eq!(env.get("TOKEN").map(String::as_str), Some("v1"));
        assert_eq!(env.get("DB_PASSWORD").map(String::as_str), Some("pw"));
        assert_eq!(env.get("CI").map(String::as_str), Some("1"), "其它 env 不受影响");
        assert!(!env.contains_key("OTHER"), "没声明过的凭据不进 env");
        assert!(!env.contains_key("STALE"), "没拿到值的键必须清掉");
    }

    /// 同一个 env 键被映射覆盖时，以 secretEnv 的 ref 值为准。
    #[test]
    fn secret_env_mapping_wins_over_same_name() {
        let mut cache = CredCache::new("t-1");
        cache.store(vals(&[("TOKEN", "direct"), ("REAL", "mapped")]), EXPIRES);

        let mut env = HashMap::new();
        cache.apply(&["TOKEN".to_string()], &[map("TOKEN", "REAL")], &mut env);
        assert_eq!(env.get("TOKEN").map(String::as_str), Some("mapped"));
    }

    #[test]
    fn failure_code_prefers_protocol_code() {
        assert_eq!(
            failure_code(&ClientError::Api {
                status: 401,
                code: "RUNNER_TOKEN_INVALID".into(),
                error: "token invalid".into()
            }),
            "RUNNER_TOKEN_INVALID"
        );
        assert_eq!(
            failure_code(&ClientError::Api {
                status: 503,
                code: String::new(),
                error: "nope".into()
            }),
            "HTTP_503"
        );
        assert_eq!(failure_code(&ClientError::Network("boom".into())), "NETWORK");
    }
}
