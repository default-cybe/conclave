import Foundation

/// GET /api/remote (core types.ts RemoteStatus): how phones and computers reach the hub from outside.
public struct RemoteStatus: Sendable, Hashable, Decodable {
    public struct Address: Sendable, Hashable, Decodable {
        public var url: String
        /// stable, quick, own or lan
        public var kind: String
        public var label: String
    }
    public struct Lan: Sendable, Hashable, Decodable {
        public var on = false
        public var listening = false
        public var fixedHost: String?
    }
    public struct Stable: Sendable, Hashable, Decodable { public var hostname: String; public var zone: String }

    /// off, quick, stable, tailscale or custom
    public var mode = "off"
    /// off, installing, starting, on or error
    public var state = "off"
    public var url: String?
    public var addresses: [Address] = []
    public var detail: String?
    public var error: String?
    public var lan = Lan()
    public var stable: Stable?

    private enum K: String, CodingKey { case mode, state, url, addresses, detail, error, lan, stable }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        mode = try c.or(.mode, "off")
        state = try c.or(.state, "off")
        url = try? c.opt(.url)
        addresses = (try? c.or(.addresses, [Address]())) ?? []
        detail = try? c.opt(.detail)
        error = try? c.opt(.error)
        lan = (try? c.or(.lan, Lan())) ?? Lan()
        stable = try? c.opt(.stable)
    }
}

/// web lib/remote.ts words.
public enum RemoteWords {
    public static let modes = ["quick", "stable", "tailscale", "custom", "off"]

    public static func label(_ m: String) -> String {
        switch m {
        case "quick": "Quick tunnel"
        case "stable": "Stable address on your domain"
        case "tailscale": "Tailscale"
        case "custom": "My own URL"
        default: "Local only"
        }
    }

    public static func help(_ m: String) -> String {
        switch m {
        case "quick": "Built in, no account. The hub runs a Cloudflare tunnel and gets an https address. The address changes when the hub restarts."
        case "stable": "A fixed name such as conclave.example.com, through your Cloudflare account. Paste an API token once and pick the domain."
        case "tailscale": "Only devices on your tailnet. Tailscale has to run on the hub and on every phone and computer."
        case "custom": "A reverse proxy or domain you already run in front of the hub."
        default: "No outside address. Devices on the same network can still connect."
        }
    }

    /// The state in one line: "On." with the address, or what is happening.
    public static func state(_ s: RemoteStatus) -> String {
        switch s.state {
        case "on": return s.url.map { "On. Phones and computers reach the hub at \($0)." } ?? "On."
        case "installing": return "Installing. " + (s.detail ?? "Downloading cloudflared.")
        case "starting": return "Starting. " + (s.detail ?? "Waiting for Cloudflare.")
        case "error": return "Not working. " + (s.error ?? "The tunnel does not answer.")
        default: return s.mode == "off" ? "Off. Only this network reaches the hub." : "Off."
        }
    }

    /// An address the hub takes for tailscale or custom: https and a host.
    public static func urlOK(_ s: String) -> Bool {
        guard let u = URL(string: s.trimmingCharacters(in: .whitespaces)), let scheme = u.scheme?.lowercased(), let host = u.host, !host.isEmpty else { return false }
        return scheme == "https" || scheme == "http"
    }
}

extension ConclaveClient {
    public func remote() async throws -> RemoteStatus { try await get(["api", "remote"]) }

    /// PUT /api/remote: fields left out keep their value; url nil leaves it, "" is not sent.
    public func setRemote(mode: String? = nil, lan: Bool? = nil, url: String? = nil) async throws -> RemoteStatus {
        var b: JSONObject = [:]
        if let mode { b["mode"] = .string(mode) }
        if let lan { b["lan"] = .bool(lan) }
        if let url, !url.isEmpty { b["url"] = .string(url) }
        return try await send("PUT", ["api", "remote"], JSONValue.object(b))
    }
}
