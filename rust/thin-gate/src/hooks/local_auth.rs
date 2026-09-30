//! `LocalAuth`: a provider's key the way `mo` finds it — the process
//! environment first, then mohdel's environment file, under the variable
//! names of `src/lib/providers.js`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use async_trait::async_trait;

use super::auth::{AuthError, AuthPolicy};
use crate::protocol::{provider_of, Auth};
use crate::secret::SecretString;

/// Provider → the variable holding its key: `apiKeyEnv` in
/// `src/lib/providers.js`. `test/unit/local-auth-names.test.js` fails when
/// the two drift.
const KEY_ENV: &[(&str, &str)] = &[
    ("anthropic", "ANTHROPIC_API_SK"),
    ("cerebras", "CEREBRAS_API_SK"),
    ("cohere", "COHERE_API_SK"),
    ("deepseek", "DEEPSEEK_API_SK"),
    ("fireworks", "FIREWORKS_API_SK"),
    ("gemini", "GEMINI_API_SK"),
    ("groq", "GROQ_API_SK"),
    ("meta", "META_API_SK"),
    ("mistral", "MISTRAL_API_SK"),
    ("novita", "NOVITA_API_SK"),
    ("openai", "OPENAI_API_SK"),
    ("openrouter", "OPENROUTER_API_SK"),
    ("qwen", "QWEN_API_SK"),
    ("xai", "XAI_API_SK"),
    ("xiaomi", "XIAOMI_API_SK"),
];

/// `optionalApiKeyEnv` in `src/lib/providers.js`: a provider that runs
/// without a key, so a missing one is an empty key, not an error.
const OPTIONAL_KEY_ENV: &[(&str, &str)] = &[("local", "MOHDEL_LOCAL_API_SK")];

/// A provider's key from the process environment, else from mohdel's
/// environment file — the places `mo` looks, in the same order, under the
/// same names. The file is read once, when the policy is built.
pub struct LocalAuth {
    file: PathBuf,
    vars: HashMap<String, String>,
    env: fn(&str) -> Option<String>,
}

impl LocalAuth {
    /// `environment` in mohdel's config directory, resolved as `mo` resolves it.
    pub fn new() -> Result<Self, AuthError> {
        let dir = mohdel_config_dir().ok_or_else(|| {
            AuthError::Other(
                "cannot locate the home directory holding mohdel's environment file".into(),
            )
        })?;
        Self::from_file(&dir.join("environment"))
    }

    /// The same, from a given file.
    pub fn from_file(path: &Path) -> Result<Self, AuthError> {
        Self::with_env(path, process_env)
    }

    pub(crate) fn with_env(
        path: &Path,
        env: fn(&str) -> Option<String>,
    ) -> Result<Self, AuthError> {
        let vars = match std::fs::read_to_string(path) {
            Ok(content) => parse_env_file(&content),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(e) => {
                return Err(AuthError::Other(format!(
                    "cannot read {}: {e}",
                    path.display()
                )))
            }
        };
        Ok(Self {
            file: path.to_path_buf(),
            vars,
            env,
        })
    }

    fn key_for(&self, model: &str) -> Result<SecretString, AuthError> {
        let provider = provider_of(model);
        if let Some(var) = lookup(OPTIONAL_KEY_ENV, provider) {
            return Ok(SecretString::new(self.value(var).unwrap_or_default()));
        }
        let var = lookup(KEY_ENV, provider).ok_or_else(|| {
            AuthError::ProviderNotConfigured(format!(
                "{provider} — mohdel knows no key variable for this provider"
            ))
        })?;
        match self.value(var) {
            Some(key) if !key.is_empty() => Ok(SecretString::new(key)),
            _ => Err(AuthError::ProviderNotConfigured(
                self.missing(provider, var),
            )),
        }
    }

    /// A variable already in the environment wins, even when empty:
    /// `process.loadEnvFile` never overrides one.
    fn value(&self, var: &str) -> Option<String> {
        (self.env)(var).or_else(|| self.vars.get(var).cloned())
    }

    fn missing(&self, provider: &str, var: &str) -> String {
        let file = tilde(&self.file);
        match (self.env)(var) {
            Some(_) => {
                format!("{provider} — {var} is empty in the environment, which hides {file}")
            }
            None if self.vars.contains_key(var) => format!("{provider} — {var} is empty in {file}"),
            None => format!("{provider} — {var} is not in the environment or in {file}"),
        }
    }
}

