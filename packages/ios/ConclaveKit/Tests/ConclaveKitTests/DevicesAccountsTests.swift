import Foundation
import Testing
@testable import ConclaveKit

// Renaming and removing a device (server routes.ts PATCH and DELETE /api/devices/:id), and the
// account list's pure rules (Logic/Accounts.swift). Android has no account switching to port.

struct DevicesAccountsTests {
    @Test func renameSendsTheNameAndReadsTheDevice() async throws {
        let hub = MockHub()
        hub.enqueue(#"{"id":"mac-1","name":"Studio","online":true,"roots":[],"createdAt":1}"#)
        let d = try await hub.client().updateDevice("mac-1", name: "Studio")
        #expect(d.id == "mac-1")
        #expect(d.name == "Studio")
        let req = try #require(hub.take())
        #expect(req.method == "PATCH")
        #expect(req.path == "/api/devices/mac-1")
        #expect(req.json == ["name": "Studio"])
        #expect(req.headers["Authorization"] == "Bearer secret-token")
    }

    @Test func removeDeletesTheDevice() async throws {
        let hub = MockHub()
        hub.enqueue(#"{"ok":true}"#)
        try await hub.client().deleteDevice("mac-1")
        let req = try #require(hub.take())
        #expect(req.method == "DELETE")
        #expect(req.path == "/api/devices/mac-1")
    }

    @Test func aRefusedRemoveThrowsTheHubsWords() async throws {
        let hub = MockHub()
        hub.enqueue(#"{"error":"the hub device cannot be removed"}"#, status: 400)
        await #expect(throws: ConclaveAPIError.self) { try await hub.client().deleteDevice("local") }
    }

    @Test func removingPicksTheNextAccount() {
        // the one in use goes: the next takes its place, or the one before when it was last
        #expect(Accounts.activeAfterRemoving(1, active: 1, count: 3) == 1)
        #expect(Accounts.activeAfterRemoving(2, active: 2, count: 3) == 1)
        #expect(Accounts.activeAfterRemoving(0, active: 0, count: 2) == 0)
        // another goes: the one in use stays, its index moves when it was after
        #expect(Accounts.activeAfterRemoving(0, active: 2, count: 3) == 1)
        #expect(Accounts.activeAfterRemoving(2, active: 0, count: 3) == 0)
        // the last one: none left, Connect shows
        #expect(Accounts.activeAfterRemoving(0, active: 0, count: 1) == nil)
    }

    @Test func theSamePersonOnTheSameHubIsOneAccount() {
        let owner = SignInKey(addresses: ["https://hub.example.com", "http://192.168.1.2:7777"], publicKey: "k1", account: "owner", token: "t1")
        // paired again: a new token and another address order, same key and person
        #expect(Accounts.same(owner, SignInKey(addresses: ["http://192.168.1.2:7777"], publicKey: "k1", account: "owner", token: "t2")))
        // another person on the same hub
        #expect(!Accounts.same(owner, SignInKey(addresses: owner.addresses, publicKey: "k1", account: "sam", token: "t3")))
        // another hub with the same address (a reinstall): the key decides
        #expect(!Accounts.same(owner, SignInKey(addresses: owner.addresses, publicKey: "k2", account: "owner", token: "t4")))
        // no key on one side: a shared address is the same hub
        #expect(Accounts.same(owner, SignInKey(addresses: ["https://hub.example.com"], publicKey: nil, account: "owner", token: "t5")))
        // a pairing from before accounts: only the same token is the same sign in
        let old = SignInKey(addresses: ["https://hub.example.com"], publicKey: nil, account: nil, token: "t1")
        #expect(Accounts.same(old, owner))
        #expect(!Accounts.same(old, SignInKey(addresses: ["https://hub.example.com"], publicKey: nil, account: "owner", token: "t9")))
    }
}
