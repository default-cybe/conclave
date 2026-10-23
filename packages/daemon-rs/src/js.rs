//! Small pieces of JavaScript behavior the TypeScript daemon relies on:
//! string lengths in UTF-16 units, `trim`, `String(v)`, `JSON.stringify`,
//! truthiness and `Date.parse` for ISO dates. The importers and the exec
//! buffers use them so their output matches the TypeScript daemon.

use serde_json::{Map, Value};

pub type Obj = Map<String, Value>;

/// `s.length` in JavaScript: UTF-16 code units.
pub fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// Byte index of the UTF-16 position `pos` (clamped). A position inside a
/// surrogate pair moves back to the start of that character.
pub fn byte_at16(s: &str, pos: usize) -> usize {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        let n = c.len_utf16();
        if units + n > pos {
            return i;
        }
        units += n;
    }
    s.len()
}

/// `s.slice(start, end)` with UTF-16 positions (no negative positions).
pub fn slice16(s: &str, start: usize, end: usize) -> &str {
    let a = byte_at16(s, start);
    let b = byte_at16(s, end.max(start));
    &s[a..b.max(a)]
}

/// Whitespace and line terminators as JavaScript's `trim` and `\s` see them.
pub fn is_js_ws(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// The characters of `\s` in a JavaScript regex, for building Rust regex classes.
pub const WS_CLASS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_ws)
}

pub fn trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_ws)
}

/// JavaScript truthiness of a JSON value (`None` is undefined).
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `a ?? b`: undefined and null are both nullish.
pub fn nullish(v: Option<&Value>) -> bool {
    matches!(v, None | Some(Value::Null))
}

/// `v?.[key]` on any value: only objects have properties here.
pub fn prop<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    match v {
        Some(Value::Object(o)) => o.get(key),
        _ => None,
    }
}

/// First of the values that is not nullish (`a ?? b ?? c`).
pub fn coalesce<'a>(vals: &[Option<&'a Value>]) -> Option<&'a Value> {
    vals.iter().copied().find(|v| !nullish(*v)).flatten()
}

pub fn as_str(v: Option<&Value>) -> Option<&str> {
    match v {
        Some(Value::String(s)) => Some(s.as_str()),
        _ => None,
    }
}

pub fn is_obj(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_)))
}

/// `typeof v === 'object' && v` (arrays count, null does not).
pub fn is_object_like(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_)) | Some(Value::Array(_)))
}

/// Number.prototype.toString for finite and non-finite numbers.
pub fn num_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.fract() == 0.0 && x.abs() < 1e21 {
        return format!("{x:.0}");
    }
    // shortest round trip digits, then JavaScript's choice of notation
    let sci = format!("{:e}", x.abs());
    let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let digits: String = mant.chars().filter(|c| c.is_ascii_digit()).collect();
    let k = digits.len() as i32;
    let n = exp + 1;
    let sign = if x < 0.0 { "-" } else { "" };
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let es = if e >= 0 { format!("+{e}") } else { format!("{e}") };
        if k == 1 {
            format!("{digits}e{es}")
        } else {
            format!("{}.{}e{es}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

fn number_string(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        if i.unsigned_abs() <= (1u64 << 53) {
            return i.to_string();
        }
    }
    if let Some(u) = n.as_u64() {
        if u <= (1u64 << 53) {
            return u.to_string();
        }
    }
    num_to_string(n.as_f64().unwrap_or(f64::NAN))
}

/// `String(v)` (undefined becomes "undefined").
pub fn js_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => number_string(n),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| match x {
                Value::Null => String::new(),
                other => js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `JSON.stringify(v)`, compact, with JavaScript's number formatting.
pub fn stringify(v: &Value) -> String {
    let mut out = String::new();
    write_json(v, &mut out);
    out
}

fn write_json(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let s = number_string(n);
            if s == "NaN" || s.ends_with("Infinity") {
                out.push_str("null")
            } else {
                out.push_str(&s)
            }
        }
        Value::String(s) => out.push_str(&serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(x, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            out.push('{');
            for (i, (k, x)) in o.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                write_json(x, out);
            }
            out.push('}');
        }
    }
}

