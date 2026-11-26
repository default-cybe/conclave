import Foundation
import Markdown

/// A message's markdown as blocks our SwiftUI renderer draws, from Apple's swift-markdown (cmark-gfm).
indirect enum MDBlock: Hashable {
    case paragraph(AttributedString)
    case heading(level: Int, AttributedString)
    case list(start: Int?, items: [MDItem])
    case code(language: String?, text: String)
    case quote([MDBlock])
    case table(head: [AttributedString], rows: [[AttributedString]])
    case rule
}

struct MDItem: Hashable {
    /// Nil for a plain item; true or false for a task list's checkbox.
    var checked: Bool?
    var blocks: [MDBlock]
}

enum MarkdownBlocks {
    static func parse(_ text: String) -> [MDBlock] {
        blocks(Document(parsing: text).children)
    }

    private static func blocks(_ children: MarkupChildren) -> [MDBlock] {
        children.compactMap(block)
    }

    private static func block(_ m: Markup) -> MDBlock? {
        switch m {
        case let p as Paragraph: return .paragraph(inline(p.children))
        case let h as Heading: return .heading(level: h.level, inline(h.children))
        case let l as UnorderedList: return .list(start: nil, items: l.listItems.map(item))
        case let l as OrderedList: return .list(start: Int(l.startIndex), items: l.listItems.map(item))
        case let c as CodeBlock: return .code(language: c.language.flatMap { $0.isEmpty ? nil : $0 }, text: String(c.code.dropLast(c.code.hasSuffix("\n") ? 1 : 0)))
        case let q as BlockQuote: return .quote(blocks(q.children))
        case let t as Table:
            return .table(
                head: t.head.cells.map { inline($0.children) },
                rows: t.body.rows.map { $0.cells.map { inline($0.children) } }
            )
        case is ThematicBreak: return .rule
        case let h as HTMLBlock: return .paragraph(AttributedString(h.rawHTML.trimmingCharacters(in: .newlines)))
        default: return nil
        }
    }

    private static func item(_ i: ListItem) -> MDItem {
        MDItem(checked: i.checkbox.map { $0 == .checked }, blocks: blocks(i.children))
    }

    private static func inline(_ children: MarkupChildren, _ intent: InlinePresentationIntent = []) -> AttributedString {
        children.reduce(into: AttributedString()) { out, c in out += inline(c, intent) }
    }

    private static func inline(_ m: Markup, _ intent: InlinePresentationIntent) -> AttributedString {
        func styled(_ s: String, _ i: InlinePresentationIntent) -> AttributedString {
            var a = AttributedString(s)
            if !i.isEmpty { a.inlinePresentationIntent = i }
            return a
        }
        switch m {
        case let t as Markdown.Text: return styled(t.string, intent)
        case let e as Emphasis: return inline(e.children, intent.union(.emphasized))
        case let s as Strong: return inline(s.children, intent.union(.stronglyEmphasized))
        case let s as Strikethrough: return inline(s.children, intent.union(.strikethrough))
        case let c as InlineCode: return styled(c.code, intent.union(.code))
        case is SoftBreak: return styled(" ", intent)
        case is LineBreak: return styled("\n", intent)
        case let h as InlineHTML: return styled(h.rawHTML, intent)
        case let l as Markdown.Link:
            var a = inline(l.children, intent)
            // only web and mail links open; anything else stays text
            if let d = l.destination, let url = URL(string: d), ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
                a.link = url
            }
            return a
        case let i as Markdown.Image:
            // a picture by url is a link to it: the transcript never loads remote images on its own
            var a = styled(i.plainText.isEmpty ? (i.source ?? "image") : i.plainText, intent)
            if let s = i.source, let url = URL(string: s), ["http", "https"].contains(url.scheme?.lowercased() ?? "") { a.link = url }
            return a
        default: return styled(m.format(), intent)
        }
    }
}
