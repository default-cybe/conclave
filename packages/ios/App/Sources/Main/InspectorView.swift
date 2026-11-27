import ConclaveKit
import SwiftUI

/// The iPad inspector for the open chat, as the web's right sidebar (ContextPanel): Files and
/// Tasks behind a segmented switch. A sheet on iPhone.
struct InspectorView: View {
    let sessionId: String
    let hub: HubModel
    @AppStorage("inspectorTab") private var tab = "files"

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Segmented(options: [("files", "Files"), ("tasks", "Tasks")], selection: $tab)
                .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 10)
            Rectangle().fill(Tone.rule).frame(height: 1)
            if tab == "tasks" { TasksPane(sessionId: sessionId, hub: hub) } else { FilesPane(sessionId: sessionId, client: hub.client) }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Tone.side.ignoresSafeArea())
        .inspectorColumnWidth(min: 280, ideal: 320, max: 420)
    }
}

/// The web's Files tab (features/chat/FilesTab.tsx): generated, screenshots and uploaded, each
/// under a 12 pt fg-3 heading; pictures in a 3-column grid of squares, other files as rows with
/// their icon, name and "size, time". A picture opens the viewer, any other file Quick Look.
struct FilesPane: View {
    let sessionId: String
    let client: ConclaveClient
    @State private var files: [SessionFile]?
    @State private var error: String?
    @State private var viewer = MediaPresenter()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let files {
                    if files.isEmpty {
                        Text("Files shared in this chat, pictures from tools and what you attach show up here.")
                            .font(.sans(12.5)).foregroundStyle(Tone.fg3).padding(.top, 8)
                    }
                    ForEach(FileWords.groups(files), id: \.title) { g in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(g.title).font(.sans(12, .medium)).foregroundStyle(Tone.fg3)
                            let pics = g.files.filter { FileWords.isPicture($0.mediaType) }
                            if !pics.isEmpty {
                                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 3), spacing: 6) {
                                    ForEach(pics) { f in
                                        GeometryReader { geo in PictureView(media: media(f), client: client, square: geo.size.width) }
                                            .aspectRatio(1, contentMode: .fit)
                                    }
                                }
                            }
                            ForEach(g.files.filter { !FileWords.isPicture($0.mediaType) }) { f in FileRow(file: f, media: media(f), client: client) }
                        }
                    }
                } else if let error {
                    Text(error).font(.sans(12.5)).foregroundStyle(Tone.fault)
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 20)
                }
            }
            .padding(14)
        }
        .mediaViewer(viewer, client: client)
        .task(id: sessionId) { await load() }
        .refreshable { await load() }
        .accessibilityIdentifier("files-pane")
    }

    private func load() async {
        do {
            let list = try await client.files(sessionId)
            files = list
            error = nil
            let pics = list.filter { FileWords.isPicture($0.mediaType) }.map { Self.media($0, sessionId) }
            viewer.gallery = { pics }
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Where a file's bytes are: a tool's file route, else its block (and part) of the transcript.
    private func media(_ f: SessionFile) -> MediaBlock { Self.media(f, sessionId) }

    private static func media(_ f: SessionFile, _ sessionId: String) -> MediaBlock {
        let url = f.toolUseId.map { MediaBytes.fileURL(session: sessionId, toolUseId: $0, image: f.image) }
            ?? BlockRef(sessionId: sessionId, messageId: f.messageId, index: f.index, part: f.part).url
        return MediaBlock(mediaType: f.mediaType, url: url, title: f.name)
    }
}

/// A file row of the Files tab: 44 pt, its icon, the name in 13 pt and "size, time" in 12 pt fg-3.
private struct FileRow: View {
    let file: SessionFile
    let media: MediaBlock
    let client: ConclaveClient
    @State private var opener = FileOpener()

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: FileIcon.of(file.mediaType)).font(.system(size: 14)).foregroundStyle(Tone.fg3).frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(file.name).font(.sans(13)).foregroundStyle(Tone.fg).lineLimit(1)
                Text([file.size.map(FileWords.size), file.at > 0 ? Date(timeIntervalSince1970: Double(file.at) / 1000).formatted(date: .abbreviated, time: .shortened) : nil]
                    .compactMap { $0 }.joined(separator: ", "))
                    .font(.sans(12)).foregroundStyle(Tone.fg3).lineLimit(1)
            }
            Spacer(minLength: 0)
            if opener.busy { ProgressView().controlSize(.small) }
            Button { Task { await opener.download(media, name: file.name, client: client) } } label: {
                Image(systemName: "arrow.down.to.line").font(.system(size: 13, weight: .medium)).foregroundStyle(Tone.fg3)
                    .frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(QuietPress(radius: Radius.r2))
            .accessibilityLabel("Download \(file.name)")
        }
        .padding(.horizontal, 6)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .onTapGesture { Task { await opener.open(media, name: file.name, client: client) } }
        .fileOpener(opener)
    }
}

