import SwiftUI
import UIKit

/// Draws a message's markdown: headings, lists, code blocks, tables, quotes, links and inline code.
struct MarkdownView: View {
    let blocks: [MDBlock]

    init(_ text: String) { blocks = MarkdownBlocks.parse(text) }
    init(blocks: [MDBlock]) { self.blocks = blocks }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { BlockView(block: $0.element) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct BlockView: View {
    let block: MDBlock

    var body: some View {
        switch block {
        case .paragraph(let s):
            Text(s).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        case .heading(let level, let s):
            Text(s)
                .font(level == 1 ? .title2.bold() : level == 2 ? .title3.bold() : .headline)
                .padding(.top, 4)
                .accessibilityAddTraits(.isHeader)
        case .list(let start, let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if let checked = item.checked {
                            Image(systemName: checked ? "checkmark.square" : "square").foregroundStyle(Tone.fg3)
                        } else {
                            Text(start.map { "\($0 + i)." } ?? "\u{2022}").foregroundStyle(Tone.fg3).monospacedDigit()
                        }
                        MarkdownView(blocks: item.blocks)
                    }
                }
            }
        case .code(let language, let text):
            CodeBlockView(language: language, text: text)
        case .quote(let inner):
            MarkdownView(blocks: inner)
                .foregroundStyle(Tone.fg2)
                .padding(.leading, 12)
                .overlay(alignment: .leading) { Rectangle().fill(Tone.rule).frame(width: 3) }
        case .table(let head, let rows):
            TableView(head: head, rows: rows)
        case .rule:
            Divider()
        }
    }
}

/// Monospaced, scrolls sideways instead of wrapping, with the language and a copy button.
struct CodeBlockView: View {
    let language: String?
    let text: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language ?? "code").font(.caption).foregroundStyle(Tone.fg3)
                Spacer()
                Button {
                    UIPasteboard.general.string = text
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        copied = false
                    }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            Divider()
            ScrollView(.horizontal) {
                Text(text)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize()
                    .padding(12)
            }
        }
        .background(Tone.sunk, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Tone.rule))
    }
}

private struct TableView: View {
    let head: [AttributedString]
    let rows: [[AttributedString]]

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                GridRow {
                    ForEach(Array(head.enumerated()), id: \.offset) { Text($0.element).bold() }
                }
                Divider()
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { Text($0.element) }
                    }
                }
            }
            .padding(12)
        }
        .background(Tone.sunk, in: RoundedRectangle(cornerRadius: 10))
    }
}
