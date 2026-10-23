//! TCP and TLS streams for the hub WebSocket, the pairing request and the
//! local Syncthing API. TLS is rustls with Mozilla's roots (as Bun bundles
//! them) plus any PEM files in NODE_EXTRA_CA_CERTS or SSL_CERT_FILE.

#[cfg(feature = "tls")]
use rustls::pki_types::{pem::PemObject, CertificateDer, ServerName};
use std::io;
use std::pin::Pin;
#[cfg(feature = "tls")]
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;

#[derive(Debug, Clone)]
pub struct Url {
    /// http, https, ws or wss
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub path: String,
    /// host[:port] as the Host header carries it
    pub authority: String,
}

impl Url {
    pub fn tls(&self) -> bool {
        self.scheme == "https" || self.scheme == "wss"
    }
}

pub fn parse_url(s: &str) -> Result<Url, String> {
    let (scheme, rest) = s.split_once("://").ok_or_else(|| format!("Invalid URL: {s}"))?;
    let scheme = scheme.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "http" | "ws" => 80,
        "https" | "wss" => 443,
        _ => return Err(format!("Unsupported URL scheme: {scheme}")),
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let mut authority = &rest[..end];
    let mut path = rest[end..].to_string();
    if let Some(i) = path.find('#') {
        path.truncate(i);
    }
    if path.is_empty() || path.starts_with('?') {
        path = format!("/{path}");
    }
    if let Some(at) = authority.rfind('@') {
        authority = &authority[at + 1..];
    }
    let (host, port) = if let Some(stripped) = authority.strip_prefix('[') {
        let close = stripped.find(']').ok_or_else(|| format!("Invalid URL: {s}"))?;
        let host = &stripped[..close];
        let after = &stripped[close + 1..];
        let port = match after.strip_prefix(':') {
            Some(p) if !p.is_empty() => p.parse().map_err(|_| format!("Invalid URL: {s}"))?,
            _ => default_port,
        };
        (host.to_string(), port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) if !p.is_empty() => (h.to_string(), p.parse().map_err(|_| format!("Invalid URL: {s}"))?),
            Some((h, _)) => (h.to_string(), default_port),
            None => (authority.to_string(), default_port),
        }
    };
    if host.is_empty() {
        return Err(format!("Invalid URL: {s}"));
    }
    Ok(Url { scheme, host, port, path, authority: authority.to_string() })
}

#[cfg(feature = "tls")]
fn extra_roots(store: &mut rustls::RootCertStore) {
    for var in ["NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"] {
        if let Ok(file) = std::env::var(var) {
            if file.is_empty() {
                continue;
            }
            if let Ok(iter) = CertificateDer::pem_file_iter(&file) {
                for cert in iter.flatten() {
                    let _ = store.add(cert);
                }
            }
        }
    }
}

#[cfg(feature = "tls")]
pub fn tls_config() -> Arc<rustls::ClientConfig> {
    static CFG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    CFG.get_or_init(|| {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        extra_roots(&mut roots);
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut cfg = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("TLS versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
        // the WebSocket upgrade and the small requests here are HTTP/1.1
        cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        Arc::new(cfg)
    })
    .clone()
}

pub enum Stream {
    Plain(TcpStream),
    #[cfg(feature = "tls")]
    Tls(Box<tokio_rustls::client::TlsStream<TcpStream>>),
}

impl AsyncRead for Stream {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_read(cx, buf),
            #[cfg(feature = "tls")]
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Stream {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_write(cx, buf),
            #[cfg(feature = "tls")]
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_flush(cx),
            #[cfg(feature = "tls")]
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_flush(cx),
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_shutdown(cx),
            #[cfg(feature = "tls")]
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
        }
    }
}