#[async_trait]
impl AuthPolicy for LocalAuth {
    async fn resolve(&self, _auth_id: &str, model: &str) -> Result<Auth, AuthError> {
        Ok(Auth {
            key: self.key_for(model)?,
        })
    }
}

fn process_env(name: &str) -> Option<String> {
    std::env::var_os(name).map(|v| v.to_string_lossy().into_owned())
}

fn lookup(table: &[(&'static str, &'static str)], provider: &str) -> Option<&'static str> {
    table
        .iter()
        .find(|(p, _)| *p == provider)
        .map(|(_, var)| *var)
}

/// mohdel's config directory as `env-paths` resolves it for `mo`.
fn mohdel_config_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let set = |name: &str| {
        std::env::var_os(name)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    Some(if cfg!(target_os = "macos") {
        home.join("Library").join("Preferences").join("mohdel")
    } else if cfg!(windows) {
        set("APPDATA")
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("mohdel")
            .join("Config")
    } else {
        set("XDG_CONFIG_HOME")
            .unwrap_or_else(|| home.join(".config"))
            .join("mohdel")
    })
}

fn tilde(path: &Path) -> String {
    if let Some(home) = dirs::home_dir() {
        if let Ok(rest) = path.strip_prefix(&home) {
            return format!("~/{}", rest.display());
        }
    }
    path.display().to_string()
}

fn trim_spaces(s: &str) -> &str {
    s.trim_matches(' ')
}

fn after_newline(s: &str) -> &str {
    s.find('\n').map_or("", |n| &s[n + 1..])
}

