import ConclaveKit
import SwiftUI

/// The transcript and its composer. Opens at the newest message; scrolling to the top reads the page
/// before it and keeps the message you were on in place. Approvals and questions show at the end.
struct ChatView: View {
    let chat: ChatModel
    let hub: HubModel
    let title: String
    @State private var position = ScrollPosition(edge: .bottom)
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduce

    var body: some View {
        let t = chat.transcript
        let m = Metrics(sizeClass)
        ScrollView {
            LazyVStack(alignment: .leading, spacing: m.compact ? 20 : 24) {
              // each row centres itself: frames on the LazyVStack moved the stack, but its rows
              // still drew from x 0 (flush left on iPad, 32 pt gap on the right on iPhone)
              Group {
                if t.older {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .onAppear { Task { await older() } }
                }
                ForEach(t.messages) { msg in
                    MessageView(message: msg, transcript: t, client: chat.client)
                }
                // a sent message rises from the composer (the web's send motion), a fade with Reduce Motion
                if let o = chat.outgoing { OutgoingBubble(outgoing: o).transition(reduce ? .opacity : .move(edge: .bottom).combined(with: .opacity)) }
                ForEach(t.approvals) { a in
                    ApprovalCard(request: a, viewing: chat.sessionId) { await chat.answer(a, $0) }.rise()
                }
                ForEach(t.questions) { q in
                    QuestionCard(request: q, viewing: chat.sessionId) { await chat.answer(q, $0) }.rise(delay: 0.04)
                }
              }
              // a fixed column: a wide code line or table must not widen it past the margins.
              // Plain frames, not containerRelativeFrame: that collapsed the ScrollView to 0 pt
              // wide in the iPhone stack (blank transcript)
              // the web's column: 784 wide with 32 pt gutters, 16 on a phone
              .frame(maxWidth: 720, alignment: .leading)
              .padding(.horizontal, m.gutter)
              .frame(maxWidth: .infinity)
            }
            .scrollTargetLayout()
            .padding(.vertical, 20)
            .animation(Motion.of(Motion.ease, reduce: reduce), value: chat.outgoing != nil)
        }
        .background(Tone.bg.ignoresSafeArea())
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            ComposerView(chat: chat, hub: hub)
                .frame(maxWidth: 720)
                // the transcript's margins, so the composer lines up with the cards
                .padding(.horizontal, m.compact ? 12 : m.gutter)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 8)
                .background(Tone.bg)
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
        .toolbarBackground(Tone.bg, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(title).font(.sans(m.compact ? 17 : 14, .semibold)).foregroundStyle(Tone.fg).lineLimit(1)
            }
        }
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
            Text(message.content.plainText).font(.sans(12.5)).foregroundStyle(Tone.fg3).frame(maxWidth: .infinity)
        } else if message.role == .user {
            let text = message.content.compactMap { b -> String? in if case .text(let s) = b, !b.isReminder { s } else { nil } }.joined(separator: "\n")
            let images = message.content.compactMap { b -> MediaBlock? in if case .image(let m) = b { m } else { nil } }
            if !text.isEmpty || !images.isEmpty {
                VStack(alignment: .trailing, spacing: 8) {
                    ForEach(Array(images.enumerated()), id: \.offset) { PictureView(media: $0.element, client: client) }
                    if !text.isEmpty { UserBubble(text: text) }
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.leading, 60)
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(message.content.enumerated()), id: \.offset) { _, b in
                    switch b {
                    case .text(let s) where !b.isReminder: MarkdownView(s)
                    case .thinking(let th): Fold(title: th.durationMs.map { "Thought for \(max(1, $0 / 1000))s" } ?? "Thinking") {
                        Text(th.thinking).font(.sans(13)).lineSpacing(4).foregroundStyle(Tone.fg2).textSelection(.enabled)
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
            if !outgoing.text.isEmpty { UserBubble(text: outgoing.text) }
            Text(outgoing.files.isEmpty ? "Sending" : "Sending, \(Attach.filesWord(outgoing.files.count))").font(.sans(12)).foregroundStyle(Tone.fg3)
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

/// Your message: the web's Bubble (components/ui/Bubble.tsx). iPad: radius 5, raised with a hairline in
/// dark, surface-2 in light; phone: radius 20 on surface-2. At most 85% of the column.
struct UserBubble: View {
    let text: String
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let m = Metrics(sizeClass)
        let flat = m.compact || scheme == .light
        Text(text)
            .font(.sans(m.read))
            .lineSpacing(m.readSpacing)
            .foregroundStyle(Tone.fg)
            .textSelection(.enabled)
            .padding(.horizontal, m.compact ? 16 : 14)
            .padding(.vertical, m.compact ? 10 : 9)
            .panel(flat ? Tone.surface2 : Tone.raise, radius: m.compact ? Radius.bubble : Radius.r2, border: flat ? nil : Tone.rule)
            // plain frames (containerRelativeFrame blanked the iPhone transcript): the fill hugs the
            // words, 520 at most, and the row's 60 pt lead keeps it under 85% on a phone
            .frame(maxWidth: 520, alignment: .trailing)
            .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

/// The web's Fold (components/motion/Fold.tsx): a quiet row, the words in 13 pt fg-3 and a small
/// chevron that turns; open, the body sits 12 pt in behind a hairline that draws down while the
/// lines rise 4 pt into place. Reduce Motion: it fades.
struct Fold<Content: View>: View {
    let title: String
    var note: String? = nil
    var tone: Color = Tone.fg3
    @ViewBuilder let content: () -> Content
    @State private var open = false
    @Environment(\.accessibilityReduceMotion) private var reduce
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        let size: CGFloat = sizeClass == .compact ? 15 : 13
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(Motion.of(open ? Motion.ease(0.2) : Motion.ease(0.28), reduce: reduce)) { open.toggle() }
            } label: {
                HStack(spacing: 4) {
                    Text(title).font(.sans(size)).lineLimit(1)
                    Image(systemName: "chevron.right")
                        .font(.system(size: size * 0.7, weight: .semibold))
                        .foregroundStyle(Tone.fg4)
                        .rotationEffect(.degrees(open ? 90 : 0))
                }
                .foregroundStyle(tone)
                .frame(minHeight: sizeClass == .compact ? 44 : 25)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(open ? "Open" : "Closed")
            if let note, !open {
                Text(note).font(.mono(12)).foregroundStyle(Tone.fg3).lineLimit(1)
            }
            if open {
                content()
                    .padding(.leading, 12).padding(.top, 4).padding(.bottom, 6)
                    .overlay(alignment: .leading) { Rectangle().fill(Tone.rule2).frame(width: 1) }
                    .transition(reduce ? .opacity : .asymmetric(
                        insertion: .opacity.combined(with: .offset(y: 4)),
                        removal: .opacity.combined(with: .offset(y: -3))))
            }
        }
        .clipped()
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
        Fold(title: ToolSummary.of(use.name, use.input) + (failed ? ", failed" : running ? ", running" : ""), note: running ? progress : nil, tone: failed ? Tone.fault : Tone.fg3) {
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
