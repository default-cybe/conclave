import Foundation
import Testing
@testable import ConclaveKit

// Port of packages/android/client AsksTest.kt: approvals and questions from subagents and workflow
// agents show in the chat the owner is in. The subagent row test (Tasks.now) comes with Tasks in phase 5.

private func approval(_ id: String, _ sid: String, tool: String, summary: String = "", root: String? = nil, from: AskFrom? = nil) -> ApprovalRequest {
    var a = ApprovalRequest(id: id, sessionId: sid, rootSessionId: root, from: from)
    a.tool = tool
    a.summary = summary
    return a
}

private let email = AskFrom(sessionId: "s_email", agent: "email", label: "Find the Lisbon booking mail", chain: ["s_email"])
private let child = approval("ap_mail", "s_email", tool: "MailRead", summary: "Read message msg_4f1c", root: "s_mail", from: email)
private let own = approval("ap_own", "s_mail", tool: "Bash", summary: "Run: ls", root: "s_mail")
private let twoDown = approval(
    "ap_deep", "s_read", tool: "Read", root: "s_mail",
    from: AskFrom(sessionId: "s_read", agent: "explore", label: "Read the thread", chain: ["s_email", "s_read"])
)
private let workflow = approval(
    "ap_wf", "s_wf3", tool: "Bash", root: "s_mail",
    from: AskFrom(sessionId: "s_wf3", agent: "workflow", label: "search r1 3", workflow: AskWorkflow(runId: "wfr_1", name: "deep-research"), chain: ["s_wf3"])
)
private let older = approval("ap_old", "s_mail", tool: "Bash")
private let question: QuestionRequest = {
    var q = QuestionRequest(id: "q1", sessionId: "s_email", rootSessionId: "s_mail", from: email)
    q.questions = try! Wire.decoder().decode([Question].self, from: Data(#"[{"question":"Which inbox?","options":[{"label":"Work"},{"label":"Home"}]}]"#.utf8))
    return q
}()

private func decode(_ json: String) throws -> ApprovalRequest { try Wire.decoder().decode(ApprovalRequest.self, from: Data(json.utf8)) }

struct AsksTests {
    @Test func rootSessionIdAndFromDecodeOnTheListAndOnTheEvent() throws {
        let a = try decode(#"{"id":"ap_mail","sessionId":"s_email","rootSessionId":"s_mail","from":{"sessionId":"s_email","agent":"email","label":"Find the Lisbon booking mail","chain":["s_email"]},"toolUseId":"tu","tool":"MailRead","input":{"id":"m1"},"summary":"Read message m1","createdAt":5,"noAlways":true}"#)
        #expect(a.rootSessionId == "s_mail")
        #expect(a.from == email)
        let wf = try decode(#"{"id":"a","sessionId":"s_wf3","rootSessionId":"s_mail","from":{"sessionId":"s_wf3","agent":"workflow","label":"search r1 3","workflow":{"runId":"wfr_1","name":"deep-research"},"chain":["s_wf3"]},"tool":"Bash"}"#)
        #expect(wf.from?.workflow == AskWorkflow(runId: "wfr_1", name: "deep-research"))
        // an older hub: neither
        let old = try decode(#"{"id":"a","sessionId":"s1","tool":"Bash"}"#)
        #expect(old.rootSessionId == nil)
        #expect(old.from == nil)

        let frame = Frame.parse(#"{"type":"question.asked","seq":1,"ts":1,"question":{"id":"q1","sessionId":"s_email","rootSessionId":"s_mail","from":{"sessionId":"s_email","agent":"email","label":"Find it","chain":["s_email"]},"questions":[{"question":"Which inbox?","options":[{"label":"Work"}]}],"createdAt":1}}"#)
        guard case .event(let env) = frame, case .questionAsked(let q) = env.event else {
            Issue.record("not a question: \(frame)")
            return
        }
        #expect(q.rootSessionId == "s_mail")
        #expect(q.from?.agent == "email")
        #expect(env.event.sessionKey == "s_email")
    }

    @Test func topSessionShowsItsOwnAndItsSubagentsRequests() {
        for a in [child, own, twoDown, workflow, older] { #expect(Asks.showsIn(a, "s_mail"), "\(a.id)") }
        #expect(Asks.showsIn(child, "s_email"))
        #expect(Asks.showsIn(twoDown, "s_email"))
        #expect(!Asks.showsIn(own, "s_email"))
        #expect(!Asks.showsIn(child, "s_other"))
        #expect(Asks.of([own, child, twoDown], "s_email").map(\.id) == ["ap_mail", "ap_deep"])
        #expect(Asks.home(child) == "s_mail")
        #expect(Asks.home(older) == "s_mail")
        // the turn that started a subagent waits with it
        #expect(Asks.below([child], "s_mail"))
        #expect(!Asks.below([own], "s_mail"))
        #expect(Asks.waitsIn([twoDown], "s_email"))
        #expect(!Asks.waitsIn([own], "s_email"))
        #expect(Asks.runWaits([workflow], "wfr_1"))
        #expect(!Asks.runWaits([child], "wfr_1"))
    }

    @Test func whoAsksTheSessionAnswerAndTheInboxLine() {
        #expect(Asks.fromLine(child, viewing: "s_mail") == "Subagent email asks")
        #expect(Asks.fromLine(workflow, viewing: "s_mail") == "Workflow deep-research, agent search r1 3, asks")
        #expect(Asks.fromLine(question, viewing: "s_mail") == "Subagent email asks")
        #expect(Asks.fromLine(own, viewing: "s_mail") == nil)
        // in the subagent's own session it is the one you are looking at
        #expect(Asks.fromLine(child, viewing: "s_email") == nil)
        #expect(Asks.fromLine(twoDown, viewing: "s_email") == "Subagent explore asks")
        #expect(Asks.sessionLabel(child) == "Allow for this subagent")
        #expect(Asks.sessionDone(child) == "Allowed for this subagent")
        #expect(Asks.sessionLabel(own) == "Allow for this chat")
        #expect(Asks.sessionDone(own) == "Allowed for this chat")
        #expect(Asks.inboxLine(child, rootTitle: "Lisbon flight booking code") == "from subagent email in Lisbon flight booking code")
        #expect(Asks.inboxLine(workflow, rootTitle: "Research") == "from workflow deep-research, agent search r1 3, in Research")
        #expect(Asks.inboxLine(own, rootTitle: "x") == nil)
        #expect(Asks.askerLine(child, "Wants to read a file") == "Subagent email wants to read a file")
        #expect(Asks.askerLine(own, "Wants to run ls") == "Wants to run ls")
        let words = [Asks.fromLine(workflow, viewing: "s_mail") ?? "", Asks.inboxLine(workflow, rootTitle: "R") ?? "", Asks.askerLine(workflow, "Asks: Now?")].joined(separator: " ")
        #expect(!words.contains("\u{2014}") && !words.contains("\u{2013}"))
    }

    @Test func theChatsTranscriptTakesASubagentsRequestAndLetsItGo() {
        var t = Transcript(sessionId: "s_mail")
        t = TranscriptReducer.apply(t, .approvalRequested(child))
        t = TranscriptReducer.apply(t, .questionAsked(question))
        #expect(t.approvals.map(\.id) == ["ap_mail"])
        #expect(t.questions.map(\.id) == ["q1"])
        // another chat's subagent stays out
        var elsewhere = child
        elsewhere.id = "ap_x"
        elsewhere.sessionId = "s_x"
        elsewhere.rootSessionId = "s_other"
        elsewhere.from?.chain = ["s_x"]
        #expect(TranscriptReducer.apply(t, .approvalRequested(elsewhere)) == t)
        t = TranscriptReducer.apply(t, .approvalResolved(id: "ap_mail", sessionId: "s_email"))
        t = TranscriptReducer.apply(t, .questionAnswered(id: "q1", sessionId: "s_email"))
        #expect(t.approvals.isEmpty)
        #expect(t.questions.isEmpty)
        #expect(EngineEvent.approvalRequested(child).isAsk)
        #expect(!EngineEvent.other(type: "config.updated").isAsk)
    }
}
