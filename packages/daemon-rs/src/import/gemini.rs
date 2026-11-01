//! Gemini CLI chats (importers/gemini.ts): ~/.gemini/tmp/<project>/chats/.
//! session-*.jsonl replays $rewindTo, $patch and $set records; older builds
//! wrote one session-*.json object, and /chat save writes checkpoint-<tag>.json.

use super::{bump, content, sanitize_tool_id, text_block, truncate_title, Converted, FoundFile};
use crate::errors::{Res, WireError};
use crate::js::{self, as_str, coalesce, js_string, nullish, prop, truthy, Obj};
use crate::paths::{base_name, join_slash};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

const KNOWN_TYPES: &[&str] = &["user", "gemini", "info", "error", "warning"];

fn root(home: &str) -> String {
    super::home_root(home, ".gemini")
}

/// Session and checkpoint files under ~/.gemini/tmp/<project>/chats, with the project dir name.
pub fn files(home: &str) -> Vec<(FoundFile, String)> {
    static NAME: OnceLock<Regex> = OnceLock::new();
    let name_re = NAME.get_or_init(|| Regex::new(r"^(session-.*\.jsonl?|checkpoint-.*\.json)$").unwrap());
    let tmp = join_slash(&[&root(home), "tmp"]);
    let found = super::walk_files(&tmp, 2, &|n| name_re.is_match(n), &|name, depth| depth == 1 && name != "chats");
    found
        .into_iter()
        .map(|f| {
            let project = f.path.get(tmp.len() + 1..).unwrap_or("").split('/').next().unwrap_or("").to_string();
            (f, project)
        })
        .collect()
}

/// `/\/tmp\/([^/]+)\/chats\/[^/]+$/`
pub fn project_of_path(path: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"/tmp/([^/]+)/chats/[^/]+$").unwrap());
    re.captures(path).map(|c| c[1].to_string())
}

/// Project dir name to project root, from projects.json and the legacy sha256 names.
pub fn projects(home: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(text) = crate::fsops::read_text_string(&join_slash(&[&root(home), "projects.json"])) else { return out };
    let Ok(raw) = js::parse_json(&text) else { return out };
    let mut add = |path: Option<&Value>, name: Option<&Value>| {
        let Some(p) = as_str(path).filter(|p| p.starts_with('/')) else { return };
        if let Some(n) = as_str(name).filter(|n| !n.is_empty()) {
            out.insert(n.to_string(), p.to_string());
        }
        out.insert(super::sha256_hex(p), p.to_string());
    };
    let obj = if js::is_object_like(Some(&raw)) { coalesce(&[prop(Some(&raw), "projects")]).or(Some(&raw)) } else { None };
    match obj {
        Some(Value::Array(a)) => {
            for p in a {
                add(coalesce(&[prop(Some(p), "path"), prop(Some(p), "root")]), coalesce(&[prop(Some(p), "name"), prop(Some(p), "id")]));
            }
        }
        Some(Value::Object(o)) => {
            for (k, v) in o {
                let key = Value::String(k.clone());
                if k.starts_with('/') {
                    add(Some(&key), Some(v));
                } else {
                    add(Some(v), Some(&key));
                }
            }
        }
        _ => {}
    }
    out
}

