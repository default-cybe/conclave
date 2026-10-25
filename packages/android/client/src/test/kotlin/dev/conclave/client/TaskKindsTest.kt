package dev.conclave.client

import dev.conclave.client.logic.RunningTask
import dev.conclave.client.logic.TaskGlyph
import dev.conclave.client.logic.TaskKind
import dev.conclave.client.logic.TaskKinds
import dev.conclave.client.logic.Tasks
import dev.conclave.client.model.Session
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.model.WorkflowRun
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class TaskKindsTest {
    private fun use(id: String, name: String, vararg pairs: Pair<String, String>) =
        ToolUseBlock(id, name, JsonObject(pairs.associate { (k, v) -> k to JsonPrimitive(v) }))

    @Test
    fun eachKindAndAgentTypeHasItsGlyph() {
        assertEquals(TaskGlyph.FLOW, TaskKinds.glyph(TaskKind.WORKFLOW))
        assertEquals(TaskGlyph.DEVICE, TaskKinds.glyph(TaskKind.DELEGATE, "explore"))
        assertEquals(TaskGlyph.SEARCH, TaskKinds.glyph(TaskKind.SUBAGENT, "explore"))
        assertEquals(TaskGlyph.BUILD, TaskKinds.glyph(TaskKind.SUBAGENT, "Builder"))
        assertEquals(TaskGlyph.TEST, TaskKinds.glyph(TaskKind.SUBAGENT, "tester"))
        assertEquals(TaskGlyph.REVIEW, TaskKinds.glyph(TaskKind.SUBAGENT, "reviewer"))
        assertEquals(TaskGlyph.DEBUG, TaskKinds.glyph(TaskKind.SUBAGENT, "debugger"))
        assertEquals(TaskGlyph.RESEARCH, TaskKinds.glyph(TaskKind.SUBAGENT, "researcher"))
        assertEquals(TaskGlyph.DESIGN, TaskKinds.glyph(TaskKind.SUBAGENT, "designer"))
        assertEquals(TaskGlyph.VERIFY, TaskKinds.glyph(TaskKind.SUBAGENT, "verifier"))
        assertEquals(TaskGlyph.BOT, TaskKinds.glyph(TaskKind.SUBAGENT, "general-purpose"))
        assertEquals(TaskGlyph.BOT, TaskKinds.glyph(TaskKind.SUBAGENT, null))
    }

    @Test
    fun groupsWorkflowsFirstAndKeepOrder() {
        val a = RunningTask.Agent(use("t1", "Task", "subagent_type" to "explore"), null)
        val d = RunningTask.Agent(use("d1", "Delegate", "device" to "arch"), null)
        val f = RunningTask.Flow(WorkflowRun("wfr_1"), null)
        val b = RunningTask.Agent(use("t2", "Task"), null)
        assertEquals(listOf(TaskKind.SUBAGENT, TaskKind.DELEGATE, TaskKind.WORKFLOW), listOf(a, d, f).map { TaskKinds.kind(it) })
        val groups = TaskKinds.grouped(listOf(a, d, f, b))
        assertEquals(listOf(TaskKind.WORKFLOW, TaskKind.SUBAGENT, TaskKind.DELEGATE), groups.map { it.first })
        assertEquals(listOf(a, b), groups[1].second)
        assertEquals(listOf(TaskKind.SUBAGENT), TaskKinds.grouped(listOf(a)).map { it.first })
    }

    @Test
    fun modelFromTheSessionElseTheCall() {
        assertEquals("Haiku 5.5", Tasks.model(use("t1", "Task"), Session("c1", model = "anthropic/claude-haiku-5-5")))
        assertEquals("Sonnet 5.5", Tasks.model(use("t1", "Task", "model" to "anthropic/claude-sonnet-5-5"), null))
        assertNull(Tasks.model(use("t1", "Task"), null))
    }
}
