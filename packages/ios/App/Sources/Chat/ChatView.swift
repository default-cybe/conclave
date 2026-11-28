import ConclaveKit
import SwiftUI
import UIKit

/// The transcript and its composer. Opens at the newest message; scrolling to the top reads the page
/// before it and keeps the message you were on in place. Approvals and questions show at the end.
struct ChatView: View {
    let chat: ChatModel
    let hub: HubModel
    let title: String
    /// After the session menu's Fork (the new id) or Archive and Delete (nil). Nil: Archive and Delete go back.
    var opened: ((String?) -> Void)? = nil
    @State private var position = ScrollPosition(edge: .bottom)
    /// Rename and Delete of the session menu, and why an action failed.
    @State private var sheets = SessionSheets()
    /// Edit asks first: the message and what follows it leave the chat.
    @State private var editing: Message?
    /// The media viewer, open on a picture with every picture of the chat to swipe through.
    @State private var media = MediaPresenter()
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduce
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let t = chat.transcript
        let m = Metrics(sizeClass)
        let session = hub.session(chat.sessionId)
        let busy = chat.busy(session)
        let ends = SessionActions.turnEnds(t.messages)
        let lastEnd = t.messages.last { ends.contains($0.id) }?.id
        let lastUser = SessionActions.lastUser(t.messages)?.id
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
                    MessageView(message: msg, transcript: t, client: chat.client,
                                actions: actions(msg, ends: ends, lastEnd: lastEnd, lastUser: lastUser, busy: busy))
                }
                // a sent message rises from the composer (the web's send motion), a fade with Reduce Motion
                if let o = chat.outgoing { OutgoingBubble(outgoing: o).transition(reduce ? .opacity : .move(edge: .bottom).combined(with: .opacity)) }
                ForEach(t.approvals) { a in
                    ApprovalCard(request: a, viewing: chat.sessionId) { await chat.answer(a, $0) }.rise()
                }
                ForEach(t.questions) { q in
                    QuestionCard(request: q, viewing: chat.sessionId) { await chat.answer(q, $0) }.rise(delay: 0.04)
                }
                // what the session does now (Android SessionLiveLine); a chat has no tools, so it is for sessions
                if session.map({ !$0.isChat }) ?? false { LiveLine(session: session, transcript: t).id("live-line") }
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
        .mediaViewer(media, client: chat.client)
        .onAppear { [chat] in media.gallery = { Gallery.pictures(chat.transcript.messages, toolResults: chat.transcript.toolResults) } }
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        // the bottom anchor on size changes kept pulling a scrollTo(id:) back to the end; off for `-scrollTo`
        .defaultScrollAnchor(Self.pinned ? .bottom : nil, for: .sizeChanges)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 8) {
                // a repo session's push, pull request and clean up; nothing for any other session
                if session.map({ !$0.isChat }) ?? false { RepoBar(hub: hub, sessionId: chat.sessionId, title: session?.title ?? "") }
                ComposerView(chat: chat, hub: hub)
            }
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
        // phone: Android's top bar, the menu icon that opens the drawer (the split view's list), no "‹ Back"
        .navigationBarBackButtonHidden(m.compact)
        .toolbar {
            if m.compact {
                ToolbarItem(placement: .topBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "line.3.horizontal").font(.system(size: 18)).foregroundStyle(Tone.fg)
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .accessibilityLabel("Open the chat list")
                }
            }
            ToolbarItem(placement: .principal) {
                Text(title).font(.sans(m.compact ? 17 : 14, .semibold)).foregroundStyle(Tone.fg).lineLimit(1)
            }
            if let session {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        SessionMenu(hub: hub, session: session, sheets: sheets, opened: opened ?? { _ in dismiss() })
                    } label: {
                        Image(systemName: "ellipsis").font(.system(size: m.compact ? 18 : 15)).foregroundStyle(Tone.fg)
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .accessibilityLabel("Session actions")
                    .accessibilityIdentifier("session-menu")
                }
            }
        }
        .sessionActionSheets(hub: hub, sheets: sheets)
        .confirmationDialog("Edit this message?", isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } }), titleVisibility: .visible, presenting: editing) { msg in
            Button("Edit") { Task { await chat.edit(msg, busy: chat.busy(hub.session(chat.sessionId))) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("It and everything after it leave the chat. Its words come back to the box.")
        }
        .task {
            await chat.loadIfNeeded()
            // a search hit: page back to its message, then bring it into view
            if let id = chat.focus {
                chat.focus = nil
                if await chat.loadUntil(id) {
                    try? await Task.sleep(for: .milliseconds(300))
                    position.scrollTo(id: id, anchor: .center)
                }
            }
            #if DEBUG
            // CI screenshots: `-scrollTop` reads the chat from its first message
            if ProcessInfo.processInfo.arguments.contains("-scrollTop") {
                try? await Task.sleep(for: .milliseconds(400))
                position.scrollTo(edge: .top)
            }
            // `-scrollTo <id>`: a message's end (m2: its code block, table and quote) above the composer.
            // ScrollPosition finds only the scroll target layout's rows, so a message id, not a table's
            if let id = Self.scrollTarget {
                try? await Task.sleep(for: .seconds(1))
                position.scrollTo(id: id, anchor: .bottom)
                // again once the rows on the way are measured: the first lands on the lazy stack's
                // estimate (the answer shot showed m2's top, not its table). A different anchor value
                // with the same bottom edge: an equal ScrollPosition is not applied again
                try? await Task.sleep(for: .milliseconds(600))
                position.scrollTo(id: id, anchor: .bottomLeading)
            }
            #endif
        }
    }

    #if DEBUG
    private static var scrollTarget: String? {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-scrollTo"), i + 1 < args.count else { return nil }
        return args[i + 1]
    }
    private static var pinned: Bool { scrollTarget == nil }
    #else
    private static let pinned = true
    #endif

    /// Copy, Edit, Retry and Fork for one message. Retry re-runs the last turn only, and not while it runs.
    private func actions(_ msg: Message, ends: Set<String>, lastEnd: String?, lastUser: String?, busy: Bool) -> MessageActions {
        var a = MessageActions()
        func retry(_ user: Message) -> () -> Void {
            return { [chat] in _ = Task { await chat.retry(user, busy: false) } }
        }
        if SessionActions.isOwn(msg) {
            a.edit = { editing = msg }
            if !busy, msg.id == lastUser { a.retry = retry(msg) }
        } else if msg.role == .assistant, msg.kind == .normal {
            a.row = ends.contains(msg.id) && !(busy && msg.id == lastEnd)
            a.turnText = { [chat] in SessionActions.turnText(chat.transcript.messages, end: msg) }
            if !busy, msg.id == lastEnd, let user = SessionActions.asker(chat.transcript.messages, before: msg.seq), user.id == lastUser { a.retry = retry(user) }
            a.fork = { [chat, hub, sheets, opened] in
                _ = Task { if let id = await sheets.fork(chat.sessionId, hub: hub, fromSeq: msg.seq) { opened?(id) } }
            }
        }
        return a
    }

    private func older() async {
        let anchor = chat.transcript.messages.first?.id
        if await chat.loadOlder(), let anchor { position.scrollTo(id: anchor, anchor: .top) }
    }
}