/// Replay a JSONL chat (or read a legacy object) into metadata and live messages.
fn records(text: &str, unknown: &mut Obj) -> Res<(Obj, Vec<Obj>)> {
    let t = js::trim_start(text);
    if t.starts_with('[') {
        // checkpoint: API contents
        let arr = js::parse_json(t).map_err(WireError::new)?;
        let Value::Array(arr) = arr else { return Ok((Map::new(), vec![])) };
        let mut msgs = Vec::new();
        for (i, c) in arr.iter().enumerate() {
            if nullish(Some(c)) {
                return Err(WireError::new("null is not an object (evaluating 'c.role')"));
            }
            let ty = if as_str(prop(Some(c), "role")) == Some("model") { "gemini" } else { "user" };
            let parts = match prop(Some(c), "parts") {
                None | Some(Value::Null) => json!([]),
                Some(p) => p.clone(),
            };
            let mut m = Map::new();
            m.insert("id".into(), json!(format!("c{i}")));
            m.insert("type".into(), json!(ty));
            m.insert("content".into(), parts);
            msgs.push(m);
        }
        return Ok((Map::new(), msgs));
    }
    if t.starts_with('{') && !t.contains("\n{") {
        if let Ok(Value::Object(mut obj)) = js::parse_json(t) {
            if let Some(Value::Array(messages)) = obj.get("messages").cloned() {
                obj.shift_remove("messages");
                let msgs = messages.into_iter().filter_map(|m| if let Value::Object(o) = m { Some(o) } else { None }).collect();
                return Ok((obj, msgs));
            }
        }
    }
    let mut meta = Map::new();
    let mut messages: Vec<Obj> = Vec::new();
    let mut first = true;
    for l in super::parse_jsonl(text.as_bytes()) {
        if let Some(to) = as_str(l.get("$rewindTo")) {
            if let Some(i) = messages.iter().position(|m| as_str(m.get("id")) == Some(to)) {
                messages.truncate(i);
            }
            continue;
        }
        if truthy(l.get("$patch")) && js::is_object_like(l.get("$patch")) {
            let patch = l.get("$patch").unwrap();
            let pid = prop(Some(patch), "id");
            if let Some(m) = messages.iter_mut().find(|x| x.get("id") == pid) {
                if let Value::Object(po) = patch {
                    for (k, v) in po {
                        m.insert(k.clone(), v.clone());
                    }
                }
            }
            continue;
        }
        if truthy(l.get("$set")) && js::is_object_like(l.get("$set")) {
            if let Some(Value::Object(so)) = l.get("$set") {
                for (k, v) in so {
                    meta.insert(k.clone(), v.clone());
                }
            }
            continue;
        }
        if first && !l.contains_key("type") {
            for (k, v) in &l {
                meta.insert(k.clone(), v.clone());
            }
            first = false;
            continue;
        }
        first = false;
        if let Some(ty) = as_str(l.get("type")) {
            if !KNOWN_TYPES.contains(&ty) {
                bump(unknown, &format!("line:{ty}"));
            }
        }
        messages.push(l);
    }
    Ok((meta, messages))
}

struct Parts {
    blocks: Vec<Value>,
    calls: Vec<Value>,
    results: Vec<Value>,
}

fn parts_to_blocks(content: Option<&Value>, user: bool, unknown: &mut Obj) -> Parts {
    let mut p = Parts { blocks: vec![], calls: vec![], results: vec![] };
    if let Some(Value::String(s)) = content {
        if !js::trim(s).is_empty() {
            p.blocks.push(text_block(s));
        }
        return p;
    }
    let list: Vec<Value> = match content {
        Some(Value::Array(a)) => a.clone(),
        Some(v @ Value::Object(_)) => vec![v.clone()],
        _ => vec![],
    };
    for part in &list {
        let part = Some(part);
        if let Some(s) = as_str(part) {
            if !js::trim(s).is_empty() {
                p.blocks.push(text_block(s));
            }
        } else if let Some(t) = as_str(prop(part, "text")) {
            if truthy(prop(part, "thought")) {
                p.blocks.push(json!({ "type": "thinking", "thinking": t }));
            } else if !js::trim(t).is_empty() {
                p.blocks.push(text_block(t));
            }
        } else if truthy(prop(part, "functionCall")) {
            let fc = prop(part, "functionCall");
            let raw = match coalesce(&[prop(fc, "id")]) {
                Some(v) => js_string(Some(v)),
                None => format!("{}_{}", js_string(prop(fc, "name")), p.calls.len()),
            };
            let name = coalesce(&[prop(fc, "name")]).map(|v| js_string(Some(v))).unwrap_or_else(|| "tool".into());
            let input = coalesce(&[prop(fc, "args")]).cloned().unwrap_or_else(|| json!({}));
            p.calls.push(json!({ "type": "tool_use", "id": sanitize_tool_id(&raw), "name": name, "input": input }));
        } else if truthy(prop(part, "functionResponse")) {
            let fr = prop(part, "functionResponse");
            let raw = match coalesce(&[prop(fr, "id")]) {
                Some(v) => js_string(Some(v)),
                None => format!("{}_{}", js_string(prop(fr, "name")), p.results.len()),
            };
            let r = prop(fr, "response");
            let content = match as_str(prop(r, "output")) {
                Some(s) => s.to_string(),
                None => js::stringify(coalesce(&[r]).unwrap_or(&json!(""))),
            };
            p.results.push(json!({ "type": "tool_result", "toolUseId": sanitize_tool_id(&raw), "content": content, "meta": { "external": true } }));
        } else if truthy(prop(prop(part, "inlineData"), "data")) {
            if user {
                let d = prop(part, "inlineData");
                let media = coalesce(&[prop(d, "mimeType")]).cloned().unwrap_or_else(|| json!("image/png"));
                p.blocks.push(json!({ "type": "image", "mediaType": media, "data": prop(d, "data").unwrap() }));
            }
        } else {
            let key = match part {
                Some(Value::Object(o)) => o.keys().next().cloned().unwrap_or_else(|| "none".into()),
                Some(Value::Array(a)) if !a.is_empty() => "0".into(),
                _ => "none".into(),
            };
            bump(unknown, &format!("part:{key}"));
        }
    }
    p
}

