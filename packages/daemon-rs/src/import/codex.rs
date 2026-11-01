//! Codex rollouts (importers/codex.ts): ~/.codex/sessions/YYYY/MM/DD and
//! ~/.codex/archived_sessions, rollout-<time>-<threadId>[_<rolloutId>].jsonl[.zst].
//! Every message carries meta.external.id, the ordinal of its first response
//! item in the thread's whole history, so a paginated fork lines up with its base.

use super::{bump, content, content_mut, kind, meta_origin, role, sanitize_tool_id, text_block, truncate_title, Converted, FoundFile};
use crate::js::{self, as_str, coalesce, is_obj, js_string, nullish, prop, Obj};
use crate::paths::{base_name, join_slash};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

const UUID: &str = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const META_PREFIXES: &[&str] = &["<environment_context>", "<user_instructions>", "<permissions instructions>", "# AGENTS.md instructions", "<INSTRUCTIONS>", "<user_shell_command>", "<turn_aborted>"];
const KNOWN_LINES: &[&str] = &["session_meta", "turn_context", "response_item", "event_msg", "compacted"];
const KNOWN_ITEMS: &[&str] = &["message", "reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "local_shell_call", "web_search_call", "ghost_snapshot", "compaction"];
/// Codex's own memory and review threads: never learned from.
const NOT_LEARNED: &[&str] = &["memory_consolidation", "guardian_review"];

pub fn is_meta_text(text: &str) -> bool {
    let t = js::trim_start(text);
    META_PREFIXES.iter().any(|p| t.starts_with(p))
}

/// A user message one agent sent another, not the owner.
fn origin(text: &str) -> &'static str {
    static PEER: OnceLock<Regex> = OnceLock::new();
    let t = js::trim_start(text);
    if t.starts_with("<subagent_notification>") {
        return "task";
    }
    // JavaScript's "." stops at any line terminator
    let peer = PEER.get_or_init(|| {
        let dot = r"[^\n\r\x{2028}\x{2029}]";
        Regex::new(&format!(r"(?m)^Message Type:{dot}*\n(?:{dot}*\n)*?Task name:{dot}*\n(?:{dot}*\n)*?Sender:{dot}*\n(?:{dot}*\n)*?Payload:")).unwrap()
    });
    if peer.is_match(t) {
        return "peer";
    }
    "human"
}

pub struct Rollout {
    pub thread_id: String,
}

/// Thread id from a file name (the time and the optional rollout id are not needed here).
pub fn parse_rollout_name(path: &str) -> Option<Rollout> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(&format!(r"(?i)^rollout-([0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}}T[0-9]{{2}}-[0-9]{{2}}-[0-9]{{2}})-({UUID})(?:_([A-Za-z0-9-]+))?\.jsonl(?:\.zst)?$")).unwrap());
    let c = re.captures(base_name(path))?;
    Some(Rollout { thread_id: c[2].to_lowercase() })
}

fn root(home: &str) -> String {
    super::home_root(home, ".codex")
}

/// Rollouts under sessions/ and archived_sessions/, with the archived flag.
pub fn files_with_archived(home: &str) -> Vec<(FoundFile, bool)> {
    let base = root(home);
    let matches = |n: &str| n.starts_with("rollout-") && (n.ends_with(".jsonl") || n.ends_with(".jsonl.zst"));
    let live = super::walk_files(&join_slash(&[&base, "sessions"]), 3, &matches, &|_, _| false);
    let archived = super::walk_files(&join_slash(&[&base, "archived_sessions"]), 3, &matches, &|_, _| false);
    live.into_iter().map(|f| (f, false)).chain(archived.into_iter().map(|f| (f, true))).collect()
}

pub fn files(home: &str) -> Vec<FoundFile> {
    files_with_archived(home).into_iter().map(|(f, _)| f).collect()
}

/// Titles from ~/.codex/session_index.jsonl: the last entry for a thread wins.
pub fn titles(home: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(text) = crate::fsops::read_text_string(&join_slash(&[&root(home), "session_index.jsonl"])) else { return out };
    for l in super::parse_jsonl(text.as_bytes()) {
        let id = coalesce(&[l.get("id"), l.get("thread_id"), l.get("threadId")]);
        let name = coalesce(&[l.get("thread_name"), l.get("title"), l.get("name")]);
        if let (Some(id), Some(name)) = (as_str(id), as_str(name)) {
            let n = js::trim(name);
            if !n.is_empty() {
                out.insert(id.to_lowercase(), n.to_string());
            }
        }
    }
    out
}