/// A JSON number for an f64 that is an integer when it can be.
pub fn num(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9.0e15 {
        Value::from(x as i64)
    } else {
        serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
    }
}

/// `Math.round`.
pub fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `toLowerCase`.
pub fn lower(s: &str) -> String {
    s.to_lowercase()
}

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Parse JSON like `JSON.parse`. serde_json refuses lone surrogate escapes that
/// JavaScript keeps; those become U+FFFD here (the same length in UTF-16).
pub fn parse_json(text: &str) -> Result<Value, String> {
    match serde_json::from_str::<Value>(text) {
        Ok(v) => Ok(v),
        Err(e) => {
            if text.contains("\\u") || text.contains("\\U") {
                if let Some(fixed) = fix_lone_surrogates(text) {
                    if let Ok(v) = serde_json::from_str::<Value>(&fixed) {
                        return Ok(v);
                    }
                }
            }
            Err(format!("JSON Parse error: {e}"))
        }
    }
}

fn hex4(b: &[u8]) -> Option<u16> {
    if b.len() < 4 {
        return None;
    }
    u16::from_str_radix(std::str::from_utf8(&b[..4]).ok()?, 16).ok()
}

/// Replace `\uD800`-`\uDFFF` escapes that are not part of a valid pair with `�`.
fn fix_lone_surrogates(text: &str) -> Option<String> {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut last = 0;
    let mut changed = false;
    while i + 1 < b.len() {
        if b[i] == b'\\' {
            if b[i + 1] == b'u' {
                if let Some(u) = hex4(&b[i + 2..]) {
                    if (0xD800..0xDC00).contains(&u) {
                        // a high surrogate must be followed by \uDC00-\uDFFF
                        let next = if i + 12 <= b.len() && b[i + 6] == b'\\' && b[i + 7] == b'u' { hex4(&b[i + 8..]) } else { None };
                        if matches!(next, Some(n) if (0xDC00..0xE000).contains(&n)) {
                            i += 12;
                            continue;
                        }
                        out.push_str(&text[last..i]);
                        out.push_str("\\uFFFD");
                        i += 6;
                        last = i;
                        changed = true;
                        continue;
                    }
                    if (0xDC00..0xE000).contains(&u) {
                        out.push_str(&text[last..i]);
                        out.push_str("\\uFFFD");
                        i += 6;
                        last = i;
                        changed = true;
                        continue;
                    }
                }
                i += 2;
                continue;
            }
            // any other escape: skip the escaped character
            i += 2;
            continue;
        }
        i += 1;
    }
    if !changed {
        return None;
    }
    out.push_str(&text[last..]);
    Some(out)
}

