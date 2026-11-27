import Foundation
import Testing
@testable import ConclaveKit

// ClientLogs: batches to POST /api/logs/client, as web clientLog.ts and Android ClientLogs.kt.
struct ClientLogsTests {
    @Test func batchesGoToTheLogsRouteWithAppVersionAndPlatform() async throws {
        let hub = MockHub()
        hub.enqueue(#"{"accepted":2}"#)
        let client = hub.client()
        let b = LogBatcher(version: "0.11 (11)", platform: "iPadOS 18.6") { try await client.sendClientLogs($0) }
        b.log("info", "app.start", ["device": .string("iPad14,5")])
        b.log("warn", "request.failed", ["status": .number(500)], msg: "boom\n  twice")
        #expect(await b.flush())
        #expect(b.pending == 0)
        let req = try #require(hub.take())
        #expect(req.method == "POST" && req.path == "/api/logs/client")
        let body = try #require(req.json)
        #expect(body["app"] == "ios")
        #expect(body["version"] == "0.11 (11)")
        #expect(body["platform"] == "iPadOS 18.6")
        #expect(body["events"]?.array?.count == 2)
        #expect(body["events"]?.array?[1]["msg"] == "boom twice")
    }

    @Test func theSameEventAgainCountsAndA404StopsSending() async {
        let b = LogBatcher(clock: { 1_000_000 }) { _ in throw ConclaveAPIError(status: 404, message: "Not found") }
        b.log("warn", "socket.closed")
        b.log("warn", "socket.closed")
        #expect(b.pending == 1)
        #expect(!(await b.flush()))
        #expect(b.isOff)
        b.log("info", "later")
        #expect(b.pending == 0)
    }

    @Test func offlineKeepsTheEventsForTheNextTry() async {
        let b = LogBatcher { _ in throw URLError(.notConnectedToInternet) }
        b.log("info", "a")
        #expect(!(await b.flush()))
        #expect(b.pending == 1)
    }

    @Test func pathsFoldTheirIds() {
        #expect(ClientLogs.foldPath(["api", "sessions", "ses_0abc12XYZ", "messages"]) == "/api/sessions/:id/messages")
        #expect(ClientLogs.foldPath(["api", "devices"]) == "/api/devices")
    }
}
