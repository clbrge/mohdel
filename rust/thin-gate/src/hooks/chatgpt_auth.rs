//! `ChatGptAuth`: `chatgpt/` from the host's signed-in ChatGPT account,
//! through mohdel's own helper (`mohdel/chatgpt/bin`); every other provider
//! from `LocalAuth`.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde::Deserialize;
use tokio::process::Command;
use tokio::sync::Mutex;
use zeroize::Zeroize;

use super::auth::{AuthError, AuthPolicy};
use super::local_auth::LocalAuth;
use crate::protocol::{provider_of, Auth};
use crate::secret::SecretString;
use crate::session_pool::is_forwarded;

/// Above the helper's own worst case: 35 s waiting on the store lock, then
/// 30 s on the token request.
const HELPER_TIMEOUT: Duration = Duration::from_secs(70);

/// Runs the helper when the cached token reaches the helper's `refreshAt`;
/// refreshing the token is the helper's job, under the store's lock.
pub struct ChatGptAuth {
    local: LocalAuth,
    node: PathBuf,
    helper: PathBuf,
    account: Option<String>,
    timeout: Duration,
    cached: Mutex<Option<Access>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Access {
    access_token: SecretString,
    refresh_at: u64,
}

impl ChatGptAuth {
    /// `helper` is the path of `mohdel/chatgpt/bin`, run with `node`.
    /// `account: None` follows the account `mo chatgpt select` made active.
    pub fn new(local: LocalAuth, node: PathBuf, helper: PathBuf, account: Option<String>) -> Self {
        Self {
            local,
            node,
            helper,
            account,
            timeout: HELPER_TIMEOUT,
            cached: Mutex::new(None),
        }
    }

    async fn token(&self) -> Result<SecretString, AuthError> {
        let mut cached = self.cached.lock().await;
        if let Some(access) = cached.as_ref().filter(|a| now_ms() < a.refresh_at) {
            return Ok(access.access_token.clone());
        }
        let access = self.fetch().await?;
        let token = access.access_token.clone();
        *cached = Some(access);
        Ok(token)
    }

