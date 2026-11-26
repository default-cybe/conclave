import Foundation

// Request and response bodies of the hub API (packages/android/client model/Api.kt).
// Encoded optionals that are nil are left out, as the Kotlin client's explicitNulls = false.

public struct HubInfo: Sendable, Hashable, Codable {
    public var name = ""
    public var version = ""
    public var startedAt: Int64 = 0
    public var devices = 0
    public var publicUrl: String?
    public var defaultModel = ""
    public var features: [String] = []
    public var fingerprint: String?

    public init(name: String = "", version: String = "") {
        self.name = name
        self.version = version
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.or(.name, "")
        version = try c.or(.version, "")
        startedAt = try c.or(.startedAt, 0)
        devices = try c.or(.devices, 0)
        publicUrl = try c.opt(.publicUrl)
        defaultModel = try c.or(.defaultModel, "")
        features = try c.or(.features, [])
        fingerprint = try c.opt(.fingerprint)
    }
}

public struct HealthInfo: Sendable, Hashable, Codable {
    public var ok = false
    public var version = ""
    public var uptimeMs: Int64 = 0
    public var people = false

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.or(.ok, false)
        version = try c.or(.version, "")
        uptimeMs = try c.or(.uptimeMs, 0)
        people = try c.or(.people, false)
    }
}

/// The hub's identity key (base64url Ed25519) and its fingerprint. Kept with the token.
public struct HubIdentity: Sendable, Hashable, Codable {
    public var publicKey: String
    public var fingerprint: String

    public init(publicKey: String, fingerprint: String = "") {
        self.publicKey = publicKey
        self.fingerprint = fingerprint
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(publicKey: try c.decode(String.self, forKey: .publicKey), fingerprint: try c.or(.fingerprint, ""))
    }
}

/// GET /api/identity: the hub's key and its signature of the nonce.
public struct IdentityProof: Sendable, Hashable, Codable {
    public var publicKey: String
    public var fingerprint: String
    public var signature: String

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        publicKey = try c.decode(String.self, forKey: .publicKey)
        fingerprint = try c.or(.fingerprint, "")
        signature = try c.decode(String.self, forKey: .signature)
    }
}

/// Who a token signs in as. Pairing and login replies carry it.
public struct AccountRef: Sendable, Hashable, Codable {
    public var id = "owner"
    public var name = "owner"
    /// "owner" or "member".
    public var role = "owner"

    public var isOwner: Bool { role == "owner" }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.or(.id, "owner")
        name = try c.or(.name, "owner")
        role = try c.or(.role, "owner")
    }
}

struct PairRequest: Encodable {
    var code: String
    var name: String
    var platform: String
}

struct LoginRequest: Encodable {
    var password: String
    var name: String
    var platform: String
    var account: String?
}

/// POST /api/pair and POST /api/login.
public struct PairResponse: Sendable, Hashable, Codable {
    public var token: String
    public var clientId = ""
    public var hub = HubInfo()
    /// Every way to reach the hub, best first.
    public var addresses: [String] = []
    /// Every later connection checks the hub holds this key. Absent from older hubs.
    public var identity: HubIdentity?
    /// Whose token this is. Absent from hubs older than accounts: the owner's.
    public var account: AccountRef?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        token = try c.decode(String.self, forKey: .token)
        clientId = try c.or(.clientId, "")
        hub = try c.or(.hub, HubInfo())
        addresses = try c.or(.addresses, [])
        identity = try c.opt(.identity)
        account = try c.opt(.account)
    }
}

// MARK: - Sending

public struct Attachment: Sendable, Hashable, Codable {
    public var mediaType: String
    public var data: String?
    public var path: String?
    public var name: String?

    public init(mediaType: String, data: String? = nil, path: String? = nil, name: String? = nil) {
        self.mediaType = mediaType
        self.data = data
        self.path = path
        self.name = name
    }
}

