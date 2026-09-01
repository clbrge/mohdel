#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use async_trait::async_trait;
use mohdel_client::{Client, Reader, Transport};
use mohdel_protocol::secret::SecretString;
use mohdel_protocol::{Auth, CallEnvelope, Prompt};
use tokio::io::{AsyncRead, ReadBuf};

pub fn fixture(name: &str) -> Vec<u8> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../test/conformance/gate/");
    std::fs::read(format!("{path}{name}")).unwrap()
}

pub fn conformance(name: &str) -> String {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../test/conformance/");
    std::fs::read_to_string(format!("{path}{name}")).unwrap()
}

/// Replays bytes `slice` bytes per read, like a socket handing out
/// arbitrary chunks.
pub struct Replay {
    data: Vec<u8>,
    pos: usize,
    slice: usize,
}

impl AsyncRead for Replay {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let remaining = self.data.len() - self.pos;
        let n = self.slice.min(remaining).min(buf.remaining());
        let start = self.pos;
        buf.put_slice(&self.data[start..start + n]);
        self.pos += n;
        Poll::Ready(Ok(()))
    }
}

pub struct ReplayTransport {
    bytes: Vec<u8>,
    slice: usize,
    pub requests: Mutex<Vec<(PathBuf, Vec<u8>)>>,
}

#[async_trait]
impl Transport for ReplayTransport {
    async fn open(&self, socket: &Path, request: Vec<u8>) -> std::io::Result<Reader> {
        self.requests.lock().unwrap().push((socket.to_path_buf(), request));
        Ok(Box::new(Replay { data: self.bytes.clone(), pos: 0, slice: self.slice }))
    }
}

pub fn client(bytes: Vec<u8>, slice: usize) -> (Client, Arc<ReplayTransport>) {
    let transport = Arc::new(ReplayTransport { bytes, slice, requests: Mutex::new(Vec::new()) });
    let client = Client::new("/tmp/data.sock")
        .with_admin("/tmp/admin.sock")
        .with_transport(transport.clone());
    (client, transport)
}

pub fn envelope() -> CallEnvelope {
    CallEnvelope {
        call_id: "c-1".into(),
        auth_id: "u-1".into(),
        auth: Some(Auth { key: SecretString::new("") }),
        model: "local/llama3.1-8b".into(),
        prompt: Prompt::Text("why is the sky blue".into()),
        output_budget: Some(4),
        ..Client::envelope_defaults()
    }
}

pub fn json_response(body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}
