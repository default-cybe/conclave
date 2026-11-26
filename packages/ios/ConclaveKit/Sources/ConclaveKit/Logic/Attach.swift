import Foundation

/// What one message may carry (Android logic/Attach.kt, core attachments/limits.ts): any number of files
/// of any type, together less than the hub reads in one request, since the app sends them inline.
public enum Attach {
    /// The files of one message together, before base64: the hub reads a 64 MB body at most.
    public static let maxTotalBytes: Int64 = 45 * 1024 * 1024
    public static let tooLarge = "Files in one message come to 45 MB at most. Send the rest in another message."

    /// A picture goes as a JPEG this long on its longest side at most.
    public static let maxImageSide = 2000
    /// A picture's JPEG is at most this big; the quality steps down until it fits.
    public static let maxImageBytes = 2 * 1024 * 1024

    /// Media types a zip comes as (Windows says x-zip-compressed).
    public static let zipTypes = ["application/zip", "application/x-zip-compressed", "application/x-zip", "multipart/x-zip"]

    /// A zip, by its media type, or by its name when the type says nothing.
    public static func isZip(_ mediaType: String?, _ name: String?) -> Bool {
        let t = (mediaType ?? "").lowercased()
        if zipTypes.contains(t) { return true }
        return (t.isEmpty || t == "application/octet-stream") && (name ?? "").lowercased().hasSuffix(".zip")
    }

    /// The type to send: a zip handed over as octet-stream goes as application/zip.
    public static func mediaTypeOf(_ type: String?, _ name: String?) -> String {
        if isZip(type, name) && !zipTypes.contains(type ?? "") { return "application/zip" }
        guard let type, !type.trimmingCharacters(in: .whitespaces).isEmpty else { return "application/octet-stream" }
        return type
    }

    /// A pasted item the composer takes as a file: any picture. Text stays text.
    public static func isPastedImage(_ mediaType: String?) -> Bool {
        (mediaType ?? "").trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("image/")
    }

    /// A file's size from its base64 (what the composer holds).
    public static func sizeOf(_ a: Attachment) -> Int64 { Int64(a.data?.utf8.count ?? 0) * 3 / 4 }

    /// Why [next] cannot join [current], or nil when it can.
    public static func refusal(_ current: [Attachment], _ next: Attachment) -> String? {
        current.reduce(0) { $0 + sizeOf($1) } + sizeOf(next) > maxTotalBytes ? tooLarge : nil
    }

    /// The hub's 409 when a send would lose a file it could not read (core attachments/prepare.ts).
    public static let lost = "Attachment not included: "

    /// The words to ask "Send without it?" with, when [error] is that 409.
    public static func lostWords(_ error: String) -> String? { error.hasPrefix(lost) ? String(error.dropFirst(lost.count)) : nil }

    /// "7 files", "1 file".
    public static func filesWord(_ n: Int) -> String { n == 1 ? "1 file" : "\(n) files" }

    /// The pixel size a picture is scaled to: its longest side at most [maxSide], never up.
    public static func fitted(width: Int, height: Int, maxSide: Int = maxImageSide) -> (width: Int, height: Int) {
        let long = max(width, height)
        guard long > maxSide, long > 0 else { return (width, height) }
        let s = Double(maxSide) / Double(long)
        return (max(1, Int((Double(width) * s).rounded())), max(1, Int((Double(height) * s).rounded())))
    }
}
