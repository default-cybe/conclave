import Foundation

/// The workflow launch form's values (Android logic/LaunchArgs.kt, web workflows/args-form.tsx):
/// typed fields from the workflow's argsSchema, and `raw`, the JSON box. With no schema the box holds
/// all the args; with one it holds the extras the schema does not name.
public struct LaunchForm: Sendable, Hashable {
    public var texts: [String: String] = [:]
    public var bools: [String: Bool] = [:]
    public var raw = ""

    public init(texts: [String: String] = [:], bools: [String: Bool] = [:], raw: String = "") {
        self.texts = texts
        self.bools = bools
        self.raw = raw
    }
}

public enum Launch {
    /// The whole form a preset fills: nothing from an earlier pick is kept.
    public static func formOf(_ schema: [WorkflowArgField]?, _ args: JSONValue?) -> LaunchForm {
        guard let args, args != .null else { return LaunchForm() }
        guard let schema, let obj = args.object else { return LaunchForm(raw: text(args)) }
        var f = LaunchForm()
        var extra: JSONObject = [:]
        for (k, v) in obj {
            guard let field = schema.first(where: { $0.name == k }) else { extra[k] = v; continue }
            if field.type == "boolean" {
                f.bools[k] = v.bool ?? false
            } else if v != .null {
                switch v {
                case .string(let s): f.texts[k] = s
                case .number(let n): f.texts[k] = n == n.rounded() && abs(n) < 1e15 ? String(Int64(n)) : String(n)
                default: f.texts[k] = text(v)
                }
            }
        }
        f.raw = extra.isEmpty ? "" : text(.object(extra))
        return f
    }

    /// The args to start or save with (nil: none), or the error to show under the form.
    public static func argsOf(_ schema: [WorkflowArgField]?, _ form: LaunchForm) -> Result<JSONValue?, LaunchError> {
        let raw = form.raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let schema else {
            if raw.isEmpty { return .success(nil) }
            guard let v = parse(raw) else { return .failure(LaunchError(message: #"Args must be JSON, like {"question": "..."}"#)) }
            return .success(v)
        }
        var out: JSONObject = [:]
        if !raw.isEmpty {
            guard let extra = parse(raw)?.object else { return .failure(LaunchError(message: "More args (JSON) must be a JSON object")) }
            out = extra
        }
        for field in schema {
            if field.type == "boolean" {
                // always sent, false included: absent and false must not collapse
                out[field.name] = .bool(form.bools[field.name] == true)
                continue
            }
            let v = (form.texts[field.name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if v.isEmpty { continue }
            if field.type == "number" {
                guard let n = Double(v), n.isFinite else { return .failure(LaunchError(message: "\(field.name) must be a number")) }
                out[field.name] = .number(n)
            } else {
                out[field.name] = .string(v)
            }
        }
        // declared fields win over an extra of the same name, as on web
        return .success(.object(out))
    }

    /// The Budget field (web RunSheet): "500k", "2m" or a plain count of output tokens; empty is no ceiling.
    public static func budgetTokens(_ s: String) -> Result<Int?, LaunchError> {
        let t = s.trimmingCharacters(in: .whitespaces).lowercased()
        if t.isEmpty { return .success(nil) }
        let unit: Double = t.hasSuffix("m") ? 1e6 : t.hasSuffix("k") ? 1e3 : 1
        let digits = unit == 1 ? t : String(t.dropLast()).trimmingCharacters(in: .whitespaces)
        guard let n = Double(digits), n.isFinite, n > 0, digits.allSatisfy({ $0.isNumber || $0 == "." }) else {
            return .failure(LaunchError(message: "Write a number of tokens, like 500k or 2m."))
        }
        return .success(Int((n * unit).rounded()))
    }

    private static func parse(_ s: String) -> JSONValue? { try? JSONDecoder().decode(JSONValue.self, from: Data(s.utf8)) }

    private static func text(_ v: JSONValue) -> String {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return (try? e.encode(v)).map { String(decoding: $0, as: UTF8.self) } ?? ""
    }
}

public struct LaunchError: Error, Sendable, Hashable {
    public let message: String
}
