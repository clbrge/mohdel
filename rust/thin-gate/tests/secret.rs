use mohdel_thin_gate::secret::SecretString;

#[test]
fn debug_redacts_the_value() {
    let s = SecretString::new("hunter2");
    let formatted = format!("{:?}", s);
    assert!(!formatted.contains("hunter2"));
    assert!(formatted.contains("redacted"));
}

#[test]
fn expose_returns_underlying_value() {
    let s = SecretString::new("abc");
    assert_eq!(s.expose(), "abc");
}

#[test]
fn serde_is_transparent() {
    let s = SecretString::new("key-123");
    let json = serde_json::to_string(&s).unwrap();
    assert_eq!(json, "\"key-123\"");

    let parsed: SecretString = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.expose(), "key-123");
}

/// The gate wipes the serialized envelope after handing it to a
/// session. `Zeroize` on a `Vec<u8>` both clears the bytes and empties
/// the vector, so an assertion on emptiness alone would pass against a
/// plain `clear()` that left the key readable in the allocation.
#[test]
fn zeroize_clears_serialized_key_bytes() {
    use zeroize::Zeroize;

    let mut bytes = serde_json::to_vec(&serde_json::json!({
        "auth": { "key": "sk-live-should-not-survive" }
    }))
    .unwrap();

    let capacity = bytes.capacity();
    let ptr = bytes.as_ptr();
    assert!(String::from_utf8_lossy(&bytes).contains("sk-live-should-not-survive"));

    bytes.zeroize();
    assert!(bytes.is_empty());

    // SAFETY: the allocation is still owned by `bytes` (zeroize does not
    // free it), so reading back the original span is in-bounds.
    let raw = unsafe { std::slice::from_raw_parts(ptr, capacity) };
    assert!(raw.iter().all(|b| *b == 0), "buffer still holds data");
}

/// `Debug` redacts and `Serialize` does not — the asymmetry PROTOCOL.md
/// §3.1 tells operators never to resolve with a diagnostic print.
#[test]
fn serialize_exposes_what_debug_hides() {
    let s = SecretString::new("sk-asymmetry");
    assert!(!format!("{s:?}").contains("sk-asymmetry"));
    assert!(serde_json::to_string(&s).unwrap().contains("sk-asymmetry"));
}