/// What a message offers on long-press and under a finished turn (ChatView.actions).
struct MessageActions {
    /// Copy (and Retry) under this reply: it ends a turn that is done.
    var row = false
    /// The turn's words, for the row's Copy.
    var turnText: () -> String = { "" }
    var retry: (() -> Void)?
    var edit: (() -> Void)?
    var fork: (() -> Void)?
}

@MainActor private func copy(_ text: String) {
    UIPasteboard.general.string = text
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
}

private struct MessageView: View {
    let message: Message
    let transcript: Transcript
    let client: ConclaveClient
    var actions = MessageActions()
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        if message.kind == .notice {
            Text(message.content.plainText).font(.sans(12.5)).foregroundStyle(Tone.fg3).frame(maxWidth: .infinity)
        } else if message.role == .user {
            let text = message.content.compactMap { b -> String? in if case .text(let s) = b, !b.isReminder { s } else { nil } }.joined(separator: "\n")
            let images = message.content.compactMap { b -> MediaBlock? in if case .image(let m) = b { m } else { nil } }
            let docs = message.content.compactMap { b -> MediaBlock? in if case .document(let m) = b { m } else { nil } }
            if !text.isEmpty || !images.isEmpty || !docs.isEmpty {
                VStack(alignment: .trailing, spacing: 8) {
                    ForEach(Array(images.enumerated()), id: \.offset) { PictureView(media: $0.element, client: client) }
                    ForEach(Array(docs.enumerated()), id: \.offset) { DocumentCard(media: $0.element, client: client) }
                    if !text.isEmpty { UserBubble(text: text) }
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.leading, 60)
                .contextMenu {
                    if !text.isEmpty { Button("Copy", systemImage: "doc.on.doc") { copy(text) } }
                    if let edit = actions.edit { Button("Edit", systemImage: "pencil", action: edit) }
                    if let retry = actions.retry { Button("Retry", systemImage: "arrow.clockwise", action: retry) }
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(message.content.enumerated()), id: \.offset) { _, b in
                    switch b {
                    case .text(let s) where !b.isReminder: MarkdownView(s, scrollId: message.id)
                    case .thinking(let th): Fold(title: th.durationMs.map { "Thought for \(max(1, $0 / 1000))s" } ?? "Thinking") {
                        Text(th.thinking).font(.sans(13)).lineSpacing(4).foregroundStyle(Tone.fg2).textSelection(.enabled)
                    }
                    case .toolUse(let u):
                        ToolFold(use: u, result: transcript.toolResults[u.id], running: transcript.runningTools.contains(u.id), progress: transcript.toolProgress[u.id], client: client)
                        // a file the tool handed over shows as its card, outside the fold (Android FileCards)
                        if let f = SharedFile(transcript.toolResults[u.id]) {
                            FileCard(name: f.name, title: f.title, mediaType: f.mediaType, size: f.size,
                                     media: MediaBlock(mediaType: f.mediaType, url: MediaBytes.fileURL(session: message.sessionId, toolUseId: f.toolUseId, image: nil)), client: client)
                        }
                    case .image(let m): PictureView(media: m, client: client)
                    case .document(let m): DocumentCard(media: m, client: client)
                    default: EmptyView()
                    }
                }
                if actions.row { turnRow }
            }
            .contextMenu {
                let text = SessionActions.copyText(message)
                if !text.isEmpty { Button("Copy", systemImage: "doc.on.doc") { copy(text) } }
                if let fork = actions.fork { Button("Fork", systemImage: "arrow.triangle.branch", action: fork) }
                if let retry = actions.retry { Button("Retry", systemImage: "arrow.clockwise", action: retry) }
            }
        }
    }

    /// Under a finished turn, as Android's icon row: Copy the turn's words, Retry the last one.
    private var turnRow: some View {
        let side: CGFloat = Metrics(sizeClass).compact ? 44 : 28
        return HStack(spacing: 2) {
            Button { copy(actions.turnText()) } label: {
                Image(systemName: "doc.on.doc").frame(width: side, height: side).contentShape(Rectangle())
            }
            .accessibilityLabel("Copy")
            .accessibilityIdentifier("turn-copy")
            if let retry = actions.retry {
                Button(action: retry) {
                    Image(systemName: "arrow.clockwise").frame(width: side, height: side).contentShape(Rectangle())
                }
                .accessibilityLabel("Retry")
                .accessibilityIdentifier("turn-retry")
            }
        }
        .buttonStyle(QuietPress(radius: Radius.r1))
        .font(.system(size: 13))
        .foregroundStyle(Tone.fg3)
    }
}

