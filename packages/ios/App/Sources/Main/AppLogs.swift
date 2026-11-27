import ConclaveKit
import Foundation
import MetricKit
import UIKit

/// The app's own lines in the hub's log (`"component":"client"`, app "ios"), as the web's
/// clientLog.ts and Android's ClientLogs.startFor: app.start with version, device and system,
/// socket state, failed calls and decode failures (ConclaveKit ClientLogs), errors the screens
/// show, and the crash reports iOS hands over at the next start (MetricKit).
@MainActor
enum AppLogs {
    private static var started = false
    private static var timer: Task<Void, Never>?
    private static let crashes = CrashReports()

    /// "0.11 (11)": CFBundleShortVersionString and CFBundleVersion, the IPA's version.
    static var version: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(v) (\(b))"
    }

    /// Sends to `client` from now on (a new pairing replaces the old one). The first call of a
    /// run logs app.start.
    static func start(_ client: ConclaveClient) {
        let d = UIDevice.current
        let platform = "\(d.userInterfaceIdiom == .pad ? "iPadOS" : "iOS") \(d.systemVersion)"
        let old = ClientLogs.batcher
        let next = LogBatcher(app: "ios", version: version, platform: platform) { try await client.sendClientLogs($0) }
        ClientLogs.batcher = next
        // what waited for the old hub stays with it; a flush sends it there
        if let old { Task { await old.flush() } }
        timer?.cancel()
        timer = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                await ClientLogs.batcher?.flush()
            }
        }
        guard !started else { return }
        started = true
        ClientLogs.log("info", "app.start", [
            "device": .string(model()), "idiom": .string(d.userInterfaceIdiom == .pad ? "pad" : "phone"),
            "os": .string(d.systemVersion), "build": .string(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"),
            "width": .number(Double(UIScreen.main.bounds.width)), "height": .number(Double(UIScreen.main.bounds.height)),
        ])
        MXMetricManager.shared.add(crashes)
        Task { await next.flush() }
    }

    /// The app goes to the background: what waits goes now.
    static func flush() { Task { await ClientLogs.batcher?.flush() } }

    /// An error a screen shows or swallows: where it happened and the short message.
    static func error(_ place: String, _ error: Error) {
        if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
        // a failed call is already logged by the client with its route and status
        if error is ConclaveAPIError || error is URLError { return }
        ClientLogs.log("error", "app.error", ["where": .string(place), "type": .string(String(describing: type(of: error)))], msg: ClientLogs.describe(error))
    }

    /// The hardware name, "iPad14,5".
    private static func model() -> String {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }
}

/// Crash and hang reports of earlier runs, which iOS delivers at a later start.
/// No state of its own, so any thread may call it.
final class CrashReports: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for p in payloads {
            for c in p.crashDiagnostics ?? [] {
                let fields: [String: JSONValue] = [
                    "version": .string(c.applicationVersion),
                    "exception": c.exceptionType.map { .number($0.doubleValue) } ?? .null,
                    "signal": c.signal.map { .number($0.doubleValue) } ?? .null,
                    "reason": .string(String((c.terminationReason ?? c.virtualMemoryRegionInfo ?? "").prefix(200))),
                ]
                ClientLogs.log("error", "app.crashed", fields, msg: c.exceptionReason?.composedMessage)
            }
            for h in p.hangDiagnostics ?? [] {
                ClientLogs.log("warn", "app.hang", ["version": .string(h.applicationVersion), "duration": .string(h.hangDuration.description)])
            }
        }
        Task { await ClientLogs.batcher?.flush() }
    }
}
