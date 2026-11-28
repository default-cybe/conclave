import Foundation

// Search, projects and a device's folders (Android ConclaveClient search, browse and folderCheck,
// ConclaveClientProjects projects).
extension ConclaveClient {
    /// Messages that match, at most 30, newest first; an empty query answers [].
    public func search(_ q: String) async throws -> [SearchHit] { try await get(["api", "search"], query: [("q", q)]) }

    public func projects() async throws -> [Project] { try await get(["api", "projects"]) }

    /// The entries of the folder at `path` on the device. `path` must be absolute: the device does not expand "~".
    public func browse(device: String, path: String) async throws -> [FileEntry] {
        try await get(["api", "devices", device, "files"], query: [("path", path)])
    }

    /// Whether a folder is at `path` ("~" is the device's home), and its absolute path.
    public func folderCheck(device: String, path: String) async throws -> FolderCheck {
        try await get(["api", "devices", device, "folder"], query: [("path", path)])
    }
}