/// How long one address gets before the next one starts too (RFC 8305 says 250 ms).
const ATTEMPT_DELAY: std::time::Duration = std::time::Duration::from_millis(250);
/// The whole connect, all addresses together.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// The resolved addresses in the order to try them: families alternate,
/// starting with the one the resolver put first (RFC 8305 4).
pub fn interleave(addrs: Vec<std::net::SocketAddr>) -> Vec<std::net::SocketAddr> {
    let first_v6 = addrs.first().is_some_and(|a| a.is_ipv6());
    let (v6, v4): (Vec<_>, Vec<_>) = addrs.into_iter().partition(|a| a.is_ipv6());
    let (mut a, mut b) = if first_v6 { (v6.into_iter(), v4.into_iter()) } else { (v4.into_iter(), v6.into_iter()) };
    let mut out = Vec::new();
    loop {
        match (a.next(), b.next()) {
            (None, None) => break,
            (x, y) => out.extend(x.into_iter().chain(y)),
        }
    }
    out
}

/// TCP to a host the way browsers do it (happy eyeballs): each address starts
/// 250 ms after the one before, and the first that connects wins. A network
/// with broken IPv6 (a hotel or campus Wi-Fi that hands out IPv6 but drops it)
/// would otherwise hang on the IPv6 address until the system gives up, while
/// a browser on the same machine reaches the hub at once over IPv4.
async fn connect_tcp(host: &str, port: u16) -> io::Result<TcpStream> {
    let addrs = interleave(tokio::net::lookup_host((host, port)).await?.collect());
    if addrs.is_empty() {
        return Err(io::Error::new(io::ErrorKind::NotFound, format!("{host} has no address")));
    }
    let race = async {
        let mut pending = futures_util::stream::FuturesUnordered::new();
        let mut next = addrs.into_iter();
        let mut last: Option<io::Error> = None;
        loop {
            if let Some(addr) = next.next() {
                pending.push(TcpStream::connect(addr));
            } else if pending.is_empty() {
                return Err(last.unwrap_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "no address answered")));
            }
            let wait = tokio::time::sleep(ATTEMPT_DELAY);
            tokio::pin!(wait);
            // a failure starts the next address at once; a success ends the race
            loop {
                tokio::select! {
                    Some(r) = futures_util::StreamExt::next(&mut pending) => match r {
                        Ok(tcp) => return Ok(tcp),
                        Err(e) => {
                            last = Some(e);
                            break;
                        }
                    },
                    _ = &mut wait => break,
                    else => break,
                }
            }
        }
    };
    tokio::time::timeout(CONNECT_TIMEOUT, race)
        .await
        .unwrap_or_else(|_| Err(io::Error::new(io::ErrorKind::TimedOut, format!("{host} did not answer in {} seconds", CONNECT_TIMEOUT.as_secs()))))
}

/// Open TCP (and TLS for https/wss) to the URL's host.
pub async fn connect(url: &Url) -> io::Result<Stream> {
    let tcp = connect_tcp(url.host.as_str(), url.port).await?;
    let _ = tcp.set_nodelay(true);
    if !url.tls() {
        return Ok(Stream::Plain(tcp));
    }
    #[cfg(feature = "tls")]
    {
        let name = ServerName::try_from(url.host.clone()).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        let tls = tokio_rustls::TlsConnector::from(tls_config()).connect(name, tcp).await?;
        Ok(Stream::Tls(Box::new(tls)))
    }
    #[cfg(not(feature = "tls"))]
    Err(io::Error::new(io::ErrorKind::Unsupported, "this build has no TLS"))
}