    async fn fetch(&self) -> Result<Access, AuthError> {
        let helper = self.helper.display();
        let mut cmd = Command::new(&self.node);
        cmd.arg(&self.helper).arg("access");
        if let Some(id) = &self.account {
            cmd.arg("--account").arg(id);
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .env_clear()
            .envs(std::env::vars_os().filter(|(key, _)| helper_env(key)));

        let child = cmd.spawn().map_err(|e| {
            AuthError::Other(format!(
                "chatgpt — cannot start {} {helper}: {e}",
                self.node.display()
            ))
        })?;
        let mut output = match tokio::time::timeout(self.timeout, child.wait_with_output()).await {
            Ok(result) => {
                result.map_err(|e| AuthError::Other(format!("chatgpt — {helper}: {e}")))?
            }
            Err(_) => {
                return Err(AuthError::Other(format!(
                    "chatgpt — {helper} did not answer within {:?} and was killed",
                    self.timeout
                )))
            }
        };

        if !output.status.success() {
            output.stdout.zeroize();
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(AuthError::ProviderNotConfigured(if message.is_empty() {
                format!("chatgpt — {helper} exited with {}", output.status)
            } else {
                format!("chatgpt — {message}")
            }));
        }
        let access = serde_json::from_slice::<Access>(&output.stdout);
        output.stdout.zeroize();
        access.map_err(|_| AuthError::Other(format!("chatgpt — {helper} printed no access token")))
    }
}

#[async_trait]
impl AuthPolicy for ChatGptAuth {
    async fn resolve(&self, auth_id: &str, model: &str) -> Result<Auth, AuthError> {
        if provider_of(model) != "chatgpt" {
            return self.local.resolve(auth_id, model).await;
        }
        Ok(Auth {
            key: self.token().await?,
        })
    }
}

/// What a session gets, plus what `env-paths` reads to find the store.
fn helper_env(key: &OsString) -> bool {
    key.to_str().is_some_and(|key| {
        is_forwarded(key)
            || key.starts_with("XDG_")
            || matches!(key, "APPDATA" | "LOCALAPPDATA" | "USERPROFILE")
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    static SEQ: AtomicUsize = AtomicUsize::new(0);

    const FAR: u64 = 32_503_680_000_000;

    struct Fixture {
        dir: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "mohdel-chatgpt-auth-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self { dir }
        }

        fn helper(&self, body: &str) -> PathBuf {
            let path = self.dir.join("helper.sh");
            let runs = self.dir.join("runs");
            std::fs::write(
                &path,
                format!("echo \"$@\" >> '{}'\n{body}\n", runs.display()),
            )
            .unwrap();
            path
        }

        fn policy(&self, body: &str, account: Option<&str>) -> ChatGptAuth {
            ChatGptAuth::new(
                self.local(),
                PathBuf::from("/bin/sh"),
                self.helper(body),
                account.map(String::from),
            )
        }

        fn local(&self) -> LocalAuth {
            let file = self.dir.join("environment");
            std::fs::write(&file, "META_API_SK=file-key\n").unwrap();
            LocalAuth::with_env(&file, |_| None).unwrap()
        }

        fn runs(&self) -> Vec<String> {
            match std::fs::read_to_string(self.dir.join("runs")) {
                Ok(text) => text.lines().map(String::from).collect(),
                Err(_) => Vec::new(),
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn answers(token: &str, refresh_at: u64) -> String {
        format!("printf '{{\"accessToken\":\"{token}\",\"refreshAt\":{refresh_at}}}'")
    }

    async fn key(auth: &ChatGptAuth, model: &str) -> String {
        auth.resolve("local", model)
            .await
            .unwrap()
            .key
            .expose()
            .to_string()
    }

    async fn error(auth: &ChatGptAuth) -> AuthError {
        auth.resolve("local", "chatgpt/gpt-x").await.unwrap_err()
    }

    #[tokio::test]
    async fn reuses_the_token_until_refresh_at() {
        let fx = Fixture::new();
        let auth = fx.policy(&answers("tok", FAR), None);
        assert_eq!(key(&auth, "chatgpt/gpt-x").await, "tok");
        assert_eq!(key(&auth, "chatgpt/gpt-y").await, "tok");
        assert_eq!(fx.runs(), vec!["access"]);
    }

    #[tokio::test]
    async fn asks_again_once_refresh_at_has_passed() {
        let fx = Fixture::new();
        let auth = fx.policy(&answers("tok", 1), None);
        key(&auth, "chatgpt/gpt-x").await;
        key(&auth, "chatgpt/gpt-x").await;
        assert_eq!(fx.runs().len(), 2);
    }

    #[tokio::test]
    async fn concurrent_resolves_share_one_run() {
        let fx = Fixture::new();
        let auth = fx.policy(&format!("sleep 0.2\n{}", answers("tok", FAR)), None);
        let keys = futures::future::join_all((0..8).map(|_| key(&auth, "chatgpt/gpt-x"))).await;
        assert!(keys.iter().all(|k| k == "tok"));
        assert_eq!(fx.runs().len(), 1);
    }

    #[tokio::test]
    async fn pins_the_account_it_was_given() {
        let fx = Fixture::new();
        let auth = fx.policy(&answers("tok", FAR), Some("oaiapp_x"));
        key(&auth, "chatgpt/gpt-x").await;
        assert_eq!(fx.runs(), vec!["access --account oaiapp_x"]);
    }

    #[tokio::test]
    async fn a_helper_failure_carries_its_message_and_no_token() {
        let fx = Fixture::new();
        let auth = fx.policy(
            "printf 'tok-leak'\necho 'ChatGPT is not connected; run mo chatgpt login' >&2\nexit 1",
            None,
        );
        let err = error(&auth).await;
        assert!(matches!(err, AuthError::ProviderNotConfigured(_)));
        let text = err.to_string();
        assert!(
            text.contains("chatgpt — ChatGPT is not connected; run mo chatgpt login"),
            "{text}"
        );
        assert!(!text.contains("tok-leak"), "{text}");
    }

    #[tokio::test]
    async fn a_failure_is_not_cached() {
        let fx = Fixture::new();
        let auth = fx.policy("exit 1", None);
        error(&auth).await;
        error(&auth).await;
        assert_eq!(fx.runs().len(), 2);
    }

    #[tokio::test]
    async fn a_helper_that_cannot_start_is_named() {
        let fx = Fixture::new();
        let auth = ChatGptAuth::new(
            fx.local(),
            PathBuf::from("/nonexistent/node"),
            fx.helper(""),
            None,
        );
        let text = error(&auth).await.to_string();
        assert!(text.contains("/nonexistent/node"), "{text}");
    }

    #[tokio::test]
    async fn a_hung_helper_is_killed() {
        let fx = Fixture::new();
        let mut auth = fx.policy("sleep 5", None);
        auth.timeout = Duration::from_millis(100);
        let start = Instant::now();
        let text = error(&auth).await.to_string();
        assert!(text.contains("killed"), "{text}");
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn unreadable_output_is_an_error() {
        let fx = Fixture::new();
        let auth = fx.policy("echo garbage", None);
        let text = error(&auth).await.to_string();
        assert!(text.contains("printed no access token"), "{text}");
    }

    #[tokio::test]
    async fn other_providers_go_to_local_auth() {
        let fx = Fixture::new();
        let auth = fx.policy(&answers("tok", FAR), None);
        assert_eq!(key(&auth, "meta/muse-x").await, "file-key");
        assert!(fx.runs().is_empty());
    }

    #[test]
    fn the_helper_sees_no_provider_key() {
        assert!(!helper_env(&OsString::from("OPENAI_API_SK")));
        assert!(helper_env(&OsString::from("XDG_DATA_HOME")));
        assert!(helper_env(&OsString::from("HOME")));
    }
}
