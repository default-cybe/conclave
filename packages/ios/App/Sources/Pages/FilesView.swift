import ConclaveKit
import SwiftUI

/// Files (web features/files): a computer's folders outside the folder picker. Pick a computer,
/// walk from its home, tap a file to read it (text, the start of a long one). Read only.
struct FilesView: View {
    let hub: HubModel
    @State private var device = "local"
    @State private var path: String?
    @State private var entries: [FileEntry]?
    @State private var error: String?
    @State private var reading: FileEntry?

    var body: some View {
        Page(title: "Files", sub: path) {
            Menu {
                ForEach(computers, id: \.0) { id, name in
                    Button { device = id; path = nil } label: { if id == device { Label(name, systemImage: "checkmark") } else { Text(name) } }
                }
            } label: {
                Label(computers.first { $0.0 == device }?.1 ?? device, systemImage: "desktopcomputer").font(.sans(13, .medium))
            }
            .buttonStyle(CVButton(look: .outline, height: 32))
            .accessibilityIdentifier("files-device")
        } content: {
            if let error { ErrorBox(message: error) { Task { await load() } } }
            if let entries, let path {
                CardSection(title: FolderWords.baseName(path)) {
                    if let up = FolderWords.parent(path) {
                        Button { self.path = up } label: {
                            CardRow(label: "Up", detail: up) { Image(systemName: "arrow.turn.left.up").foregroundStyle(Tone.fg3) }.contentShape(Rectangle())
                        }
                        .buttonStyle(QuietPress(radius: 0))
                    }
                    if entries.isEmpty { EmptyLine(text: "This folder is empty.") }
                    ForEach(entries.sorted { $0.isFolder != $1.isFolder ? $0.isFolder : $0.name.localizedStandardCompare($1.name) == .orderedAscending }) { e in
                        Button { if e.isFolder { self.path = e.path } else { reading = e } } label: {
                            HStack(spacing: 10) {
                                Image(systemName: e.isFolder ? "folder" : "doc.text").foregroundStyle(e.isFolder ? Tone.signal : Tone.fg3).frame(width: 20)
                                Text(e.name).font(.sans(14)).foregroundStyle(Tone.fg).lineLimit(1).truncationMode(.middle)
                                Spacer(minLength: 8)
                                if let s = e.size, !e.isFolder { Text(ByteCountFormatter.string(fromByteCount: s, countStyle: .file)).font(.sans(12)).foregroundStyle(Tone.fg3) }
                            }
                            .padding(.horizontal, 14).frame(minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(QuietPress(radius: 0))
                    }
                }
            } else if error == nil {
                LoadingLine()
            }
        }
        .task(id: "\(device)|\(path ?? "")") { await load() }
        .sheet(item: $reading) { e in FileReader(hub: hub, device: device, entry: e) }
    }

    /// This hub, then the computers online now.
    private var computers: [(String, String)] {
        [("local", (hub.info?.name).flatMap { $0.isEmpty ? nil : $0 } ?? "This hub")] + hub.devices.filter(\.online).map { ($0.id, $0.name.isEmpty ? $0.id : $0.name) }
    }

    private func load() async {
        do {
            // the device does not expand "~": ask it where home is first
            if path == nil { path = try await hub.client.folderCheck(device: device, path: "~").path; return }
            entries = try await hub.client.browse(device: device, path: path ?? "/")
            error = nil
        } catch {
            if error is CancellationError { return }
            entries = nil
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }
}

private struct FileReader: View {
    let hub: HubModel
    let device: String
    let entry: FileEntry
    @State private var file: DeviceFile?
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView([.vertical, .horizontal]) {
                if let file {
                    VStack(alignment: .leading, spacing: 8) {
                        if file.truncated { Text("Only the start of this file.").font(.sans(12)).foregroundStyle(Tone.fg3) }
                        Text(file.content).font(.mono(12.5)).foregroundStyle(Tone.fg).textSelection(.enabled)
                    }
                    .padding(16)
                } else if let error {
                    Text(error).font(.sans(13)).foregroundStyle(Tone.fault).padding(16)
                } else {
                    LoadingLine().padding(16)
                }
            }
            .background(Tone.bg)
            .navigationTitle(entry.name).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                if let file { ToolbarItem(placement: .primaryAction) { ShareLink(item: file.content) } }
            }
        }
        .task {
            do { file = try await hub.client.readDeviceFile(device: device, path: entry.path) } catch {
                self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
            }
        }
    }
}
