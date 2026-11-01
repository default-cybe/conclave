//! glob and grep. With rg on PATH they run it with exactly the arguments
//! LocalMachine uses, so results are the same. Without rg (or with
//! CONCLAVE_DAEMON_SEARCH=builtin) they use ripgrep's own crates: the same
//! walker, ignore rules, globs, file types, matcher and output format.

use crate::errors::{Res, WireError};
use crate::paths::{self, native};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const SEARCH_TIMEOUT: Duration = Duration::from_millis(60_000);
const MAX_STDOUT: usize = 32 * 1024 * 1024;
const MAX_STDERR: usize = 256 * 1024;

fn rg() -> Option<&'static str> {
    static RG: OnceLock<Option<String>> = OnceLock::new();
    RG.get_or_init(|| {
        if std::env::var("CONCLAVE_DAEMON_SEARCH").map(|v| v == "builtin").unwrap_or(false) {
            return None;
        }
        crate::env::which("rg").map(|p| p.to_string_lossy().into_owned())
    })
    .as_deref()
}

fn glob_has_magic(seg: &str) -> bool {
    seg.chars().any(|c| matches!(c, '*' | '?' | '[' | ']' | '{' | '}'))
}

/// "*.ts *.tsx" -> ["*.ts", "*.tsx"]
fn split_globs(g: Option<&str>) -> Vec<String> {
    g.map(|g| g.split(crate::js::is_js_ws).map(crate::js::trim).filter(|s| !s.is_empty()).map(str::to_string).collect()).unwrap_or_default()
}

pub struct GlobOpts {
    pub cwd: String,
    pub limit: Option<usize>,
    pub include_ignored: bool,
    pub dot: Option<bool>,
}

/// Machine.glob: absolute paths, newest first.
pub async fn glob(pattern: &str, opts: GlobOpts) -> Res<Value> {
    let home = paths::home_dir();
    let mut cwd = paths::resolve(if opts.cwd.is_empty() { "." } else { &opts.cwd }, &home);
    let mut pat = crate::js::trim(pattern).to_string();
    // absolute pattern: move the literal prefix into cwd
    if native::is_absolute(&pat) || pat.starts_with('~') {
        let abs = paths::resolve(&pat, &cwd);
        let parts: Vec<&str> = abs.split(paths::SEP).collect();
        match parts.iter().position(|s| glob_has_magic(s)) {
            None => {
                let a = abs.clone();
                let st = tokio::task::spawn_blocking(move || crate::fsops::stat(&a)).await.map_err(join_err)?;
                return Ok(match st {
                    Ok(Some(s)) if s.kind != "dir" => json!([abs]),
                    _ => json!([]),
                });
            }
            Some(idx) => {
                let joined = parts[..idx].join(&paths::SEP.to_string());
                cwd = if joined.is_empty() { paths::SEP.to_string() } else { joined };
                pat = parts[idx..].join("/");
            }
        }
    }
    if let Some(p) = pat.strip_prefix("./") {
        pat = p.to_string();
    }
    let limit = opts.limit.unwrap_or(1000);
    let dot = opts.dot.unwrap_or_else(|| {
        static RE: OnceLock<regex::Regex> = OnceLock::new();
        RE.get_or_init(|| regex::Regex::new(r"(^|/)\.[^/.]").unwrap()).is_match(&pat)
    });
    if !crate::fsops::is_dir(&cwd) {
        return Err(WireError::new(format!("Directory does not exist: {cwd}")));
    }
    if let Some(rg) = rg() {
        let mut args = vec![rg.to_string(), "--files".into(), "--color=never".into(), "--sortr=modified".into(), "--glob".into(), pat.clone()];
        if dot {
            args.extend(["--hidden".into(), "--glob".into(), "!.git/".into()]);
        }
        if opts.include_ignored {
            args.push("--no-ignore".into());
        }
        let c = crate::procs::capture(&args, Some(&cwd), SEARCH_TIMEOUT, MAX_STDOUT, MAX_STDERR).await.map_err(|e| WireError::new(e.to_string()))?;
        if c.code != Some(0) && c.code != Some(1) && c.stdout.is_empty() {
            let msg = crate::js::trim(&c.stderr).to_string();
            return Err(WireError::new(if msg.is_empty() { format!("rg exited with {}", c.code.map(|c| c.to_string()).unwrap_or("null".into())) } else { msg }));
        }
        let found = c.stdout.split('\n').filter(|l| !l.is_empty()).map(|l| native::resolve(&[&cwd, l]));
        return Ok(Value::Array(crate::private::without(found).take(limit).map(Value::String).collect()));
    }
    let include_ignored = opts.include_ignored;
    let found = tokio::task::spawn_blocking(move || builtin_files(&cwd, &pat, dot, include_ignored)).await.map_err(join_err)??;
    Ok(Value::Array(crate::private::without(found).take(limit).map(Value::String).collect()))
}

fn join_err(e: tokio::task::JoinError) -> WireError {
    WireError::new(format!("internal error: {e}"))
}

