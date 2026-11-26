import Foundation

/// Effort as the web shows it (Android logic/Effort.kt, core providers/effort.ts): a model's levels come
/// from the hub's list; a stored level it lacks shows as the nearest one, the lower on a tie.
public enum Effort {
    /// The model's default, when the hub knows it and it is one of the choices.
    public static func defaultOf(_ e: ModelEffort) -> ThinkingLevel? {
        e.defaultLevel.flatMap(ThinkingLevel.init(rawValue:)).flatMap { choices(e).contains($0) ? $0 : nil }
    }

    /// The level the model takes for a stored one; nil for none, or for a model without Effort.
    public static func clamp(_ level: ThinkingLevel?, _ e: ModelEffort?) -> ThinkingLevel? {
        guard let level, let e else { return nil }
        let have = levels(e)
        if level == .off { return e.off ? .off : have.first }
        if have.contains(level) { return level }
        guard !have.isEmpty else { return e.off ? .off : nil }
        let at = order.firstIndex(of: level) ?? 0
        // min keeps the first of equals, and `have` is lowest first: the lower on a tie
        return have.min { abs(order.firstIndex(of: $0)! - at) < abs(order.firstIndex(of: $1)! - at) }
    }

    /// The stored level as the model takes it, else the model's default.
    public static func shown(_ level: ThinkingLevel?, _ e: ModelEffort) -> ThinkingLevel? { clamp(level, e) ?? defaultOf(e) }

    /// The word for a level; a model with one level (a switch) calls it On.
    public static func label(_ level: ThinkingLevel, _ e: ModelEffort? = nil) -> String {
        if level != .off, let e, e.levels == [level.rawValue] { return "On" }
        return level.label
    }

    /// The model and its effort as the composer says them: "Opus 5.5 Medium". The level shows only
    /// when the model has more than one; no model is "Choose a model".
    public static func words(_ model: String?, _ value: ThinkingLevel?, _ e: ModelEffort?) -> String {
        let name = ModelRefs.displayName(model)
        let shownName = name.isEmpty ? "Choose a model" : name
        guard let e, e.levels.count > 1, let level = shown(value, e), level != .off else { return shownName }
        return "\(shownName) \(label(level, e))"
    }

    private static let order: [ThinkingLevel] = [.low, .medium, .high, .xhigh, .max, .ultra]

    /// The model's levels, lowest first.
    public static func levels(_ e: ModelEffort) -> [ThinkingLevel] { order.filter { e.levels.contains($0.rawValue) } }

    /// Off where the model can stop thinking, then its levels. Empty: no Effort control.
    public static func choices(_ e: ModelEffort?) -> [ThinkingLevel] {
        guard let e else { return [] }
        return (e.off ? [.off] : []) + levels(e)
    }
}

/// The Cyber access programs a model offers (Android logic/CyberAccess.kt).
public enum CyberAccess {
    private static let labels = ["standard": "Standard", "daybreak_blue": "Daybreak Blue", "daybreak_red": "Daybreak Red"]

    public static func label(_ program: String?) -> String { program.map { labels[$0] ?? $0 } ?? "Default" }

    /// Default (nil), then the model's programs. Empty: the model has no Cyber access choice.
    public static func choices(_ m: ModelInfo?) -> [String?] {
        let own = (m?.cyber ?? []).filter { labels[$0] != nil }
        return own.isEmpty ? [] : [nil] + own
    }
}
