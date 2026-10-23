//! The device side of chat import (protocol 2: importScan and importRead),
//! ported from import/wire.ts, import/sources.ts and src/importers. The
//! device finds Claude Code, Codex and Gemini CLI sessions on its own disk,
//! converts them with the same rules as the hub and sends compact rows, so a
//! 23 MB transcript never crosses the WebSocket.

pub mod claude;
pub mod codex;
pub mod gemini;
pub mod render;
pub mod secrets;

use crate::errors::{Res, WireError};
use crate::js::{self, as_str, len16, num, Obj};
use crate::paths::{base_name, join_slash};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// IMPORT_LIMITS.maxSessionBytes: one session file, on disk or decompressed.
pub const MAX_SESSION_BYTES: u64 = 512 * 1024 * 1024;
pub const DEVICE_TOOL_CHARS: usize = 50_000;
pub const DEVICE_SOURCES: &[&str] = &["claude-code", "codex", "gemini"];

// ---------------------------------------------------------------------------
// Converted sessions
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct Converted {
    pub source: &'static str,
    pub native_id: Option<String>,
    pub native_id_unique: bool,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub git_branch: Option<String>,
    pub repo: Option<String>,
    pub model: Option<String>,
    pub kind: &'static str,
    pub parent_native_id: Option<String>,
    pub entrypoint: Option<String>,
    pub messages: Vec<Obj>,
    pub unknown: Obj,
    pub learnable: bool,
}

impl Converted {
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("source".into(), json!(self.source));
        put_opt(&mut o, "nativeId", &self.native_id);
        o.insert("nativeIdUnique".into(), json!(self.native_id_unique));
        put_opt(&mut o, "title", &self.title);
        put_opt(&mut o, "cwd", &self.cwd);
        put_opt(&mut o, "gitBranch", &self.git_branch);
        put_opt(&mut o, "repo", &self.repo);
        put_opt(&mut o, "model", &self.model);
        o.insert("kind".into(), json!(self.kind));
        put_opt(&mut o, "parentNativeId", &self.parent_native_id);
        put_opt(&mut o, "entrypoint", &self.entrypoint);
        o.insert("messages".into(), Value::Array(self.messages.iter().cloned().map(Value::Object).collect()));
        o.insert("unknown".into(), Value::Object(self.unknown.clone()));
        o.insert("learnable".into(), json!(self.learnable));
        Value::Object(o)
    }
}

fn put_opt(o: &mut Obj, k: &str, v: &Option<String>) {
    if let Some(s) = v {
        o.insert(k.into(), Value::String(s.clone()));
    }
}

pub fn bump(counts: &mut Obj, key: &str) {
    let n = counts.get(key).and_then(Value::as_u64).unwrap_or(0) + 1;
    counts.insert(key.to_string(), json!(n));
}

/// A message object in the order the readers build it.
pub fn message(role: &str, kind: &str, content: Vec<Value>, created_at: f64, meta: Value) -> Obj {
    let mut m = Map::new();
    m.insert("role".into(), json!(role));
    m.insert("kind".into(), json!(kind));
    m.insert("content".into(), Value::Array(content));
    m.insert("createdAt".into(), num(created_at));
    m.insert("meta".into(), meta);
    m
}

pub fn content_mut(m: &mut Obj) -> &mut Vec<Value> {
    if !matches!(m.get("content"), Some(Value::Array(_))) {
        m.insert("content".into(), Value::Array(Vec::new()));
    }
    match m.get_mut("content") {
        Some(Value::Array(a)) => a,
        _ => unreachable!(),
    }
}

pub fn content(m: &Obj) -> &[Value] {
    match m.get("content") {
        Some(Value::Array(a)) => a,
        _ => &[],
    }
}

pub fn role(m: &Obj) -> &str {
    as_str(m.get("role")).unwrap_or("")
}

pub fn kind(m: &Obj) -> &str {
    as_str(m.get("kind")).unwrap_or("")
}

pub fn meta_origin(m: &Obj) -> Option<&str> {
    as_str(js::prop(m.get("meta"), "origin"))
}

pub fn block_type(b: &Value) -> &str {
    as_str(js::prop(Some(b), "type")).unwrap_or("")
}

pub fn text_block(text: &str) -> Value {
    json!({ "type": "text", "text": text })
}

