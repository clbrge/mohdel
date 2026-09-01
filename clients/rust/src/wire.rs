//! HTTP/1.1 response parsing for the thin-gate surface: head, chunked
//! bodies, NDJSON framing. Push-style over byte slices; no I/O.

use std::collections::HashMap;

pub const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

pub const CALL_PATH: &str = "/v1/call";
pub const IMAGE_PATH: &str = "/v1/image";
pub const TRANSCRIPTION_PATH: &str = "/v1/transcription";
pub const HEALTH_PATH: &str = "/v1/health";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireError {
    /// The peer closed before sending a response head.
    NoResponse,
    /// Bytes that do not form a valid HTTP/1.1 response.
    Malformed(String),
    /// One NDJSON line exceeded `MAX_LINE_BYTES` without a newline.
    LineTooLong,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub status: u16,
    pub headers: HashMap<String, String>,
}

pub fn request(method: &str, path: &str, body: Option<&[u8]>) -> Vec<u8> {
    let mut out = format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n")
        .into_bytes();
    match body {
        Some(body) => {
            out.extend_from_slice(
                format!("Content-Type: application/json\r\nContent-Length: {}\r\n\r\n", body.len())
                    .as_bytes(),
            );
            out.extend_from_slice(body);
        }
        None => out.extend_from_slice(b"\r\n"),
    }
    out
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// `Ok(None)` while the head is incomplete; `Ok(Some((head, consumed)))`
/// once the blank line has arrived, `consumed` being the byte length of
/// the head including that blank line.
pub fn parse_head(buf: &[u8]) -> Result<Option<(Head, usize)>, WireError> {
    let Some(end) = find(buf, b"\r\n\r\n") else {
        return Ok(None);
    };
    let text = std::str::from_utf8(&buf[..end])
        .map_err(|_| WireError::Malformed("non-UTF-8 response head".into()))?;
    let mut lines = text.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let status = parse_status(status_line)?;
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    Ok(Some((Head { status, headers }, end + 4)))
}

fn parse_status(line: &str) -> Result<u16, WireError> {
    let malformed = || WireError::Malformed(format!("malformed status line: {line}"));
    let mut parts = line.split(' ');
    match parts.next() {
        Some("HTTP/1.1") | Some("HTTP/1.0") => {}
        _ => return Err(malformed()),
    }
    parts.next().and_then(|code| code.parse().ok()).ok_or_else(malformed)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChunkState {
    Size,
    Data(usize),
    Crlf,
    Trailer,
    Complete,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Body {
    Chunked { buf: Vec<u8>, state: ChunkState },
    Sized { remaining: usize },
    UntilClose,
}

impl Body {
    pub fn from_head(head: &Head) -> Body {
        let chunked = head
            .headers
            .get("transfer-encoding")
            .map(|te| te.to_ascii_lowercase().contains("chunked"))
            .unwrap_or(false);
        if chunked {
            return Body::Chunked { buf: Vec::new(), state: ChunkState::Size };
        }
        match head.headers.get("content-length").and_then(|v| v.trim().parse().ok()) {
            Some(remaining) => Body::Sized { remaining },
            None => Body::UntilClose,
        }
    }

    /// True once the body is complete according to its framing; a
    /// body that ends with the connection can also end at EOF.
    pub fn may_end_with_close(&self) -> bool {
        matches!(
            self,
            Body::UntilClose
                | Body::Chunked { state: ChunkState::Complete, .. }
                | Body::Sized { remaining: 0 }
        )
    }

    /// Feeds bytes; appends the decoded body bytes to `out` and returns
    /// whether the body is complete (never for `UntilClose`).
    pub fn feed(&mut self, bytes: &[u8], out: &mut Vec<u8>) -> Result<bool, WireError> {
        match self {
            Body::UntilClose => {
                out.extend_from_slice(bytes);
                Ok(false)
            }
            Body::Sized { remaining } => {
                let n = (*remaining).min(bytes.len());
                out.extend_from_slice(&bytes[..n]);
                *remaining -= n;
                Ok(*remaining == 0)
            }
            Body::Chunked { buf, state } => {
                buf.extend_from_slice(bytes);
                loop {
                    match state {
                        ChunkState::Complete => return Ok(true),
                        ChunkState::Size => {
                            let Some(i) = find(buf, b"\r\n") else { return Ok(false) };
                            let size = parse_chunk_size(&buf[..i])?;
                            buf.drain(..i + 2);
                            *state = if size == 0 { ChunkState::Trailer } else { ChunkState::Data(size) };
                        }
                        ChunkState::Data(remaining) => {
                            let n = (*remaining).min(buf.len());
                            if n == 0 {
                                return Ok(false);
                            }
                            out.extend_from_slice(&buf[..n]);
                            buf.drain(..n);
                            *remaining -= n;
                            if *remaining == 0 {
                                *state = ChunkState::Crlf;
                            }
                        }
                        ChunkState::Crlf => {
                            if buf.len() < 2 {
                                return Ok(false);
                            }
                            if &buf[..2] != b"\r\n" {
                                return Err(WireError::Malformed("malformed chunk terminator".into()));
                            }
                            buf.drain(..2);
                            *state = ChunkState::Size;
                        }
                        ChunkState::Trailer => {
                            let Some(i) = find(buf, b"\r\n") else { return Ok(false) };
                            buf.drain(..i + 2);
                            if i == 0 {
                                *state = ChunkState::Complete;
                                return Ok(true);
                            }
                        }
                    }
                }
            }
        }
    }
}

fn parse_chunk_size(line: &[u8]) -> Result<usize, WireError> {
    let text = std::str::from_utf8(line)
        .map_err(|_| WireError::Malformed("malformed chunk size".into()))?;
    let hex = text.split(';').next().unwrap_or("").trim();
    usize::from_str_radix(hex, 16)
        .map_err(|_| WireError::Malformed(format!("malformed chunk size: {text}")))
}

/// Splits decoded body bytes into NDJSON documents. `\n` is the only
/// terminator; blank lines are skipped; the cap applies to bytes that
/// have not yet seen a newline.
#[derive(Debug, Default)]
pub struct Framer {
    buf: Vec<u8>,
}

impl Framer {
    pub fn new() -> Framer {
        Framer::default()
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Result<Vec<String>, WireError> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(i) = self.buf.iter().position(|b| *b == b'\n') {
            let line = line_text(&self.buf[..i])?;
            self.buf.drain(..i + 1);
            if !line.is_empty() {
                out.push(line);
            }
        }
        if self.buf.len() > MAX_LINE_BYTES {
            return Err(WireError::LineTooLong);
        }
        Ok(out)
    }

    /// The final document, if the stream ended without a trailing newline.
    pub fn finish(&mut self) -> Result<Option<String>, WireError> {
        let line = line_text(&self.buf)?;
        self.buf.clear();
        Ok(if line.is_empty() { None } else { Some(line) })
    }
}

fn line_text(bytes: &[u8]) -> Result<String, WireError> {
    std::str::from_utf8(bytes)
        .map(|s| s.trim().to_string())
        .map_err(|_| WireError::Malformed("non-UTF-8 NDJSON line".into()))
}
