package dev.conclave.client

import dev.conclave.client.logic.ChatItem
import dev.conclave.client.logic.ChatItems
import dev.conclave.client.logic.ToolLines
import dev.conclave.client.logic.ToolStep
import dev.conclave.client.logic.TurnPiece
import dev.conclave.client.logic.Work
import dev.conclave.client.logic.WorkEntry
import dev.conclave.client.logic.WorkSegment
import dev.conclave.client.logic.WorkStep
import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.RedactedThinkingBlock
import dev.conclave.client.model.Role
import dev.conclave.client.model.TextBlock
import dev.conclave.client.model.ThinkingBlock
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolResultMeta
import dev.conclave.client.model.ToolUseBlock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ToolLinesTest {
    private val cwd = "/home/sam/fernway-web"

    private fun use(id: String, name: String, vararg pairs: Pair<String, String>) =
        ToolUseBlock(id, name, JsonObject(pairs.associate { (k, v) -> k to JsonPrimitive(v) }))

    private val read = use("t1", "Read", "file_path" to "$cwd/src/auth/redirect.ts")
    private val edit = use("t2", "Edit", "file_path" to "$cwd/src/auth/redirect.ts", "old_string" to "return next", "new_string" to "if (safe(next)) return next\nreturn '/home'")
    private val test = use("t3", "Bash", "command" to "bun test src/auth")
    private val done = mapOf(
        "t1" to ToolResultBlock("t1", JsonPrimitive("export function afterLogin")),
        "t2" to ToolResultBlock("t2", JsonPrimitive("ok")),
        "t3" to ToolResultBlock("t3", JsonPrimitive("3 pass")),
    )

    @Test
    fun aTurnReadsAsOneSentence() {
        val steps = ToolLines.steps(listOf(read, edit, test), done, cwd)
        assertEquals("Read redirect.ts, edited it, ran bun test", ToolLines.sentence(steps))
    }

    @Test
    fun moreThanThreeEndsWithACount() {
        val more = (4..10).map { use("t$it", "Bash", "command" to "git status --short $it") }
        val steps = ToolLines.steps(listOf(read, edit, test) + more, done, cwd)
        // the git status calls differ only after their flags, so they read the same and count once
        assertEquals("Read redirect.ts, edited it, ran bun test and 1 more", ToolLines.sentence(steps))
        val other = listOf(use("a", "Grep", "pattern" to "afterLogin"), use("b", "Glob", "pattern" to "src/**/*.ts"), use("c", "WebSearch", "query" to "open redirect"), use("d", "WebFetch", "url" to "https://owasp.org/x"))
        assertEquals(
            "Read redirect.ts, edited it, ran bun test and 4 more",
            ToolLines.sentence(ToolLines.steps(listOf(read, edit, test) + other, done, cwd)),
        )
        assertEquals("Searched for afterLogin, listed src/**/*.ts, searched the web and 1 more", ToolLines.sentence(ToolLines.steps(other, emptyMap())))
    }

    @Test
    fun rowsNameTheFileTheCommandAndTheLinesAnEditChanged() {
        val steps = ToolLines.steps(listOf(read, edit, test), done, cwd)
        assertEquals(listOf("Read", "Edited", "Ran"), steps.map { it.verb })
        assertEquals(listOf("redirect.ts", "redirect.ts", "bun test src/auth"), steps.map { it.target })
        assertTrue(steps.all { it.code })
        assertEquals("+2 −1", steps[1].counts)
        assertNull(steps[0].counts)
        // the hub's own diff wins over the call's input
        val diff = "--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-a\n+b\n+c\n"
        val withDiff = ToolLines.step(edit, ToolResultBlock("t2", JsonPrimitive("ok"), meta = ToolResultMeta(diff = diff)), cwd)
        assertEquals(2 to 1, withDiff.added to withDiff.removed)
        val write = ToolLines.step(use("w", "Write", "file_path" to "$cwd/notes.md", "content" to "one\ntwo"), null, cwd)
        assertEquals("Wrote", write.verb)
        assertEquals("+2 −0", write.counts)
    }

    @Test
    fun whatRunsNowIsLeftOutOfTheSentence() {
        val steps = ToolLines.steps(listOf(read, edit, test), done - "t3", cwd, live = true)
        assertTrue(steps[2].running)
        assertEquals("Running", steps[2].verb)
        assertEquals("Read redirect.ts, edited it", ToolLines.sentence(steps))
        assertEquals("", ToolLines.sentence(ToolLines.steps(listOf(test), emptyMap(), cwd, live = true)))
        // after the turn a call with no result is not running any more
        assertEquals("Ran bun test", ToolLines.sentence(ToolLines.steps(listOf(test), emptyMap(), cwd, live = false)))
    }

    @Test
    fun failuresSayWhatFailed() {
        val failed = mapOf(
            "t1" to ToolResultBlock("t1", JsonPrimitive("ok")),
            "t3" to ToolResultBlock("t3", JsonPrimitive("1 fail"), isError = true),
        )
        assertEquals("Read redirect.ts, bun test failed", ToolLines.sentence(ToolLines.steps(listOf(read, test), failed, cwd)))
        // a command keeps its own case at the start of the sentence
        assertEquals("bun test failed", ToolLines.sentence(ToolLines.steps(listOf(test), failed, cwd)))
        val editFailed = mapOf("t2" to ToolResultBlock("t2", JsonPrimitive("no match"), isError = true))
        assertEquals("Could not edit redirect.ts", ToolLines.sentence(ToolLines.steps(listOf(edit), editFailed, cwd)))
    }

    @Test
    fun repeatsAreSaidOnce() {
        val again = use("t9", "Read", "file_path" to "$cwd/src/auth/redirect.ts")
        val steps = ToolLines.steps(listOf(read, again, edit), done, cwd)
        assertEquals("Read redirect.ts, edited it", ToolLines.sentence(steps))
    }

    @Test
    fun chatToolsReadPlainly() {
        val steps = ToolLines.steps(
            listOf(
                use("s", "WebSearch", "query" to "caddy tailscale"),
                use("f", "WebFetch", "url" to "https://www.caddyserver.com/docs"),
                use("m", "MemorySave", "content" to "Sam deploys on Fridays"),
                use("x", "mcp__github__create_issue"),
            ),
            emptyMap(),
        )
        assertEquals("Searched the web, read caddyserver.com, saved to memory and 1 more", ToolLines.sentence(steps))
        assertEquals("Used", steps[3].verb)
        assertEquals("github create_issue", steps[3].target)
        assertEquals("caddy tailscale", steps[0].target)
    }

    @Test
    fun aCommandIsShortenedToWhatItDoes() {
        assertEquals("bun test", ToolLines.shortCommand("bun test src/auth"))
        assertEquals("git push", ToolLines.shortCommand("git push origin fix/login"))
        assertEquals("git log", ToolLines.shortCommand("git log --oneline -3"))
        assertEquals("npm run build", ToolLines.shortCommand("npm run build -- --watch"))
        assertEquals("bun test", ToolLines.shortCommand("cd /repo && bun test"))
        assertEquals("pytest", ToolLines.shortCommand("CI=1 pytest -q tests/"))
        assertEquals("./gradlew", ToolLines.shortCommand("./gradlew :client:test"))
        assertEquals("cat", ToolLines.shortCommand("cat src/auth/redirect.ts | head"))
        assertEquals("make", ToolLines.shortCommand("make\necho done"))
    }

    @Test
    fun usesAreTheTurnsToolCallsInOrder() {
        val msgs = listOf(
            Message("a1", "s", 1, Role.ASSISTANT, content = listOf(TextBlock("Checking"), read)),
            Message("r1", "s", 2, Role.USER, content = listOf(ToolResultBlock("t1"))),
            Message("a2", "s", 3, Role.ASSISTANT, content = listOf(edit, test)),
        )
        assertEquals(listOf("t1", "t2", "t3"), ToolLines.uses(msgs).map { it.id })
    }

    @Test
    fun aStepWithoutAPathStillReads() {
        val step: ToolStep = ToolLines.step(use("t", "Read"), null)
        assertEquals("Read", step.verb)
        assertNull(step.target)
        assertEquals("Read", ToolLines.sentence(listOf(step)))
    }
}