/// truncateTitle: whitespace runs become one space, then at most 80 characters.
pub fn truncate_title(s: &str) -> String {
    let mut t = String::with_capacity(s.len());
    let mut ws = false;
    for c in s.chars() {
        if js::is_js_ws(c) {
            ws = true;
        } else {
            if ws && !t.is_empty() {
                t.push(' ');
            }
            ws = false;
            t.push(c);
        }
    }
    if len16(&t) > 80 {
        format!("{}...", js::slice16(&t, 0, 77))
    } else {
        t
    }
}

/// newId from util/ids.ts: base36 time, then 10 random base36 characters.
pub fn new_id(prefix: &str) -> String {
    use std::hash::{BuildHasher, Hasher};
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let mut digits = Vec::new();
    while t > 0 {
        digits.push(ALPHABET[(t % 36) as usize]);
        t /= 36;
    }
    while digits.len() < 9 {
        digits.push(b'0');
    }
    digits.reverse();
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(std::process::id() as u64);
    let mut r = h.finish();
    let mut s = String::from_utf8(digits).unwrap_or_default();
    for _ in 0..10 {
        s.push(ALPHABET[(r % 36) as usize] as char);
        r /= 36;
        if r == 0 {
            let mut h2 = std::collections::hash_map::RandomState::new().build_hasher();
            h2.write_u64(r);
            r = h2.finish();
        }
    }
    if prefix.is_empty() {
        s
    } else {
        format!("{prefix}_{s}")
    }
}

/// sanitizeToolId: characters outside [a-zA-Z0-9_-] become "_" (one per UTF-16 unit), at most 64.
pub fn sanitize_tool_id(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for c in id.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                out.push('_');
            }
        }
    }
    if out.is_empty() {
        return new_id("toolu");
    }
    out.truncate(64);
    out
}

/// One JSON object per line; blank, broken and non-object lines are skipped.
/// A last line without a newline counts (includePartialTail).
pub fn parse_jsonl(bytes: &[u8]) -> Vec<Obj> {
    let mut out = Vec::new();
    for raw in bytes.split(|b| *b == b'\n') {
        if raw.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(raw);
        let line = js::trim(&text);
        if line.is_empty() {
            continue;
        }
        if let Ok(Value::Object(o)) = js::parse_json(line) {
            out.push(o);
        }
    }
    out
}

pub fn sha256_hex(text: &str) -> String {
    let d = Sha256::digest(text.as_bytes());
    d.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Stats, rows and fingerprints (importers/types.ts, import/sources.ts)
// ---------------------------------------------------------------------------

/// originOf: who wrote a user message.
pub fn origin_of(m: &Obj) -> Option<&str> {
    if role(m) != "user" {
        return None;
    }
    match meta_origin(m) {
        Some(o @ ("human" | "task" | "peer" | "sdk" | "system")) => Some(o),
        _ => {
            if kind(m) == "normal" {
                Some("human")
            } else {
                Some("system")
            }
        }
    }
}

pub fn text_of(blocks: &[Value]) -> String {
    let parts: Vec<String> = blocks.iter().filter(|b| block_type(b) == "text").map(|b| js::js_string(js::prop(Some(b), "text"))).collect();
    js::trim(&parts.join("\n")).to_string()
}

/// humanText: text the owner typed in a message, or "".
pub fn human_text(m: &Obj) -> String {
    if role(m) != "user" || kind(m) != "normal" || origin_of(m) != Some("human") {
        return String::new();
    }
    text_of(content(m))
}

pub fn external_id(m: &Obj) -> Option<&str> {
    let ext = js::prop(m.get("meta"), "external");
    as_str(js::prop(ext, "id")).filter(|s| !s.is_empty())
}

pub struct Stats {
    pub messages: usize,
    pub human_prompts: usize,
    pub human_chars: usize,
    pub created_at: f64,
    pub updated_at: f64,
    pub first_ids: Vec<String>,
}

pub fn session_stats(messages: &[Obj]) -> Stats {
    let mut st = Stats { messages: messages.len(), human_prompts: 0, human_chars: 0, created_at: f64::INFINITY, updated_at: 0.0, first_ids: Vec::new() };
    for m in messages {
        let t = human_text(m);
        if !t.is_empty() {
            st.human_prompts += 1;
            st.human_chars += len16(&t);
        }
        let c = m.get("createdAt").and_then(Value::as_f64).unwrap_or(f64::NAN);
        if c < st.created_at {
            st.created_at = c;
        }
        if c > st.updated_at {
            st.updated_at = c;
        }
        if let Some(id) = external_id(m) {
            if st.first_ids.len() < 3 {
                st.first_ids.push(id.to_string());
            }
        }
    }
    if !st.created_at.is_finite() {
        st.created_at = 0.0;
    }
    st
}

pub fn fingerprint(c: &Converted, first_ids: &[String]) -> String {
    let mut parts: Vec<&str> = vec![c.source, if c.native_id_unique { c.native_id.as_deref().unwrap_or("") } else { "" }];
    parts.extend(first_ids.iter().map(String::as_str));
    sha256_hex(&parts.join("\n"))[..32].to_string()
}

pub fn source_name(s: &str) -> &str {
    match s {
        "claude-code" => "Claude Code",
        "codex" => "Codex",
        "gemini" => "Gemini CLI",
        "opencode" => "OpenCode",
        "claude-ai" => "claude.ai",
        "chatgpt" => "ChatGPT",
        other => other,
    }
}

/// A session file found on disk.
#[derive(Clone, Debug)]
pub struct Found {
    pub source: &'static str,
    pub path: String,
    pub size: u64,
    pub mtime: f64,
    pub parent: Option<String>,
    pub project: Option<String>,
    pub archived: bool,
}

impl Found {
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("source".into(), json!(self.source));
        o.insert("path".into(), json!(self.path));
        o.insert("size".into(), json!(self.size));
        o.insert("mtime".into(), num(self.mtime));
        if let Some(p) = &self.parent {
            o.insert("parent".into(), json!(p));
        }
        if self.archived {
            o.insert("archived".into(), json!(true));
        }
        if let Some(p) = &self.project {
            o.insert("project".into(), json!(p));
        }
        Value::Object(o)
    }
}

