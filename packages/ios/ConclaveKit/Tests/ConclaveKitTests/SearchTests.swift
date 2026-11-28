import Foundation
import Testing
@testable import ConclaveKit

// Search and the new session's folder picker: the client routes, Android ProjectsTest pathHelpers,
// and the web FolderPicker's recentFolders, filterFolders and crumbs.
struct SearchTests {
    private func session(_ json: String) throws -> Session { try decode(json) }

    @Test func searchEncodesTheQueryAndReadsHitsLeniently() async throws {
        let hub = MockHub()
        hub.enqueue(#"[{"sessionId":"s1","messageId":"m2","snippet":"the [passkey] prompt","title":"Login"},{"sessionId":"s2"}]"#)
        let hits = try await hub.client().search("a+b & c")
        #expect(hits.map(\.id) == ["s1:m2", "s2:"])
        #expect(hits[1].snippet == "" && hits[1].title == "")
        let req = try #require(hub.take())
        #expect(req.path == "/api/search")
        #expect(req.query("q") == "a+b & c")
        #expect(URLComponents(url: req.url, resolvingAgainstBaseURL: false)?.percentEncodedQuery == "q=a%2Bb%20%26%20c")
        #expect(req.headers["Authorization"] == "Bearer secret-token")
    }

    @Test func browseAndFolderCheckUseTheDevicesRoutes() async throws {
        let hub = MockHub()
        hub.enqueue(#"[{"name":"conclave","path":"/Users/kai/code/conclave","type":"dir"},{"name":"notes.md","type":"file","size":"bad"},{"name":"link","type":"symlink"}]"#)
        let entries = try await hub.client().browse(device: "d1", path: "/Users/kai/My Code")
        #expect(entries.map(\.isFolder) == [true, false, true])
        #expect(entries[1].size == nil)
        var req = try #require(hub.take())
        #expect(req.path == "/api/devices/d1/files")
        #expect(req.query("path") == "/Users/kai/My Code")
        hub.enqueue(#"{"path":"/Users/kai","exists":true}"#)
        let home = try await hub.client().folderCheck(device: "d1", path: "~")
        #expect(home == FolderCheck(path: "/Users/kai", exists: true))
        req = try #require(hub.take())
        #expect(req.path == "/api/devices/d1/folder")
        #expect(req.query("path") == "~")
    }

    @Test func projectsReadWithMissingFields() async throws {
        let hub = MockHub()
        hub.enqueue(#"[{"id":"p1","name":"conclave","locations":[{"projectId":"p1","device":"local","path":"/srv/conclave","pinned":true,"via":"new"}]},{"id":"p2"}]"#)
        let list = try await hub.client().projects()
        #expect(list[0].locations == [ProjectLocation(device: "local", path: "/srv/conclave", pinned: true)])
        #expect(list[1].name == "" && list[1].locations.isEmpty)
        #expect(try #require(hub.take()).path == "/api/projects")
    }

    @Test func pathHelpers() {
        #expect(FolderWords.tildePath("/home/kai/code/portfolio", home: "/home/kai") == "~/code/portfolio")
        #expect(FolderWords.tildePath("/home/kai", home: "/home/kai/") == "~")
        #expect(FolderWords.tildePath("/home/kaiser/x", home: "/home/kai") == "/home/kaiser/x")
        #expect(FolderWords.tildePath("/srv/x", home: nil) == "/srv/x")
        #expect(FolderWords.expandTilde(" ~/code ", home: "/home/kai") == "/home/kai/code")
        #expect(FolderWords.expandTilde("~", home: "/home/kai/") == "/home/kai")
        #expect(FolderWords.expandTilde("~/code", home: nil) == "~/code")
        #expect(FolderWords.parent("/home/kai/code/") == "/home/kai")
        #expect(FolderWords.parent("/home") == "/")
        #expect(FolderWords.parent("/") == nil)
        #expect(FolderWords.baseName("/home/kai/code/portfolio/") == "portfolio")
        #expect(FolderWords.join("/srv/", "media") == "/srv/media")
        #expect(FolderWords.join("/", "srv") == "/srv")
    }

    @Test func crumbsWalkFromTheTopOnBothKindsOfPath() {
        #expect(FolderWords.crumbs("/home/kai") == [Crumb(name: "/", path: "/"), Crumb(name: "home", path: "/home"), Crumb(name: "kai", path: "/home/kai")])
        #expect(FolderWords.crumbs("C:\\Users\\kai").map(\.path) == ["C:/", "C:/Users", "C:/Users/kai"])
        #expect(FolderWords.parent("C:/Users") == "C:/")
        #expect(FolderWords.parent("C:/") == nil)
    }

    @Test func theBrowserListsFoldersByNameAndHidesDotFolders() {
        let list = [FileEntry(name: "src", type: "dir"), FileEntry(name: ".git", type: "dir"), FileEntry(name: "README.md"), FileEntry(name: "Apps", type: "symlink")]
        #expect(FolderWords.folders(list).map(\.name) == ["Apps", "src"])
        #expect(FolderWords.folders(list, hidden: true).map(\.name) == [".git", "Apps", "src"])
    }

    @Test func recentIsNewestFirstOncePerFolderOnTheDevice() throws {
        let sessions = try [
            session(#"{"id":"a","agent":"coder","cwd":"/home/conclave/work/conclave","device":"local","updatedAt":5}"#),
            session(#"{"id":"b","agent":"coder","cwd":"/home/conclave/work/conclave/","device":"local","updatedAt":4}"#),
            session(#"{"id":"c","agent":"coder","cwd":"/srv/media","updatedAt":9}"#),
            session(#"{"id":"d","kind":"chat","cwd":"/srv/chat","updatedAt":10}"#),
            session(#"{"id":"e","agent":"coder","cwd":"~","updatedAt":11}"#),
            session(#"{"id":"f","agent":"coder","cwd":"/srv/wt","meta":{"repo":{"url":"x"}},"updatedAt":12}"#),
            session(#"{"id":"g","agent":"coder","cwd":"/Users/kai/x","device":"d1","updatedAt":13}"#),
            session(#"{"id":"h","agent":"coder","cwd":"/home/conclave","updatedAt":3}"#),
        ]
        let rows = FolderWords.recent(sessions, device: "local", home: "/home/conclave")
        #expect(rows.map(\.path) == ["/srv/media", "/home/conclave/work/conclave"])
        #expect(rows.map(\.name) == ["media", "conclave"])
        #expect(rows.map(\.detail) == ["/srv/media", "~/work/conclave"])
        #expect(FolderWords.recent(sessions, device: "local", max: 1).count == 1)
        #expect(FolderWords.recent(sessions, device: "d1").map(\.path) == ["/Users/kai/x"])
    }

    @Test func aProjectsFolderReadsByTheProjectsName() throws {
        let projects = [Project(id: "p1", name: "site", locations: [ProjectLocation(device: "local", path: "/srv/site")])]
        let sessions = try [
            session(#"{"id":"a","cwd":"/srv/site/web","updatedAt":2}"#),
            session(#"{"id":"b","cwd":"/srv/site","updatedAt":1}"#),
        ]
        let rows = FolderWords.recent(sessions, projects: projects, device: "local")
        #expect(rows.map(\.name) == ["site/web", "site"])
        #expect(rows.map(\.projectId) == ["p1", "p1"])
        // a project folder not in Recent shows once the query matches it
        let other = [Project(id: "p2", name: "kener-theme", locations: [ProjectLocation(device: "local", path: "/home/kai/kener"), ProjectLocation(device: "d1", path: "/x")])]
        #expect(FolderWords.choices(recent: rows, projects: other, device: "local", query: "kener").map(\.path) == ["/home/kai/kener"])
        #expect(FolderWords.choices(recent: rows, projects: other, device: "local", query: " ") == rows)
    }

    @Test func filterKeepsRowsHoldingEveryWord() {
        let rows = [FolderRow(path: "/srv/media", name: "media"), FolderRow(path: "/home/conclave/work/conclave", name: "conclave")]
        #expect(FolderWords.filter(rows, "WORK con").map(\.name) == ["conclave"])
        #expect(FolderWords.filter(rows, "srv").map(\.name) == ["media"])
        #expect(FolderWords.filter(rows, "").count == 2)
        #expect(FolderWords.filter(rows, "nope").isEmpty)
    }

    @Test func computersAreTheHubThenOnlineOnesByName() {
        let list = [
            Device(id: "d2", name: "zeta", online: true), Device(id: "d3", name: "NAS"),
            Device(id: "p", name: "Pixel", online: true, info: MachineInfo(platform: "android")), Device(id: "d1", name: "MacBook Pro", online: true),
        ]
        #expect(FolderWords.computers(list).map(\.id) == ["local", "d1", "d2"])
        #expect(FolderWords.placeName(Device(id: "local", name: "homelab")) == "homelab (hub)")
        #expect(FolderWords.placeName(Device(id: "local")) == "conclave (hub)")
        #expect(FolderWords.placeName(Device(id: "d9", name: " ")) == "d9")
    }

    @Test func snippetsMarkTheHubsBracketedMatches() {
        #expect(SearchWords.snippet("…the [passkey] prompt\non [Safari]") == [
            SnippetPart("…the "), SnippetPart("passkey", match: true), SnippetPart(" prompt on "), SnippetPart("Safari", match: true),
        ])
        // an empty or broken mark is plain text
        #expect(SearchWords.snippet("a [] b [c\nd]") == [SnippetPart("a [] b [c d]")])
        #expect(SearchWords.snippet("") == [])
    }

    @Test func titleHitsAndMessageGroups() throws {
        let sessions = try [
            session(#"{"id":"s1","title":"Fix login passkey","agent":"coder","updatedAt":1}"#),
            session(#"{"id":"s2","title":"Passkey notes","kind":"chat","updatedAt":2}"#),
            session(#"{"id":"s3","title":"Passkey archived","archived":true,"updatedAt":3}"#),
            session(#"{"id":"s4","title":"Other","updatedAt":4}"#),
        ]
        #expect(SearchWords.titleHits(sessions, "PASSkey").map(\.id) == ["s2", "s1"])
        #expect(SearchWords.titleHits(sessions, "login passkey").map(\.id) == ["s1"])
        #expect(SearchWords.titleHits(sessions, "  ").isEmpty)
        let hits = [SearchHit(sessionId: "s1", messageId: "m1", title: "Fix"), SearchHit(sessionId: "s9", messageId: "m2"), SearchHit(sessionId: "s1", messageId: "m3", title: "Fix")]
        let groups = SearchWords.groups(hits, titles: ["s9": "Kept title"])
        #expect(groups.map(\.sessionId) == ["s1", "s9"])
        #expect(groups.map(\.title) == ["Fix", "Kept title"])
        #expect(groups[0].hits.map(\.messageId) == ["m1", "m3"])
        #expect(SearchWords.groups([SearchHit(sessionId: "x")]).first?.title == "Untitled")
    }
}
