# Security Policy

## Reporting a vulnerability

If you discover a security issue in mohdel, please **do not** open a
public GitHub issue. Instead, email `clb@toort.net` with:

- A description of the issue and its impact.
- Steps to reproduce (minimal repro preferred).
- Any suggested mitigation if you have one.

You should get an acknowledgement within a few working days. I'll
coordinate a fix, a release, and a public disclosure on GitHub Advisory
once users have had a reasonable window to upgrade.

## Scope

Mohdel handles provider API keys and prompts. Classes of issues that
are in scope:

- API-key leakage (in logs, error messages, stack traces, wire events).
- Auth bypass / privilege escalation in the `thin-gate` policy layer
  (RoutePolicy, QuotaPolicy).
- Remote code execution via crafted envelopes or event streams.
- Denial of service through the HTTP or NDJSON layers.
- Sandbox escapes in the session subprocess.
- Cross-tenant state leakage in the gate's shared enforcer.

Out of scope:
- Issues in upstream provider APIs or their SDKs — report those to the
  provider directly.
- Issues in consumer orchestration code (chains, agents, prompt
  templates) — mohdel doesn't provide these.
- Configuration mistakes in deployments (e.g. publishing the unix
  socket path to an untrusted network).

## Operational note on API keys

See `PROTOCOL.md §3.1 Operational note — auth.key lifetime asymmetry`
for the intentional asymmetry between the Rust-side secret handling
(zeroized on drop) and the JS-side (GC-managed strings). If local
process inspection is in your threat model, lock down the host
accordingly — core dumps, `/proc/<pid>/mem`, and `ptrace` can surface
an in-memory key on the session subprocess.