/// rowInfo: everything the list, the skip rules and the estimate need.
pub fn row_info(c: &Converted, found: &Found) -> Value {
    let st = session_stats(&c.messages);
    let mut o = Map::new();
    let id = c.native_id.clone().unwrap_or_else(|| {
        let last = found.path.rsplit('/').next().unwrap_or("");
        strip_jsonl_ext(last)
    });
    o.insert("id".into(), json!(id));
    // a title is often the first prompt: a token in it never reaches the lists
    let title = match c.title.as_deref().filter(|t| !t.is_empty()) {
        Some(t) => secrets::redact(t),
        None => format!("Untitled {} session", source_name(c.source)),
    };
    o.insert("title".into(), json!(title));
    for (k, v) in [("cwd", &c.cwd), ("gitBranch", &c.git_branch), ("repo", &c.repo), ("model", &c.model)] {
        if let Some(s) = v.as_deref().filter(|s| !s.is_empty()) {
            o.insert(k.into(), json!(s));
        }
    }
    o.insert("kind".into(), json!(c.kind));
    if let Some(p) = c.parent_native_id.as_deref().filter(|s| !s.is_empty()) {
        o.insert("parentId".into(), json!(p));
    }
    if let Some(e) = c.entrypoint.as_deref().filter(|s| !s.is_empty()) {
        o.insert("entrypoint".into(), json!(e));
    }
    o.insert("messages".into(), json!(st.messages));
    o.insert("humanPrompts".into(), json!(st.human_prompts));
    o.insert("humanChars".into(), json!(st.human_chars));
    o.insert("createdAt".into(), num(if st.created_at != 0.0 { st.created_at } else { found.mtime }));
    o.insert("updatedAt".into(), num(if st.updated_at != 0.0 { st.updated_at } else { found.mtime }));
    o.insert("fingerprint".into(), json!(fingerprint(c, &st.first_ids)));
    o.insert("estTokens".into(), json!(render::rendered_tokens(&c.messages)));
    o.insert("learnable".into(), json!(c.learnable));
    if found.archived {
        o.insert("archived".into(), json!(true));
    }
    if !c.unknown.is_empty() {
        o.insert("unknown".into(), Value::Object(c.unknown.clone()));
    }
    Value::Object(o)
}

