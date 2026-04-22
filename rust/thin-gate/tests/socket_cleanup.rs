//! `remove_stale_socket` / `bind` cleanup behavior.
//!
//! A stale unix socket from a previous crashed run should be
//! reclaimed automatically. A regular file, directory, or other
//! non-socket path at the same location must NOT be silently
//! overwritten — that was the old behavior and let a bad config
//! path delete unrelated files.

use std::path::PathBuf;

use mohdel_thin_gate::{bind, remove_stale_socket};

struct CleanupGuard(PathBuf);
impl Drop for CleanupGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn tmp_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "mohdel-socket-cleanup-{}-{}",
        std::process::id(),
        name
    ))
}

#[test]
fn absent_path_is_a_noop() {
    let path = tmp_path("absent");
    assert!(!path.exists());
    remove_stale_socket(&path).expect("absent path should succeed");
    assert!(!path.exists());
}

#[test]
fn stale_socket_is_removed() {
    let path = tmp_path("stale");
    let _g = CleanupGuard(path.clone());

    // Create a real unix socket so the file type check sees it.
    let listener =
        std::os::unix::net::UnixListener::bind(&path).expect("bind stale socket");
    drop(listener);
    assert!(path.exists());

    remove_stale_socket(&path).expect("stale socket should be removed");
    assert!(!path.exists(), "path should be gone after cleanup");
}

#[test]
fn regular_file_is_refused() {
    let path = tmp_path("regular");
    let _g = CleanupGuard(path.clone());

    std::fs::write(&path, b"do-not-delete").expect("write regular file");
    assert!(path.exists());

    let err = remove_stale_socket(&path).expect_err("regular file must be rejected");
    let msg = err.to_string();
    assert!(
        msg.contains("not a unix socket") || msg.contains("refusing to overwrite"),
        "unexpected error: {msg}"
    );
    assert!(
        path.exists(),
        "the regular file must still be on disk after a refused cleanup"
    );
    let body = std::fs::read(&path).unwrap();
    assert_eq!(body, b"do-not-delete", "regular file contents mutated");
}

// F46: sockets are chmod'd to 0o600 (owner-only) regardless of
// the process umask, so a shared-host local user can't connect.
#[tokio::test]
async fn bind_applies_owner_only_mode() {
    use std::os::unix::fs::PermissionsExt;

    let path = tmp_path("mode");
    let _g = CleanupGuard(path.clone());

    let _listener = bind(&path).expect("bind succeeds");
    assert!(path.exists());

    let meta = std::fs::metadata(&path).expect("stat socket");
    let mode = meta.permissions().mode() & 0o777;
    assert_eq!(
        mode, 0o600,
        "socket mode must be 0o600 regardless of umask; got 0o{:o}",
        mode
    );
}

#[test]
fn directory_is_refused() {
    let path = tmp_path("dir");
    std::fs::create_dir_all(&path).expect("create dir");
    let err = remove_stale_socket(&path).expect_err("directory must be rejected");
    assert!(err.to_string().contains("not a unix socket"));
    assert!(path.exists() && path.is_dir());
    let _ = std::fs::remove_dir(&path);
}