fn mtime(p: &Path) -> std::time::SystemTime {
    std::fs::metadata(p).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH)
}

/// The walker rg builds: ignore files apply unless no_ignore; hidden files only when asked.
fn walker(root: &str, hidden: bool, no_ignore: bool, globs: &[String], types: Option<&str>) -> Res<ignore::WalkBuilder> {
    let mut b = ignore::WalkBuilder::new(root);
    b.hidden(!hidden).follow_links(false);
    b.add_custom_ignore_filename(".rgignore");
    if no_ignore {
        b.ignore(false).git_ignore(false).git_global(false).git_exclude(false).parents(false);
    }
    if !globs.is_empty() {
        let mut ob = ignore::overrides::OverrideBuilder::new(root);
        for g in globs {
            ob.add(g).map_err(|e| WireError::new(format!("rg: {e}")))?;
        }
        b.overrides(ob.build().map_err(|e| WireError::new(format!("rg: {e}")))?);
    }
    if let Some(t) = types {
        let mut tb = ignore::types::TypesBuilder::new();
        tb.add_defaults();
        tb.select(t);
        b.types(tb.build().map_err(|e| WireError::new(format!("rg: {e}")))?);
    }
    Ok(b)
}

fn walk_files(b: &ignore::WalkBuilder, started: Instant) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for ent in b.build().flatten() {
        if started.elapsed() > SEARCH_TIMEOUT {
            break;
        }
        if ent.file_type().is_some_and(|t| t.is_file()) {
            out.push(ent.into_path());
        }
    }
    out
}

/// rg --files --sortr=modified --glob pat [--hidden --glob !.git/] [--no-ignore]
fn builtin_files(cwd: &str, pat: &str, dot: bool, include_ignored: bool) -> Res<Vec<String>> {
    let mut globs = vec![pat.to_string()];
    if dot {
        globs.push("!.git/".into());
    }
    let b = walker(cwd, dot, include_ignored, &globs, None)?;
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = walk_files(&b, Instant::now()).into_iter().map(|p| (mtime(&p), p)).collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.0));
    Ok(files.into_iter().map(|(_, p)| p.to_string_lossy().into_owned()).collect())
}

#[derive(Clone)]
pub struct GrepOpts {
    pub pattern: String,
    pub path: String,
    pub glob: Option<String>,
    pub file_type: Option<String>,
    pub case_insensitive: bool,
    pub multiline: bool,
    /// content, files or count
    pub mode: String,
    pub before: usize,
    pub after: usize,
    pub line_numbers: bool,
    pub limit: Option<usize>,
    pub offset: usize,
}

/// Machine.grep: rg output lines, then offset and limit.
pub async fn grep(o: GrepOpts) -> Res<Value> {
    let home = paths::home_dir();
    let path = paths::resolve(if o.path.is_empty() { "." } else { &o.path }, &home);
    crate::private::check(&path)?;
    let p2 = path.clone();
    let st = tokio::task::spawn_blocking(move || crate::fsops::stat(&p2)).await.map_err(join_err)??;
    let Some(st) = st else { return Err(WireError::new(format!("Path does not exist: {path}"))) };
    let cwd = if st.kind == "dir" { path.clone() } else { native::dirname(&path) };
    let stdout = if let Some(rg) = rg() {
        let mut args: Vec<String> = vec![rg.into(), "--color=never".into(), "--no-messages".into(), "--hidden".into(), "--glob".into(), "!.git/".into(), "--max-columns=500".into(), "--max-columns-preview".into()];
        if o.case_insensitive {
            args.push("-i".into());
        }
        if o.multiline {
            args.extend(["-U".into(), "--multiline-dotall".into()]);
        }
        for g in split_globs(o.glob.as_deref()) {
            args.extend(["--glob".into(), g]);
        }
        if let Some(t) = o.file_type.as_ref().filter(|t| !t.is_empty()) {
            args.extend(["--type".into(), t.clone()]);
        }
        match o.mode.as_str() {
            "files" => args.extend(["--files-with-matches".into(), "--sortr=modified".into()]),
            "count" => args.extend(["--count".into(), "--with-filename".into()]),
            _ => {
                args.extend(["--no-heading".into(), "--with-filename".into()]);
                if o.line_numbers {
                    args.push("-n".into());
                }
                if o.before > 0 {
                    args.extend(["-B".into(), o.before.to_string()]);
                }
                if o.after > 0 {
                    args.extend(["-A".into(), o.after.to_string()]);
                }
            }
        }
        args.extend(["-e".into(), o.pattern.clone(), "--".into(), path.clone()]);
        let c = crate::procs::capture(&args, Some(&cwd), SEARCH_TIMEOUT, MAX_STDOUT, MAX_STDERR).await.map_err(|e| WireError::new(e.to_string()))?;
        if c.code == Some(2) && c.stdout.is_empty() {
            let msg = crate::js::trim(&c.stderr).to_string();
            return Err(WireError::new(if msg.is_empty() { "ripgrep failed (invalid pattern?)".to_string() } else { msg }));
        }
        c.stdout
    } else {
        let is_dir = st.kind == "dir";
        let opts = o.clone();
        let p3 = path.clone();
        tokio::task::spawn_blocking(move || builtin_grep(&p3, is_dir, &opts)).await.map_err(join_err)??
    };
    let mut lines: Vec<&str> = stdout.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    // a search above a private folder never shows what is in it
    let private: Vec<String> = crate::private::dirs().into_iter().filter(|d| crate::private::under(d, &path)).collect();
    lines.retain(|l| !private.iter().any(|d| l.strip_prefix(d.as_str()).is_some_and(|r| r.starts_with(paths::SEP))));
    let total = lines.len();
    let offset = o.offset;
    let limit = o.limit.filter(|l| *l > 0);
    let end = match limit {
        Some(l) => (offset + l).min(total),
        None => total,
    };
    let picked = if offset < total { &lines[offset..end.max(offset)] } else { &[][..] };
    Ok(json!({ "output": picked.join("\n"), "total": total, "truncated": limit.is_some_and(|l| offset + l < total) }))
}