/// `.replace(/\.jsonl?(\.zst)?$/, '')`
fn strip_jsonl_ext(name: &str) -> String {
    for ext in [".jsonl.zst", ".json.zst", ".jsonl", ".json"] {
        if let Some(s) = name.strip_suffix(ext) {
            return s.to_string();
        }
    }
    name.to_string()
}

/// clipToolResults: long tool results keep their head and tail on the device.
pub fn clip_tool_results(c: &mut Converted, max: usize) {
    for m in c.messages.iter_mut() {
        for b in content_mut(m).iter_mut() {
            let Value::Object(bo) = b else { continue };
            if as_str(bo.get("type")) != Some("tool_result") {
                continue;
            }
            let Some(Value::String(text)) = bo.get("content") else { continue };
            let n = len16(text);
            if n <= max {
                continue;
            }
            let half = max / 2;
            let clipped = format!(
                "{}\n\n[{} characters cut on the device; the full output stays in the source file]\n\n{}",
                js::slice16(text, 0, half),
                n - 2 * half,
                js::slice16(text, n - half, n)
            );
            let mut meta = match bo.get("meta") {
                Some(Value::Object(m)) => m.clone(),
                _ => Map::new(),
            };
            meta.insert("clippedFrom".into(), json!(n));
            bo.insert("content".into(), Value::String(clipped));
            bo.insert("meta".into(), Value::Object(meta));
        }
    }
}

// ---------------------------------------------------------------------------
// Files on this disk (importers/files.ts)
// ---------------------------------------------------------------------------

pub struct FoundFile {
    pub path: String,
    pub mtime_ms: f64,
    pub size: u64,
}

/// walkFiles: files whose name matches, depth first; depth 0 is `root` itself.
pub fn walk_files(root: &str, max_depth: usize, matches: &dyn Fn(&str) -> bool, skip_dir: &dyn Fn(&str, usize) -> bool) -> Vec<FoundFile> {
    let mut out = Vec::new();
    fn visit(dir: &str, depth: usize, max_depth: usize, matches: &dyn Fn(&str) -> bool, skip_dir: &dyn Fn(&str, usize) -> bool, out: &mut Vec<FoundFile>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut files = Vec::new();
        let mut dirs = Vec::new();
        for ent in rd.flatten() {
            let name = ent.file_name().to_string_lossy().into_owned();
            let p = join_slash(&[dir, &name]);
            let ft = ent.file_type().ok();
            let is_dir = ft.is_some_and(|t| t.is_dir());
            let is_file_or_link = ft.is_some_and(|t| t.is_file() || t.is_symlink());
            if is_dir {
                if depth < max_depth && !skip_dir(&name, depth) {
                    dirs.push(p);
                }
            } else if is_file_or_link && matches(&name) {
                files.push(p);
            }
        }
        for p in files {
            if let Ok(Some(s)) = crate::fsops::stat(&p) {
                if s.kind != "dir" {
                    out.push(FoundFile { path: p, mtime_ms: s.mtime_ms, size: s.size });
                }
            }
        }
        for d in dirs {
            visit(&d, depth + 1, max_depth, matches, skip_dir, out);
        }
    }
    visit(root, 0, max_depth, matches, skip_dir, &mut out);
    out
}

fn too_large(path: &str, bytes: Option<u64>, max: u64) -> WireError {
    let mb = |n: u64| js::round(n as f64 / 1_048_576.0) as u64;
    let msg = match bytes {
        Some(b) => format!("{} is too large to import ({} MB once read; the limit is {} MB)", base_name(path), mb(b), mb(max)),
        None => format!("{} is too large to import (over MB {} MB once read; the limit is {} MB)", base_name(path), mb(max), mb(max)),
    };
    WireError::coded(msg, "E2BIG")
}

/// readSessionBytes: refuse files over the limit, decompress .zst (several frames too).
pub fn read_session_bytes(path: &str) -> Res<Vec<u8>> {
    let max = MAX_SESSION_BYTES;
    if let Ok(Some(st)) = crate::fsops::stat(path) {
        if st.size > max {
            return Err(too_large(path, Some(st.size), max));
        }
    }
    let bytes = crate::fsops::read_bytes(path)?;
    if bytes.len() as u64 > max {
        return Err(too_large(path, Some(bytes.len() as u64), max));
    }
    if !path.ends_with(".zst") {
        return Ok(bytes);
    }
    zstd_decompress(&bytes, max).map_err(|e| match e {
        None => too_large(path, None, max),
        Some(msg) => WireError::new(msg),
    })
}