/// A document block (a PDF someone attached): its card, opened in Quick Look.
private struct DocumentCard: View {
    let media: MediaBlock
    let client: ConclaveClient

    var body: some View {
        let name = media.title?.isEmpty == false ? media.title! : "Document." + (media.mediaType.split(separator: "/").last.map(String.init) ?? "pdf")
        FileCard(name: name, mediaType: media.mediaType, size: media.data.map { Int64($0.count * 3 / 4) }, media: media, client: client)
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
        let size: CGFloat = Metrics(sizeClass).compact ? 15 : 13
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
                .frame(minHeight: Metrics(sizeClass).compact ? 44 : 25)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(open ? "Open" : "Closed")
            .accessibilityIdentifier("fold")
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
                // the web's ToolFold: a command, a path or a pattern as itself; other tools as JSON
                if let cmd = use.input["command"]?.string {
                    if let d = use.input["description"]?.string, !d.isEmpty {
                        Text(d).font(.sans(13)).foregroundStyle(Tone.fg3)
                    }
                    CodeBlockView(language: "bash", text: cmd)
                } else if let path = use.input["file_path"]?.string ?? use.input["path"]?.string, use.name == "Read" || use.name == "Write" || use.name == "Edit" {
                    CodeBlockView(language: use.name, text: path)
                } else if let pattern = use.input["pattern"]?.string {
                    CodeBlockView(language: use.name, text: pattern + (use.input["path"]?.string.map { "\nin \($0)" } ?? ""))
                } else if let json = use.input.pretty {
                    CodeBlockView(language: use.name, text: json)
                }
                if let result, !result.text.isEmpty {
                    CodeBlockView(language: "result", text: String(result.text.prefix(20_000)))
                }
                if let parts = result?.content.array {
                    ForEach(Array(parts.enumerated()), id: \.offset) { _, p in
                        if let m = Gallery.picture(p) { PictureView(media: m, client: client) }
                    }
                }
            }
        }
    }
}
