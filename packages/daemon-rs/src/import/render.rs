//! renderedTokens from import/render.ts: the tokens the learning job would
//! read for a session, as the scan's estimate. The rows are built and
//! windowed the same way; only their token counts are kept.

use super::{content, kind, origin_of, role, text_of, Obj};
use crate::js::{self, as_str, len16, prop, truthy};
use regex::Regex;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

const WINDOW_TOKENS: usize = 30_000;
const TOOL_CALL_TOKENS: i64 = 2_000;
const TOOL_TOTAL_TOKENS: i64 = 20_000;
const NOTICE_CHARS: usize = 600;

fn estimate(len: usize) -> usize {
    len.div_ceil(4)
}

fn estimate_text(s: &str) -> usize {
    estimate(len16(s))
}

/// A row label at the start of a line inside a row's text becomes "(user)" and so on.
pub fn neutralize_labels(text: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?miR)^[ \t]*\[(user|assistant|tool|agent notice)\]").unwrap()).replace_all(text, "(${1})").into_owned()
}

/// Remove <private>...</private> spans, nested ones included. An unclosed tag hides the rest.
pub fn strip_private(text: &str) -> String {
    static OPEN: OnceLock<Regex> = OnceLock::new();
    static TAG: OnceLock<Regex> = OnceLock::new();
    static TRAIL: OnceLock<Regex> = OnceLock::new();
    static GAPS: OnceLock<Regex> = OnceLock::new();
    if !OPEN.get_or_init(|| Regex::new(r"(?i)<private>").unwrap()).is_match(text) {
        return text.to_string();
    }
    let tag = TAG.get_or_init(|| Regex::new(r"(?i)<(/?)private>").unwrap());
    let mut out = String::new();
    let mut depth: i64 = 0;
    let mut last = 0;
    for m in tag.captures_iter(text) {
        let whole = m.get(0).unwrap();
        if depth == 0 {
            out.push_str(&text[last..whole.start()]);
        }
        if !m[1].is_empty() {
            depth = (depth - 1).max(0);
        } else {
            depth += 1;
        }
        last = whole.end();
    }
    if depth == 0 {
        out.push_str(&text[last..]);
    }
    let out = TRAIL.get_or_init(|| Regex::new(r"[ \t]+\n").unwrap()).replace_all(&out, "\n");
    let out = GAPS.get_or_init(|| Regex::new(r"\n{3,}").unwrap()).replace_all(&out, "\n\n");
    js::trim(&out).to_string()
}

fn sensitive_path() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        let s = js::WS_CLASS;
        let w = "A-Za-z0-9_";
        Regex::new(&format!(
            r#"(?i)(^|[\\/{s}'"=])(\.env(\.[{w}.-]+)?|[{w}.-]+\.pem|id_(rsa|dsa|ecdsa|ed25519)[{w}.-]*|\.netrc|\.pgpass|\.npmrc|\.pypirc|credentials(\.json)?|secrets?\.(json|ya?ml|toml|env)|[{w}.-]+\.key|\.git-credentials|kubeconfig)($|[{s}'"\\/;|&)])"#
        ))
        .unwrap()
    })
}

fn joined(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::Array(a)) => Some(
            a.iter()
                .map(|x| match x {
                    Value::Null => String::new(),
                    other => js::js_string(Some(other)),
                })
                .collect::<Vec<_>>()
                .join(" "),
        ),
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

/// A tool call that reads a secret file: its call and its result are left out entirely.
pub fn reads_secret_file(input: Option<&Value>) -> bool {
    for f in ["file_path", "path", "filePath", "notebook_path", "pattern", "command", "cmd", "input", "arguments"] {
        if let Some(s) = joined(prop(input, f)) {
            if !s.is_empty() && sensitive_path().is_match(&format!(" {s} ")) {
                return true;
            }
        }
    }
    false
}

