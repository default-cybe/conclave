import ConclaveKit
import SwiftUI

/// Search (web SessionList's search, Android SessionsScreen): titles of the chats and sessions the
/// app holds match as you type; from three letters the hub's message search follows, a moment after
/// typing stops, each session's hits under its title with the matched words in fg.
struct SearchView: View {
    let hub: HubModel
    let open: (String) -> Void
    @State private var query = ""
    @State private var messages = MessageState.idle
    @FocusState private var focused: Bool
    @Environment(\.horizontalSizeClass) private var sizeClass

    private enum MessageState: Equatable {
        case idle, loading
        case done([SearchHit])
        case failed(String)
    }

    var body: some View {
        let m = Metrics(sizeClass)
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let titles = SearchWords.titleHits(hub.sessions, q)
        Page(title: "Search") {
            field(m)
            if q.isEmpty {
                EmptyLine(text: "Search chat titles and every message.")
            } else {
                if !titles.isEmpty {
                    CardSection(title: "Chats") {
                        ForEach(titles) { s in titleRow(s, m) }
                    }
                }
                switch messages {
                case .idle:
                    if titles.isEmpty { EmptyLine(text: q.count < SearchWords.minMessageQuery ? "Type a few more letters to search messages." : "No matches for \"\(q)\".") }
                case .loading:
                    LoadingLine(text: "Searching messages")
                case .failed(let e):
                    ErrorBox(message: e) { Task { await run(q) } }
                case .done(let hits):
                    if hits.isEmpty {
                        if titles.isEmpty { EmptyLine(text: "No matches for \"\(q)\".") } else { EmptyLine(text: "No message matches \"\(q)\".") }
                    } else {
                        CardSection(title: "Messages") {
                            ForEach(SearchWords.groups(hits, titles: titleMap(hits))) { g in hitRow(g, m) }
                        }
                    }
                }
            }
        }
        // a moment after typing stops; a new letter cancels the wait
        .task(id: q) {
            guard q.count >= SearchWords.minMessageQuery else { messages = .idle; return }
            messages = .loading
            try? await Task.sleep(for: .milliseconds(350))
            if Task.isCancelled { return }
            await run(q)
        }
        .task {
            // focus once the push has settled: set at once it can be dropped
            try? await Task.sleep(for: .milliseconds(150))
            focused = true
        }
    }

    private func field(_ m: Metrics) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundStyle(Tone.fg3)
            TextField("Search chats and messages", text: $query)
                .font(.sans(m.compact ? 16 : 14))
                .foregroundStyle(Tone.fg)
                .focused($focused)
                .submitLabel(.search)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("search-field")
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 15)).foregroundStyle(Tone.fg4)
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 12)
        .frame(height: m.compact ? 46 : 38)
        .panel(Tone.raise, radius: m.compact ? Radius.tile : Radius.r3, border: Tone.rule2)
    }

    private func titleRow(_ s: Session, _ m: Metrics) -> some View {
        Button { open(s.id) } label: {
            HStack(spacing: 10) {
                Image(systemName: s.isChat ? "bubble.left" : "chevron.left.forwardslash.chevron.right")
                    .font(.system(size: 13)).foregroundStyle(Tone.fg3).frame(width: 18)
                Text(Panel.title(s)).font(.sans(m.compact ? 15 : 14)).foregroundStyle(Tone.fg).lineLimit(1)
                Spacer(minLength: 8)
                if !s.isChat, !s.cwd.isEmpty {
                    Text(FolderWords.baseName(s.cwd)).font(.sans(12.5)).foregroundStyle(Tone.fg3).lineLimit(1)
                }
            }
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }
        .buttonStyle(QuietPress(radius: 0))
        .accessibilityIdentifier("search-title-\(s.id)")
    }

    /// A session's title, then up to three of its hits; any tap opens the session.
    private func hitRow(_ g: HitGroup, _ m: Metrics) -> some View {
        Button { open(g.sessionId) } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(g.title).font(.sans(m.compact ? 15 : 14, .medium)).foregroundStyle(Tone.fg).lineLimit(1)
                ForEach(g.hits.prefix(3)) { h in
                    snippet(h.snippet).font(.sans(m.compact ? 13.5 : 12.5)).foregroundStyle(Tone.fg3).lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if g.hits.count > 3 {
                    Text("\(g.hits.count - 3) more in this session").font(.sans(12)).foregroundStyle(Tone.fg4)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(QuietPress(radius: 0))
        .accessibilityIdentifier("search-hit-\(g.sessionId)")
    }

    private func snippet(_ raw: String) -> Text {
        SearchWords.snippet(raw).reduce(Text(verbatim: "")) { text, part in
            text + (part.match ? Text(verbatim: part.text).foregroundStyle(Tone.fg).fontWeight(.semibold) : Text(verbatim: part.text))
        }
    }

    private func titleMap(_ hits: [SearchHit]) -> [String: String] {
        var out: [String: String] = [:]
        for h in hits where h.title.isEmpty { if let s = hub.session(h.sessionId) { out[h.sessionId] = Panel.title(s) } }
        return out
    }

    private func run(_ q: String) async {
        messages = .loading
        do {
            let hits = try await hub.client.search(q)
            if !Task.isCancelled { messages = .done(hits) }
        } catch is CancellationError {
        } catch {
            if (error as? URLError)?.code == .cancelled || Task.isCancelled { return }
            messages = .failed(error.localizedDescription)
        }
    }
}