/// `Date.parse` for the ISO 8601 forms transcripts use. Returns ms since the epoch.
/// A date and time without an offset is local time, as in JavaScript.
pub fn date_parse(s: &str) -> Option<f64> {
    let s = s.trim();
    let b = s.as_bytes();
    let mut i = 0;
    let num = |from: usize, len: usize| -> Option<i64> {
        if from + len > b.len() || !b[from..from + len].iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(&b[from..from + len]).ok()?.parse().ok()
    };
    let (year, ylen) = if b.first() == Some(&b'+') || b.first() == Some(&b'-') {
        let y = num(1, 6)?;
        (if b[0] == b'-' { -y } else { y }, 7)
    } else {
        (num(0, 4)?, 4)
    };
    i += ylen;
    let mut month = 1;
    let mut day = 1;
    if b.get(i) == Some(&b'-') {
        month = num(i + 1, 2)?;
        i += 3;
        if b.get(i) == Some(&b'-') {
            day = num(i + 1, 2)?;
            i += 3;
        }
    }
    let (mut hh, mut mm, mut ss, mut ms) = (0i64, 0i64, 0i64, 0f64);
    let mut has_time = false;
    let mut offset_min: Option<i64> = None;
    if i < b.len() && (b[i] == b'T' || b[i] == b't' || b[i] == b' ') {
        has_time = true;
        hh = num(i + 1, 2)?;
        if b.get(i + 3) != Some(&b':') {
            return None;
        }
        mm = num(i + 4, 2)?;
        i += 6;
        if b.get(i) == Some(&b':') {
            ss = num(i + 1, 2)?;
            i += 3;
            if b.get(i) == Some(&b'.') || b.get(i) == Some(&b',') {
                let start = i + 1;
                let mut j = start;
                while j < b.len() && b[j].is_ascii_digit() {
                    j += 1;
                }
                if j == start {
                    return None;
                }
                let frac = &s[start..j];
                let first3: String = frac.chars().chain(std::iter::repeat('0')).take(3).collect();
                ms = first3.parse::<f64>().ok()?;
                i = j;
            }
        }
        if i < b.len() {
            match b[i] {
                b'Z' | b'z' => {
                    offset_min = Some(0);
                    i += 1;
                }
                b'+' | b'-' => {
                    let sign = if b[i] == b'-' { -1 } else { 1 };
                    let oh = num(i + 1, 2)?;
                    let om = if b.get(i + 3) == Some(&b':') { num(i + 4, 2)? } else { num(i + 3, 2)? };
                    i += if b.get(i + 3) == Some(&b':') { 6 } else { 5 };
                    offset_min = Some(sign * (oh * 60 + om));
                }
                _ => return None,
            }
        }
    }
    if i != b.len() {
        return None;
    }
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) || hh > 24 || mm > 59 || ss > 59 {
        return None;
    }
    if hh == 24 && (mm != 0 || ss != 0 || ms != 0.0) {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let utc_ms = (days * 86_400 + hh * 3600 + mm * 60 + ss) as f64 * 1000.0 + ms;
    match (has_time, offset_min) {
        (_, Some(off)) => Some(utc_ms - off as f64 * 60_000.0),
        (false, None) => Some(utc_ms),
        (true, None) => Some(utc_ms - local_offset_ms(utc_ms)),
    }
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if is_leap(y) {
                29
            } else {
                28
            }
        }
    }
}

/// Days since 1970-01-01 for a proleptic Gregorian date.
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Offset of local time from UTC at a wall-clock time given as if it were UTC.
#[cfg(unix)]
fn local_offset_ms(wall_as_utc_ms: f64) -> f64 {
    let t = (wall_as_utc_ms / 1000.0).floor() as libc::time_t;
    // SAFETY: localtime_r writes into the tm we pass; tm is plain data.
    unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&t, &mut tm).is_null() {
            return 0.0;
        }
        let first = tm.tm_gmtoff as f64 * 1000.0;
        // the offset at the resulting instant (DST edges)
        let t2 = ((wall_as_utc_ms - first) / 1000.0).floor() as libc::time_t;
        if libc::localtime_r(&t2, &mut tm).is_null() {
            return first;
        }
        tm.tm_gmtoff as f64 * 1000.0
    }
}

#[cfg(not(unix))]
fn local_offset_ms(_wall_as_utc_ms: f64) -> f64 {
    0.0
}

/// `parseTime` from importers/files.ts.
pub fn parse_time(v: Option<&Value>, fallback: f64) -> f64 {
    match v {
        Some(Value::Number(n)) => {
            let x = n.as_f64().unwrap_or(f64::NAN);
            if x < 1e12 {
                x * 1000.0
            } else {
                x
            }
        }
        Some(Value::String(s)) => date_parse(s).unwrap_or(fallback),
        _ => fallback,
    }
}

/// Decodes a byte stream as UTF-8 the way TextDecoder does with `stream: true`:
/// bad bytes become U+FFFD and a character split across chunks waits for its rest.
#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, chunk: &[u8]) -> String {
        let mut data = std::mem::take(&mut self.pending);
        data.extend_from_slice(chunk);
        let mut out = String::with_capacity(data.len());
        let mut rest: &[u8] = &data;
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let good = e.valid_up_to();
                    // SAFETY: from_utf8 said the first `good` bytes are valid UTF-8
                    out.push_str(unsafe { std::str::from_utf8_unchecked(&rest[..good]) });
                    match e.error_len() {
                        Some(n) => {
                            out.push('\u{FFFD}');
                            rest = &rest[good + n..];
                        }
                        None => {
                            self.pending = rest[good..].to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }

    /// End of the stream: an unfinished character becomes U+FFFD.
    pub fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            String::new()
        } else {
            self.pending.clear();
            "\u{FFFD}".into()
        }
    }
}

