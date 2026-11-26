import Foundation

/// The Effort control's levels for a model (Android logic/Effort.kt). Phase 4's picker uses the rest.
public enum Effort {
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
