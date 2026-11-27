import SwiftUI
import UIKit

/// Draws a message's markdown as the web's `.md` does (styles/index.css): Mona Sans at the reading size
/// (15/1.6 on iPad, 16/1.55 on a phone), headings 1.375, 1.2 and 1.0625 em, inline code as a small
/// mono chip, code in a sunk box, tables with rules between rows, quotes with a hairline on the left.
struct MarkdownView: View {
    let blocks: [MDBlock]
    @Environment(\.horizontalSizeClass) private var sizeClass

    init(_ text: String) { blocks = MarkdownBlocks.parse(text) }
    init(blocks: [MDBlock]) { self.blocks = blocks }

    var body: some View {
        let m = Metrics(sizeClass)
        VStack(alignment: .leading, spacing: m.read * 0.9) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { BlockView(block: $0.element, m: m) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Inline styles of a run: strong 600, em 560 (the web does not slant), code a mono chip, links underlined.
func inlineStyled(_ a: AttributedString, size: CGFloat, weight: Font.Weight = .regular) -> AttributedString {
    var out = a
    for run in a.runs {
        let i = run.inlinePresentationIntent ?? []
        // SwiftUI's keys by type: UIKit is imported too, and `c.font` would be ambiguous
        typealias UI = AttributeScopes.SwiftUIAttributes
        var c = AttributeContainer()
        if i.contains(.code) {
            c[UI.FontAttribute.self] = Font.mono(size * 0.875)
            c[UI.BackgroundColorAttribute.self] = Tone.sunk
        } else {
            c[UI.FontAttribute.self] = Font.sans(size, i.contains(.stronglyEmphasized) ? .semibold : i.contains(.emphasized) ? .medium : weight)
        }
        if i.contains(.strikethrough) { c[UI.StrikethroughStyleAttribute.self] = Text.LineStyle.single }
        if run.link != nil {
            c[UI.UnderlineStyleAttribute.self] = Text.LineStyle.single
            c[UI.ForegroundColorAttribute.self] = Tone.fg
        }
        out[run.range].mergeAttributes(c)
    }
    return out
}

private struct BlockView: View {
    let block: MDBlock
    let m: Metrics

    var body: some View {
        switch block {
        case .paragraph(let s):
            Text(inlineStyled(s, size: m.read))
                .lineSpacing(m.readSpacing)
                .foregroundStyle(Tone.fg)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        case .heading(let level, let s):
            let size = m.read * (level == 1 ? 1.375 : level == 2 ? 1.2 : level == 3 ? 1.0625 : 1)
            Text(inlineStyled(s, size: size, weight: .semibold))
                .foregroundStyle(level >= 4 ? Tone.fg2 : Tone.fg)
                .padding(.top, m.read * 0.6)
                .accessibilityAddTraits(.isHeader)
        case .list(let start, let items):
            VStack(alignment: .leading, spacing: m.read * 0.4) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Group {
                            if let checked = item.checked {
                                Image(systemName: checked ? "checkmark.square.fill" : "square")
                                    .font(.system(size: m.read * 0.85))
                                    .foregroundStyle(checked ? Tone.fg2 : Tone.fg3)
                            } else {
                                Text(start.map { "\($0 + i)." } ?? "\u{2022}").font(.sans(m.read)).monospacedDigit()
                            }
                        }
                        .foregroundStyle(Tone.fg3)
                        .frame(minWidth: 12, alignment: .leading)
                        MarkdownView(blocks: item.blocks)
                    }
                }
            }
        case .code(let language, let text):
            CodeBlockView(language: language, text: text)
        case .quote(let inner):
            MarkdownView(blocks: inner)
                .foregroundStyle(Tone.fg2)
                .padding(.leading, 14)
                .overlay(alignment: .leading) { Rectangle().fill(Tone.rule2).frame(width: 1) }
        case .table(let head, let rows):
            TableView(head: head, rows: rows, size: m.read * 0.875)
        case .rule:
            Rectangle().fill(Tone.rule).frame(height: 1).padding(.vertical, m.read * 0.8)
        }
    }
}

/// The web's CodeBlock (components/ui/Code.tsx): a sunk box with a hairline, radius 5, the language at
/// the top left in 12 pt fg-3, a copy icon that turns into a check; mono 13, scrolls sideways.
struct CodeBlockView: View {
    let language: String?
    let text: String
    @State private var copied = false
    @Environment(\.accessibilityReduceMotion) private var reduce

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language ?? "").font(.sans(12)).foregroundStyle(Tone.fg3)
                Spacer()
                Button {
                    UIPasteboard.general.string = text
                    withAnimation(Motion.of(Motion.ease(Motion.dur1), reduce: reduce)) { copied = true }
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        withAnimation(Motion.of(Motion.ease(Motion.dur1), reduce: reduce)) { copied = false }
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 12))
                        .foregroundStyle(copied ? Tone.ok : Tone.fg3)
                        .contentTransition(.symbolEffect(.replace))
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(copied ? "Copied" : "Copy code")
            }
            .padding(.leading, 12).padding(.trailing, 2)
            .frame(height: 32)
            ScrollView(.horizontal) {
                Text(text)
                    .font(.mono(13))
                    .lineSpacing(4)
                    .foregroundStyle(Tone.fg)
                    .textSelection(.enabled)
                    .fixedSize()
                    .padding(.horizontal, 12)
                    .padding(.bottom, 10)
            }
            .scrollIndicators(.hidden)
        }
        .panel(Tone.sunk, radius: Radius.r2, border: Tone.rule)
    }
}

private struct TableView: View {
    let head: [AttributedString]
    let rows: [[AttributedString]]
    let size: CGFloat

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(head.enumerated()), id: \.offset) {
                        Text(inlineStyled($0.element, size: size * 0.93, weight: .medium)).foregroundStyle(Tone.fg3).padding(.vertical, 8)
                    }
                }
                Rectangle().fill(Tone.rule).frame(height: 1).gridCellUnsizedAxes(.horizontal)
                ForEach(Array(rows.enumerated()), id: \.offset) { r, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) {
                            Text(inlineStyled($0.element, size: size)).foregroundStyle(Tone.fg).padding(.vertical, 8)
                        }
                    }
                    if r < rows.count - 1 { Rectangle().fill(Tone.rule).frame(height: 1).gridCellUnsizedAxes(.horizontal) }
                }
            }
        }
        .scrollIndicators(.hidden)
    }
}