class TurnsTest {
    @Test
    fun assistantMessagesBetweenYoursJoinIntoOneTurn() {
        val msgs = listOf(
            Message("u1", "s", 1, Role.USER, content = listOf(TextBlock("Fix the redirect"))),
            Message("a1", "s", 2, Role.ASSISTANT, content = listOf(ToolUseBlock("t1", "Read"))),
            Message("r1", "s", 3, Role.USER, content = listOf(ToolResultBlock("t1"))),
            Message("a2", "s", 4, Role.ASSISTANT, content = listOf(TextBlock("Fixed."))),
            Message("n", "s", 5, Role.ASSISTANT, MessageKind.NOTICE, listOf(TextBlock("Stopped by you."))),
            Message("a3", "s", 6, Role.ASSISTANT, content = listOf(TextBlock("After the notice"))),
            Message("u2", "s", 7, Role.USER, content = listOf(TextBlock("Thanks"))),
        )
        val turns = ChatItems.turns(ChatItems.build(msgs))
        assertEquals(listOf("u1", "turn:a1", "n", "turn:a3", "u2"), turns.map { it.key })
        assertEquals(listOf("a1", "a2"), (turns[1] as ChatItem.Turn).messages.map { it.id })
        // nothing to join: the items stay as they were
        val plain = ChatItems.build(listOf(msgs[0]))
        assertEquals(plain, ChatItems.turns(plain))
    }
}

