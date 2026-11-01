//! redactSecrets from memory/secrets.ts. The same patterns, rewritten for
//! Rust: `\b`, `\d`, `\w` and `\s` keep JavaScript's meaning (ASCII word
//! characters, ASCII digits, JavaScript whitespace). Patterns with lookahead
//! use fancy-regex; the rest use the regex crate.

use std::sync::OnceLock;

enum Pat {
    Plain(regex::Regex),
    Fancy(fancy_regex::Regex),
}

/// A pattern source with {S} for `\s` contents, {B} for an ASCII `\b`.
fn expand(src: &str) -> String {
    src.replace("{S}", crate::js::WS_CLASS).replace("{B}", r"(?-u:\b)")
}

fn plain(src: &str) -> Pat {
    Pat::Plain(regex::Regex::new(&expand(src)).expect("secret pattern"))
}

fn fancy(src: &str) -> Pat {
    let mut b = fancy_regex::RegexBuilder::new(&expand(src));
    b.backtrack_limit(50_000_000);
    Pat::Fancy(b.build().expect("secret pattern"))
}

// a word character before / after, for `\b` next to a known word character
const NWB: &str = r"(?<![A-Za-z0-9_])";
const NWA: &str = r"(?![A-Za-z0-9_])";

fn patterns() -> &'static Vec<Pat> {
    static P: OnceLock<Vec<Pat>> = OnceLock::new();
    P.get_or_init(|| {
        let f = |s: String| fancy(&s);
        vec![
            plain(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
            plain(r"{B}(?:AKIA|ASIA)[0-9A-Z]{16}{B}"),
            plain(r"{B}gh[pousr]_[A-Za-z0-9]{30,}{B}"),
            plain(r"{B}github_pat_[A-Za-z0-9_]{20,}{B}"),
            plain(r"{B}glpat-[A-Za-z0-9_-]{20,}{B}"),
            plain(r"{B}sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}{B}"),
            plain(r"{B}xox[abposr]-[A-Za-z0-9-]{10,}{B}"),
            plain(r"{B}AIza[0-9A-Za-z_-]{35}{B}"),
            plain(r"{B}[rs]k_(?:live|test)_[A-Za-z0-9]{16,}{B}"),
            plain(r"{B}[0-9]{8,10}:[A-Za-z0-9_-]{35}{B}"),
            plain(r"{B}eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
            plain(r"{B}tk_[A-Za-z0-9]{20,}{B}"),
            plain(r"{B}hf_[A-Za-z0-9]{30,}{B}"),
            plain(r"{B}npm_[A-Za-z0-9]{30,}{B}"),
            plain(r"(?i){B}Bearer[{S}]+[A-Za-z0-9._~+/=-]{16,}"),
            plain(r"(?i){B}[a-z][a-z0-9+.-]*://[^/:@{S}]+:[^/@{S}]+@"),
            plain(r"(?i){B}(?:password|passwd|passphrase|pwd){B}[{S}]*[:=][{S}]*[^{S}]+"),
            plain(r"(?i){B}(?:password|passphrase|pin code|recovery code)s?[{S}]+(?:is|was|=)[{S}]+[^{S}]+"),
            f(format!(r#"(?i){NWB}(?:secret|token|api[_ -]?key|apikey|access[_ -]?key|private[_ -]?key|client[_ -]?secret|auth[_ -]?key){NWA}[{{S}}]*[:=][{{S}}]*['"]?(?=[^{{S}}'"]*[0-9])[^{{S}}'"]{{8,}}"#)),
            plain(r"{B}[A-Fa-f0-9]{48,}{B}"),
            f(format!(
                r#"{NWB}[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_?(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASS|PWD)[{{S}}]*[:=][{{S}}]*(?:"(?![$<{{])[^"\n]{{4,}}"|'(?![$<{{])[^'\n]{{4,}}'|['"]?(?![$<{{]|\*{{3}})(?=[^{{S}}'"]*[^{{S}}'"0-9])[^{{S}}'"]{{6,}})"#
            )),
            plain(r#"(?i){B}PVEAPIToken=[^{S}'"]+"#),
            plain(r#"{B}sshpass[{S}]+-p[{S}]*['"]?[^{S}'"]+"#),
            f(format!(r#"{NWB}mysql(?:dump)?{NWA}[^\n]*?[{{S}}]-p(?![{{S}}])['"]?[^{{S}}'"]+"#)),
            plain(r#"{B}curl{B}[^\n]*?[{S}](?:-u|--user)[{S}]+['"]?[^{S}:'"]+:[^{S}'"]+"#),
            fancy(r#"--password(?:=|[{S}]+)['"]?(?![$<{])[^{S}'"]+"#),
            plain(r#"{B}(?:RESTIC_PASSWORD|BORG_PASSPHRASE|RESTIC_REPOSITORY_PASSWORD|BORG_PASSCOMMAND){B}[{S}]*[:=][{S}]*(?:"[^"\n]+"|'[^'\n]+'|[^{S}'"]+)"#),
            f(format!(
                r#"(?i){NWB}(?:password|passphrase|passwd){NWA}(?:[{{S}}]+(?:for|of|on)(?:[{{S}}]+(?!is{NWA}|was{NWA})[A-Za-z0-9_.@:/-]+){{1,3}})?[{{S}}]+(?:is|was)[{{S}}]+['"]?(?=[^{{S}}'"]*[0-9!@#$%^&*])[^{{S}}'"]{{6,}}"#
            )),
            f(format!(r#"(?i){NWB}(?:password|passphrase|passwd)[{{S}}]+(?:to|as)[{{S}}]+['"]?(?=[^{{S}}'"]*[0-9])(?=[^{{S}}'"]*[A-Za-z])[^{{S}}'"]{{6,}}"#)),
            f(format!(r#"{NWB}(?:docker|podman|nerdctl|helm(?:[{{S}}]+registry)?)[{{S}}]+login{NWA}[^\n]*?[{{S}}]-p[{{S}}]*['"]?(?![$<{{-])[^{{S}}'"]+"#)),
            f(format!(r#"{NWB}echo[{{S}}]+['"]?(?![$<{{])[^{{S}}'"|]{{4,}}['"]?[{{S}}]*\|[{{S}}]*sudo[{{S}}]+(?:-[A-Za-z0-9_]+[{{S}}]+)*-S{NWA}"#)),
            plain(r"(?i){B}(?:password|passphrase|passwd){B}[^\n]{0,40}?{B}[A-Fa-f0-9]{20,}{B}"),
            plain(r"b3BlbnNzaC1rZXktdjE[A-Za-z0-9+/=]*"),
            fancy(r"(?m)^(?=[^\n]*[0-9])(?=[^\n]*[A-Z])(?=[^\n]*[a-z])[A-Za-z0-9+/]{60,76}={0,2}$"),
            fancy(r"(?:(?<=[A-Za-z0-9_])(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])(?=[A-Za-z0-9_]))(?=[A-Za-z0-9_+-]*[0-9])(?=[A-Za-z0-9_+-]*[A-Z])(?=[A-Za-z0-9_+-]*[a-z])[A-Za-z0-9_+-]{40,}={0,2}"),
        ]
    })
}

pub fn redact(text: &str) -> String {
    let mut out = text.to_string();
    for p in patterns() {
        let next = match p {
            Pat::Plain(re) => match re.replace_all(&out, regex::NoExpand("[redacted]")) {
                std::borrow::Cow::Borrowed(_) => None,
                std::borrow::Cow::Owned(s) => Some(s),
            },
            Pat::Fancy(re) => match re.try_replacen(&out, 0, |_: &fancy_regex::Captures| "[redacted]") {
                Ok(std::borrow::Cow::Owned(s)) => Some(s),
                _ => None,
            },
        };
        if let Some(s) = next {
            out = s;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pattern_compiles() {
        assert_eq!(patterns().len(), 35);
    }

    #[test]
    fn redacts_like_secrets_ts() {
        assert_eq!(redact("key sk-ant-abcdefghijklmnopqrstuvwxyz here"), "key [redacted] here");
        assert_eq!(redact("export CLOUDFLARE_API_TOKEN=abcdef123456"), "export [redacted]");
        assert_eq!(redact("CLOUDFLARE_API_TOKEN=$TOKEN"), "CLOUDFLARE_API_TOKEN=$TOKEN");
        assert_eq!(redact("password: hunter22"), "[redacted]");
        assert_eq!(redact("the root password for pve is s3cret!x"), "the root [redacted]");
        assert_eq!(redact("mysql -u root -pS3cr3t db"), "[redacted] db");
        assert_eq!(redact("curl -u admin:pa55 https://x"), "[redacted] https://x");
        assert_eq!(redact("plain words only"), "plain words only");
        assert_eq!(redact("git sha 0123456789abcdef0123456789abcdef01234567"), "git sha 0123456789abcdef0123456789abcdef01234567");
        assert_eq!(redact("token=abc12345678"), "[redacted]");
        assert_eq!(redact("https://user:pw@example.com/x"), "[redacted]example.com/x");
    }
}