fn zstd_decompress(data: &[u8], max: u64) -> Result<Vec<u8>, Option<String>> {
    use std::io::Read;
    let mut out = Vec::new();
    let mut rest = data;
    while !rest.is_empty() {
        let mut cursor = std::io::Cursor::new(rest);
        let mut dec = ruzstd::decoding::StreamingDecoder::new(&mut cursor).map_err(|e| Some(e.to_string()))?;
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = dec.read(&mut buf).map_err(|e| Some(e.to_string()))?;
            if n == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n]);
            if out.len() as u64 > max {
                return Err(None);
            }
        }
        drop(dec);
        let used = cursor.position() as usize;
        if used == 0 {
            break;
        }
        rest = &rest[used..];
        // skippable frames and trailing zero padding end the stream
        if rest.iter().all(|b| *b == 0) {
            break;
        }
    }
    Ok(out)
}

/// readSessionText: the same size limit, then the file as text.
pub fn read_session_text(path: &str) -> Res<String> {
    if let Ok(Some(st)) = crate::fsops::stat(path) {
        if st.size > MAX_SESSION_BYTES {
            return Err(too_large(path, Some(st.size), MAX_SESSION_BYTES));
        }
    }
    crate::fsops::read_text_string(path)
}

/// `machine.resolve('~/.claude', '/')` and friends on this disk.
pub fn home_root(home: &str, name: &str) -> String {
    crate::paths::resolve_with(&format!("~/{name}"), "/", home, cfg!(windows))
}

// ---------------------------------------------------------------------------
// Reading sessions (import/sources.ts ReadContext)
// ---------------------------------------------------------------------------

pub struct ReadContext {
    home: String,
    titles: OnceLock<HashMap<String, String>>,
    projects: OnceLock<HashMap<String, String>>,
    threads: Mutex<Option<HashMap<String, String>>>,
    bases: Mutex<HashMap<String, Converted>>,
}

impl ReadContext {
    pub fn new(home: &str, threads: Option<HashMap<String, String>>) -> Self {
        ReadContext { home: home.to_string(), titles: OnceLock::new(), projects: OnceLock::new(), threads: Mutex::new(threads), bases: Mutex::new(HashMap::new()) }
    }

    fn codex_titles(&self) -> &HashMap<String, String> {
        self.titles.get_or_init(|| codex::titles(&self.home))
    }

    fn gemini_projects(&self) -> &HashMap<String, String> {
        self.projects.get_or_init(|| gemini::projects(&self.home))
    }

    fn thread_path(&self, thread_id: &str) -> Option<String> {
        let mut g = self.threads.lock().unwrap();
        if g.is_none() {
            let mut m = HashMap::new();
            for f in codex::files(&self.home) {
                if let Some(r) = codex::parse_rollout_name(&f.path) {
                    m.entry(r.thread_id).or_insert(f.path.clone());
                }
            }
            *g = Some(m);
        }
        g.as_ref().and_then(|m| m.get(thread_id).cloned())
    }

    /// The converted base thread of a paginated fork (forks of forks to depth 4).
    fn codex_base(&self, thread_id: &str, depth: usize, chain: &[String]) -> Res<Option<Converted>> {
        if let Some(c) = self.bases.lock().unwrap().get(thread_id) {
            return Ok(Some(c.clone()));
        }
        if chain.iter().any(|c| c == thread_id) || depth > 4 {
            return Ok(None);
        }
        let Some(path) = self.thread_path(thread_id) else { return Ok(None) };
        let conv = self.read(&Found { source: "codex", path, size: 0, mtime: 0.0, parent: None, project: None, archived: false }, depth + 1, chain)?;
        // a result cut short by a loop is not cached: a read from outside the loop may get further
        if !conv.unknown.contains_key("history_base:loop") {
            self.bases.lock().unwrap().insert(thread_id.to_string(), conv.clone());
        }
        Ok(Some(conv))
    }