public struct SendInput: Sendable, Hashable, Codable {
    public var text: String
    public var attachments: [Attachment]?
    public var mode: SessionMode?
    public var model: String?
    /// "steer" or "queue" while the session works.
    public var whenBusy: String?
    public var pendingId: String?
    public var attachmentLoss: String?

    public init(text: String, attachments: [Attachment]? = nil, mode: SessionMode? = nil, model: String? = nil, whenBusy: String? = nil, pendingId: String? = nil) {
        self.text = text
        self.attachments = attachments
        self.mode = mode
        self.model = model
        self.whenBusy = whenBusy
        self.pendingId = pendingId
    }
}

public struct SendResult: Sendable, Hashable, Codable {
    public var queued = false
    public var messageId: String?
    public var pendingId: String?

    public init(queued: Bool = false, messageId: String? = nil, pendingId: String? = nil) {
        self.queued = queued
        self.messageId = messageId
        self.pendingId = pendingId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(queued: try c.or(.queued, false), messageId: try c.opt(.messageId), pendingId: try c.opt(.pendingId))
    }
}

public struct QueuedAttachment: Sendable, Hashable, Codable {
    public var name: String?
    public var mediaType = ""

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.opt(.name)
        mediaType = try c.or(.mediaType, "")
    }
}

/// A message waiting while the session works (GET /queue, session.queue).
public struct QueuedMessage: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    public var text = ""
    public var attachments: [QueuedAttachment] = []
    public var at: Int64 = 0
    public var whenBusy = "queue"
    public var held = false

    public init(id: String, text: String = "", at: Int64 = 0, whenBusy: String = "queue", held: Bool = false) {
        self.id = id
        self.text = text
        self.at = at
        self.whenBusy = whenBusy
        self.held = held
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        text = try c.or(.text, "")
        attachments = try c.or(.attachments, [])
        at = try c.or(.at, 0)
        whenBusy = try c.or(.whenBusy, "queue")
        held = try c.or(.held, false)
    }
}

public struct NextModelResult: Sendable, Hashable, Codable {
    public var model = ""
    public var label = ""

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        model = try c.or(.model, "")
        label = try c.or(.label, "")
    }
}

// MARK: - Session changes

/// PATCH /api/sessions/:id. Nil fields are left out.
public struct SessionPatch: Sendable, Hashable {
    public var title: String?
    public var pinned: Bool?
    public var archived: Bool?
    public var model: String?
    public var chat: ChatSettingsPatch?

    public init(title: String? = nil, pinned: Bool? = nil, archived: Bool? = nil, model: String? = nil, chat: ChatSettingsPatch? = nil) {
        self.title = title
        self.pinned = pinned
        self.archived = archived
        self.model = model
        self.chat = chat
    }

    var json: JSONObject {
        var o: JSONObject = [:]
        if let title { o["title"] = .string(title) }
        if let pinned { o["pinned"] = .bool(pinned) }
        if let archived { o["archived"] = .bool(archived) }
        if let model { o["model"] = .string(model) }
        if let chat { o["chat"] = .object(chat.json) }
        return o
    }
}

/// Some of a chat's switches. `agentThinking` sends thinking: null (back to the agent's
/// setting), `defaultCyber` cyber: null; a plain nil leaves the switch alone.
public struct ChatSettingsPatch: Sendable, Hashable {
    public var webSearch: Bool?
    public var memory: Bool?
    public var memorySave: Bool?
    public var thinking: ThinkingLevel?
    public var agentThinking = false
    public var cyber: String?
    public var defaultCyber = false
    public var sameModel: Bool?
    public var security: Bool?

    public init(
        webSearch: Bool? = nil, memory: Bool? = nil, memorySave: Bool? = nil, thinking: ThinkingLevel? = nil,
        agentThinking: Bool = false, cyber: String? = nil, defaultCyber: Bool = false, sameModel: Bool? = nil, security: Bool? = nil
    ) {
        self.webSearch = webSearch
        self.memory = memory
        self.memorySave = memorySave
        self.thinking = thinking
        self.agentThinking = agentThinking
        self.cyber = cyber
        self.defaultCyber = defaultCyber
        self.sameModel = sameModel
        self.security = security
    }

