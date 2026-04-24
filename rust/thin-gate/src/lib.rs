//! mohdel-thin-gate — generic inference multiplexer / scheduler / state owner.
//!
//! Default binary (`mohdel-thin-gate`) serves the gate directly.
//! Embedders can depend on this crate as a library and override the
//! hook traits (`RoutePolicy`, `QuotaPolicy`, `ConfigSource`,
//! `CachePolicy`) to integrate with their own catalog, quota, and
//! config sources.

pub mod defaults;
pub mod enforcer;
pub mod hooks;
pub mod metrics;
pub mod protocol;
pub mod secret;
pub mod server;
pub mod session_pool;
pub mod tracing;

pub use enforcer::Enforcer;
pub use server::{
    bind, handle_call, handle_image, health_handler, not_found_response, remove_stale_socket,
    serve_admin, serve_data, serve_data_with_state, typed_error_response, Body, GateState,
    CatalogSource, ServeError, SessionConfig,
};
pub use session_pool::{PoolError, PooledSession, SessionPool};

/// Curated re-export set for embedders composing their own binary on
/// top of this crate. Import `use mohdel_thin_gate::prelude::*;` to
/// get everything needed for a typical gate wrapper (custom route
/// composition, shared state, hook impls, wire types).
pub mod prelude {
    pub use crate::enforcer::Enforcer;
    pub use crate::hooks::{
        AuthError, AuthPolicy, CachePolicy, ConfigSource, QuotaError, QuotaPolicy, QuotaSpec,
        RequireInlineAuth, RouteDecision, RouteError, RoutePolicy,
    };
    pub use crate::protocol::{
        catalog_key, provider_of, split_model_id, AnswerResult, Auth, CallEnvelope, Event,
        ImageEnvelope, ImageResult, Severity, Status, TypedError,
    };
    pub use crate::server::{
        bind, handle_call, handle_image, health_handler, not_found_response,
        serve_data_with_state, typed_error_response, Body, GateState, ServeError,
        SessionConfig,
    };
    pub use crate::session_pool::{PooledSession, SessionPool};
}
