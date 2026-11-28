import Foundation
import Testing
@testable import ConclaveKit

// Port of packages/android/client ComposerTest.kt aCustomAgentIsPickedUnderPlusOnly, plus the
// Agents page's groups (AgentsScreen.kt) and GET /api/agents decoding.
struct AgentsTests {
    let agents = [
        AgentDef("coder", model: "anthropic/claude-opus-5-5", source: "builtin"),
        AgentDef("assistant", model: "anthropic/claude-sonnet-5-5", source: "builtin"),
        AgentDef("chat", source: "builtin"),
        AgentDef("explore", source: "builtin", subagent: true, primary: false),
        AgentDef("researcher", model: "openai/gpt-5.5"),
    ]

    @Test func aCustomAgentIsPickedUnderPlusOnly() {
        #expect(AgentPicks.customAgents(agents).map(\.name) == ["researcher"])
        #expect(AgentPicks.customAgents(agents, picked: "explore").map(\.name) == ["explore", "researcher"])
    }

    @Test func theNewSessionSheetOffersTheModesAgentFirstThenCustomOnes() {
        #expect(AgentPicks.startChoices(agents, mode: .code).map(\.0) == ["coder", "security", "researcher"])
        #expect(AgentPicks.startChoices(agents, mode: .security).map(\.1) == ["Security", "Coder", "researcher"])
    }

    @Test func theAgentsPageSplitsAgentsFromSubagentsOnce() {
        let (primary, sub) = AgentPicks.sections(agents + [AgentDef("researcher")])
        #expect(primary.map(\.name) == ["coder", "assistant", "chat", "researcher"])
        #expect(sub.map(\.name) == ["explore"])
        #expect(AgentPicks.switchable(agents).map(\.name) == ["coder", "assistant", "researcher"])
    }

    @Test func agentsDecodeWithDefaults() throws {
        let json = #"[{"name":"coder","description":"Writes code","model":"anthropic/claude-opus-5-5","source":"builtin","mode":"agent","tools":["Bash"]},{"name":"x"}]"#
        let list = try JSONDecoder().decode([AgentDef].self, from: Data(json.utf8))
        #expect(list[0].description == "Writes code")
        #expect(list[0].tools == ["Bash"])
        #expect(list[1].source == "user")
        #expect(list[1].prompt.isEmpty)
    }
}
