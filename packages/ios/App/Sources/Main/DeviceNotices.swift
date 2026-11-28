import ConclaveKit
import SwiftUI
import UserNotifications

/// Settings > Notifications on this device (Android "Notify this device"): a banner for an approval,
/// a question or a failed turn, posted from the hub's live stream. A free Apple ID has no push, and
/// iOS stops the stream once the app is in the background, so these come while Conclave is open
/// (another chat, another page, Split View or Slide Over); the Inbox holds the rest.
@MainActor
final class DeviceNotices: NSObject, UNUserNotificationCenterDelegate {
    static let shared = DeviceNotices()
    static let key = "notify.device"

    /// The chat a tapped banner asks to open; MainSplitView reads it.
    var onOpen: ((String) -> Void)?
    /// The chat on screen: nothing is posted for it.
    var visible: String?

    var enabled: Bool { UserDefaults.standard.bool(forKey: Self.key) }

    func install() { UNUserNotificationCenter.current().delegate = self }

    /// Ask iOS once; false when the owner said no (Settings then says where to change it).
    func requestPermission() async -> Bool {
        (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    func post(_ e: EngineEvent, title: (String) -> String) {
        guard enabled, let (sid, body, id) = Self.words(e), sid != visible else { return }
        let c = UNMutableNotificationContent()
        c.title = title(sid)
        c.body = body
        c.sound = .default
        c.threadIdentifier = sid
        c.userInfo = ["session": sid]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: c, trigger: nil))
    }

    /// The session, the line and a stable id for the events worth a banner; nil for the rest.
    nonisolated static func words(_ e: EngineEvent) -> (String, String, String)? {
        switch e {
        case .approvalRequested(let a):
            return (a.sessionId, "Asks to run \(a.tool.isEmpty ? "a tool" : a.tool)" + (a.summary.isEmpty ? "." : ": \(a.summary)"), "approval-\(a.id)")
        case .questionAsked(let q):
            return (q.sessionId, q.questions.first?.question ?? "Has a question for you.", "question-\(q.id)")
        case .sessionUpdated(let s) where s.status == .error:
            return (s.id, "The turn failed. Open the chat to retry.", "error-\(s.id)-\(s.updatedAt)")
        default:
            return nil
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let sid = response.notification.request.content.userInfo["session"] as? String else { return }
        await MainActor.run { onOpen?(sid) }
    }
}