pub struct HistoryBase {
    pub thread_id: String,
    pub items: f64,
}

fn history_base_of(p: &Value) -> Option<HistoryBase> {
    let h = p.get("history_base");
    if !js::is_object_like(h) {
        return None;
    }
    let thread_id = as_str(coalesce(&[prop(h, "thread_id"), prop(h, "threadId"), prop(h, "id")]))?;
    let items = coalesce(&[prop(h, "items"), prop(h, "item_count"), prop(h, "upto"), prop(h, "ordinal"), prop(h, "count")])?.as_f64()?;
    if items < 0.0 {
        return None;
    }
    Some(HistoryBase { thread_id: thread_id.to_lowercase(), items: items.floor() })
}

/// session_meta of a rollout, read from its first 64 KiB.
pub fn meta_of_bytes(bytes: &[u8]) -> Option<Value> {
    let head = &bytes[..bytes.len().min(65_536)];
    for l in super::parse_jsonl(head) {
        if as_str(l.get("type")) == Some("session_meta") {
            return Some(match l.get("payload") {
                None | Some(Value::Null) => json!({}),
                Some(p) => p.clone(),
            });
        }
    }
    None
}

pub fn history_base_of_bytes(bytes: &[u8]) -> Option<HistoryBase> {
    meta_of_bytes(bytes).and_then(|m| history_base_of(&m))
}

struct KindInfo {
    kind: &'static str,
    parent: Option<String>,
    learnable: bool,
    entrypoint: Option<String>,
}

fn kind_of(meta: Option<&Value>) -> KindInfo {
    let Some(meta) = meta else { return KindInfo { kind: "main", parent: None, learnable: true, entrypoint: None } };
    let src = meta.get("source");
    let thread_source = as_str(meta.get("thread_source")).map(str::to_string);
    let learnable = !(thread_source.as_deref().is_some_and(|t| !t.is_empty() && NOT_LEARNED.contains(&t))) && !as_str(src).is_some_and(|s| NOT_LEARNED.contains(&s));
    let src_obj = js::is_object_like(src);
    let from_src = if src_obj { coalesce(&[prop(prop(src, "subagent"), "parent_thread_id"), prop(prop(src, "subagent"), "thread_id")]) } else { None };
    let parent = coalesce(&[from_src, meta.get("parent_thread_id"), meta.get("forked_from_id")]);
    let entrypoint = match src {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Object(o)) => o.keys().next().cloned(),
        Some(Value::Array(a)) => {
            if a.is_empty() {
                None
            } else {
                Some("0".to_string())
            }
        }
        _ => None,
    };
    let has_subagent_key = matches!(src, Some(Value::Object(o)) if o.contains_key("subagent"));
    let ts = thread_source.as_deref();
    let kind = if has_subagent_key || as_str(src) == Some("subagent") || ts == Some("subagent") {
        "subagent"
    } else if as_str(src) == Some("internal") || ts.is_some_and(|t| !t.is_empty() && t != "user") {
        "internal"
    } else if matches!(as_str(src), Some("exec") | Some("mcp")) {
        "automation"
    } else {
        "main"
    };
    KindInfo { kind, parent: as_str(parent).map(js::lower), learnable, entrypoint }
}

fn ext(id: &str) -> Value {
    json!({ "source": "codex", "id": id })
}

/// The id of a base message as an ordinal ("i12" -> 12), or infinity.
fn ordinal_of(m: &Obj) -> f64 {
    match super::external_id(m) {
        Some(id) if id.len() > 1 && id.starts_with('i') && id[1..].bytes().all(|b| b.is_ascii_digit()) => id[1..].parse().unwrap_or(f64::INFINITY),
        _ => f64::INFINITY,
    }
}

struct Builder {
    out: Vec<Obj>,
    model: Option<String>,
}

impl Builder {
    fn assistant(&mut self, ts: f64, id: &str) -> &mut Obj {
        let reuse = self.out.last().is_some_and(|m| role(m) == "assistant" && kind(m) == "normal");
        if !reuse {
            let mut n = super::message("assistant", "normal", vec![], ts, json!({ "external": ext(id) }));
            if let Some(model) = &self.model {
                n.insert("model".into(), json!(format!("openai/{model}")));
            }
            self.out.push(n);
        }
        self.out.last_mut().unwrap()
    }

