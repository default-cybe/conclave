import Foundation

/// Port of packages/android/client logic/SessionModes.kt (the parts the iOS app shows).
public enum SessionModes {
    /// Why the model picker's "Use this model for all subagents" switch is off (web ComposerParts.tsx
    /// SameModelRow): a `member` whose model the hub marked `unavailable` (engine.ts listModels) gets
    /// the hub's refusal (engine.ts updateSession). Nil: it can be switched. Already `on`, it can always go off.
    public static func sameModelRefusal(member: Bool, unavailable: String?, on: Bool, name: String) -> String? {
        member && unavailable != nil && !on ? "Same model for all work needs a model your account may use; \(name) is not one." : nil
    }
}
