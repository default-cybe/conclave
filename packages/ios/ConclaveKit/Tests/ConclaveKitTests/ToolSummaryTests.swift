import Testing
@testable import ConclaveKit

// Port of LogicTest.kt's tool summary case.
struct ToolSummaryTests {
    @Test func oneLinePerCall() {
        #expect(ToolSummary.of("Bash", ["command": "npm test\nmore"]) == "Run: npm test")
        #expect(ToolSummary.of("Edit", ["file_path": "/a/b.kt"]) == "Edit /a/b.kt")
        #expect(ToolSummary.of("mcp__x", ["q": "hello"]) == "mcp__x: hello")
        #expect(ToolSummary.of("Thing", [:]) == "Thing")
        #expect(ToolSummary.of("Delegate", ["to": "assistant", "prompt": "plan"]) == "Assistant: plan")
    }
}
