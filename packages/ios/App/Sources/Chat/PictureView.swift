import ConclaveKit
import ImageIO
import SwiftUI

/// A picture in the transcript or the Files pane. A trimmed one is read with blockData only once it
/// is on screen (the LazyVStack builds it then), and every picture is decoded at display size, never
/// whole. A tap opens the media viewer of the screen around it (MediaPresenter).
struct PictureView: View {
    let media: MediaBlock
    let client: ConclaveClient
    /// A square tile, cropped to fill (the Files grid); nil draws the whole picture, 240 pt at most.
    var square: CGFloat? = nil
    private static let side: CGFloat = 240
    @Environment(\.displayScale) private var scale
    @Environment(\.media) private var presenter
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        let side = square ?? Self.side
        Group {
            if let image {
                Button { presenter?.open(media) } label: {
                    if square != nil {
                        Color.clear.overlay { Image(uiImage: image).resizable().scaledToFill() }
                            .frame(width: side, height: side)
                    } else {
                        Image(uiImage: image).resizable().scaledToFit()
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Picture, opens full screen")
                .accessibilityIdentifier("picture")
            } else {
                RoundedRectangle(cornerRadius: 12).fill(Tone.sunk)
                    .overlay { failed ? AnyView(Image(systemName: "photo").foregroundStyle(Tone.fg3)) : AnyView(ProgressView()) }
                    .frame(width: side, height: square == nil ? side * 0.66 : side)
            }
        }
        .frame(maxWidth: side, maxHeight: side)
        .clipShape(RoundedRectangle(cornerRadius: square == nil ? 12 : Radius.r2))
        .overlay { if square != nil { RoundedRectangle(cornerRadius: Radius.r2).strokeBorder(Tone.rule) } }
        .task(id: media) { await load(side) }
    }

    private func load(_ side: CGFloat) async {
        guard let data = await MediaBytes.load(media, client) else {
            failed = true
            return
        }
        let px = side * scale
        let thumb = await Task.detached { Self.thumbnail(data, maxPixels: px) }.value
        guard let thumb else {
            failed = true
            return
        }
        image = UIImage(cgImage: thumb)
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
