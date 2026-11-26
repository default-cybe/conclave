import Foundation
import Testing
@testable import Conclave

private final class MemoryStore: PairingStore, @unchecked Sendable {
    var saved: SavedPairing?
    func load() -> SavedPairing? { saved }
    func save(_ p: SavedPairing?) { saved = p }
}

@MainActor
struct AppModelTests {
    @Test func aPairLinkFillsTheForm() throws {
        let m = AppModel(store: MemoryStore())
        m.open(URL(string: "conclave://pair?url=https%3A%2F%2Fhub.example.com&code=482913&fp=21FE31DFA154A261626BF854046FD227&alt=http%3A%2F%2F192.168.1.2%3A7777")!)
        #expect(m.address == "https://hub.example.com")
        #expect(m.code == "482913")
        #expect(m.alts == ["http://192.168.1.2:7777"])
        #expect(m.fingerprint == "21fe31dfa154a261626bf854046fd227")
        #expect(m.canPair)
    }

    @Test func startsPairedWhenTheStoreHasAHub() {
        let store = MemoryStore()
        store.saved = SavedPairing(addresses: ["https://hub.example.com"], token: "t", hubName: "home")
        let m = AppModel(store: store)
        #expect(m.pairing?.hubName == "home")
        m.forget()
        #expect(m.pairing == nil)
        #expect(store.saved == nil)
    }

    @Test func noAddressNoConnect() {
        let m = AppModel(store: MemoryStore())
        m.code = "1"
        #expect(!m.canPair)
    }
}