    fn tool_results(&mut self, ts: f64, id: &str) -> &mut Obj {
        let reuse = self.out.last().is_some_and(|m| role(m) == "user" && kind(m) == "normal" && meta_origin(m) == Some("system") && content(m).iter().all(|b| super::block_type(b) == "tool_result"));
        if !reuse {
            self.out.push(super::message("user", "normal", vec![], ts, json!({ "external": ext(id), "origin": "system" })));
        }
        self.out.last_mut().unwrap()
    }

    fn user_text(&mut self, ts: f64, id: &str, blocks: Vec<Value>) {
        let text = blocks.iter().filter(|b| super::block_type(b) == "text").map(|b| js_string(prop(Some(b), "text"))).collect::<Vec<_>>().join("\n");
        let o = origin(&text);
        // one user turn can be several input items
        if let Some(m) = self.out.last_mut() {
            if role(m) == "user" && kind(m) == "normal" && meta_origin(m) == Some("human") && o == "human" {
                content_mut(m).extend(blocks);
                return;
            }
        }
        if o == "human" {
            self.out.push(super::message("user", "normal", blocks, ts, json!({ "external": ext(id), "origin": o })));
        } else {
            let mut m = Map::new();
            m.insert("role".into(), json!("user"));
            m.insert("kind".into(), json!("aside"));
            m.insert("author".into(), json!(if o == "task" { "Background task" } else { "Peer agent" }));
            m.insert("content".into(), Value::Array(blocks));
            m.insert("createdAt".into(), js::num(ts));
            m.insert("meta".into(), json!({ "external": ext(id), "origin": o }));
            self.out.push(m);
        }
    }
}

fn tool_id(p: &Value, keys: &[&str]) -> String {
    let vals: Vec<Option<&Value>> = keys.iter().map(|k| p.get(*k)).collect();
    coalesce(&vals).map(|v| js_string(Some(v))).unwrap_or_default()
}

