import Foundation
import Testing
@testable import ConclaveKit

// Ports of the Kotlin LogicTest (Format), HomeTest (percent) and ReflectTest (ApiValue) for the
// Usage page, the web's windowLabel, and the memory and usage routes.
struct MemoryUsageTests {
    @Test func formatsReadAsOnAndroid() {
        #expect(UsageWords.countdown(0) == "now")
        #expect(UsageWords.countdown(45_000) == "45s")
        #expect(UsageWords.countdown(125_000) == "2m 05s")
        #expect(UsageWords.countdown((4 * 3600 + 12 * 60) * 1000) == "4h 12m")
        #expect(UsageWords.countdown((2 * 86_400 + 3 * 3600) * 1000) == "2d 3h")
        #expect(UsageWords.tokens(950) == "950")
        #expect(UsageWords.tokens(1234) == "1.2k")
        #expect(UsageWords.tokens(45_400) == "45k")
        #expect(UsageWords.tokens(3_400_000) == "3.4M")
        #expect(UsageWords.usd(0) == "$0")
        #expect(UsageWords.usd(1.5) == "$1.50")
        #expect(UsageWords.usd(1234) == "$1,234")
        #expect(UsageWords.usd(1_234_567) == "$1,234,567")
        #expect(UsageWords.usd(0.004) == "$0.0040")
        #expect(UsageWords.percent(0.82) == "82%")
    }

    @Test func aWindowsPercentAndReset() {
        #expect(UsageWords.used(LimitWindow(name: "5h", usedPercent: 12), blocked: true) == 100)
        #expect(UsageWords.used(LimitWindow(name: "tokens", remaining: 40, limit: 100)) == 60)
        #expect(UsageWords.used(LimitWindow(name: "5h")) == nil)
        #expect(UsageWords.used(LimitWindow(name: "5h", limit: 100)) == nil)
        #expect(UsageWords.used(LimitWindow(name: "5h", usedPercent: 0)) == 0)
        #expect(UsageWords.used(LimitWindow(name: "5h", usedPercent: 140)) == 100)
        #expect(UsageWords.level(42) == .normal && UsageWords.level(71) == .warn && UsageWords.level(90) == .fault)
        #expect(UsageWords.balance(LimitWindow(name: "credits", remaining: 40)) == "40 balance")
        let w = LimitWindow(name: "5h", usedPercent: 42, resetsAt: 10_000_000)
        #expect(UsageWords.reset(w, now: 10_000_000 - (2 * 3600 + 10 * 60) * 1000) == "resets in 2h 10m")
        #expect(UsageWords.reset(w, now: 10_000_001) == "reset")
        #expect(UsageWords.reset(LimitWindow(name: "5h"), now: 0) == nil)
    }

    @Test func windowLabelsReadAsTheWebs() {
        #expect(UsageWords.windowLabel("5h") == "5 hours")
        #expect(UsageWords.windowLabel("7d") == "Week")
        #expect(UsageWords.windowLabel("7d opus") == "Week, Opus")
        #expect(UsageWords.windowLabel("5h prompts") == "5 hours")
        #expect(UsageWords.windowLabel("requests / min") == "Requests per minute")
        #expect(UsageWords.windowLabel("tokens") == "Tokens")
        #expect(UsageWords.windowLabel(" ") == "")
    }

    @Test func plansNameTheirAccountAndSource() {
        let now: Int64 = 10_000_000
        let a = LimitState(provider: "anthropic", account: "claude-b", label: "Claude Max 20x", updatedAt: now - 5 * 60_000, source: "oauth")
        #expect(UsageWords.planName(a) == "Claude Max 20x · claude-b")
        #expect(UsageWords.planName(LimitState(provider: "anthropic", account: "claude-b", label: "Claude Max · claude-b")) == "Claude Max · claude-b")
        #expect(UsageWords.planName(LimitState(provider: "openai")) == "openai")
        #expect(UsageWords.source(a, now: now).text == "read from OAuth, updated 5m ago")
        let blocked = UsageWords.source(LimitState(provider: "x", updatedAt: now, blocked: true), now: now)
        #expect(blocked.text == "blocked, updated just now" && blocked.fault)
        #expect(UsageWords.source(LimitState(provider: "x", source: "error"), now: now).text == "not read")
        #expect(UsageWords.sorted([LimitState(provider: "openai", label: "ChatGPT Pro"), LimitState(provider: "anthropic", label: "Claude Max")]).map(\.provider) == ["openai", "anthropic"])
    }

