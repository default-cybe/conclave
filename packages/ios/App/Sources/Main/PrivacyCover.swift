import LocalAuthentication
import SwiftUI

/// Settings > Privacy (Android Security): "Lock with Face ID" asks for Face ID, Touch ID or the
/// passcode when the app comes back from the background; "Hide content" blanks the app in the app
/// switcher. iOS has no switch that blocks screenshots, so this does not claim one.
struct PrivacyCover: ViewModifier {
    @AppStorage("privacy.lock") private var lock = false
    @AppStorage("privacy.hide") private var hide = false
    @Environment(\.scenePhase) private var phase
    @State private var locked = PrivacyCover.lockedAtLaunch
    @State private var asking = false

    /// A fresh start with the lock on starts locked.
    private static var lockedAtLaunch: Bool { UserDefaults.standard.bool(forKey: "privacy.lock") }

    func body(content: Content) -> some View {
        content
            .overlay {
                if locked && lock {
                    cover(unlock: true)
                } else if hide && phase != .active {
                    cover(unlock: false)
                }
            }
            .onChange(of: phase) { _, now in
                if now == .background, lock { locked = true }
                if now == .active, locked, lock { Task { await unlock() } }
            }
            .task { if locked, lock { await unlock() } }
    }

    private func cover(unlock: Bool) -> some View {
        ZStack {
            Tone.bg.ignoresSafeArea()
            VStack(spacing: 14) {
                Image(systemName: "lock.fill").font(.system(size: 28, weight: .regular)).foregroundStyle(Tone.fg3)
                if unlock {
                    Text("Conclave is locked").font(.sans(17, .semibold)).foregroundStyle(Tone.fg)
                    Button("Unlock") { Task { await self.unlock() } }.buttonStyle(CVButton(look: .solid, height: 40))
                        .accessibilityIdentifier("unlock")
                }
            }
        }
        .transition(.opacity)
    }

    @MainActor
    private func unlock() async {
        guard !asking else { return }
        asking = true
        defer { asking = false }
        let ctx = LAContext()
        var why: NSError?
        // no passcode set on the device: nothing can unlock, so the lock does not trap the owner
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &why) else { locked = false; return }
        if (try? await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock Conclave")) == true { locked = false }
    }

    /// Whether this device can lock at all (a passcode is set), for the Settings switch.
    static var canLock: Bool { LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) }
}
