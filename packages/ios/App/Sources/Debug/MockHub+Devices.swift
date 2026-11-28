#if DEBUG
import Foundation

extension MockHub {
    /// PATCH /api/devices/:id answers with the device renamed, DELETE with { ok: true }, as the hub
    /// (server routes.ts). The hub's own row cannot be removed. Nil for any other request.
    static func devicesReply(_ method: String, _ url: URL, _ body: Data?) -> (Int, String)? {
        let p = url.path.split(separator: "/").map(String.init)
        guard p.count == 3, p[0] == "api", p[1] == "devices" else { return nil }
        let id = p[2]
        switch method {
        case "PATCH":
            let input = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            let name = (input["name"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
            guard !name.isEmpty else { return (400, #"{"error":"name must be a non-empty string"}"#) }
            let device: [String: Any] = ["id": id, "name": name, "online": true, "roots": [String](), "createdAt": 0]
            guard let data = try? JSONSerialization.data(withJSONObject: device) else { return nil }
            return (200, String(decoding: data, as: UTF8.self))
        case "DELETE":
            return id == "local" ? (400, #"{"error":"the hub device cannot be removed"}"#) : (200, #"{"ok":true}"#)
        default:
            return nil
        }
    }
}
#endif
