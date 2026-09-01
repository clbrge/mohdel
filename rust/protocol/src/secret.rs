//! Minimal secret-string wrapper.
//!
//! - Transparent serde (serializes as a plain JSON string)
//! - Debug impl redacts the value
//! - Drop zeroizes the underlying bytes

use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

#[derive(Clone, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SecretString(String);

impl SecretString {
    pub fn new<S: Into<String>>(s: S) -> Self {
        Self(s.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretString(<redacted>)")
    }
}

impl Drop for SecretString {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