    var json: JSONObject {
        var o: JSONObject = [:]
        if let webSearch { o["webSearch"] = .bool(webSearch) }
        if let memory { o["memory"] = .bool(memory) }
        if let memorySave { o["memorySave"] = .bool(memorySave) }
        if let thinking { o["thinking"] = .string(thinking.rawValue) }
        if agentThinking { o["thinking"] = .null }
        if let cyber { o["cyber"] = .string(cyber) }
        if defaultCyber { o["cyber"] = .null }
        if let sameModel { o["sameModel"] = .bool(sameModel) }
        if let security { o["security"] = .bool(security) }
        return o
    }
}

// MARK: - Models

public struct ModelEffort: Sendable, Hashable, Codable {
    public var levels: [String] = []
    public var off = false
    public var defaultLevel: String?

    private enum CodingKeys: String, CodingKey {
        case levels, off
        case defaultLevel = "default"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        levels = try c.or(.levels, [])
        off = try c.or(.off, false)
        defaultLevel = try c.opt(.defaultLevel)
    }
}

public struct ModelInfo: Sendable, Hashable, Codable, Identifiable {
    public var id: String
    public var ref = ""
    public var provider = ""
    public var name = ""
    public var contextWindow: Int64 = 0
    public var maxOutput: Int64 = 0
    public var vision = false
    public var tools = false
    public var thinking = false
    public var inputPrice = 0.0
    public var outputPrice = 0.0
    /// "fast", "smart" or "deep" when the hub's tier lists name it.
    public var tier: String?
    public var effort: ModelEffort?
    /// The same model under another account: the picker shows it once.
    public var sameAs: String?
    /// The account or route it goes through ("personal", "neu").
    public var via: String?
    public var refs: [String]?
    public var choices: [String]?
    public var vendor: String?
    public var cyber: [String]?
    /// Why it cannot be picked right now; nil when it can.
    public var unavailable: String?

    public init(id: String, ref: String = "", provider: String = "", name: String = "", via: String? = nil, sameAs: String? = nil, refs: [String]? = nil) {
        self.id = id
        self.ref = ref
        self.provider = provider
        self.name = name
        self.via = via
        self.sameAs = sameAs
        self.refs = refs
    }

    public var fullRef: String { ref.isEmpty ? (provider.isEmpty ? id : "\(provider)/\(id)") : ref }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        ref = try c.or(.ref, "")
        provider = try c.or(.provider, "")
        name = try c.or(.name, "")
        contextWindow = try c.or(.contextWindow, 0)
        maxOutput = try c.or(.maxOutput, 0)
        vision = try c.or(.vision, false)
        tools = try c.or(.tools, false)
        thinking = try c.or(.thinking, false)
        inputPrice = try c.or(.inputPrice, 0)
        outputPrice = try c.or(.outputPrice, 0)
        tier = try c.opt(.tier)
        effort = try c.opt(.effort)
        sameAs = try c.opt(.sameAs)
        via = try c.opt(.via)
        refs = try c.opt(.refs)
        choices = try c.opt(.choices)
        vendor = try c.opt(.vendor)
        cyber = try c.opt(.cyber)
        unavailable = try c.opt(.unavailable)
    }
}

public struct ModelGroup: Sendable, Hashable, Codable {
    public var provider: String
    public var name = ""
    public var type = ""
    public var configured = false
    public var enabled = false
    public var models: [ModelInfo] = []
    public var error: String?

    public init(provider: String, name: String = "", enabled: Bool = true, configured: Bool = true, models: [ModelInfo] = []) {
        self.provider = provider
        self.name = name
        self.enabled = enabled
        self.configured = configured
        self.models = models
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = try c.decode(String.self, forKey: .provider)
        name = try c.or(.name, "")
        type = try c.or(.type, "")
        configured = try c.or(.configured, false)
        enabled = try c.or(.enabled, false)
        models = try c.or(.models, [])
        error = try c.opt(.error)
    }
}
