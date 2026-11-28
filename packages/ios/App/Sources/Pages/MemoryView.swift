import ConclaveKit
import SwiftUI

/// What the agents remember across chats (Android MemoryScreen): search, a kind filter, each note
/// with its kind, scope and tags; tap one to edit or delete it, Add to write a new one.
struct MemoryView: View {
    let hub: HubModel
    @State private var entries: [MemoryEntry]?
    @State private var error: String?
    @State private var query = ""
    @State private var kind: MemoryKind?
    @State private var editing: MemoryEdit?
    @State private var mapShown = false

    var body: some View {
        if mapShown { MemoryMapView(hub: hub) { mapShown = false } } else { list }
    }

    private var list: some View {
        Page(title: "Memory", sub: entries.map { MemoryWords.count($0.count) }) {
            Button("Map") { mapShown = true }.buttonStyle(CVButton(look: .outline)).accessibilityIdentifier("memory-map")
            Button("Add") { editing = MemoryEdit(entry: nil) }
                .buttonStyle(CVButton(look: .solid))
                .accessibilityIdentifier("memory-add")
        } content: {
            search
            ScrollView(.horizontal, showsIndicators: false) {
                Segmented(options: kinds, selection: $kind)
            }
            if let error { ErrorBox(message: error) { Task { await load() } } }
            if let entries {
                if entries.isEmpty {
                    EmptyLine(text: query.trimmingCharacters(in: .whitespaces).isEmpty
                        ? "No memories yet. Facts, procedures and episodes the agents keep across chats show here."
                        : "No memories match \u{201C}\(query.trimmingCharacters(in: .whitespaces))\u{201D}.")
                } else {
                    let now = Int64(Date().timeIntervalSince1970 * 1000)
                    VStack(spacing: 0) {
                        ForEach(Array(entries.enumerated()), id: \.element.id) { i, m in
                            if i > 0 { Rectangle().fill(Tone.rule).frame(height: 1) }
                            Button { editing = MemoryEdit(entry: m) } label: { MemoryRow(entry: m, now: now) }
                                .buttonStyle(QuietPress(radius: 0))
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: Radius.r3, style: .continuous))
                    .panel(Tone.raise, radius: Radius.r3, border: Tone.rule)
                }
            } else if error == nil {
                LoadingLine()
            }
        }
        .refreshable { await load() }
        // typing waits 300 ms; a new key cancels the last wait (Android's debounce)
        .task(id: "\(kind?.rawValue ?? "")|\(query)") {
            if !query.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }
            guard !Task.isCancelled else { return }
            await load()
        }
        .sheet(item: $editing) { e in
            MemoryEditSheet(entry: e.entry, save: { await save(e.entry, $0) }, delete: { await delete(e.entry) })
        }
    }

    private var kinds: [(MemoryKind?, String)] { [(nil, "All")] + MemoryKind.allCases.map { (Optional($0), $0.label) } }

    private var search: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundStyle(Tone.fg3)
            TextField("Search memory", text: $query)
                .font(.sans(14)).foregroundStyle(Tone.fg)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .submitLabel(.search)
                .accessibilityIdentifier("memory-search")
            if !query.isEmpty {
                Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Tone.fg4) }
                    .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 12).frame(height: 38)
        .panel(Tone.raise, radius: Radius.r2 + 3, border: Tone.rule)
    }

    private func load() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        let k = kind
        do {
            var list: [MemoryEntry]
            if q.isEmpty {
                list = try await hub.client.memories(kind: k)
            } else {
                list = try await hub.client.searchMemory(q)
                if let k { list = list.filter { $0.kind == k } }
            }
            guard !Task.isCancelled else { return }
            entries = list
            error = nil
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            self.error = error.localizedDescription
        }
    }

    /// Nil when saved; else the hub's words for the sheet.
    private func save(_ existing: MemoryEntry?, _ input: MemoryInput) async -> String? {
        do {
            let m: MemoryEntry
            if let existing { m = try await hub.client.updateMemory(existing.id, input) } else { m = try await hub.client.saveMemory(input) }
            entries = [m] + (entries ?? []).filter { $0.id != m.id }
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    private func delete(_ entry: MemoryEntry?) async -> String? {
        guard let entry else { return nil }
        do {
            try await hub.client.deleteMemory(entry.id)
            entries?.removeAll { $0.id == entry.id }
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}

/// The sheet's subject: a note, or nil for a new one.
private struct MemoryEdit: Identifiable {
    let entry: MemoryEntry?
    var id: String { entry?.id ?? "new" }
}

private struct MemoryRow: View {
    let entry: MemoryEntry
    let now: Int64

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(entry.content).font(.sans(14)).foregroundStyle(Tone.fg).lineLimit(4).multilineTextAlignment(.leading)
            HStack(spacing: 6) {
                Pill(text: entry.kind.rawValue, color: Tone.signal)
                Pill(text: MemoryWords.scope(entry), color: Tone.fg3)
                ForEach(entry.tags.prefix(3), id: \.self) { Pill(text: "#\($0)", color: Tone.fg3) }
            }
            Text(MemoryWords.meta(entry, now: now)).font(.sans(12)).foregroundStyle(Tone.fg4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14).padding(.vertical, 12)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct Pill: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text).font(.sans(11.5, .medium)).foregroundStyle(color).lineLimit(1)
            .padding(.horizontal, 7).frame(height: 20)
            .background(color.opacity(0.1), in: Capsule())
    }
}

/// New or edit: the text, tags and kind; Save, and Delete (asked once) for a kept note.
private struct MemoryEditSheet: View {
    let entry: MemoryEntry?
    let save: @MainActor (MemoryInput) async -> String?
    let delete: @MainActor () async -> String?
    @State private var content: String
    @State private var tags: String
    @State private var kind: MemoryKind
    @State private var busy = false
    @State private var error: String?
    @State private var confirming = false
    @Environment(\.dismiss) private var dismiss

    init(entry: MemoryEntry?, save: @escaping @MainActor (MemoryInput) async -> String?, delete: @escaping @MainActor () async -> String?) {
        self.entry = entry
        self.save = save
        self.delete = delete
        _content = State(initialValue: entry?.content ?? "")
        _tags = State(initialValue: entry?.tags.joined(separator: ", ") ?? "")
        _kind = State(initialValue: entry?.kind ?? .fact)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text(entry == nil ? "New memory" : "Edit memory").font(.sans(18, .semibold)).foregroundStyle(Tone.fg)
                    Spacer()
                    Button("Cancel") { dismiss() }.buttonStyle(CVButton(look: .quiet))
                }
                field("Content") {
                    TextEditor(text: $content)
                        .font(.sans(14)).foregroundStyle(Tone.fg)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 140)
                        .padding(8)
                        .panel(Tone.raise, radius: Radius.r3, border: Tone.rule)
                        .accessibilityIdentifier("memory-content")
                }
                field("Tags, comma separated") {
                    TextField("tools, homelab", text: $tags)
                        .font(.sans(14)).foregroundStyle(Tone.fg)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .padding(.horizontal, 12).frame(height: 38)
                        .panel(Tone.raise, radius: Radius.r3, border: Tone.rule)
                }
                field("Kind") {
                    Segmented(options: MemoryKind.allCases.map { ($0, $0.label) }, selection: $kind)
                }
                if let error { Text(error).font(.sans(13)).foregroundStyle(Tone.fault) }
                HStack {
                    if entry != nil {
                        Button("Delete") { confirming = true }
                            .buttonStyle(CVButton(look: .quietFault))
                            .accessibilityIdentifier("memory-delete")
                    }
                    Spacer()
                    Button("Save") { run { await save(MemoryInput(content: text, kind: kind, tags: MemoryWords.tags(tags))) } }
                        .buttonStyle(CVButton(look: .solid))
                        .disabled(text.isEmpty || busy)
                        .accessibilityIdentifier("memory-save")
                }
            }
            .padding(24)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .background(Tone.bg.ignoresSafeArea())
        .confirmationDialog("Delete this memory?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { run { await delete() } }
        } message: {
            Text("The agents stop using it. This cannot be undone.")
        }
        .accessibilityIdentifier("memory-sheet")
    }

    private var text: String { content.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func field(_ label: String, @ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.sans(12.5, .medium)).foregroundStyle(Tone.fg3)
            content()
        }
    }

    /// Saves or deletes; the sheet closes once the hub took it, else says why.
    private func run(_ action: @escaping @MainActor () async -> String?) {
        busy = true
        Task {
            error = await action()
            busy = false
            if error == nil { dismiss() }
        }
    }
}