/// `Buffer.from(s, 'base64')`: lenient about whitespace, padding and the URL-safe alphabet.
pub fn decode_base64_lenient(s: &str) -> Vec<u8> {
    let mut clean = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '+' | '/' => clean.push(c),
            '-' => clean.push('+'),
            '_' => clean.push('/'),
            '=' => break,
            _ => {}
        }
    }
    if clean.len() % 4 == 1 {
        clean.pop();
    }
    use base64::engine::{general_purpose::GeneralPurposeConfig, DecodePaddingMode, GeneralPurpose};
    use base64::Engine;
    let engine = GeneralPurpose::new(&base64::alphabet::STANDARD, GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::RequireNone).with_decode_allow_trailing_bits(true));
    engine.decode(clean.as_bytes()).unwrap_or_default()
}

pub fn encode_base64(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn utf16_lengths_and_slices() {
        assert_eq!(len16("abc"), 3);
        assert_eq!(len16("a😀"), 3);
        assert_eq!(slice16("a😀b", 0, 2), "a");
        assert_eq!(slice16("a😀b", 0, 3), "a😀");
        assert_eq!(slice16("héllo", 1, 3), "él");
    }

    #[test]
    fn numbers_print_like_javascript() {
        assert_eq!(num_to_string(1.0), "1");
        assert_eq!(num_to_string(0.5), "0.5");
        assert_eq!(num_to_string(1e21), "1e+21");
        assert_eq!(num_to_string(1.5e-7), "1.5e-7");
        assert_eq!(num_to_string(123.456), "123.456");
        assert_eq!(num_to_string(0.000001), "0.000001");
        assert_eq!(stringify(&json!({"a": 1.0, "b": [true, null, "x\n"]})), r#"{"a":1,"b":[true,null,"x\n"]}"#);
        assert_eq!(js_string(Some(&json!([1, null, "a"]))), "1,,a");
    }

    #[test]
    fn trims_like_javascript() {
        assert_eq!(trim("\u{FEFF} x \u{2028}"), "x");
        // NEL is not whitespace in JavaScript
        assert_eq!(trim("\u{85}x"), "\u{85}x");
    }

    #[test]
    fn dates() {
        assert_eq!(date_parse("2025-01-02T03:04:05.678Z"), Some(1_735_787_045_678.0));
        assert_eq!(date_parse("2025-01-02T03:04:05.6789Z"), Some(1_735_787_045_678.0));
        assert_eq!(date_parse("2025-01-02"), Some(1_735_776_000_000.0));
        assert_eq!(date_parse("2025-01-02T03:04:05+01:00"), Some(1_735_783_445_000.0));
        assert_eq!(date_parse("nope"), None);
        assert_eq!(parse_time(Some(&json!(1_700_000_000)), 0.0), 1_700_000_000_000.0);
    }

    #[test]
    fn lone_surrogates_parse() {
        let v = parse_json(r#"{"a":"x\ud83d"}"#).unwrap();
        assert_eq!(v["a"], "x\u{FFFD}");
        let v = parse_json(r#"{"a":"😀"}"#).unwrap();
        assert_eq!(v["a"], "😀");
    }

    #[test]
    fn utf8_stream_splits() {
        let mut d = Utf8Stream::default();
        let euro = "€".as_bytes();
        assert_eq!(d.push(&euro[..2]), "");
        assert_eq!(d.push(&euro[2..]), "€");
        assert_eq!(d.push(&[0xff, b'o', b'k', 0xe2, 0x82]), "\u{FFFD}ok");
        assert_eq!(d.finish(), "\u{FFFD}");
    }

    #[test]
    fn base64_is_lenient() {
        assert_eq!(decode_base64_lenient("aGk="), b"hi");
        assert_eq!(decode_base64_lenient("aGk"), b"hi");
        assert_eq!(decode_base64_lenient("a G\nk"), b"hi");
    }
}
