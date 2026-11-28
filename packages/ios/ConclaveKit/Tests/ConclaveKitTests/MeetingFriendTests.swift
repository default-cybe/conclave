import Foundation
import Testing
@testable import ConclaveKit

// Meetings sections and words (Android logic/Meetings.kt) and Friends order and words.
struct MeetingFriendTests {
    let now: Int64 = 1_000_000_000_000

    @Test func sections() throws {
        let list = try JSONDecoder().decode([Meeting].self, from: Data(#"""
        [{"id":"a","status":"ready","scheduledAt":1000000600000,"durationMin":30},
         {"id":"b","status":"scheduled","scheduledAt":1000090000000},
         {"id":"c","status":"ended","startedAt":999000000000},
         {"id":"d","status":"scheduled","scheduledAt":999900000000,"durationMin":30},
         {"id":"e","status":"live","startedAt":999999000000},
         {"id":"f","status":"brand-new"}]
        """#.utf8))
        let s = MeetingWords.sections(list, now: now)
        // ready in 10 minutes is Now; scheduled tomorrow is Upcoming; d ended more than 3 h ago, never held: Past, newest first
        #expect(Set(s.now.map(\.id)) == ["a", "e", "f"])
        #expect(s.upcoming.map(\.id) == ["b"])
        #expect(s.past.map(\.id) == ["d", "c"])
        #expect(MeetingWords.status(list[3], now: now).0 == "Not held")
        #expect(MeetingWords.status(list[4], now: now).0 == "Listening")
    }

    @Test func countdownAndPrep() {
        let utc = TimeZone(identifier: "UTC")!
        #expect(MeetingWords.countdown(3 * 86_400_000, start: 0, zone: utc) == "in 3 days")
        #expect(MeetingWords.countdown(2 * 3_600_000 + 5 * 60_000, start: 0, zone: utc) == "in 2h 05m")
        #expect(MeetingWords.countdown(249_000, start: 0, zone: utc) == "in 4:09")
        #expect(MeetingWords.countdown(-60_000, start: 0, zone: utc) == "now")
        #expect(MeetingWords.countdown(-2 * 3_600_000, start: 0, zone: utc) == "started 2h ago")
        var m = Meeting(id: "x")
        m.prepState = "running"
        m.prepProgress = PrepProgress(phase: "map", done: 34, total: 120)
        #expect(MeetingWords.prep(m).0 == "Preparing 34/120")
        m.prepState = "none"
        #expect(MeetingWords.prep(m).0 == "Not prepared")
        #expect(MeetingWords.folderName("/home/me/capstone/") == "capstone")
    }

    @Test func friends() throws {
        let list = try JSONDecoder().decode([Friend].self, from: Data(#"""
        [{"id":"1","name":"Zed","status":"active","verified":true},
         {"id":"2","name":"Amy","status":"pending","direction":"in"},
         {"id":"3","name":"Bob","status":"removed"},
         {"id":"4","name":"Cal","status":"active","lastError":"no answer"}]
        """#.utf8))
        #expect(FriendWords.ordered(list).map(\.id) == ["2", "4", "1"])
        #expect(FriendWords.state(list[1]).0 == "Asks to be friends")
        #expect(FriendWords.state(list[0]).0 == "Verified")
        #expect(FriendWords.state(list[3]).0 == "Not reached")
        #expect(FriendWords.linkOK("conclave://friend?fp=ab&url=x") && !FriendWords.linkOK("https://x"))
    }
}