/// Convert a Codex rollout. Pass the converted base thread as `base` to put its shared items first.
pub fn convert(bytes: &[u8], title: Option<String>, base: Option<&Converted>, path: Option<&str>) -> Converted {
    let mut unknown = Map::new();
    let lines = super::parse_jsonl(bytes);
    let has_items = lines.iter().any(|l| as_str(l.get("type")) == Some("response_item") && as_str(prop(l.get("payload"), "type")) == Some("message"));
    let meta: Option<Value> = lines.iter().find(|l| as_str(l.get("type")) == Some("session_meta")).map(|l| match l.get("payload") {
        None | Some(Value::Null) => json!({}),
        Some(p) => p.clone(),
    });
    let hb = meta.as_ref().and_then(history_base_of);
    let mut b = Builder { out: Vec::new(), model: None };
    let mut ordinal: f64 = 0.0;
    match (&hb, base) {
        (Some(h), Some(base)) => {
            for m in &base.messages {
                if ordinal_of(m) < h.items {
                    b.out.push(m.clone());
                }
            }
            ordinal = h.items;
        }
        (Some(_), None) => bump(&mut unknown, "history_base:missing"),
        _ => {}
    }
    let mut cwd: Option<String> = meta.as_ref().and_then(|m| as_str(m.get("cwd"))).map(str::to_string);
    let mut last_ts = 0.0;
    let empty = json!({});
    let next_id = |prefix: &str, ordinal: &mut f64| {
        let id = format!("{prefix}{}", js::num_to_string(*ordinal));
        *ordinal += 1.0;
        id
    };

    for l in &lines {
        let ts = js::parse_time(l.get("timestamp"), last_ts);
        if ts != 0.0 && !ts.is_nan() {
            last_ts = ts;
        }
        let p = match l.get("payload") {
            None | Some(Value::Null) => &empty,
            Some(v) => v,
        };
        let ty = match l.get("type") {
            Some(Value::String(t)) if KNOWN_LINES.contains(&t.as_str()) => t.as_str(),
            other => {
                let name = if nullish(other) { "none".to_string() } else { js_string(other) };
                bump(&mut unknown, &format!("line:{name}"));
                continue;
            }
        };
        if ty == "turn_context" {
            if let Some(m) = as_str(prop(Some(p), "model")) {
                b.model = Some(m.to_string());
            }
            if cwd.is_none() {
                if let Some(c) = as_str(prop(Some(p), "cwd")) {
                    cwd = Some(c.to_string());
                }
            }
            continue;
        }
        if ty == "compacted" {
            if let Some(msg) = as_str(prop(Some(p), "message")).filter(|m| !js::trim(m).is_empty()) {
                let id = format!("c{}", js::num_to_string(ordinal));
                b.out.push(super::message("user", "summary", vec![text_block(msg)], ts, json!({ "external": ext(&id), "origin": "system" })));
                continue;
            }
        }
        if !has_items && ty == "event_msg" {
            // very old rollouts: fall back to UI events
            let id = next_id("e", &mut ordinal);
            let pt = as_str(prop(Some(p), "type"));
            let msg = as_str(prop(Some(p), "message"));
            if pt == Some("user_message") && msg.is_some_and(|m| !is_meta_text(m)) {
                b.user_text(ts, &id, vec![text_block(msg.unwrap())]);
            } else if pt == Some("agent_message") && msg.is_some() {
                content_mut(b.assistant(ts, &id)).push(text_block(msg.unwrap()));
            }
            continue;
        }
        if ty != "response_item" {
            continue;
        }
        let id = next_id("i", &mut ordinal);
        let item = prop(Some(p), "type");
        if !as_str(item).is_some_and(|t| KNOWN_ITEMS.contains(&t)) {
            bump(&mut unknown, &format!("item:{}", js_string(item)));
        }
        match as_str(item) {
            Some("message") => match as_str(prop(Some(p), "role")) {
                Some("user") => {
                    let blocks = user_content(prop(Some(p), "content"));
                    if !blocks.is_empty() {
                        b.user_text(ts, &id, blocks);
                    }
                }
                Some("assistant") => {
                    let t = message_text(prop(Some(p), "content"));
                    if !t.is_empty() {
                        content_mut(b.assistant(ts, &id)).push(text_block(&t));
                    }
                }
                _ => {}
            },
            Some("reasoning") => {
                let mut parts: Vec<String> = Vec::new();
                for key in ["summary", "content"] {
                    if let Some(Value::Array(a)) = prop(Some(p), key) {
                        for s in a {
                            if let Some(t) = as_str(prop(Some(s), "text")) {
                                parts.push(t.to_string());
                            }
                        }
                    }
                }
                if !parts.is_empty() {
                    content_mut(b.assistant(ts, &id)).push(json!({ "type": "thinking", "thinking": parts.join("\n\n") }));
                }
            }
            Some("function_call") => {
                let tid = sanitize_tool_id(&tool_id(p, &["call_id", "id"]));
                let name = coalesce(&[prop(Some(p), "name")]).map(|v| js_string(Some(v))).unwrap_or_else(|| "function".into());
                content_mut(b.assistant(ts, &id)).push(json!({ "type": "tool_use", "id": tid, "name": name, "input": parse_args(prop(Some(p), "arguments")) }));
            }
            Some("custom_tool_call") => {
                let tid = sanitize_tool_id(&tool_id(p, &["call_id", "id"]));
                let name = coalesce(&[prop(Some(p), "name")]).map(|v| js_string(Some(v))).unwrap_or_else(|| "tool".into());
                let input = match prop(Some(p), "input") {
                    None => json!({}),
                    Some(v) => json!({ "input": v }),
                };
                content_mut(b.assistant(ts, &id)).push(json!({ "type": "tool_use", "id": tid, "name": name, "input": input }));
            }
            Some("local_shell_call") | Some("web_search_call") => {
                let tid = sanitize_tool_id(&tool_id(p, &["call_id", "id"]));
                let name = if as_str(item) == Some("local_shell_call") { "shell" } else { "web_search" };
                let input = if is_obj(prop(Some(p), "action")) { prop(Some(p), "action").unwrap().clone() } else { json!({}) };
                content_mut(b.assistant(ts, &id)).push(json!({ "type": "tool_use", "id": tid.clone(), "name": name, "input": input }));
                if name == "web_search" {
                    // no output item follows a web search; close it so transcripts stay valid
                    let status = coalesce(&[prop(Some(p), "status")]).map(|v| js_string(Some(v))).unwrap_or_else(|| "completed".into());
                    content_mut(b.tool_results(ts, &id)).push(json!({ "type": "tool_result", "toolUseId": tid, "content": status, "meta": { "external": true } }));
                }
            }
            Some("function_call_output") | Some("custom_tool_call_output") => {
                let (text, exit) = output_text(prop(Some(p), "output"));
                let tid = sanitize_tool_id(&tool_id(p, &["call_id"]));
                let mut o = Map::new();
                o.insert("type".into(), json!("tool_result"));
                o.insert("toolUseId".into(), json!(tid));
                o.insert("content".into(), text);
                if exit.as_ref().is_some_and(|c| c.as_f64() != Some(0.0)) {
                    o.insert("isError".into(), json!(true));
                }
                let mut meta = Map::new();
                meta.insert("external".into(), json!(true));
                if let Some(c) = exit {
                    meta.insert("exitCode".into(), c);
                }
                o.insert("meta".into(), Value::Object(meta));
                content_mut(b.tool_results(ts, &id)).push(Value::Object(o));
            }
            _ => {}
        }
    }

    let k = kind_of(meta.as_ref());
    let native_id = meta.as_ref().and_then(|m| as_str(m.get("id"))).map(js::lower).or_else(|| path.and_then(parse_rollout_name).map(|r| r.thread_id));
    let messages: Vec<Obj> = b.out.into_iter().filter(|m| !content(m).is_empty()).collect();
    let first_text = messages
        .iter()
        .find(|m| role(m) == "user" && kind(m) == "normal" && meta_origin(m) == Some("human"))
        .and_then(|m| content(m).iter().find(|bl| super::block_type(bl) == "text"))
        .map(|bl| js_string(prop(Some(bl), "text")));
    let title = title.or(first_text);
    let git = meta.as_ref().and_then(|m| m.get("git")).filter(|g| js::is_object_like(Some(g)));
    Converted {
        source: "codex",
        native_id,
        native_id_unique: true,
        title: title.filter(|t| !t.is_empty()).map(|t| truncate_title(&t)),
        cwd,
        git_branch: as_str(prop(git, "branch")).map(str::to_string),
        repo: as_str(prop(git, "repository_url")).map(str::to_string),
        model: b.model.map(|m| format!("openai/{m}")),
        kind: k.kind,
        parent_native_id: k.parent,
        entrypoint: k.entrypoint,
        messages,
        unknown,
        learnable: k.learnable,
    }
}

