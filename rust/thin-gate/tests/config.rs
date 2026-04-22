//! `ConfigSource` TOML impl — parsing, defaults, error paths.

use std::path::PathBuf;

use mohdel_thin_gate::defaults::TomlConfigSource;
use mohdel_thin_gate::hooks::ConfigSource;

struct TempFile(PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn write_tmp(name: &str, body: &str) -> TempFile {
    let path = std::env::temp_dir().join(format!(
        "mohdel-thin-gate-cfg-{}-{name}.toml",
        std::process::id()
    ));
    std::fs::write(&path, body).expect("write tmp toml");
    TempFile(path)
}

#[tokio::test]
async fn missing_file_returns_defaults_without_error() {
    let path = std::env::temp_dir().join(format!(
        "mohdel-thin-gate-cfg-{}-does-not-exist.toml",
        std::process::id()
    ));
    assert!(!path.exists());
    let src = TomlConfigSource::new(&path);
    let cfg = src.load().await.expect("defaults on missing file");
    assert!(cfg.session.is_none());
    assert!(cfg.providers.is_empty());
    assert_eq!(
        cfg.sockets.data.to_string_lossy(),
        "/tmp/mohdel-thin-gate.sock"
    );
}

#[tokio::test]
async fn parses_full_toml() {
    let tmp = write_tmp(
        "full",
        r#"
default_timeouts_ms = 45000

[sockets]
data  = "/run/mohdel/data.sock"
admin = "/run/mohdel/admin.sock"

[session]
command = "node"
args    = ["/opt/mohdel/js/session/bin.js"]
pool_size = 4

[providers.openai]
endpoint    = "https://api.openai.com/v1"
api_key_env = "OPENAI_API_SK"

[providers.anthropic]
endpoint = "https://api.anthropic.com"
"#,
    );
    let cfg = TomlConfigSource::new(&tmp.0)
        .load()
        .await
        .expect("parse full");

    assert_eq!(cfg.default_timeouts_ms, 45_000);
    assert_eq!(cfg.sockets.data.to_string_lossy(), "/run/mohdel/data.sock");

    let session = cfg.session.as_ref().expect("session");
    assert_eq!(session.command, "node");
    assert_eq!(session.pool_size, 4);

    assert_eq!(
        cfg.providers.get("openai").unwrap().api_key_env.as_deref(),
        Some("OPENAI_API_SK")
    );
    assert!(cfg.providers.get("anthropic").unwrap().api_key_env.is_none());
}

#[tokio::test]
async fn session_pool_size_defaults_to_2() {
    let tmp = write_tmp(
        "pool-default",
        r#"
[session]
command = "node"
args = ["/x.js"]
"#,
    );
    let cfg = TomlConfigSource::new(&tmp.0).load().await.unwrap();
    assert_eq!(cfg.session.unwrap().pool_size, 2);
}

#[tokio::test]
async fn malformed_toml_returns_parse_error() {
    let tmp = write_tmp("bad", "this is = not = valid toml\n");
    let err = TomlConfigSource::new(&tmp.0)
        .load()
        .await
        .expect_err("should fail to parse");
    assert!(format!("{err}").starts_with("parse:"));
}

#[tokio::test]
async fn unknown_fields_are_rejected() {
    let tmp = write_tmp(
        "unknown",
        r#"
[sockets]
data = "/d"
admin = "/a"
mystery_knob = "not-a-field"
"#,
    );
    let err = TomlConfigSource::new(&tmp.0)
        .load()
        .await
        .expect_err("deny_unknown_fields should reject");
    assert!(format!("{err}").contains("mystery_knob"));
}

#[tokio::test]
async fn env_var_selects_config_path() {
    let tmp = write_tmp(
        "from-env",
        r#"
default_timeouts_ms = 12345
"#,
    );
    // Safety: tests in the same process share env; each test uses a
    // unique file name so concurrent access is safe for the path we
    // point at. We set + unset to avoid leaking to sibling tests.
    std::env::set_var("MOHDEL_THIN_GATE_CONFIG", &tmp.0);
    let cfg = TomlConfigSource::with_default_path().load().await.unwrap();
    std::env::remove_var("MOHDEL_THIN_GATE_CONFIG");
    assert_eq!(cfg.default_timeouts_ms, 12345);
}
