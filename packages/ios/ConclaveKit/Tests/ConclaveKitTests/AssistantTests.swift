import Foundation
import Testing
@testable import ConclaveKit

// Today, routines and the schedule editor: GET /api/assistant/today and /api/routines decode with
// defaults, and every editor choice round-trips through the line the hub reads (routes.ts preview).
struct AssistantTests {
    @Test func todayDecodesThePlanTasksAndNoCalendar() throws {
        let json = #"{"date":"2026-11-28","timezone":"America/Los_Angeles","plan":{"summary":"Deep work","items":[{"time":"09:00","text":"Write","kind":"focus"},{"text":"Gym"}]},"tasks":{"dueToday":2,"overdue":1}}"#
        let t = try JSONDecoder().decode(Today.self, from: Data(json.utf8))
        #expect(t.plan?.items.count == 2)
        #expect(t.plan?.items[1].time == nil)
        #expect(t.dueToday == 2 && t.overdue == 1)
        #expect(t.events == nil)
    }

    @Test func routinesDecodeWithDefaults() throws {
        let r = try JSONDecoder().decode([Routine].self, from: Data(#"[{"id":"r1","name":"Brief","schedule":"30 7 * * 1-5"}]"#.utf8))
        #expect(r[0].enabled)
        #expect(r[0].nextRunAt == nil)
    }

    @Test func eachScheduleChoiceMakesTheHubsLine() {
        #expect(Schedules.expr(.daily, hour: 3, minute: 0) == "0 3 * * *")
        #expect(Schedules.expr(.weekdays, hour: 7, minute: 30) == "30 7 * * 1-5")
        #expect(Schedules.expr(.weekly, hour: 20, minute: 0, weekday: 0) == "0 20 * * 0")
        #expect(Schedules.expr(.every, hour: 0, minute: 0, every: 30) == "@every 30m")
        #expect(Schedules.expr(.every, hour: 0, minute: 0, every: 120) == "@every 2h")
        #expect(Schedules.expr(.once, hour: 9, minute: 5, date: "2026-12-01") == "@once 2026-12-01T09:05")
        #expect(Schedules.expr(.custom, hour: 0, minute: 0, custom: " */15  * * * * ") == "*/15 * * * *")
    }

    @Test func aSavedScheduleOpensInItsChoice() {
        #expect(Schedules.parse("30 7 * * 1-5").kind == .weekdays)
        #expect(Schedules.parse("0 20 * * 0").weekday == 0)
        #expect(Schedules.parse("@every 2h").every == 120)
        let once = Schedules.parse("@once 2026-12-01T09:05")
        #expect(once.kind == .once && once.date == "2026-12-01" && once.hour == 9 && once.minute == 5)
        #expect(Schedules.parse("*/15 * * * *").kind == .custom)
        #expect(Schedules.parse("0 9 1 * *").kind == .custom)
    }
}