/// Join the text parts of an assistant message.
fn message_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => {
            let parts: Vec<&str> = a.iter().filter(|c| matches!(as_str(prop(Some(c), "type")), Some("input_text" | "output_text" | "text"))).filter_map(|c| as_str(prop(Some(c), "text"))).collect();
            js::trim(&parts.join("\n")).to_string()
        }
        _ => String::new(),
    }
}

fn data_url(s: &str) -> Option<(String, String)> {
    let rest = s.strip_prefix("data:")?;
    let semi = rest.find(';')?;
    let media = &rest[..semi];
    if media.is_empty() {
        return None;
    }
    let data = rest[semi..].strip_prefix(";base64,")?;
    Some((media.to_string(), data.to_string()))
}

fn user_content(content: Option<&Value>) -> Vec<Value> {
    match content {
        Some(Value::String(s)) => {
            if is_meta_text(s) || js::trim(s).is_empty() {
                vec![]
            } else {
                vec![text_block(s)]
            }
        }
        Some(Value::Array(a)) => {
            let mut out = Vec::new();
            for c in a {
                let t = as_str(prop(Some(c), "type"));
                if matches!(t, Some("input_text" | "text")) && as_str(prop(Some(c), "text")).is_some() {
                    let text = as_str(prop(Some(c), "text")).unwrap();
                    if !is_meta_text(text) && !js::trim(text).is_empty() {
                        out.push(text_block(text));
                    }
                } else if t == Some("input_image") {
                    if let Some(url) = as_str(prop(Some(c), "image_url")) {
                        out.push(match data_url(url) {
                            Some((media, data)) => json!({ "type": "image", "mediaType": media, "data": data }),
                            None => json!({ "type": "image", "mediaType": "image/png", "url": url }),
                        });
                    }
                }
            }
            out
        }
        _ => vec![],
    }
}

fn parse_args(args: Option<&Value>) -> Value {
    match args {
        Some(Value::Object(_)) => args.unwrap().clone(),
        Some(Value::String(s)) => match js::parse_json(s) {
            Ok(v @ Value::Object(_)) => v,
            Ok(v) => json!({ "arguments": v }),
            Err(_) => json!({ "arguments": s }),
        },
        _ => json!({}),
    }
}

