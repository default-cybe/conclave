import Foundation
import Testing
@testable import ConclaveKit

// Settings > Providers and Subscriptions (Android ProvidersTest): rows, words and routes.
struct ProvidersTests {
    @Test func keyedRowsAndAddable() throws {
        let secrets = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"providers":["zai","anthropic","cliproxy"],"keyed":["my-proxy"]}"#.utf8))
        let keys = Providers.withKeys(secrets)
        #expect(keys == ["zai", "anthropic", "cliproxy", "my-proxy"])
        // catalog order, then custom ones; cliproxy lives on Subscriptions
        #expect(Providers.keyedRows(keys) == ["anthropic", "zai", "my-proxy"])
        #expect(!Providers.addable(Providers.keyedRows(keys)).contains { $0.id == "anthropic" })
        #expect(Providers.placeholder("openrouter") == "Paste a key that starts with sk-or-")
        #expect(Providers.placeholder("mistral") == "Paste a key")
    }

    @Test func testWords() {
        let works = Providers.testWords(ProviderTestResult(ok: true, detail: "Found 7 models", latencyMs: 212))
        #expect(works.0 == "Works, 7 models, 212 ms" && works.1)
        let rejected = Providers.testWords(ProviderTestResult(ok: false, detail: "HTTP 401 Unauthorized"))
        #expect(rejected.0 == "Rejected, 401" && !rejected.1)
        #expect(Providers.testWords(ProviderTestResult(ok: false, detail: "No key set")).0 == "Not set")
    }

    @Test func subscriptionWords() {
        let claude = SubscriptionProvider(id: "claude", name: "Claude")
        let qwen = SubscriptionProvider(id: "qwen", name: "Qwen", more: true)
        var s = SubscriptionsStatus(mode: "off", providers: [claude, qwen])
        #expect(Providers.who(s, claude) == "Not signed in")
        #expect(Providers.action(s, claude) == "Sign in")
        #expect(Providers.usable(s) && Providers.needsStart(s))
        #expect(Providers.rows(s, more: false).map(\.id) == ["claude"])
        #expect(Providers.statusLine(s).0 == "Off.")
        s = SubscriptionsStatus(mode: "builtin", state: "on", management: true, providers: [claude, qwen],
                                accounts: [SubscriptionAccount(name: "a", provider: "claude", label: "kai"), SubscriptionAccount(name: "b", provider: "claude")])
        #expect(Providers.who(s, claude) == "2 accounts")
        #expect(Providers.action(s, claude) == "Add account")
        #expect(!Providers.needsStart(s))
        #expect(Providers.statusLine(s).1 == "2 accounts are signed in.")
        #expect(Providers.accountLabel(s.accounts[1]) == "claude")
        #expect(Providers.accountWord("unavailable").0 == "Limited")
        #expect(Providers.needsPaste(SignInStart(state: "x", url: "u", flow: "redirect", caught: false)))
        #expect(!Providers.needsPaste(SignInStart(state: "x", url: "u", flow: "device")))
    }

    @Test func signedInLines() throws {
        let now: Int64 = 10_000_000_000
        let list = try JSONDecoder().decode([SignedInApp].self, from: Data(#"[{"id":"a","name":"Pixel","platform":"android","createdAt":1,"online":true},{"id":"b","platform":"linux","createdAt":1,"lastSeenAt":9989200000},{"id":"c","platform":"zz","createdAt":1}]"#.utf8))
        #expect(list[0].line(now: now) == "Android, online")
        #expect(list[1].line(now: now) == "Terminal on Linux, last seen 3h ago")
        #expect(list[2].line(now: now) == "App, not seen yet")
        #expect(SignedInApp(id: "d", lastSeenAt: now - 5_000).line(now: now) == "App, last seen just now")
    }

    @Test func secretNamesAndRoutes() async throws {
        #expect(SecretWords.nameError("", taken: []) == nil)
        #expect(SecretWords.nameError("github-token", taken: []) == nil)
        #expect(SecretWords.nameError("GitHub", taken: []) != nil)
        #expect(SecretWords.nameError("a b", taken: []) != nil)
        #expect(SecretWords.nameError("constructor", taken: []) != nil)
        #expect(SecretWords.nameError("x", taken: ["x"]) == "x exists. Use Replace on its row.")
        #expect(SecretWords.meta(SecretInfo(name: "t", prefix: "ghp_", setAt: 0), now: 3 * 86_400_000) == "ghp_…, set 3d ago")
        let hub = MockHub()
        let c = hub.client()
        hub.enqueue(#"{"ok":true}"#)
        try await c.setSecret("gh", "v", member: false)
        #expect(hub.take()?.json == .object(["kind": .string("values"), "key": .string("gh"), "value": .string("v")]))
        hub.enqueue(#"{"ok":true}"#)
        try await c.setSecret("gh", nil, member: true)
        let r = try #require(hub.take())
        #expect(r.path == "/api/me/secrets" && r.json == .object(["key": .string("gh"), "value": .null]))
    }

    @Test func accountOrders() throws {
        let s = try JSONDecoder().decode(AccountsStatus.self, from: Data(#"{"management":true,"accounts":[{"id":"a","vendor":"anthropic","vendorName":"Claude","state":"limited","enabled":true},{"id":"b","vendor":"anthropic","state":"ready"},{"id":"c","vendor":"anthropic","state":"ready"},{"id":"z","vendor":"zai","state":"cooldown"}],"routes":[{"vendor":"anthropic","vendorName":"Claude","order":["b","a"]},{"vendor":"anthropic","match":"claude-opus-*","order":["a"]}]}"#.utf8))
        let g = AccountWords.vendorOrders(s)
        // per-model routes are not vendor rows; an account the order leaves out goes last
        #expect(g.count == 1 && g[0].1.map(\.id) == ["b", "a", "c"])
        #expect(AccountWords.moved(["b", "a", "c"], "a", by: -1) == ["a", "b", "c"])
        #expect(AccountWords.moved(["b", "a", "c"], "b", by: -1) == ["b", "a", "c"])
        #expect(AccountWords.state("limited").0 == "At its limit")
        #expect(AccountWords.state("unknown").0 == "Ready")
    }

    @Test func peopleWordsAndAdd() async throws {
        let now: Int64 = 1_000_000_000_000
        let list = try JSONDecoder().decode([Person].self, from: Data(#"[{"id":"m1","name":"sam","displayName":"Sam Lee","role":"member","passwordSet":true,"providers":{"anthropic":{"monthlyUsd":10},"zai":{}},"spend":[{"provider":"anthropic","name":"Anthropic","monthlyUsd":10,"spentUsd":3.2}]},{"id":"m2","name":"ria","inviteExpiresAt":1000518400000}]"#.utf8))
        #expect(list[0].shownName == "Sam Lee" && list[0].providers["anthropic"] == .some(10) && list[0].providers["zai"] == .some(nil))
        #expect(PeopleWords.spend(list[0]) == ["$3.20 of $10.00 this month on Anthropic"])
        #expect(PeopleWords.signIn(list[0], now: now) == "Password set")
        #expect(PeopleWords.signIn(list[1], now: now) == "Invite waits, 6d left")
        #expect(PeopleWords.nameOK("sam.lee") && !PeopleWords.nameOK("Sam Lee"))
        #expect(!PeopleWords.passwordOK("short") && PeopleWords.passwordOK("twelve chars"))
        let hub = MockHub()
        let c = hub.client()
        hub.enqueue(#"{"person":{"id":"m3","name":"jo"},"invite":{"url":"https://hub/invite/x","secret":"x","expiresAt":9}}"#)
        let r = try await c.addPerson(name: "jo", displayName: "", email: nil, password: nil)
        #expect(r.invite?.url == "https://hub/invite/x")
        #expect(hub.take()?.json == .object(["name": .string("jo"), "invite": .bool(true)]))
    }

    @Test func routes() async throws {
        let hub = MockHub()
        let c = hub.client()
        hub.enqueue(#"{"ok":true}"#)
        try await c.setProviderKey("zai", nil)
        let put = try #require(hub.take())
        #expect(put.method == "PUT" && put.path == "/api/secrets")
        #expect(put.json == .object(["kind": .string("providers"), "key": .string("zai"), "value": .null]))
        hub.enqueue(#"{"state":"st1","provider":"claude","url":"https://claude.ai/oauth","caught":false,"callbackHost":"localhost:54545"}"#)
        let f = try await c.startSignIn("claude")
        #expect(f.state == "st1" && f.flow == "redirect" && f.callbackHost == "localhost:54545")
        #expect(hub.take()?.path == "/api/subscriptions/signin")
        hub.enqueue(#"{"state":"st1","status":"ok"}"#)
        #expect(try await c.finishSignIn("st1", url: "http://localhost:54545/callback?code=1").status == "ok")
        #expect(hub.take()?.path == "/api/subscriptions/signin/st1/callback")
    }
}