fn regex_error(e: impl std::fmt::Display) -> WireError {
    let msg = e.to_string();
    if msg.contains("is not allowed in a regex") {
        return WireError::new(format!("rg: {msg}\n\nConsider enabling multiline mode with the --multiline flag (or -U for short).\nWhen multiline mode is enabled, new line characters can be matched."));
    }
    WireError::new(format!("rg: {msg}"))
}

/// rg with LocalMachine's arguments, in this process.
fn builtin_grep(path: &str, is_dir: bool, o: &GrepOpts) -> Res<String> {
    use grep_printer::{StandardBuilder, SummaryBuilder, SummaryKind};
    use grep_regex::RegexMatcherBuilder;
    use grep_searcher::{BinaryDetection, SearcherBuilder};

    let started = Instant::now();
    let mut mb = RegexMatcherBuilder::new();
    mb.case_insensitive(o.case_insensitive).multi_line(true);
    if o.multiline {
        mb.dot_matches_new_line(true);
    } else {
        mb.line_terminator(Some(b'\n'));
    }
    // grep-regex wraps the pattern as rg does, so errors quote the same text
    let matcher = mb.build(&o.pattern).map_err(regex_error)?;

    let haystacks: Vec<(PathBuf, bool)> = if is_dir {
        let mut globs = vec!["!.git/".to_string()];
        globs.extend(split_globs(o.glob.as_deref()));
        let b = walker(path, true, false, &globs, o.file_type.as_deref().filter(|t| !t.is_empty()))?;
        let mut files = walk_files(&b, started);
        if o.mode == "files" {
            let mut with_time: Vec<(std::time::SystemTime, PathBuf)> = files.into_iter().map(|p| (mtime(&p), p)).collect();
            with_time.sort_by_key(|f| std::cmp::Reverse(f.0));
            files = with_time.into_iter().map(|(_, p)| p).collect();
        }
        files.into_iter().map(|p| (p, false)).collect()
    } else {
        // a file named on the command line is searched whatever the globs say
        if let Some(t) = o.file_type.as_deref().filter(|t| !t.is_empty()) {
            walker(path, true, false, &[], Some(t))?;
        }
        vec![(PathBuf::from(path), true)]
    };

    let searcher_for = |explicit: bool| {
        SearcherBuilder::new()
            .line_number(o.mode == "content" && o.line_numbers)
            .before_context(if o.mode == "content" { o.before } else { 0 })
            .after_context(if o.mode == "content" { o.after } else { 0 })
            .multi_line(o.multiline)
            .binary_detection(if explicit { BinaryDetection::convert(b'\x00') } else { BinaryDetection::quit(b'\x00') })
            .build()
    };

    if o.mode == "files" || o.mode == "count" {
        let kind = if o.mode == "files" { SummaryKind::PathWithMatch } else { SummaryKind::Count };
        let mut printer = SummaryBuilder::new().kind(kind).path(true).build_no_color(Vec::new());
        for (p, explicit) in &haystacks {
            if started.elapsed() > SEARCH_TIMEOUT {
                break;
            }
            let mut s = searcher_for(*explicit);
            let _ = s.search_path(&matcher, p, printer.sink_with_path(&matcher, p));
        }
        return Ok(String::from_utf8_lossy(&printer.into_inner().into_inner()).into_owned());
    }
    let context = o.before > 0 || o.after > 0;
    let mut printer = StandardBuilder::new()
        .path(true)
        .heading(false)
        .max_columns(Some(500))
        .max_columns_preview(true)
        .separator_search(if context { Some(b"--".to_vec()) } else { None })
        .build_no_color(Vec::new());
    for (p, explicit) in &haystacks {
        if started.elapsed() > SEARCH_TIMEOUT {
            break;
        }
        let mut s = searcher_for(*explicit);
        let _ = s.search_path(&matcher, p, printer.sink_with_path(&matcher, p));
        if printer.get_mut().get_ref().len() > MAX_STDOUT {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&printer.into_inner().into_inner()).into_owned())
}