/// Function outputs are a string, a JSON string {output, metadata}, or content items.
fn output_text(output: Option<&Value>) -> (Value, Option<Value>) {
    match output {
        Some(Value::String(s)) => {
            if s.starts_with('{') {
                if let Ok(Value::Object(v)) = js::parse_json(s) {
                    if let Some(Value::String(out)) = v.get("output") {
                        let code = prop(v.get("metadata"), "exit_code").filter(|c| c.is_number()).cloned();
                        return (Value::String(out.clone()), code);
                    }
                }
            }
            (Value::String(s.clone()), None)
        }
        Some(Value::Array(a)) => {
            let mut parts: Vec<Value> = Vec::new();
            for c in a {
                if let Some(t) = as_str(prop(Some(c), "text")) {
                    parts.push(text_block(t));
                } else if as_str(prop(Some(c), "type")) == Some("input_image") {
                    if let Some((media, data)) = as_str(prop(Some(c), "image_url")).and_then(data_url) {
                        parts.push(json!({ "type": "image", "mediaType": media, "data": data }));
                    }
                }
            }
            if parts.iter().all(|x| super::block_type(x) == "text") {
                (Value::String(parts.iter().map(|x| js_string(prop(Some(x), "text"))).collect::<Vec<_>>().join("\n")), None)
            } else {
                (Value::Array(parts), None)
            }
        }
        Some(Value::Object(o)) => match o.get("content") {
            Some(Value::String(c)) => (Value::String(c.clone()), None),
            _ => (Value::String(js::stringify(output.unwrap())), None),
        },
        None | Some(Value::Null) => (Value::String(String::new()), None),
        Some(other) => (Value::String(js_string(Some(other))), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rollout_names() {
        let r = parse_rollout_name("/x/rollout-2025-09-12T10-00-00-0199A0B1-2c3d-4e5f-8a9b-0c1d2e3f4a5b_r2.jsonl.zst").unwrap();
        assert_eq!(r.thread_id, "0199a0b1-2c3d-4e5f-8a9b-0c1d2e3f4a5b");
        assert!(parse_rollout_name("/x/rollout-bad.jsonl").is_none());
    }

    #[test]
    fn converts_items_and_outputs() {
        let text = [
            r#"{"timestamp":"2025-09-12T10:00:00Z","type":"session_meta","payload":{"id":"0199A0B1-2C3D-4E5F-8A9B-0C1D2E3F4A5B","cwd":"/w","source":"cli","git":{"branch":"main","repository_url":"git@github.com:a/b.git"}}}"#,
            r#"{"timestamp":"2025-09-12T10:00:01Z","type":"turn_context","payload":{"model":"gpt-5"}}"#,
            r#"{"timestamp":"2025-09-12T10:00:02Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"},{"type":"input_text","text":"fix the bug"}]}}"#,
            r#"{"timestamp":"2025-09-12T10:00:03Z","type":"response_item","payload":{"type":"function_call","call_id":"call_1","name":"shell","arguments":"{\"command\":[\"ls\"]}"}}"#,
            r#"{"timestamp":"2025-09-12T10:00:04Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"{\"output\":\"a.txt\",\"metadata\":{\"exit_code\":1}}"}}"#,
            r#"{"timestamp":"2025-09-12T10:00:05Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}"#,
            r#"{"type":"mystery"}"#,
        ]
        .join("\n");
        let c = convert(text.as_bytes(), None, None, None);
        assert_eq!(c.native_id.as_deref(), Some("0199a0b1-2c3d-4e5f-8a9b-0c1d2e3f4a5b"));
        assert_eq!(c.title.as_deref(), Some("fix the bug"));
        assert_eq!(c.model.as_deref(), Some("openai/gpt-5"));
        assert_eq!(c.git_branch.as_deref(), Some("main"));
        assert_eq!(c.entrypoint.as_deref(), Some("cli"));
        assert_eq!(c.messages.len(), 4);
        let tr = &content(&c.messages[2])[0];
        assert_eq!(tr["content"], "a.txt");
        assert_eq!(tr["isError"], true);
        assert_eq!(tr["meta"]["exitCode"], 1);
        assert_eq!(c.messages[3]["meta"]["external"]["id"], "i3");
        assert_eq!(c.unknown.get("line:mystery"), Some(&json!(1)));
    }
}