pub struct Response {
    pub status: u16,
    pub reason: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

const MAX_BODY: usize = 16 * 1024 * 1024;

fn decode_chunked(mut b: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(nl) = b.windows(2).position(|w| w == b"\r\n") {
        let size_line = String::from_utf8_lossy(&b[..nl]);
        let size = usize::from_str_radix(size_line.split(';').next().unwrap_or("").trim(), 16).unwrap_or(0);
        b = &b[nl + 2..];
        if size == 0 || b.len() < size {
            out.extend_from_slice(&b[..size.min(b.len())]);
            break;
        }
        out.extend_from_slice(&b[..size]);
        b = &b[size..];
        if b.starts_with(b"\r\n") {
            b = &b[2..];
        }
    }
    out
}

/// One HTTP/1.1 request with `Connection: close`. Follows up to 5 redirects.
pub async fn request(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&[u8]>, timeout: Duration) -> Result<Response, String> {
    request_limited(method, url, headers, body, timeout, MAX_BODY).await
}

/// `request` with a larger cap on the answer (an update download).
pub async fn request_limited(method: &str, url: &str, headers: &[(&str, &str)], body: Option<&[u8]>, timeout: Duration, max_body: usize) -> Result<Response, String> {
    let mut current = url.to_string();
    let mut headers = headers.to_vec();
    for _ in 0..5 {
        let u = parse_url(&current)?;
        let res = tokio::time::timeout(timeout, request_once(method, &u, &headers, body, max_body)).await.map_err(|_| "The operation timed out.".to_string())?;
        let res = res.map_err(|e| connect_error_text(&e, &u))?;
        if matches!(res.status, 301 | 302 | 307 | 308) {
            if let Some(loc) = res.header("location") {
                current = if loc.contains("://") { loc.to_string() } else { format!("{}://{}{}", u.scheme, u.authority, loc) };
                // as fetch does: the bearer token never follows a redirect to another origin
                if parse_url(&current).map_or(true, |n| (&n.scheme, &n.host, n.port) != (&u.scheme, &u.host, u.port)) {
                    headers.retain(|(k, _)| !k.eq_ignore_ascii_case("authorization"));
                }
                continue;
            }
        }
        return Ok(res);
    }
    Err("Too many redirects".into())
}

fn connect_error_text(e: &io::Error, u: &Url) -> String {
    match e.kind() {
        io::ErrorKind::ConnectionRefused => format!("Unable to connect. Is the computer able to access the url? ({}:{} refused the connection)", u.host, u.port),
        _ => format!("{e} ({}:{})", u.host, u.port),
    }
}

async fn request_once(method: &str, u: &Url, headers: &[(&str, &str)], body: Option<&[u8]>, max_body: usize) -> io::Result<Response> {
    let mut s = connect(u).await?;
    let mut req = format!("{method} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nAccept: */*\r\nUser-Agent: conclave-daemon/{}\r\n", u.path, u.authority, crate::info::VERSION);
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    if let Some(b) = body {
        req.push_str(&format!("Content-Length: {}\r\n", b.len()));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).await?;
    if let Some(b) = body {
        s.write_all(b).await?;
    }
    s.flush().await?;
    let mut raw = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    loop {
        match s.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&chunk[..n]);
                if raw.len() > max_body {
                    break;
                }
            }
            // a TLS peer that closes without close_notify still sent the whole reply
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof && !raw.is_empty() => break,
            Err(e) => return Err(e),
        }
    }
    let head_end = raw.windows(4).position(|w| w == b"\r\n\r\n").ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid HTTP response"))?;
    let head = String::from_utf8_lossy(&raw[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let mut parts = status_line.splitn(3, ' ');
    let _ver = parts.next();
    let status: u16 = parts.next().and_then(|c| c.parse().ok()).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid HTTP status"))?;
    let reason = parts.next().unwrap_or("").to_string();
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))).collect();
    let mut body = raw[head_end + 4..].to_vec();
    let chunked = headers.iter().any(|(k, v)| k.eq_ignore_ascii_case("transfer-encoding") && v.to_ascii_lowercase().contains("chunked"));
    if chunked {
        body = decode_chunked(&body);
    } else if let Some(len) = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse::<usize>().ok()) {
        body.truncate(len);
    }
    Ok(Response { status, reason, headers, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_alternate_families_starting_with_the_first() {
        let a = |s: &str| s.parse::<std::net::SocketAddr>().unwrap();
        let got = interleave(vec![a("[2606:4700::1]:443"), a("[2606:4700::2]:443"), a("104.21.0.1:443"), a("172.67.0.1:443")]);
        assert_eq!(got, vec![a("[2606:4700::1]:443"), a("104.21.0.1:443"), a("[2606:4700::2]:443"), a("172.67.0.1:443")]);
        let got = interleave(vec![a("104.21.0.1:443"), a("[2606:4700::1]:443")]);
        assert_eq!(got, vec![a("104.21.0.1:443"), a("[2606:4700::1]:443")]);
        assert!(interleave(vec![]).is_empty());
    }

    #[tokio::test]
    async fn connects_past_an_address_that_never_answers() {
        // localhost resolves to ::1 and 127.0.0.1 on most systems; only the IPv4 one listens here
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let tcp = connect_tcp("127.0.0.1", port).await.unwrap();
        assert_eq!(tcp.peer_addr().unwrap().port(), port);
        let err = connect_tcp("127.0.0.1", 1).await.unwrap_err();
        assert_ne!(err.kind(), io::ErrorKind::TimedOut);
    }
    #[test]
    fn urls() {
        let u = parse_url("wss://hub.example.com/api/daemon?deviceId=x").unwrap();
        assert_eq!((u.scheme.as_str(), u.host.as_str(), u.port, u.path.as_str()), ("wss", "hub.example.com", 443, "/api/daemon?deviceId=x"));
        let u = parse_url("http://127.0.0.1:8230").unwrap();
        assert_eq!((u.host.as_str(), u.port, u.path.as_str(), u.authority.as_str()), ("127.0.0.1", 8230, "/", "127.0.0.1:8230"));
        let u = parse_url("ws://[::1]:7717/x").unwrap();
        assert_eq!((u.host.as_str(), u.port), ("::1", 7717));
        assert!(parse_url("ftp://x").is_err());
    }

    #[test]
    fn chunked_bodies() {
        assert_eq!(decode_chunked(b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"), b"hello world");
    }

    /// Accept one request and answer what `reply` makes of its head.
    async fn one_reply(l: &tokio::net::TcpListener, reply: impl FnOnce(&str) -> String) {
        let (mut s, _) = l.accept().await.unwrap();
        let mut head = Vec::new();
        let mut chunk = [0u8; 4096];
        while !head.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = s.read(&mut chunk).await.unwrap();
            if n == 0 {
                break;
            }
            head.extend_from_slice(&chunk[..n]);
        }
        s.write_all(reply(&String::from_utf8_lossy(&head)).as_bytes()).await.unwrap();
        let _ = s.shutdown().await;
    }

    #[test]
    fn a_redirect_to_another_origin_drops_the_token() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let a = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let b = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let (pa, pb) = (a.local_addr().unwrap().port(), b.local_addr().unwrap().port());
            let echo = |head: &str| format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{head}", head.len());
            let to = |loc: String| move |_: &str| format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: {loc}\r\nContent-Length: 0\r\n\r\n");
            let servers = async {
                one_reply(&a, to("/echo".into())).await;
                one_reply(&a, echo).await;
                one_reply(&a, to(format!("http://127.0.0.1:{pb}/echo"))).await;
                one_reply(&b, echo).await;
            };
            let client = async {
                let h = [("Authorization", "Bearer secret")];
                let same = request("GET", &format!("http://127.0.0.1:{pa}/same"), &h, None, Duration::from_secs(5)).await.unwrap();
                let other = request("GET", &format!("http://127.0.0.1:{pa}/other"), &h, None, Duration::from_secs(5)).await.unwrap();
                (String::from_utf8_lossy(&same.body).into_owned(), String::from_utf8_lossy(&other.body).into_owned())
            };
            let ((), (same, other)) = tokio::join!(servers, client);
            assert!(same.contains("Authorization: Bearer secret"), "{same}");
            assert!(other.starts_with("GET /echo ") && !other.to_lowercase().contains("authorization"), "{other}");
        });
    }
}
