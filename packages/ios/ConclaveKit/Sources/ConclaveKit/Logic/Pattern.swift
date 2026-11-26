import Foundation

/// A java.util.regex-style pattern, so the Kotlin rules port as they are.
/// NSRegularExpression (ICU) reads the same syntax, lookahead included.
struct Pattern: @unchecked Sendable {
    // NSRegularExpression is immutable and documented thread safe.
    private let re: NSRegularExpression

    init(_ pattern: String, ignoreCase: Bool = false) {
        // a bad pattern is a bug in this file, not input
        re = try! NSRegularExpression(pattern: pattern, options: ignoreCase ? [.caseInsensitive] : [])
    }

    private func range(_ s: String) -> NSRange { NSRange(s.startIndex..., in: s) }

    func contains(_ s: String) -> Bool { re.firstMatch(in: s, range: range(s)) != nil }

    /// The groups of the first match, "" for one that took no part (Kotlin's groupValues).
    func find(_ s: String) -> [String]? {
        guard let m = re.firstMatch(in: s, range: range(s)) else { return nil }
        return (0..<m.numberOfRanges).map { i in Range(m.range(at: i), in: s).map { String(s[$0]) } ?? "" }
    }

    /// The groups when the whole string matches.
    func matchEntire(_ s: String) -> [String]? {
        guard let g = find(s), g[0].utf16.count == s.utf16.count else { return nil }
        return g
    }

    func replace(_ s: String, with template: String) -> String {
        re.stringByReplacingMatches(in: s, range: range(s), withTemplate: template)
    }
}

extension String {
    /// Kotlin's substringBefore: the whole string when there is no [c].
    func before(_ c: Character) -> String { firstIndex(of: c).map { String(self[..<$0]) } ?? self }

    /// Kotlin's substringAfter: the whole string when there is no [c].
    func after(_ c: Character) -> String { firstIndex(of: c).map { String(self[index(after: $0)...]) } ?? self }

    /// Kotlin's substringAfterLast: the whole string when there is no [c].
    func afterLast(_ c: Character) -> String { lastIndex(of: c).map { String(self[index(after: $0)...]) } ?? self }

    /// Kotlin's substringBeforeLast with a fallback.
    func beforeLast(_ c: Character, or fallback: String) -> String { lastIndex(of: c).map { String(self[..<$0]) } ?? fallback }

    func removingPrefix(_ p: String) -> String { hasPrefix(p) ? String(dropFirst(p.count)) : self }

    func removingSuffix(_ p: String) -> String { hasSuffix(p) ? String(dropLast(p.count)) : self }

    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}
