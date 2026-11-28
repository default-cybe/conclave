import Foundation
import Testing
@testable import ConclaveKit

// The Map's rows by computer and the memory map's links (Android MapModel and MemoryMaps).
struct MapTests {
    @Test func byDeviceAndLines() throws {
        let s = try JSONDecoder().decode(MapSnapshot.self, from: Data(#"""
        {"devices":[{"id":"local","name":"hub"},{"id":"d1","name":"Alpha"}],
         "nodes":[{"id":"a","state":"idle","device":"local","startedAt":5},
                  {"id":"b","state":"running","device":"local","tool":{"name":"Running","target":"ls"}},
                  {"id":"c","state":"waiting","device":"d1"},
                  {"id":"b1","state":"running","device":"local","parentId":"b"}]}
        """#.utf8))
        let g = MapWords.byDevice(s)
        // the hub first; live work first; subagents are not rows
        #expect(g.map(\.1) == ["hub", "Alpha"])
        #expect(g[0].2.map(\.id) == ["b", "a"])
        #expect(MapWords.line(g[0].2[0]) == "Running ls")
        #expect(MapWords.line(g[1].2[0]) == "Waiting on you")
        #expect(MapWords.children(s, of: "b") == 1)
    }

    @Test func graphLinks() throws {
        let g = try JSONDecoder().decode(MemoryGraph.self, from: Data(#"{"nodes":[{"id":"a"},{"id":"b"},{"id":"c"}],"edges":[[0,1,0],[1,1,0],[0,9,0],[2,0]],"labels":["about"]}"#.utf8))
        // a self-link and one to a missing node are dropped
        #expect(g.links.count == 2)
        #expect(g.neighbours(0).map(\.0.id) == ["b", "c"])
        #expect(g.neighbours(0).first?.1 == "about")
        #expect(g.ringAngles().count == 3)
    }
}
