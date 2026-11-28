import Foundation
import Testing
@testable import ConclaveKit

// The hub settings rows (PATCH /api/config with one nested value; web patchAt and LimitInput).
struct ConfigPathTests {
    @Test func patchNestsAndValueReads() throws {
        #expect(ConfigPath.patch("limits.stuck.minutes", .number(7)) == .object(["limits": .object(["stuck": .object(["minutes": .number(7)])])]))
        #expect(ConfigPath.patch("cache.ttl", .null) == .object(["cache": .object(["ttl": .null])]))
        let c = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"limits":{"stuck":{"minutes":5}},"cache":{"ttl":"1h"}}"#.utf8))
        #expect(ConfigPath.value(c, "limits.stuck.minutes")?.number == 5)
        #expect(ConfigPath.value(c, "cache.ttl")?.string == "1h")
        #expect(ConfigPath.value(c, "limits.nope.x") == nil)
        #expect(ConfigPath.value(nil, "a") == nil)
    }

    @Test func numberBoxRule() {
        #expect(ConfigPath.number("") == 0)
        #expect(ConfigPath.number(" 1,000,000 ") == 1_000_000)
        #expect(ConfigPath.number("2.5") == nil)
        #expect(ConfigPath.number("2.5", fraction: true) == 2.5)
        #expect(ConfigPath.number("-1") == nil)
        #expect(ConfigPath.number("lots") == nil)
    }

    /// Move to Code's PATCH (Android continueAsSession): kind agent, the place, the mode, the kept title.
    @Test func moveToCodePatch() {
        let p = SessionPlacePatch(agent: "coder", device: "local", cwd: "~", kind: .agent, permissionMode: .acceptEdits, title: "Plan")
        #expect(p.json == ["agent": .string("coder"), "device": .string("local"), "cwd": .string("~"), "kind": .string("agent"), "permissionMode": .string("acceptEdits"), "title": .string("Plan")])
        #expect(SessionPlacePatch(agent: "coder").json == ["agent": .string("coder")])
    }

    @Test func configReadsInsideTheWrapper() async throws {
        let hub = MockHub()
        let c = hub.client()
        hub.enqueue(#"{"config":{"limits":{"maxSteps":250}},"user":{},"secrets":{}}"#)
        let cfg = try await c.hubConfig()
        #expect(ConfigPath.value(cfg, "limits.maxSteps")?.number == 250)
        hub.enqueue(#"{"ok":true}"#)
        _ = hub.take()
        try await c.patchConfig(ConfigPath.patch("limits.maxSteps", .number(300)))
        let r = try #require(hub.take())
        #expect(r.method == "PATCH" && r.path == "/api/config")
        #expect(r.json == .object(["limits": .object(["maxSteps": .number(300)])]))
    }
}