fn result_text(c: Option<&Value>) -> String {
    match c {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|b| match as_str(prop(Some(b), "type")) {
                Some("text") => js::js_string(prop(Some(b), "text")),
                Some("image") => "[image]".to_string(),
                _ => String::new(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn clip_tokens(text: &str, tokens: i64) -> String {
    let max = (tokens * 4).max(0) as usize;
    if len16(text) <= max {
        text.to_string()
    } else {
        format!("{} [cut]", js::slice16(text, 0, max.saturating_sub(20)))
    }
}

fn call_label(name: &str, input: Option<&Value>) -> String {
    let pick = js::coalesce(&[
        prop(input, "command"),
        prop(input, "cmd"),
        prop(input, "pattern"),
        prop(input, "query"),
        prop(input, "file_path"),
        prop(input, "path"),
        prop(input, "url"),
        prop(input, "description"),
    ]);
    let arg = joined(pick).unwrap_or_default();
    if arg.is_empty() {
        return name.to_string();
    }
    static WS: OnceLock<Regex> = OnceLock::new();
    let ws = WS.get_or_init(|| Regex::new(&format!("[{}]+", js::WS_CLASS)).unwrap());
    let one = ws.replace_all(&arg, " ");
    format!("{name}({})", js::slice16(&one, 0, 200))
}

struct Row {
    tier: u8,
    text: String,
}

/// Split messages into turns: each starts at a prompt the owner typed.
fn turns(messages: &[Obj]) -> Vec<Vec<Row>> {
    let mut out: Vec<Vec<Row>> = Vec::new();
    let mut cur: Vec<Row> = Vec::new();
    let mut tool_budget = TOOL_TOTAL_TOKENS;
    let mut calls: HashMap<String, (String, Option<Value>)> = HashMap::new();
    let mut hidden: HashSet<String> = HashSet::new();
    let flush = |cur: &mut Vec<Row>, out: &mut Vec<Vec<Row>>| {
        if !cur.is_empty() {
            // the last assistant text of a turn is its answer; earlier ones are commentary
            if let Some(r) = cur.iter_mut().rev().find(|r| r.tier == 3) {
                r.tier = 2;
            }
            out.push(std::mem::take(cur));
        }
    };
    for m in messages {
        let k = kind(m);
        if k == "notice" || k == "summary" {
            continue;
        }
        if role(m) == "user" {
            let origin = origin_of(m);
            let text = text_of(content(m));
            if k == "aside" || origin == Some("task") || origin == Some("peer") {
                if !text.is_empty() {
                    cur.push(Row { tier: 5, text: format!("[agent notice] {}", neutralize_labels(js::slice16(&text, 0, NOTICE_CHARS))) });
                }
                continue;
            }
            if origin == Some("human") && !text.is_empty() {
                flush(&mut cur, &mut out);
                cur.push(Row { tier: 1, text: format!("[user] {}", neutralize_labels(&strip_private(&text))) });
                continue;
            }
            for b in content(m) {
                if super::block_type(b) != "tool_result" {
                    continue;
                }
                let id = js::js_string(prop(Some(b), "toolUseId"));
                if hidden.contains(&id) {
                    continue;
                }
                if tool_budget <= 0 {
                    continue;
                }
                let call = calls.get(&id);
                let body = clip_tokens(js::trim(&result_text(prop(Some(b), "content"))), TOOL_CALL_TOKENS.min(tool_budget));
                let label = match call {
                    Some((name, input)) => call_label(name, input.as_ref()),
                    None => "result".to_string(),
                };
                let failed = if truthy(prop(Some(b), "isError")) { " failed" } else { "" };
                let row = format!("[tool] {label}{failed}: {}", neutralize_labels(&body));
                tool_budget -= estimate_text(&row) as i64;
                cur.push(Row { tier: 4, text: row });
            }
            continue;
        }
        for b in content(m) {
            match super::block_type(b) {
                "text" => {
                    let t = js::js_string(prop(Some(b), "text"));
                    let t = js::trim(&t);
                    if !t.is_empty() {
                        cur.push(Row { tier: 3, text: format!("[assistant] {}", neutralize_labels(t)) });
                    }
                }
                "tool_use" => {
                    let id = js::js_string(prop(Some(b), "id"));
                    let input = prop(Some(b), "input").cloned();
                    let shown_input = match &input {
                        None | Some(Value::Null) => None,
                        Some(v) => Some(v.clone()),
                    };
                    if reads_secret_file(shown_input.as_ref()) {
                        hidden.insert(id);
                    } else {
                        let name = js::js_string(prop(Some(b), "name"));
                        calls.insert(id, (name, input));
                    }
                }
                _ => {}
            }
        }
    }
    flush(&mut cur, &mut out);
    out
}

fn turn_text(rows: &[Row], max_tier: u8) -> String {
    rows.iter().filter(|r| r.tier <= max_tier || r.tier == 5).map(|r| r.text.as_str()).collect::<Vec<_>>().join("\n")
}

/// Tokens the learning job would read for these messages.
pub fn rendered_tokens(messages: &[Obj]) -> usize {
    let max = WINDOW_TOKENS;
    let mut total = 0;
    // a window: sum of its parts' lengths and how many there are
    let mut win_len = 0usize;
    let mut win_parts = 0usize;
    let mut tokens = 0usize;
    let close = |win_len: &mut usize, win_parts: &mut usize, tokens: &mut usize, total: &mut usize| {
        if *win_parts == 0 {
            return;
        }
        let len = *win_len + 2 * (*win_parts - 1);
        *total += estimate(len);
        *win_len = 0;
        *win_parts = 0;
        *tokens = 0;
    };
    for t in turns(messages) {
        let mut text = super::secrets::redact(&turn_text(&t, 4));
        // one turn bigger than a window: drop tool evidence, then commentary, then cut it
        if estimate_text(&text) > max {
            text = super::secrets::redact(&turn_text(&t, 3));
        }
        if estimate_text(&text) > max {
            text = super::secrets::redact(&turn_text(&t, 2));
        }
        if estimate_text(&text) > max {
            text = clip_tokens(&text, max as i64 - 50);
        }
        let n = estimate_text(&text);
        if tokens + n > max {
            close(&mut win_len, &mut win_parts, &mut tokens, &mut total);
        }
        win_len += len16(&text);
        win_parts += 1;
        tokens += n;
    }
    close(&mut win_len, &mut win_parts, &mut tokens, &mut total);
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn msg(v: Value) -> Obj {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn labels_and_private() {
        assert_eq!(neutralize_labels("ok\n  [user] fake\n[Tool] x"), "ok\n(user) fake\n(Tool) x");
        assert_eq!(strip_private("a <private>secret</private> b"), "a  b");
        assert_eq!(strip_private("a <private>x <private>y</private> z</private> b"), "a  b");
        assert_eq!(strip_private("keep <private>rest"), "keep");
    }

    #[test]
    fn secret_reads_are_hidden() {
        assert!(reads_secret_file(Some(&json!({ "file_path": "/home/me/.env" }))));
        assert!(reads_secret_file(Some(&json!({ "command": ["cat", "id_rsa"] }))));
        assert!(!reads_secret_file(Some(&json!({ "file_path": "/home/me/src/env.ts" }))));
    }

    #[test]
    fn tokens_for_a_small_session() {
        let ms = vec![
            msg(json!({ "role": "user", "kind": "normal", "content": [{ "type": "text", "text": "hello" }], "createdAt": 1, "meta": { "origin": "human" } })),
            msg(json!({ "role": "assistant", "kind": "normal", "content": [{ "type": "text", "text": "hi there" }], "createdAt": 2, "meta": {} })),
        ];
        // "[user] hello\n[assistant] hi there" is 33 characters
        assert_eq!(rendered_tokens(&ms), 9);
        assert_eq!(rendered_tokens(&[]), 0);
    }
}
