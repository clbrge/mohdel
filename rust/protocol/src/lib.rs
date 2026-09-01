//! Wire types of the mohdel thin-gate protocol (PROTOCOL.md), shared
//! by the gate and by Rust clients. JS mirror: `js/core/`.

pub mod secret;

mod protocol;

pub use protocol::*;