/// The session's background work, as Android's running-task rows (ui/conversation/Tasks.kt): the
/// agent's glyph, "Subagent explore: what it does", and its state in a word, running in signal,
/// waiting in amber, failed in fault. A tap opens the subagent's own transcript.
struct TasksPane: View {
    let sessionId: String
    let hub: HubModel
    @State private var children: [Session]?
    @State private var open: Session?
    @Environment(\.accessibilityReduceMotion) private var reduce

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                if let children {
                    Text(TaskKinds.summary(children)).font(.sans(12, .medium)).foregroundStyle(Tone.fg3).padding(.horizontal, 6).padding(.bottom, 6)
                    if children.isEmpty {
                        Text("Subagents and delegated jobs this chat starts show up here, with what each is doing.")
                            .font(.sans(12.5)).foregroundStyle(Tone.fg3).padding(.horizontal, 6)
                    }
                    ForEach(TaskKinds.sorted(children)) { s in
                        TaskRow(session: s) { open = s }.rise()
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 20)
                }
            }
            .padding(8).padding(.top, 6)
        }
        .task(id: "\(sessionId)-\(hub.childTick)") { children = (try? await hub.client.children(sessionId)) ?? children ?? [] }
        .sheet(item: $open) { s in
            NavigationStack {
                ChatView(chat: hub.chat(s.id), hub: hub, title: s.title.isEmpty ? TaskKinds.who(s) : s.title)
                    .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { open = nil }.font(.sans(14, .medium)).foregroundStyle(Tone.fg2) } }
            }
        }
        .accessibilityIdentifier("tasks-pane")
    }
}

private struct TaskRow: View {
    let session: Session
    let action: () -> Void

    var body: some View {
        let (word, tone) = TaskKinds.state(session)
        let color: Color = switch tone { case .live: Tone.signal; case .waits: Tone.warn; case .failed: Tone.fault; case .quiet: Tone.fg3 }
        Button(action: action) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: Self.symbol(TaskKinds.glyph(agent: session.agent)))
                    .font(.system(size: 14)).foregroundStyle(tone == .live ? Tone.signal : Tone.fg3).frame(width: 18).padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    (Text(TaskKinds.who(session) + ": ").foregroundStyle(Tone.fg2) + Text(session.title.isEmpty ? "Working" : session.title).foregroundStyle(Tone.fg))
                        .font(.sans(13)).lineLimit(2)
                    HStack(spacing: 6) {
                        Text(word).foregroundStyle(color)
                        if session.updatedAt > 0 {
                            Text(Ago.short(session.updatedAt, now: Int64(Date().timeIntervalSince1970 * 1000))).foregroundStyle(Tone.fg4)
                        }
                    }
                    .font(.sans(12))
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Tone.fg4).padding(.top, 3)
            }
            .padding(.horizontal, 8).padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(QuietPress(fill: Tone.sideHover))
        .accessibilityIdentifier("task-row")
    }

    static func symbol(_ g: TaskGlyph) -> String {
        switch g {
        case .flow: "point.3.connected.trianglepath.dotted"
        case .device: "desktopcomputer"
        case .search: "magnifyingglass"
        case .build: "hammer"
        case .test: "checkmark.seal"
        case .review: "eye"
        case .debug: "ant"
        case .research: "books.vertical"
        case .design: "paintbrush"
        case .verify: "checkmark.shield"
        case .bot: "cpu"
        }
    }
}
