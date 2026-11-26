import Foundation
import Testing
@testable import ConclaveKit

// Port of packages/android/client DrawerTest.kt, the cases for Group by project and time. Device
// grouping, the project list and the account row come with their pages.

private let utc = TimeZone(identifier: "UTC")!

private func at(_ day: Int, _ h: Int) -> Int64 {
    var c = DateComponents(year: 2026, month: 10, day: day, hour: h)
    c.timeZone = utc
    return Int64(Calendar(identifier: .gregorian).date(from: c)!.timeIntervalSince1970 * 1000)
}

private let now = at(22, 18)

private func chat(_ id: String, _ updated: Int64, title: String? = nil) -> Session {
    Session(id: id, title: title ?? id, kind: .chat, updatedAt: updated)
}

private func code(_ id: String, _ updated: Int64, cwd: String? = nil, projectId: String? = nil, status: SessionStatus = .idle) -> Session {
    var s = Session(id: id, title: id, status: status, updatedAt: updated)
    s.agent = "coder"
    s.device = "mac"
    s.cwd = cwd ?? "/Users/sam/\(id)"
    s.projectId = projectId
    return s
}

private func ids(_ g: [DrawerGroup]) -> [String] { g.flatMap { $0.items.map(\.id) } }

struct DrawerTests {
    @Test func groupByIsStoredByItsWireWordAndProjectIsTheDefault() {
        #expect(GroupBy.from("time") == .time)
        #expect(GroupBy.from(nil) == .project)
        #expect(GroupBy.from("agent") == .project)
    }

    @Test func timeGroupsAreTodayYesterdayThisWeekAndOlder() {
        let t = { (ts: Int64) in Drawer.timeGroup(ts, now: now, zone: utc).1 }
        #expect(t(at(22, 1)) == "Today")
        #expect(t(at(21, 23)) == "Yesterday")
        #expect(t(at(20, 12)) == "This week")
        #expect(t(at(16, 12)) == "This week")
        #expect(t(at(15, 12)) == "Older")
        #expect(t(at(1, 12)) == "Older")
        // a clock a little ahead on another device is still today
        #expect(t(at(22, 19)) == "Today")
    }

    @Test func byTimeTheGroupsComeInOrderWithTheNewestFirstInEach() {
        let sessions = [chat("a", at(22, 9)), chat("b", at(22, 11)), chat("c", at(21, 9)), chat("d", at(18, 9)), chat("e", at(2, 9))]
        let groups = Drawer.groups(sessions, mode: .chat, by: .time, now: now, zone: utc)
        #expect(groups.map(\.title) == ["Today", "Yesterday", "This week", "Older"])
        #expect(groups[0].items.map(\.id) == ["b", "a"])
    }

    @Test func onlyTheModesConversationsAreListedAndNotTheArchiveSubagentsOrWorkflowAgents() {
        var archived = chat("archived", at(22, 10))
        archived.archived = true
        var sub = code("sub", at(22, 12))
        sub.parentId = "code"
        var wf = code("wf", at(22, 13))
        wf.meta = ["workflow": ["runId": "run-1"]]
        var assistant = Session(id: "assistant", title: "Plan", updatedAt: at(22, 14))
        assistant.agent = StartMode.assistantAgent
        let sessions = [chat("chat", at(22, 9)), archived, code("code", at(22, 11)), sub, wf, assistant]
        let of = { (m: StartMode?) in ids(Drawer.groups(sessions, mode: m, by: .time, now: now, zone: utc)) }
        #expect(of(.chat) == ["chat"])
        #expect(of(.code) == ["code"])
        #expect(of(.assistant) == ["assistant"])
        #expect(of(nil) == ["assistant", "code", "chat"])
    }

    @Test func pinnedComeFirstWhateverTheGrouping() {
        var pinned = code("pinned", at(10, 9), cwd: "/Users/sam/src/conclave")
        pinned.pinned = true
        let sessions = [pinned, code("today", at(22, 9), cwd: "/Users/sam/src/conclave")]
        for by in GroupBy.allCases {
            let groups = Drawer.groups(sessions, mode: .code, by: by, now: now, zone: utc)
            #expect(groups.first?.title == "Pinned")
            #expect(groups.first?.items.map(\.id) == ["pinned"])
            #expect(ids(Array(groups.dropFirst())) == ["today"])
        }
    }

    @Test func byProjectFoldersGroupAndChatsAndNoFolderGoLast() {
        let sessions = [
            chat("chat", at(22, 12)),
            code("code", at(22, 9), cwd: "/Users/sam/src/conclave/"),
            code("loose", at(22, 10), cwd: ""),
            code("other", at(22, 8), cwd: "/Users/sam/src/notes"),
            code("other-too", at(21, 8), cwd: "/srv/Notes"),
            code("home", at(22, 11), cwd: "~"),
        ]
        let groups = Drawer.groups(sessions, by: .project, now: now, zone: utc)
        #expect(groups.map(\.title) == ["conclave", "notes", "No project", "Chats"])
        // a folder of the same name elsewhere keeps them together
        #expect(groups[1].items.map(\.id) == ["other", "other-too"])
        #expect(groups[2].items.map(\.id) == ["home", "loose"])
        // the project id is known but not the project: its folder names the group, under the project's key
        #expect(Drawer.projectGroup(code("w", 1, cwd: "/Users/sam/site/", projectId: "p9")) == ("p:p9", "site"))
        // a Windows folder
        #expect(Drawer.projectGroup(code("v", 1, cwd: "C:\\Users\\sam\\Game")) == ("f:game", "Game"))
    }

    @Test func searchKeepsWhatMatchesInItsGroups() {
        let sessions = [
            chat("plan", at(22, 9), title: "Plan the week"),
            chat("trip", at(22, 8), title: "Trip to Lisbon"),
            code("fix", at(22, 10), cwd: "/Users/sam/src/conclave", projectId: "p1"),
            code("notes", at(21, 10), cwd: "/srv/notes"),
        ]
        let find = { (m: StartMode?, by: GroupBy, q: String) in ids(Drawer.groups(sessions, mode: m, by: by, query: q, now: now, zone: utc)) }
        #expect(find(.chat, .time, " PLAN ") == ["plan"])
        #expect(find(.chat, .time, "") == ["plan", "trip"])
        #expect(find(.chat, .time, "conclave").isEmpty)
        // a session by its folder, its agent, or the project it is grouped under
        #expect(find(.code, .time, "notes") == ["notes"])
        #expect(find(.code, .time, "coder") == ["fix", "notes"])
        #expect(find(.code, .project, "conclave") == ["fix"])
    }

    @Test func rowsCarryTheirTitleAndDot() {
        var blank = Session(id: "blank", updatedAt: at(22, 7))
        blank.cwd = "/Users/sam/x"
        let sessions = [code("run", at(22, 9), status: .running), code("ask", at(22, 8)), blank]
        let items = Drawer.groups(sessions, mode: .code, by: .time, waiting: ["ask"], now: now, zone: utc)[0].items
        #expect(items.map(\.dot) == [.running, .waiting, .none])
        #expect(items[2].title == "New session")
    }
}
