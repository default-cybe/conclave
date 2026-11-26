import ConclaveKit
import Foundation
import Observation

/// One paired hub: its sessions, the live socket and the open chats (Android HubRepository, trimmed
/// to what reading needs). The socket runs while the app is on screen and tells the hub so (presence).
@MainActor @Observable
final class HubModel {
    let client: ConclaveClient
    private(set) var sessions: [Session] = []
    private(set) var connection: ConnectionState = .connecting
    private(set) var loaded = false
    private(set) var error: String?
    /// Sessions an open approval or question shows in: their row gets the waiting dot.
    private(set) var waiting: Set<String> = []

    private let transport: any LiveTransport
    private var chats: [String: ChatModel] = [:]
    private var live: Task<Void, Never>?

    init(client: ConclaveClient, transport: any LiveTransport) {
        self.client = client
        self.transport = transport
    }

    func start() {
        guard live == nil else { return }
        live = Task { [weak self] in
            await self?.load()
            await self?.listen()
        }
    }

    func stop() {
        live?.cancel()
        live = nil
    }

    func load() async {
        do {
            sessions = try await client.topLevelSessions(archived: false)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
        await loadAsks()
    }

    private func loadAsks() async {
        let approvals = (try? await client.approvals()) ?? []
        let questions = (try? await client.questions()) ?? []
        waiting = Set(approvals.map { Asks.home($0) } + questions.map { Asks.home($0) })
    }

    private func listen() async {
        var opened = false
        for await e in client.live(presence: true, transport: transport) {
            switch e {
            case .status(let s):
                connection = s
                // a reconnect: what came while the socket was down
                if s == .open, opened { for c in chats.values { await c.catchUp() } }
                if s == .open { opened = true }
            case .resync:
                await load()
                for c in chats.values { await c.reload() }
            case .event(let env):
                apply(env.event)
            case .rejected:
                connection = .closed
            case .hello, .notYourHub:
                // not your hub reaches AppModel through the identity guard
                break
            }
        }
    }

    func apply(_ e: EngineEvent) {
        switch e {
        case .sessionCreated(let s), .sessionUpdated(let s):
            if let i = sessions.firstIndex(where: { $0.id == s.id }) { sessions[i] = s } else if s.parentId == nil { sessions.append(s) }
        case .sessionDeleted(let id):
            sessions.removeAll { $0.id == id }
        case .approvalRequested(let a):
            waiting.insert(Asks.home(a))
        case .questionAsked(let q):
            waiting.insert(Asks.home(q))
        case .approvalResolved, .questionAnswered:
            // the event names the one that asked, not where it showed: read the list again
            Task { await loadAsks() }
        default:
            break
        }
        for c in chats.values { c.apply(e) }
    }

    func chat(_ id: String) -> ChatModel {
        if let c = chats[id] { return c }
        let c = ChatModel(sessionId: id, client: client)
        chats[id] = c
        return c
    }

    func session(_ id: String) -> Session? { sessions.first { $0.id == id } }

    /// A new chat; its id to open. Each window keeps its own selection.
    func newChat() async -> String? {
        do {
            let s = try await client.createSession(CreateSessionInput(mode: .chat, kind: .chat))
            if !sessions.contains(where: { $0.id == s.id }) { sessions.append(s) }
            return s.id
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }
}
