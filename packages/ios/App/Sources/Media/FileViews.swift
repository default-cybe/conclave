import ConclaveKit
import QuickLook
import SwiftUI

/// A file in the transcript (a document someone attached, a file a tool shared), as Android's
/// compact FileCard and the web's: a card up to 560 pt, radius 5, rule-2 line; the title, then
/// "name, PDF, 14.2 KB" in fg-3, and one small download icon at the right. A tap opens Quick Look.
struct FileCard: View {
    let name: String
    var title: String? = nil
    let mediaType: String
    var size: Int64? = nil
    /// Where the bytes are (inline, a trimmed block or a tool's file).
    let media: MediaBlock
    let client: ConclaveClient
    @State private var opener = FileOpener()

    var body: some View {
        let head = title?.isEmpty == false ? title! : name
        HStack(spacing: 4) {
            Button { Task { await opener.open(media, name: name, client: client) } } label: {
                HStack(spacing: 12) {
                    Image(systemName: FileIcon.of(mediaType)).font(.system(size: 18)).foregroundStyle(Tone.fg3).frame(width: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(head).font(.sans(14, .medium)).foregroundStyle(Tone.fg).lineLimit(1)
                        Text(([head == name ? nil : name] + [FileWords.facts(mediaType, size: size, name: name)]).compactMap { $0 }.joined(separator: ", "))
                            .font(.sans(12.5)).foregroundStyle(Tone.fg3).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    if opener.busy { ProgressView().controlSize(.small) }
                }
                .padding(.vertical, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("file-card")
            Button { Task { await opener.download(media, name: name, client: client) } } label: {
                Image(systemName: "arrow.down.to.line").font(.system(size: 15, weight: .medium)).foregroundStyle(Tone.fg3)
                    .frame(width: 32, height: 32).contentShape(Rectangle())
            }
            .buttonStyle(QuietPress(radius: Radius.r2))
            .accessibilityLabel("Download \(name)")
        }
        .padding(.leading, 14).padding(.trailing, 6)
        .frame(maxWidth: 560, alignment: .leading)
        .panel(Tone.raise, radius: Radius.r2, border: Tone.rule2)
        .fileOpener(opener)
    }
}

/// Loads a file's bytes once, then shows it in Quick Look or the share sheet.
@MainActor @Observable
final class FileOpener {
    var busy = false
    var preview: URL?
    var share: URL?
    private var cached: URL?

    func open(_ media: MediaBlock, name: String, client: ConclaveClient) async { preview = await file(media, name, client) }
    func download(_ media: MediaBlock, name: String, client: ConclaveClient) async { share = await file(media, name, client) }

    private func file(_ media: MediaBlock, _ name: String, _ client: ConclaveClient) async -> URL? {
        if let cached { return cached }
        busy = true
        defer { busy = false }
        guard let data = await MediaBytes.load(media, client) else { return nil }
        cached = MediaBytes.file(data, name: name, mediaType: media.mediaType)
        return cached
    }
}

extension View {
    func fileOpener(_ o: FileOpener) -> some View {
        @Bindable var o = o
        return quickLookPreview($o.preview).sheet(item: $o.share) { ShareSheet(items: [$0]) }
    }
}

enum FileIcon {
    static func of(_ mediaType: String) -> String {
        let t = mediaType.lowercased()
        if t.hasPrefix("image/") { return "photo" }
        if t.hasPrefix("video/") { return "film" }
        if t.hasPrefix("audio/") { return "waveform" }
        if t == "application/pdf" { return "doc.richtext" }
        if t.hasPrefix("text/") || t.contains("json") || t.contains("xml") { return "doc.text" }
        if t.contains("zip") || t.contains("tar") || t.contains("gzip") { return "doc.zipper" }
        return "doc"
    }
}

/// A file a ShareFile call handed over: its result's meta.file (Android logic/FileCards.kt `of`).
struct SharedFile {
    let toolUseId: String
    let name: String
    let mediaType: String
    let size: Int64?
    let title: String?

    init?(_ result: ToolResultBlock?) {
        guard let result, !result.isError, let f = result.meta?["file"],
              let id = f["toolUseId"]?.string, !id.isEmpty, let name = f["name"]?.string else { return nil }
        toolUseId = id
        self.name = name
        mediaType = f["mediaType"]?.string ?? "application/octet-stream"
        size = f["size"]?.number.map { Int64($0) }
        title = f["title"]?.string
    }
}
