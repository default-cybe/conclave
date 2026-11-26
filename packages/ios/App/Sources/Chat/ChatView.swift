import ConclaveKit
import SwiftUI

/// The transcript and its composer. Opens at the newest message; scrolling to the top reads the page
/// before it and keeps the message you were on in place. Approvals and questions show at the end.
struct ChatView: View {
    let chat: ChatModel
    let hub: HubModel
    let title: String
    @State private var position = ScrollPosition(edge: .bottom)

    var body: some View {
        let t = chat.transcript
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                if t.older {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .onAppear { Task { await older() } }
                }
                ForEach(t.messages) { m in
                    MessageView(message: m, transcript: t, client: chat.client)
                }
                if let o = chat.outgoing { OutgoingBubble(outgoing: o) }
                ForEach(t.approvals) { a in
                    ApprovalCard(request: a, viewing: chat.sessionId) { await chat.answer(a, $0) }
                }
                ForEach(t.questions) { q in
                    QuestionCard(request: q, viewing: chat.sessionId) { await chat.answer(q, $0) }
                }
            }
            .scrollTargetLayout()
            .padding(.vertical)
            // a fixed width: a wide code line or table must not widen the column past the margins
            .containerRelativeFrame(.horizontal) { w, _ in min(w - 32, 820) }
            .frame(maxWidth: .infinity)
        }
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            ComposerView(chat: chat, hub: hub)
                .frame(maxWidth: 820)
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 8)
                .background(.bar)
        }
        // a sent message scrolls into view
        .onChange(of: chat.outgoing != nil) { _, now in if now { withAnimation { position.scrollTo(edge: .bottom) } } }
        .overlay {
            if !chat.loaded { ProgressView() } else if let e = chat.error, t.messages.isEmpty {
                ContentUnavailableView("Could not load this chat", systemImage: "exclamationmark.triangle", description: Text(e))
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await chat.loadIfNeeded() }
    }

    private func older() async {
        let anchor = chat.transcript.messages.first?.id
        if await chat.loadOlder(), let anchor { position.scrollTo(id: anchor, anchor: .top) }
    }
}

private struct MessageView: View {
    let message: Message
    let transcript: Transcript
    let client: ConclaveClient

    var body: some View {
        if message.kind == .notice {
            Text(message.content.plainText).font(.footnote).foregroundStyle(Tone.fg3).frame(maxWidth: .infinity)
        } else if message.role == .user {
            let text = message.content.compactMap { b -> String? in if case .text(let s) = b, !b.isReminder { s } else { nil } }.joined(separator: "\n")
            let images = message.content.compactMap { b -> MediaBlock? in if case .image(let m) = b { m } else { nil } }
            if !text.isEmpty || !images.isEmpty {
                VStack(alignment: .trailing, spacing: 8) {
                    ForEach(Array(images.enumerated()), id: \.offset) { PictureView(media: $0.element, client: client) }
                    if !text.isEmpty {
                        Text(text)
                            .textSelection(.enabled)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(Tone.raise, in: RoundedRectangle(cornerRadius: 18))
                            .overlay(RoundedRectangle(cornerRadius: 18).stroke(Tone.rule))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.leading, 60)
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(message.content.enumerated()), id: \.offset) { _, b in
                    switch b {
                    case .text(let s) where !b.isReminder: MarkdownView(s)
                    case .thinking(let th): Fold(title: th.durationMs.map { "Thought for \(max(1, $0 / 1000))s" } ?? "Thinking", icon: "brain") {
                        Text(th.thinking).font(.callout).foregroundStyle(Tone.fg2).textSelection(.enabled)
                    }
                    case .toolUse(let u): ToolFold(use: u, result: transcript.toolResults[u.id], running: transcript.runningTools.contains(u.id), progress: transcript.toolProgress[u.id], client: client)
                    case .image(let m): PictureView(media: m, client: client)
                    default: EmptyView()
                    }
                }
            }
        }
    }
}

/// Your message as it goes, until the hub's copy takes its place.
private struct OutgoingBubble: View {
    let outgoing: Outgoing

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            if !outgoing.text.isEmpty {
                Text(outgoing.text)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Tone.raise, in: RoundedRectangle(cornerRadius: 18))
                    .overlay(RoundedRectangle(cornerRadius: 18).stroke(Tone.rule))
            }
            Text(outgoing.files.isEmpty ? "Sending" : "Sending, \(Attach.filesWord(outgoing.files.count))").font(.caption).foregroundStyle(Tone.fg3)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 60)
    }
}

extension JSONObject {
    /// Pretty JSON for a tool's input or an approval's details; nil when empty.
    var pretty: String? {
        guard !isEmpty else { return nil }
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? e.encode(self)).map { String(decoding: $0, as: UTF8.self) }
    }
}

/// Collapsed until tapped, as Android's thought and call rows.
struct Fold<Content: View>: View {
    let title: String
    let icon: String
    var note: String? = nil
    @ViewBuilder let content: () -> Content
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(.snappy) { open.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: icon).frame(width: 18)
                    Text(title).lineLimit(1)
                    Image(systemName: "chevron.right").font(.caption).rotationEffect(.degrees(open ? 90 : 0))
                }
                .font(.callout)
                .foregroundStyle(Tone.fg3)
            }
            .buttonStyle(.plain)
            .accessibilityValue(open ? "Open" : "Closed")
            if let note, !open {
                Text(note).font(.caption.monospaced()).foregroundStyle(Tone.fg3).lineLimit(1).padding(.leading, 26)
            }
            if open { content().padding(.leading, 26) }
        }
    }
}

private struct ToolFold: View {
    let use: ToolUseBlock
    let result: ToolResultBlock?
    let running: Bool
    /// The running tool's latest line (tool.progress).
    let progress: String?
    let client: ConclaveClient

    var body: some View {
        let failed = result?.isError == true
        Fold(title: ToolSummary.of(use.name, use.input) + (failed ? ", failed" : running ? ", running" : ""), icon: failed ? "exclamationmark.triangle" : "wrench.and.screwdriver", note: running ? progress : nil) {
            VStack(alignment: .leading, spacing: 8) {
                if let json = use.input.pretty {
                    CodeBlockView(language: use.name, text: json)
                }
                if let result, !result.text.isEmpty {
                    CodeBlockView(language: "result", text: String(result.text.prefix(20_000)))
                }
                if let parts = result?.content.array {
                    ForEach(Array(parts.enumerated()), id: \.offset) { _, p in
                        if p["type"]?.string == "image" {
                            PictureView(media: MediaBlock(mediaType: p["mediaType"]?.string ?? "image/png", data: (p["data"] ?? p["source"]?["data"])?.string, url: p["url"]?.string), client: client)
                        }
                    }
                }
            }
        }
    }
}