    /// Read and convert one session file.
    pub fn read(&self, found: &Found, depth: usize, chain: &[String]) -> Res<Converted> {
        match found.source {
            "claude-code" => {
                let bytes = read_session_bytes(&found.path)?;
                Ok(claude::convert(&bytes, found.parent.is_some(), found.parent.clone()))
            }
            "codex" => {
                let bytes = read_session_bytes(&found.path)?;
                let hb = codex::history_base_of_bytes(&bytes);
                let id = codex::parse_rollout_name(&found.path).map(|r| r.thread_id);
                let mut here: Vec<String> = chain.to_vec();
                if let Some(i) = &id {
                    if !here.contains(i) {
                        here.push(i.clone());
                    }
                }
                let looped = hb.as_ref().is_some_and(|h| here.contains(&h.thread_id));
                let base = match &hb {
                    Some(h) if !looped => self.codex_base(&h.thread_id, depth, &here)?,
                    _ => None,
                };
                let title = id.as_ref().and_then(|i| self.codex_titles().get(i).cloned());
                let mut conv = codex::convert(&bytes, title, base.as_ref(), Some(&found.path));
                if looped {
                    conv.unknown.insert("history_base:loop".into(), json!(1));
                }
                Ok(conv)
            }
            "gemini" => {
                let text = read_session_text(&found.path)?;
                // the project dir is the folder above chats/ (a single file read later has no scan row to say so)
                let project = found.project.clone().or_else(|| gemini::project_of_path(&found.path));
                let cwd = project.and_then(|p| self.gemini_projects().get(&p).cloned());
                gemini::convert(&text, cwd, Some(&found.path))
            }
            other => Err(WireError::new(format!("{} sessions are not read from devices.", source_name(other)))),
        }
    }
}

/// discover: every session file of the given sources, with size and mtime.
pub fn discover(home: &str, sources: &[String]) -> (Vec<Found>, Vec<Value>) {
    let mut found = Vec::new();
    for s in sources {
        match s.as_str() {
            "claude-code" => {
                for f in claude::files(home) {
                    found.push(Found { source: "claude-code", path: f.0.path, size: f.0.size, mtime: js::round(f.0.mtime_ms), parent: f.1, project: None, archived: false });
                }
            }
            "codex" => {
                for (f, archived) in codex::files_with_archived(home) {
                    found.push(Found { source: "codex", path: f.path, size: f.size, mtime: js::round(f.mtime_ms), parent: None, project: None, archived });
                }
            }
            "gemini" => {
                for (f, project) in gemini::files(home) {
                    found.push(Found { source: "gemini", path: f.path, size: f.size, mtime: js::round(f.mtime_ms), parent: None, project: Some(project), archived: false });
                }
            }
            _ => {}
        }
    }
    // the walks never fail as a whole (a missing folder is just empty)
    (found, Vec::new())
}

fn param_sources(p: &Value) -> Vec<String> {
    match p.get("sources") {
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        _ => DEVICE_SOURCES.iter().map(|s| s.to_string()).collect(),
    }
}

/// importScan: rows for new or changed files, plus every file present.
pub fn scan(params: &Value) -> Res<Value> {
    let home = crate::paths::home_dir();
    let sources = param_sources(params);
    let mut known: HashMap<String, (f64, f64)> = HashMap::new();
    if let Some(Value::Array(list)) = params.get("known") {
        for k in list {
            if let Some(a) = k.as_array() {
                if let (Some(p), Some(size), Some(mtime)) = (a.first().and_then(Value::as_str), a.get(1).and_then(Value::as_f64), a.get(2).and_then(Value::as_f64)) {
                    known.insert(p.to_string(), (size, mtime));
                }
            }
        }
    }
    let concurrency = params.get("concurrency").and_then(Value::as_f64).map(|n| n.max(1.0) as usize).unwrap_or(4).min(8);
    let (found, failed) = discover(&home, &sources);
    let changed: Vec<&Found> = found.iter().filter(|f| known.get(&f.path).is_none_or(|(s, m)| *s != f.size as f64 || *m != f.mtime)).collect();
    let mut threads = HashMap::new();
    for f in &found {
        if f.source != "codex" {
            continue;
        }
        if let Some(r) = codex::parse_rollout_name(&f.path) {
            threads.entry(r.thread_id).or_insert(f.path.clone());
        }
    }
    let ctx = ReadContext::new(&home, Some(threads));
    let next = std::sync::atomic::AtomicUsize::new(0);
    let rows = Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for _ in 0..concurrency.min(changed.len()).max(1) {
            s.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let Some(f) = changed.get(i) else { break };
                let row = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| ctx.read(f, 0, &[]))) {
                    Ok(Ok(c)) => json!({ "found": f.to_json(), "info": row_info(&c, f) }),
                    Ok(Err(e)) => json!({ "found": f.to_json(), "error": e.message }),
                    Err(_) => json!({ "found": f.to_json(), "error": "the reader failed on this file" }),
                };
                rows.lock().unwrap().push(row);
            });
        }
    });
    let rows = rows.into_inner().unwrap();
    Ok(json!({
        "rows": rows,
        "present": found.iter().map(Found::to_json).collect::<Vec<_>>(),
        "failed": failed,
    }))
}

