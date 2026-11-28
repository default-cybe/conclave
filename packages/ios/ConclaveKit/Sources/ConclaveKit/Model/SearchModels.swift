import Foundation

// Wire shapes of search and the folder pickers: GET /api/search (engine.search), GET /api/projects
// (core projects), GET /api/devices/:device/files and /folder (engine.browse, folderCheck).
// Missing fields fall back, as the Kotlin client's.

/// One message that matched. The hub marks the matched words in `snippet` as [word].
public struct SearchHit: Sendable, Hashable, Codable, Identifiable {
    public var sessionId: String
    public var messageId = ""
    public var snippet = ""
    public var title = ""

    public var id: String { "\(sessionId):\(messageId)" }

    public init(sessionId: String, messageId: String = "", snippet: String = "", title: String = "") {
        self.sessionId = sessionId
        self.messageId = messageId
        self.snippet = snippet
        self.title = title
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        messageId = try c.or(.messageId, "")
        snippet = try c.or(.snippet, "")
        title = try c.or(.title, "")
    }
}

/// One entry of a folder on a device; `type` is file, dir, symlink or other.
public struct FileEntry: Sendable, Hashable, Codable, Identifiable {
    public var name: String
    public var path = ""
    public var type = "file"
    public var size: Int64?

    public var id: String { path.isEmpty ? name : path }
    /// A symlink may lead to a folder: the pickers offer it as one, as the web's.
    public var isFolder: Bool { type == "dir" || type == "symlink" }

    public init(name: String, path: String = "", type: String = "file", size: Int64? = nil) {
        self.name = name
        self.path = path
        self.type = type
        self.size = size
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        path = try c.or(.path, "")
        type = try c.or(.type, "file")
        size = try? c.opt(.size)
    }
}

/// Whether a folder is at a path on a device; `path` comes back absolute ("~" resolved).
public struct FolderCheck: Sendable, Hashable, Codable {
    public var path = ""
    public var exists = false

    public init(path: String = "", exists: Bool = false) {
        self.path = path
        self.exists = exists
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.or(.path, "")
        exists = try c.or(.exists, false)
    }
}

/// Where a project's folder is on one device.
public struct ProjectLocation: Sendable, Hashable, Codable {
    public var device = ""
    public var path = ""
    public var pinned = false

    public init(device: String = "", path: String = "", pinned: Bool = false) {
        self.device = device
        self.path = path
        self.pinned = pinned
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        device = try c.or(.device, "")
        path = try c.or(.path, "")
        pinned = try c.or(.pinned, false)
    }
}

/// A project the hub knows, with its folders across devices.
public struct Project: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    public var name = ""
    public var locations: [ProjectLocation] = []

    public init(id: String, name: String = "", locations: [ProjectLocation] = []) {
        self.id = id
        self.name = name
        self.locations = locations
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.or(.name, "")
        locations = (try? c.opt(.locations)) ?? []
    }
}