/**
 * One row per stretch of work (Work.kt, CHAT-AND-MOTION 6.3): the thoughts
 * and calls between two pieces of text are one row, "Thought for 24s, ran 1
 * command, read 3 files"; a Workflow or Task call stands alone.
 */
class WorkGroupsTest {
    private val cwd = "/home/kai/vault"

    private fun use(id: String, name: String, vararg pairs: Pair<String, String>) =
        ToolUseBlock(id, name, JsonObject(pairs.associate { (k, v) -> k to JsonPrimitive(v) }))

    private fun read(id: String, file: String) = use(id, "Read", "file_path" to "$cwd/lib/$file")
    private fun think(ms: Long?, text: String = "Looking at the gate") = ThinkingBlock(text, durationMs = ms)
    private fun assistant(id: String, vararg blocks: dev.conclave.client.model.ContentBlock, stop: String? = "tool_use") =
        Message(id, "s", 0, Role.ASSISTANT, content = blocks.toList(), stopReason = stop)

    /** The owner's turn: a thought, the calls, two more thoughts and one still being written, between two pieces of text. */
    private fun ownersTurn(streaming: Boolean) = listOf(
        assistant("a1", TextBlock("Let me look at the vault."), think(5_000), use("b1", "Bash", "command" to "cd $cwd && wc -l lib/*.dart"), read("r1", "vault_entry.dart"), read("r2", "vault_screens.dart")),
        assistant("a2", read("r3", "vault_screens.dart"), read("r4", "vault_gate_test.dart"), think(9_000), if (streaming) think(null, "") else think(10_000), stop = if (streaming) null else "end_turn"),
    )

    @Test
    fun aStretchOfThoughtsAndCallsIsOneRow() {
        val pieces = Work.pieces(ownersTurn(streaming = true), streaming = true)
        assertEquals(2, pieces.size)
        assertIs<TurnPiece.Block>(pieces[0])
        val work = assertIs<TurnPiece.Work>(pieces[1])
        // every thought, the one being written too, and every call: in one group, in order
        val segs = Work.segment(work.entries)
        val group = assertIs<WorkSegment.Group>(segs.single())
        assertEquals(listOf("t", "c", "c", "c", "c", "c", "t", "t"), group.entries.map { if (it is WorkEntry.Thought) "t" else "c" })
        assertTrue((group.entries.last() as WorkEntry.Thought).streaming)
        assertEquals(0, Work.lastText(pieces))

        // done: the thinking time first, then the calls as counts
        val done = Work.pieces(ownersTurn(streaming = false))
        val entries = (done[1] as TurnPiece.Work).entries
        assertEquals("Thought for 24s, ran 1 command, read 3 files", ToolLines.workSummary(Work.steps(entries)))
        // while the last thought is written the summary says so; the row says what it does now
        assertEquals("Thinking, ran 1 command, read 3 files", ToolLines.workSummary(Work.steps(work.entries)))
        assertEquals("Thinking", Work.now(work.entries, emptyMap(), live = true))
        assertNull(Work.now(entries, emptyMap(), live = false))
    }

    @Test
    fun theRowSaysTheCallRunningNow() {
        val bash = use("b1", "Bash", "command" to "flutter analyze lib")
        val entries = Work.pieces(listOf(assistant("a", think(3_000), read("r1", "vault_entry.dart"), bash, stop = null)))
            .filterIsInstance<TurnPiece.Work>().single().entries
        val results = mapOf("r1" to ToolResultBlock("r1", JsonPrimitive("ok")))
        assertEquals("Running flutter analyze", Work.now(entries, results, live = true))
        // past the stretch, or the turn ended: the summary
        assertNull(Work.now(entries, results, live = false))
        assertEquals("Thought for 3s, read 1 file, ran 1 command", ToolLines.workSummary(Work.steps(entries)))
    }

