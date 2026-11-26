import ConclaveKit
import ImageIO
import QuickLook
import SwiftUI

/// A picture in the transcript. A trimmed one is read with blockData only once it is on screen
/// (the LazyVStack builds it then), and every picture is decoded at display size, never whole.
/// A tap opens it in Quick Look.
struct PictureView: View {
    let media: MediaBlock
    let client: ConclaveClient
    private static let side: CGFloat = 240
    @Environment(\.displayScale) private var scale
    @State private var image: UIImage?
    @State private var file: URL?
    @State private var preview: URL?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                Button { preview = file } label: {
                    Image(uiImage: image).resizable().scaledToFit()
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Picture, opens full size")
            } else {
                RoundedRectangle(cornerRadius: 12).fill(Tone.sunk)
                    .overlay { failed ? AnyView(Image(systemName: "photo").foregroundStyle(Tone.fg3)) : AnyView(ProgressView()) }
                    .frame(width: Self.side, height: Self.side * 0.66)
            }
        }
        .frame(maxWidth: Self.side, maxHeight: Self.side)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .quickLookPreview($preview)
        .task(id: media) { await load() }
    }

    private func load() async {
        var b64 = media.data
        if b64 == nil, let ref = BlockRef.of(media.url) { b64 = try? await client.blockData(ref) }
        guard let b64, let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else {
            failed = true
            return
        }
        let px = Self.side * scale
        let thumb = await Task.detached { Self.thumbnail(data, maxPixels: px) }.value
        guard let thumb else {
            failed = true
            return
        }
        image = UIImage(cgImage: thumb)
        // Quick Look reads a file: the original bytes, in the cache folder the system may empty
        let ext = media.mediaType.split(separator: "/").last.map(String.init) ?? "png"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(abs(b64.hashValue)).\(ext)")
        if (try? data.write(to: url)) != nil { file = url }
    }

    nonisolated static func thumbnail(_ data: Data, maxPixels: CGFloat) -> CGImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
    }
}