    @Test func planUseIsWorthItsApiPrice() throws {
        let s = try decode(#"""
        {"from":0,"to":1,"totals":{"key":"total","costUsd":128.4,"apiValueUsd":340.15,"estimatedUsd":4,"calls":10},
         "byAccount":[{"key":"claude-a","costUsd":0,"apiValueUsd":95.6,"calls":3},{"key":"api-anthropic","costUsd":38.59,"apiValueUsd":38.59,"calls":5}],
         "savedUsd":211.75}
        """#, as: UsageSummary.self)
        #expect(ApiValue.savedSentence(s.totals) == "Your plans saved you about $212 this month")
        #expect(ApiValue.savedDetail(s.totals).hasPrefix("Worth $340 at API prices, billed $128."))
        #expect(ApiValue.billedLine(s.byAccount[0].costUsd, s.byAccount[0].apiValueUsd) == "Billed $0, worth $95.60 at API prices")
        #expect(ApiValue.billedLine(s.byAccount[1].costUsd, s.byAccount[1].apiValueUsd) == "Billed $38.59")
        #expect(ApiValue.savedSentence(UsageBucket(costUsd: 5)) == nil)
        #expect(s.savedUsd == 211.75)
        #expect(UsageWords.tiles(s).map(\.label) == ["Billed", "At API prices", "Calls", "Input tokens", "Output tokens", "Cache hit rate", "Saved by cache"])
        #expect(UsageWords.tiles(UsageSummary()).first?.label == "Cost")
    }

    @Test func memoryWords() throws {
        let m = try decode(#"{"id":"m1","kind":"brand-new","scope":"project","scopeKey":"conclave","content":"x","tags":["a"],"updatedAt":0,"useCount":1}"#, as: MemoryEntry.self)
        #expect(m.kind == .fact)
        #expect(MemoryWords.scope(m) == "project: conclave")
        #expect(MemoryWords.meta(m, now: 5) == "used once")
        let n = MemoryEntry(id: "m2", updatedAt: 0, useCount: 4)
        #expect(MemoryWords.meta(MemoryEntry(id: "m2", updatedAt: 1, useCount: 4), now: 1 + 3 * 3_600_000) == "updated 3h ago, used 4 times")
        #expect(MemoryWords.scope(n) == "global")
        #expect(MemoryWords.tags(" pnpm, ,tools ,") == ["pnpm", "tools"])
        #expect(MemoryKind.procedure.label == "Procedure")
    }

    @Test func memoryRoutesAndBodies() async throws {
        let hub = MockHub()
        hub.enqueue(#"[{"id":"m1","content":"The owner prefers pnpm","kind":"profile","tags":["tools"],"updatedAt":5}]"#)
        let list = try await hub.client().memories(kind: .profile)
        #expect(list.first?.kind == .profile)
        var req = try #require(hub.take())
        #expect(req.path == "/api/memory")
        #expect(req.query("kind") == "profile")
        #expect(req.query("limit") == "200")

        hub.enqueue("[]")
        _ = try await hub.client().searchMemory("pnpm & yarn")
        req = try #require(hub.take())
        #expect(req.path == "/api/memory/search")
        #expect(req.query("q") == "pnpm & yarn")
        #expect(req.query("limit") == "50")

        hub.enqueue(#"{"id":"m2","content":"Hub runs on Proxmox","kind":"fact"}"#)
        let saved = try await hub.client().saveMemory(MemoryInput(content: "Hub runs on Proxmox", kind: .fact, tags: []))
        #expect(saved.id == "m2")
        req = try #require(hub.take())
        #expect(req.method == "POST")
        #expect(req.json == ["content": "Hub runs on Proxmox", "kind": "fact", "tags": []])

        hub.enqueue(#"{"id":"m2","content":"Hub runs on Proxmox CT conclave"}"#)
        _ = try await hub.client().updateMemory("m2", MemoryInput(content: "Hub runs on Proxmox CT conclave"))
        req = try #require(hub.take())
        #expect(req.method == "PATCH")
        #expect(req.path == "/api/memory/m2")
        #expect(req.json == ["content": "Hub runs on Proxmox CT conclave"])

        hub.enqueue(#"{"ok":true}"#)
        try await hub.client().deleteMemory("m2")
        req = try #require(hub.take())
        #expect(req.method == "DELETE")
        #expect(req.path == "/api/memory/m2")
    }

    @Test func usageAndLimitRoutes() async throws {
        let hub = MockHub()
        hub.enqueue(#"{"totals":{"costUsd":1,"calls":"bad"},"byDay":[{"key":"2026-11-27","costUsd":1}]}"#)
        let s = try await hub.client().usage(from: 10, to: 20, tzOffset: -60)
        #expect(s.totals.costUsd == 1)
        #expect(s.totals.calls == 0)
        #expect(UsageWords.shortDay(s.byDay[0].key) == "11-27")
        var req = try #require(hub.take())
        #expect(req.path == "/api/usage")
        #expect(req.query("from") == "10" && req.query("to") == "20" && req.query("tzOffset") == "-60")

        hub.enqueue(#"[{"provider":"anthropic","label":"Claude Max","windows":[{"name":"5h","usedPercent":42,"resetsAt":9}],"source":"oauth"},{"provider":"openai"}]"#)
        let limits = try await hub.client().limits()
        #expect(limits.map(\.key) == ["anthropic", "openai"])
        #expect(limits[0].windows.first?.usedPercent == 42)
        #expect(try #require(hub.take()).path == "/api/limits")

        hub.enqueue("[]")
        _ = try await hub.client().refreshLimits()
        req = try #require(hub.take())
        #expect(req.method == "POST")
        #expect(req.path == "/api/limits/refresh")
    }
}