/// importRead: one session, converted, with long tool results cut.
pub fn read(params: &Value) -> Res<Value> {
    let home = crate::paths::home_dir();
    let path = as_str(params.get("path")).unwrap_or("").to_string();
    let source = match as_str(params.get("source")).unwrap_or("") {
        "claude-code" => "claude-code",
        "codex" => "codex",
        "gemini" => "gemini",
        "opencode" => "opencode",
        "claude-ai" => "claude-ai",
        "chatgpt" => "chatgpt",
        _ => "unknown",
    };
    let Some(st) = crate::fsops::stat(&path)? else {
        return Err(WireError::coded(format!("{path} is not on this device any more"), "ENOENT"));
    };
    let parent = as_str(params.get("parent")).filter(|s| !s.is_empty()).map(str::to_string);
    let found = Found { source, path: path.clone(), size: st.size, mtime: js::round(st.mtime_ms), parent, project: None, archived: false };
    let ctx = ReadContext::new(&home, None);
    let mut conv = ctx.read(&found, 0, &[])?;
    let max = params.get("maxToolChars").and_then(Value::as_f64).map(|n| n as usize).unwrap_or(DEVICE_TOOL_CHARS).max(2_000);
    clip_tool_results(&mut conv, max);
    Ok(conv.to_json())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_and_ids() {
        assert_eq!(truncate_title("  hello \n\t world  "), "hello world");
        let long = "x".repeat(100);
        assert_eq!(truncate_title(&long), format!("{}...", "x".repeat(77)));
        assert_eq!(sanitize_tool_id("toolu_01:ab.c"), "toolu_01_ab_c");
        assert_eq!(sanitize_tool_id("a😀"), "a__");
        assert!(sanitize_tool_id("").starts_with("toolu_"));
        assert_eq!(sanitize_tool_id(&"y".repeat(80)).len(), 64);
        assert_eq!(strip_jsonl_ext("rollout-x.jsonl.zst"), "rollout-x");
        assert_eq!(strip_jsonl_ext("a.json"), "a");
    }

    #[test]
    fn fingerprints_match_sources_ts() {
        let c = Converted { source: "codex", native_id: Some("abc".into()), native_id_unique: true, kind: "main", learnable: true, ..Default::default() };
        // sha256("codex\nabc\ni0\ni1") first 32 hex characters
        assert_eq!(fingerprint(&c, &["i0".into(), "i1".into()]), sha256_hex("codex\nabc\ni0\ni1")[..32].to_string());
        assert_eq!(sha256_hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn clip_keeps_head_and_tail() {
        let mut c = Converted { source: "codex", kind: "main", ..Default::default() };
        let long = format!("{}{}", "a".repeat(3000), "b".repeat(3000));
        c.messages.push(message("user", "normal", vec![json!({ "type": "tool_result", "toolUseId": "t", "content": long, "meta": { "external": true } })], 1.0, json!({})));
        clip_tool_results(&mut c, 2000);
        let b = &content(&c.messages[0])[0];
        let text = b["content"].as_str().unwrap();
        assert!(text.starts_with(&"a".repeat(1000)));
        assert!(text.contains("[4000 characters cut on the device; the full output stays in the source file]"));
        assert!(text.ends_with(&"b".repeat(1000)));
        assert_eq!(b["meta"]["clippedFrom"], 6000);
        assert_eq!(b["meta"]["external"], true);
    }

    #[test]
    fn jsonl_skips_junk() {
        let lines = parse_jsonl(b"{\"a\":1}\n\nnot json\n[1,2]\n  {\"b\":2}  \r\n{\"c\":3}");
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[2].get("c"), Some(&json!(3)));
    }
}