fn join_values(a: &[Value]) -> String {
    a.iter()
        .map(|x| match x {
            Value::Null => String::new(),
            other => js_string(Some(other)),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Convert one Gemini CLI chat. cwd comes from the project map when the caller knows it.
pub fn convert(text: &str, cwd: Option<String>, path: Option<&str>) -> Res<Converted> {
    let mut unknown = Map::new();
    let (meta, recs) = records(text, &mut unknown)?;
    let mut out: Vec<Obj> = Vec::new();
    let mut model: Option<String> = None;
    let mut last_ts = js::parse_time(meta.get("startTime"), 0.0);
    for r in &recs {
        let ts = js::parse_time(r.get("timestamp"), last_ts);
        if ts != 0.0 && !ts.is_nan() {
            last_ts = ts;
        }
        let id = as_str(r.get("id")).map(str::to_string).unwrap_or_else(|| format!("m{}", out.len()));
        let external = json!({ "source": "gemini", "id": id });
        let external_r = json!({ "source": "gemini", "id": format!("{id}:r") });
        match as_str(r.get("type")) {
            Some("user") => {
                let p = parts_to_blocks(r.get("content"), true, &mut unknown);
                if !p.results.is_empty() {
                    out.push(super::message("user", "normal", p.results, ts, json!({ "external": external_r, "origin": "system" })));
                }
                let text = p.blocks.iter().filter(|b| super::block_type(b) == "text").map(|b| js_string(prop(Some(b), "text"))).collect::<Vec<_>>().join("\n");
                // shell passthrough and slash commands are still the owner's words
                if !p.blocks.is_empty() && !js::trim(&text).is_empty() {
                    out.push(super::message("user", "normal", p.blocks, ts, json!({ "external": external, "origin": "human" })));
                }
            }
            Some("gemini") => {
                if let Some(m) = as_str(r.get("model")) {
                    model = Some(format!("google/{m}"));
                }
                let p = parts_to_blocks(r.get("content"), false, &mut unknown);
                let mut thinking: Vec<Value> = Vec::new();
                if let Some(Value::Array(th)) = r.get("thoughts") {
                    for t in th {
                        let s = prop(Some(t), "subject");
                        let d = prop(Some(t), "description");
                        if truthy(s) || truthy(d) {
                            let parts: Vec<String> = [s, d].iter().filter(|v| truthy(**v)).map(|v| js_string(*v)).collect();
                            thinking.push(json!({ "type": "thinking", "thinking": parts.join(": ") }));
                        }
                    }
                }
                let mut tool_uses: Vec<Value> = p.calls;
                let mut results: Vec<Value> = Vec::new();
                if let Some(Value::Array(calls)) = r.get("toolCalls") {
                    for c in calls {
                        let c = Some(c);
                        let raw = match coalesce(&[prop(c, "id")]) {
                            Some(v) => js_string(Some(v)),
                            None => format!("{}_{}", js_string(prop(c, "name")), tool_uses.len()),
                        };
                        let tid = sanitize_tool_id(&raw);
                        let name = coalesce(&[prop(c, "name")]).map(|v| js_string(Some(v))).unwrap_or_else(|| "tool".into());
                        let args = prop(c, "args");
                        let input = if truthy(args) && js::is_object_like(args) { args.unwrap().clone() } else { json!({}) };
                        tool_uses.push(json!({ "type": "tool_use", "id": tid.clone(), "name": name, "input": input }));
                        let res = match prop(c, "result") {
                            Some(Value::Array(items)) => {
                                let vals: Vec<Value> = items
                                    .iter()
                                    .map(|x| coalesce(&[prop(prop(prop(Some(x), "functionResponse"), "response"), "output"), prop(Some(x), "text")]).cloned().unwrap_or_else(|| json!("")))
                                    .collect();
                                join_values(&vals)
                            }
                            other => match as_str(prop(c, "resultDisplay")) {
                                Some(d) => d.to_string(),
                                None => js::stringify(coalesce(&[other]).unwrap_or(&json!(""))),
                            },
                        };
                        let mut o = Map::new();
                        o.insert("type".into(), json!("tool_result"));
                        o.insert("toolUseId".into(), json!(tid));
                        o.insert("content".into(), json!(res));
                        if as_str(prop(c, "status")) == Some("error") {
                            o.insert("isError".into(), json!(true));
                        }
                        o.insert("meta".into(), json!({ "external": true }));
                        results.push(Value::Object(o));
                    }
                }
                let mut all = thinking;
                all.extend(p.blocks);
                all.extend(tool_uses);
                if all.is_empty() {
                    continue;
                }
                let mut m = super::message("assistant", "normal", all, ts, json!({ "external": external }));
                if let Some(md) = &model {
                    m.insert("model".into(), json!(md));
                }
                out.push(m);
                if !results.is_empty() {
                    out.push(super::message("user", "normal", results, ts, json!({ "external": external_r, "origin": "system" })));
                }
            }
            _ => {}
        }
    }
    let native_id = as_str(meta.get("sessionId")).map(str::to_string).or_else(|| path.map(|p| strip_json_ext(base_name(p))));
    let first_text = out.iter().find(|m| super::meta_origin(m) == Some("human")).and_then(|m| content(m).iter().find(|b| super::block_type(b) == "text")).map(|b| js_string(prop(Some(b), "text")));
    let title = as_str(meta.get("summary")).filter(|s| !s.is_empty()).map(str::to_string).or(first_text);
    Ok(Converted {
        source: "gemini",
        native_id,
        native_id_unique: true,
        title: title.filter(|t| !t.is_empty()).map(|t| truncate_title(&t)),
        cwd,
        git_branch: None,
        repo: None,
        model,
        kind: if as_str(meta.get("kind")) == Some("subagent") { "subagent" } else { "main" },
        parent_native_id: None,
        entrypoint: None,
        messages: out,
        unknown,
        learnable: true,
    })
}

/// `.replace(/\.jsonl?$/, '')`
fn strip_json_ext(name: &str) -> String {
    name.strip_suffix(".jsonl").or_else(|| name.strip_suffix(".json")).unwrap_or(name).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replays_jsonl_records() {
        let text = [
            r#"{"sessionId":"g1","startTime":"2025-03-01T00:00:00Z","summary":""}"#,
            r#"{"id":"a","type":"user","timestamp":"2025-03-01T00:00:01Z","content":"hello there"}"#,
            r#"{"id":"b","type":"gemini","model":"gemini-2.5-pro","content":"hi","thoughts":[{"subject":"Plan","description":"say hi"}],"toolCalls":[{"id":"c1","name":"ls","args":{"dir":"."},"resultDisplay":"x.txt"}]}"#,
            r#"{"id":"c","type":"user","content":"gone"}"#,
            r#"{"$rewindTo":"c"}"#,
            r#"{"$patch":{"id":"a","content":"hello again"}}"#,
            r#"{"id":"d","type":"mystery"}"#,
        ]
        .join("\n");
        let c = convert(&text, Some("/w".into()), Some("/h/.gemini/tmp/p/chats/session-1.jsonl")).unwrap();
        assert_eq!(c.native_id.as_deref(), Some("g1"));
        assert_eq!(c.title.as_deref(), Some("hello again"));
        assert_eq!(c.model.as_deref(), Some("google/gemini-2.5-pro"));
        assert_eq!(c.messages.len(), 3);
        assert_eq!(content(&c.messages[1]).len(), 3);
        assert_eq!(c.messages[2]["meta"]["external"]["id"], "b:r");
        assert_eq!(c.unknown.get("line:mystery"), Some(&json!(1)));
        assert_eq!(project_of_path("/h/.gemini/tmp/p/chats/session-1.jsonl").as_deref(), Some("p"));
    }

    #[test]
    fn checkpoints_are_api_contents() {
        let c = convert(r#"[{"role":"user","parts":[{"text":"q"}]},{"role":"model","parts":[{"text":"a"}]}]"#, None, Some("/x/checkpoint-t.json")).unwrap();
        assert_eq!(c.native_id.as_deref(), Some("checkpoint-t"));
        assert_eq!(c.messages.len(), 2);
    }
}
