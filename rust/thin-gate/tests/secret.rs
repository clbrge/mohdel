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