    @Test
    fun thinkingComesFirstOnlyWhenTheStretchStartsWithAThought() {
        val calls = listOf<WorkStep>(WorkStep.Call(use("g", "Bash", "command" to "git log --oneline")))
        assertEquals("Thought for 15s, ran git log", ToolLines.workSummary(listOf(WorkStep.Thought(9_000)) + calls + WorkStep.Thought(6_000)))
        assertEquals("Ran git log, thought for 6s", ToolLines.workSummary(calls + WorkStep.Thought(6_000)))
        assertEquals("Reasoned, ran git log", ToolLines.workSummary(listOf(WorkStep.Thought(null)) + calls))
        assertEquals("Thought for 12s", ToolLines.workSummary(listOf(WorkStep.Thought(5_000), WorkStep.Thought(7_000))))
        assertEquals("", ToolLines.workSummary(emptyList()))
    }

    @Test
    fun callsCountByKindInTheOrderTheyFirstRan() {
        val uses = listOf(
            use("1", "Bash", "command" to "bun test"),
            read("2", "a.dart"),
            use("3", "Bash", "command" to "git status"),
            read("4", "a.dart"),
            read("5", "b.dart"),
            use("6", "Grep", "pattern" to "jwt"),
            use("7", "Grep", "pattern" to "token"),
            use("8", "Edit", "file_path" to "$cwd/lib/a.dart"),
            use("9", "WebSearch", "query" to "flutter"),
            use("10", "mcp__github__create_issue"),
            use("11", "mcp__github__list_issues"),
            use("12", "TodoWrite"),
            use("13", "Skill", "skill" to "pdf"),
        )
        assertEquals(
            "Ran 2 commands, read 2 files, searched 2 times, edited 1 file, searched the web once, used github 2 times, updated the plan, used the pdf skill",
            ToolLines.groupSummary(uses),
        )
        assertEquals("ran git log", ToolLines.callPhrase(use("g", "Bash", "command" to "git log --oneline")))
        assertEquals("read redirect.ts", ToolLines.callPhrase(read("r", "redirect.ts")))
    }

    @Test
    fun aLoneThoughtAndASingleCallStayAsTheyAre() {
        val lone = Work.segment(Work.pieces(listOf(assistant("a", think(4_000), TextBlock("Done.")))).filterIsInstance<TurnPiece.Work>().single().entries)
        assertIs<WorkSegment.Lone>(lone.single())
        val one = Work.segment(Work.pieces(listOf(assistant("a", TextBlock("Checking."), read("r", "a.dart"), TextBlock("Fine.")))).filterIsInstance<TurnPiece.Work>().single().entries)
        assertIs<WorkSegment.One>(one.single())
        // text splits the work; an empty text block does not, nor does an empty thought with no time
        val pieces = Work.pieces(listOf(assistant("a", read("r1", "a.dart"), TextBlock("  "), ThinkingBlock(""), read("r2", "b.dart"), TextBlock("Both read."), read("r3", "c.dart"))))
        assertEquals(listOf(2, 1), pieces.filterIsInstance<TurnPiece.Work>().map { it.entries.size })
        // a redacted thought is a thought
        val redacted = Work.pieces(listOf(assistant("a", RedactedThinkingBlock("x"), read("r", "a.dart")))).filterIsInstance<TurnPiece.Work>().single()
        assertIs<WorkSegment.Group>(Work.segment(redacted.entries).single())
        assertEquals("Reasoned, read a.dart", ToolLines.workSummary(Work.steps(redacted.entries)))
    }

    @Test
    fun workflowAndTaskCallsStandAloneAndSplitTheGroup() {
        val flow = use("w", "Workflow", "name" to "deep-research")
        val task = use("t", "Task", "description" to "Find the auth code", "subagent_type" to "explore", "prompt" to "Find it")
        val entries = Work.pieces(
            listOf(assistant("a", think(2_000), read("r1", "a.dart"), flow, read("r2", "b.dart"), use("g", "Grep", "pattern" to "jwt"), task, think(1_000))),
        ).filterIsInstance<TurnPiece.Work>().single().entries
        val segs = Work.segment(entries)
        assertEquals(listOf("Group", "One", "Group", "One", "Lone"), segs.map { it::class.simpleName })
        assertEquals("w", (segs[1] as WorkSegment.One).call.use.id)
        assertEquals("t", (segs[3] as WorkSegment.One).call.use.id)
    }