/// Node's dotenv parser (`src/node_dotenv.cc`, behind `process.loadEnvFile`
/// and `util.parseEnv`), step for step, quirks included. The shared fixture
/// `test/conformance/env-file.env` holds both sides to one result.
fn parse_env_file(input: &str) -> HashMap<String, String> {
    let lines = input.replace('\r', "");
    let mut store = HashMap::new();
    let mut content = trim_spaces(&lines);

    while !content.is_empty() {
        if content.starts_with('\n') || content.starts_with('#') {
            content = after_newline(content);
            continue;
        }

        let Some(pos) = content.find(|c: char| c == '=' || c == '\n') else {
            break;
        };
        if content.as_bytes()[pos] == b'\n' {
            content = trim_spaces(&content[pos + 1..]);
            continue;
        }

        let mut key = trim_spaces(&content[..pos]);
        content = &content[pos + 1..];
        if let Some(rest) = key.strip_prefix("export ") {
            key = trim_spaces(rest);
        }

        if content.is_empty() || content.starts_with('\n') {
            store.insert(key.to_string(), String::new());
            continue;
        }

        content = trim_spaces(content);
        if key.is_empty() {
            match content.find('\n') {
                Some(n) => {
                    content = trim_spaces(&content[n + 1..]);
                    continue;
                }
                None => break,
            }
        }
        if content.is_empty() {
            store.insert(key.to_string(), String::new());
            break;
        }

        let quote = content.as_bytes()[0];
        if quote == b'"' {
            if let Some(close) = content[1..].find('"').map(|i| i + 1) {
                store.insert(key.to_string(), content[1..close].replace("\\n", "\n"));
                content = after_newline(&content[close + 1..]);
                continue;
            }
        }

        if matches!(quote, b'\'' | b'"' | b'`') {
            match content[1..].find(quote as char).map(|i| i + 1) {
                Some(close) => {
                    store.insert(key.to_string(), content[1..close].to_string());
                    content = after_newline(&content[close + 1..]);
                }
                None => match content.find('\n') {
                    Some(n) => {
                        store.insert(key.to_string(), content[..n].to_string());
                        content = &content[n..];
                    }
                    None => {
                        store.insert(key.to_string(), content.to_string());
                        break;
                    }
                },
            }
        } else {
            let (line, rest) = match content.find('\n') {
                Some(n) => (&content[..n], &content[n + 1..]),
                None => (content, ""),
            };
            let value = line.find('#').map_or(line, |h| &line[..h]);
            store.insert(key.to_string(), trim_spaces(value).to_string());
            content = rest;
        }

        content = trim_spaces(content);
    }

    store
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../../test/conformance/env-file.env");
    const EXPECTED: &str = include_str!("../../../../test/conformance/env-file.expected.json");

    fn no_env(_: &str) -> Option<String> {
        None
    }

    fn meta_in_env(name: &str) -> Option<String> {
        (name == "META_API_SK").then(|| "from-env".to_string())
    }

    fn meta_empty_in_env(name: &str) -> Option<String> {
        (name == "META_API_SK").then(String::new)
    }

    fn temp_file(name: &str, content: &[u8]) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("mohdel-local-auth-{}-{name}", std::process::id()));
        std::fs::write(&path, content).unwrap();
        path
    }

    fn missing_file(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "mohdel-local-auth-{}-{name}-absent",
            std::process::id()
        ))
    }

    fn key(auth: &LocalAuth, model: &str) -> String {
        match auth.key_for(model) {
            Ok(key) => key.expose().to_string(),
            Err(e) => panic!("expected a key, got: {e}"),
        }
    }

    fn error(auth: &LocalAuth, model: &str) -> String {
        match auth.key_for(model) {
            Ok(_) => panic!("expected an error"),
            Err(e) => e.to_string(),
        }
    }

    #[test]
    fn parses_the_shared_fixture_as_node_does() {
        let expected: HashMap<String, String> = serde_json::from_str(EXPECTED).unwrap();
        assert_eq!(parse_env_file(FIXTURE), expected);
    }

    #[test]
    fn crlf_lines_parse_as_lf() {
        let parsed = parse_env_file("A=a\r\nB=\"b\"\r\n");
        assert_eq!(parsed.get("A").map(String::as_str), Some("a"));
        assert_eq!(parsed.get("B").map(String::as_str), Some("b"));
    }

    #[test]
    fn environment_only() {
        let auth = LocalAuth::with_env(&missing_file("env-only"), meta_in_env).unwrap();
        assert_eq!(key(&auth, "meta/muse-spark-1.3"), "from-env");
    }

    #[test]
    fn file_only() {
        let file = temp_file("file-only", b"META_API_SK=from-file\n");
        let auth = LocalAuth::with_env(&file, no_env).unwrap();
        assert_eq!(key(&auth, "meta/muse-spark-1.3"), "from-file");
    }

    #[test]
    fn environment_wins_over_file() {
        let file = temp_file("both", b"META_API_SK=from-file\n");
        let auth = LocalAuth::with_env(&file, meta_in_env).unwrap();
        assert_eq!(key(&auth, "meta/muse-spark-1.3"), "from-env");
    }

    #[test]
    fn neither_names_the_variable_and_both_places() {
        let file = missing_file("neither");
        let auth = LocalAuth::with_env(&file, no_env).unwrap();
        let message = error(&auth, "meta/muse-spark-1.3");
        assert!(
            message.contains("meta — META_API_SK is not in the environment or in"),
            "{message}"
        );
        assert!(message.contains("mohdel-local-auth-"), "{message}");
    }

    #[test]
    fn empty_in_environment_hides_the_file() {
        let file = temp_file("empty-env", b"META_API_SK=from-file\n");
        let auth = LocalAuth::with_env(&file, meta_empty_in_env).unwrap();
        let message = error(&auth, "meta/muse-spark-1.3");
        assert!(
            message.contains("META_API_SK is empty in the environment, which hides"),
            "{message}"
        );
    }

    #[test]
    fn optional_key_is_empty_when_absent() {
        let auth = LocalAuth::with_env(&missing_file("local"), no_env).unwrap();
        assert_eq!(key(&auth, "local/llama3-1-8b"), "");
        let file = temp_file("local", b"MOHDEL_LOCAL_API_SK=bearer\n");
        let auth = LocalAuth::with_env(&file, no_env).unwrap();
        assert_eq!(key(&auth, "local/llama3-1-8b"), "bearer");
    }

    #[test]
    fn unknown_provider_is_refused() {
        let auth = LocalAuth::with_env(&missing_file("unknown"), no_env).unwrap();
        let message = error(&auth, "acme/model");
        assert!(
            message.contains("acme — mohdel knows no key variable"),
            "{message}"
        );
    }

    #[test]
    fn missing_file_is_no_keys() {
        assert!(LocalAuth::from_file(&missing_file("from-file")).is_ok());
    }

    #[test]
    fn unreadable_file_is_refused_at_construction() {
        let not_utf8 = temp_file("not-utf8", &[0x4b, 0x3d, 0xff, 0xfe, 0x0a]);
        assert!(LocalAuth::from_file(&not_utf8).is_err());
        assert!(LocalAuth::from_file(&std::env::temp_dir()).is_err());
    }
}
