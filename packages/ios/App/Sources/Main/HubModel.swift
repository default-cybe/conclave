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
    /// What waits on you across sessions, for the Inbox.
    private(set) var approvals: [ApprovalRequest] = []
    private(set) var questions: [QuestionRequest] = []
    /// Bumps when a session under another changes (a subagent starts, runs, ends): the Tasks pane reads again.
    private(set) var childTick = 0
    /// Bumps on device.updated and device.deleted: the Devices page reads again.
    private(set) var deviceTick = 0
    /// The hub's model list, read when a picker first opens.
    private(set) var models: [ModelGroup] = []
    /// Who signs in with this token (GET /api/me), the hub's ui.name and its info: the account row.
    private(set) var me: Me?
    private(set) var uiName: String?
    private(set) var info: HubInfo?

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
            AppLogs.error("sessions.load", error)
            self.error = error.localizedDescription
        }
        loaded = true
        await loadAsks()
        await loadAccount()
    }

    /// The person, the hub's ui.name and version, for the account row and its menu.
    func loadAccount() async {
        async let m = try? client.me()
        async let u = try? client.uiName()
        async let i = try? client.info()
        let (me, ui, info) = await (m, u, i)
        if let me { self.me = me }
        if let ui { uiName = ui }
        if let info { self.info = info }
    }

    /// Settings > Defaults changed the person's own defaults.
    func setMe(_ m: Me) { me = m }

    func loadAsks() async {
        approvals = (try? await client.approvals()) ?? []
        questions = (try? await client.questions()) ?? []
        waiting = Set(approvals.map { Asks.home($0) } + questions.map { Asks.home($0) })
    }

    private func listen() async {
        var opened = false
        for await e in client.live(presence: true, transport: transport) {
            switch e {
            case .status(let s):
                if s != connection { ClientLogs.log(s == .closed ? "warn" : "info", "socket.\(s)") }
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
                ClientLogs.log("warn", "socket.rejected")
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
            if s.parentId != nil { childTick += 1 }
        case .sessionDeleted(let id):
            sessions.removeAll { $0.id == id }
        case .approvalRequested(let a):
            waiting.insert(Asks.home(a))
            if !approvals.contains(where: { $0.id == a.id }) { approvals.append(a) }
        case .questionAsked(let q):
            waiting.insert(Asks.home(q))
            if !questions.contains(where: { $0.id == q.id }) { questions.append(q) }
        case .other(let type) where type == "device.updated" || type == "device.deleted":
            deviceTick += 1
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

    /// An answer from the Inbox; the list is read again once the hub took it.
    func answer(_ a: ApprovalRequest, _ r: ApprovalResponse) async {
        do { try await client.resolveApproval(a.id, r) } catch { self.error = error.localizedDescription }
        await loadAsks()
    }

    func answer(_ q: QuestionRequest, _ answers: [String: String]) async {
        do { try await client.answerQuestion(q.id, answers) } catch { self.error = error.localizedDescription }
        await loadAsks()
    }

    func loadModels() async {
        guard models.isEmpty, let m = try? await client.models() else { return }
        models = m
    }

    /// A model or effort pick is the chat's default from now on (PATCH, as Android).
    func update(_ id: String, _ patch: SessionPatch) async {
        do {
            apply(.sessionUpdated(try await client.updateSession(id, patch)))
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// A new conversation of `mode`; its id to open. Each window keeps its own selection. The hub
    /// fills in the model: the person's default, else the agent's, else the hub's (engine createSession).
    /// Chat: a plain chat. Assistant: the assistant agent on the hub. Code and Security: the coder or
    /// security agent where the newest session of that mode ran, as the web's project group + and
    /// sessionSetup on a phone (the last computer used, its folder unless it was a repo's worktree).
    func newSession(_ mode: StartMode) async -> String? {
        let input: CreateSessionInput
        switch mode {
        case .chat: input = CreateSessionInput(mode: .chat, kind: .chat)
        case .assistant: input = CreateSessionInput(agent: StartMode.assistantAgent, device: "local")
        case .code, .security:
            let last = sessions.filter { StartMode.of($0) == mode && Panel.shown($0) }.max { $0.updatedAt < $1.updatedAt }
            let devices = (try? await client.devices()) ?? []
            let online = last.map { l in l.device == "local" || devices.contains { $0.id == l.device && $0.online } } ?? false
            let repo = last?.meta?["repo"] != nil
            let cwd = online && !repo && last?.cwd != "~" ? last?.cwd : nil
            input = CreateSessionInput(agent: mode == .security ? StartMode.securityAgent : StartMode.codeAgent,
                                       cwd: cwd?.isEmpty == false ? cwd : nil, device: online ? last?.device : "local")
        }
        do {
            let s = try await client.createSession(input)
            if !sessions.contains(where: { $0.id == s.id }) { sessions.append(s) }
            error = nil
            return s.id
        } catch {
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
            return nil
        }
    }
}
