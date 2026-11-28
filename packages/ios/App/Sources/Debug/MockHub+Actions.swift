#if DEBUG
import Foundation

/// `-mockHub` answers for the session actions: fork, rewind, abort and move, shaped as the hub answers
/// (packages/server/src/routes.ts, routes-projects.ts). Nil for every other route, plain PATCH included.
extension MockHub {
    static func actionsReply(_ method: String, _ url: URL, _ body: Data?) -> (Int, String)? {
        let p = url.path.split(separator: "/").map(String.init) // ["api", "sessions", id, action]
        guard method == "POST", p.count == 4, p[0] == "api", p[1] == "sessions" else { return nil }
        let id = p[2]
        let input = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        switch p[3] {
        case "fork":
            // the hub copies the session; the copy is a new chat of the same kind
            return (200, #"{"id":"fork-\#(UUID().uuidString.prefix(6))","title":"Fork","kind":"chat","model":"anthropic/claude-opus-5-5","updatedAt":\#(now)}"#)
        case "rewind":
            guard input["seq"] is NSNumber else { return (400, #"{"error":"seq is required"}"#) }
            return (200, #"{"id":"\#(id)","status":"idle","updatedAt":\#(now)}"#)
        case "abort":
            return (200, #"{"ok":true}"#)
        case "move":
            guard let device = input["device"] as? String else { return (400, #"{"error":"device is required"}"#) }
            return (200, #"{"resolved":true,"cwd":"~","via":"same","level":"exact","line":"Moved to \#(device).","session":{"id":"\#(id)","device":"\#(device)","updatedAt":\#(now)}}"#)
        default:
            return nil
        }
    }
}
#endif