    @Test
    fun taskCallsOfOneMessageAreOneFanOutCard() {
        fun task(id: String) = use(id, "Task", "description" to "Check $id", "subagent_type" to "explore", "prompt" to "Do it")
        val entries = Work.pieces(
            listOf(
                assistant("a1", task("t1"), task("t2"), use("d1", "Delegate", "description" to "Build it", "prompt" to "Build"), read("r1", "a.dart"), task("t3")),
                assistant("a2", task("t4"), use("w", "Workflow", "name" to "review-changes"), task("t5")),
            ),
        ).filterIsInstance<TurnPiece.Work>().single().entries
        val segs = Work.segment(entries)
        // a read splits the card; a new message starts a new one; a Workflow call is never in a card
        assertEquals(listOf("FanOut", "One", "One", "One", "One", "One"), segs.map { it::class.simpleName })
        assertEquals(listOf("t1", "t2", "d1"), (segs[0] as WorkSegment.FanOut).calls.map { it.use.id })
        assertEquals("a1:0", segs[0].key)
        assertEquals(listOf("r1", "t3", "t4", "w", "t5"), segs.drop(1).map { (it as WorkSegment.One).call.use.id })
    }

    @Test
    fun aWorkflowByAnyOtherNameIsStillAWorkflow() {
        assertEquals("Workflow", Work.name("Workflow"))
        assertEquals("Workflow", Work.name("mcp__conclave__Workflow"))
        assertEquals("Workflow", Work.name("workflow"))
        assertEquals("Task", Work.name("mcp__conclave__Task"))
        // a harness's titled call whose input is a workflow script
        val script = JsonObject(mapOf("script" to JsonPrimitive("export const meta = { name: 'sweep', phases: [] }\nawait agent('x')")))
        assertEquals("Workflow", Work.name("Tool", script))
        assertTrue(Work.isWorkflow(ToolUseBlock("h", "Tool", script)))
        // a harness's Agent with a subagent's input is a Task
        assertEquals("Task", Work.name("Agent", JsonObject(mapOf("subagent_type" to JsonPrimitive("explore")))))
        // not these
        assertEquals("WorkflowStatus", Work.name("WorkflowStatus"))
        assertEquals("mcp__conclave__WorkflowStatus", Work.name("mcp__conclave__WorkflowStatus"))
        assertEquals("Tool", Work.name("Tool", JsonObject(mapOf("script" to JsonPrimitive("echo hi")))))
        assertFalse(Work.standsAlone(use("b", "Bash", "command" to "ls")))
    }

    @Test
    fun aThoughtsRowSaysHowLongItTook() {
        val m = assistant("a")
        assertEquals("Thought for 5s", Work.thoughtLabel(WorkEntry.Thought(think(5_000), m, "k")))
        assertEquals("Thought for 7s", Work.thoughtLabel(WorkEntry.Thought(think(null), m, "k"), measured = 7_000))
        assertEquals("Thinking", Work.thoughtLabel(WorkEntry.Thought(think(null), m, "k", streaming = true)))
        assertEquals("Thought, 4 words", Work.thoughtLabel(WorkEntry.Thought(think(null), m, "k")))
        assertEquals("The provider hid this reasoning.", Work.thoughtLabel(WorkEntry.Thought(RedactedThinkingBlock(), m, "k")))
        // a time the phone measured counts until the hub has one
        val entries = listOf(WorkEntry.Thought(think(null), m, "k"), WorkEntry.Call(read("r", "a.dart"), "c"))
        assertEquals("Thought for 4s, read a.dart", ToolLines.workSummary(Work.steps(entries, mapOf("a" to 4_000L))))
    }

    @Test
    fun whatACallDoesWhileItRuns() {
        assertEquals("Running bun test", ToolLines.working(use("b", "Bash", "command" to "cd /x && bun test src")))
        assertEquals("Reading vault_entry.dart", ToolLines.working(read("r", "vault_entry.dart")))
        assertEquals("Editing a.dart", ToolLines.working(use("e", "Edit", "file_path" to "/x/a.dart")))
        assertEquals("Searching for jwt", ToolLines.working(use("g", "Grep", "pattern" to "jwt")))
        assertEquals("Searching the web", ToolLines.working(use("w", "WebSearch", "query" to "x")))
        assertEquals("Reading caddyserver.com", ToolLines.working(use("f", "WebFetch", "url" to "https://www.caddyserver.com/docs")))
        assertEquals("Running deep-research", ToolLines.working(use("w", "Workflow", "name" to "deep-research")))
        assertEquals("Using github create_issue", ToolLines.working(use("m", "mcp__github__create_issue")))
        assertEquals("Working", ToolLines.working(use("o", "Mystery")))
    }
}
