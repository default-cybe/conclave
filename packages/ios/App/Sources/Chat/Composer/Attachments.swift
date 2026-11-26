import ConclaveKit
import ImageIO
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Files the composer sends inline as base64, as Android does. A picture goes as a JPEG of at most
/// Attach.maxImageSide pixels and Attach.maxImageBytes; a GIF stays as it is so it still moves.
/// shortcut: the JPEG is made on the main actor (a few hundred ms for a 48 MP photo); move it off if pickers stutter.
@MainActor
enum Attachments {
    static func image(_ data: Data, name: String?) -> Attachment? {
        let base = (name.map { ($0 as NSString).deletingPathExtension } ?? "picture")
        if let src = CGImageSourceCreateWithData(data as CFData, nil),
           (CGImageSourceGetType(src) as String?) == UTType.gif.identifier, data.count <= Attach.maxImageBytes {
            return Attachment(mediaType: "image/gif", data: data.base64EncodedString(), name: name ?? "picture.gif")
        }
        guard let jpeg = jpeg(data) else { return nil }
        return Attachment(mediaType: "image/jpeg", data: jpeg.base64EncodedString(), name: base + ".jpg")
    }

    /// Scaled with ImageIO (never decoded whole), turned upright, then the quality steps down until it fits.
    nonisolated static func jpeg(_ data: Data) -> Data? {
        guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: Attach.maxImageSide,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let image = UIImage(cgImage: cg)
        for q in stride(from: 0.85, through: 0.35, by: -0.1) {
            if let d = image.jpegData(compressionQuality: q), d.count <= Attach.maxImageBytes { return d }
        }
        return image.jpegData(compressionQuality: 0.25)
    }

    static func file(_ data: Data, name: String, type: UTType?) -> Attachment? {
        if type?.conforms(to: .image) == true { return image(data, name: name) }
        return Attachment(mediaType: Attach.mediaTypeOf(type?.preferredMIMEType, name), data: data.base64EncodedString(), name: name)
    }

    /// A file from the Files picker: it lies outside the sandbox until we ask for it.
    static func file(at url: URL) -> Attachment? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return nil }
        return file(data, name: url.lastPathComponent, type: UTType(filenameExtension: url.pathExtension))
    }

    /// A dropped item: a picture by its data, anything else as the file it carries.
    static func load(_ p: NSItemProvider) async -> Attachment? {
        let name = p.suggestedName
        if p.hasItemConformingToTypeIdentifier(UTType.image.identifier),
           let data = try? await p.loadData(UTType.image) {
            return image(data, name: name)
        }
        guard let type = p.registeredContentTypes.first, let data = try? await p.loadData(type) else { return nil }
        return file(data, name: name.map { $0 + (type.preferredFilenameExtension.map { ".\($0)" } ?? "") } ?? "file", type: type)
    }

    /// The composer's chip picture, decoded at chip size.
    static func thumbnail(_ a: Attachment, side: CGFloat) -> UIImage? {
        guard a.mediaType.hasPrefix("image/"), let b64 = a.data, let data = Data(base64Encoded: b64) else { return nil }
        return PictureView.thumbnail(data, maxPixels: side).map { UIImage(cgImage: $0) }
    }
}

extension NSItemProvider {
    func loadData(_ type: UTType) async throws -> Data {
        try await withCheckedThrowingContinuation { c in
            _ = loadDataRepresentation(for: type) { data, error in
                if let data { c.resume(returning: data) } else { c.resume(throwing: error ?? CocoaError(.fileReadUnknown)) }
            }
        }
    }
}
