package dev.conclave.client.logic

/*
 * What kind of background task a row shows (a workflow, a subagent, a job
 * delegated to a device) and the icon it leads with. The app draws each
 * glyph (ui/conversation/Tasks.kt taskIcon); one place, so a later motion
 * pack can swap the icons without touching the rows. The web keeps the same
 * mapping in lib/taskKinds.ts.
 */

/** A background task's kind, its word on a row and its heading in the list. */
enum class TaskKind(val label: String, val group: String) {
    WORKFLOW("Workflow", "Workflows"),
    SUBAGENT("Subagent", "Subagents"),
    DELEGATE("Delegate", "Delegated"),
}

/** The icon a task row leads with. */
enum class TaskGlyph { FLOW, DEVICE, SEARCH, BUILD, TEST, REVIEW, DEBUG, RESEARCH, DESIGN, VERIFY, BOT }

object TaskKinds {
    private val AGENTS = mapOf(
        "explore" to TaskGlyph.SEARCH,
        "builder" to TaskGlyph.BUILD,
        "tester" to TaskGlyph.TEST,
        "reviewer" to TaskGlyph.REVIEW,
        "debugger" to TaskGlyph.DEBUG,
        "researcher" to TaskGlyph.RESEARCH,
        "designer" to TaskGlyph.DESIGN,
        "verifier" to TaskGlyph.VERIFY,
    )

    /** A flow for a workflow, a device for a delegated job, the agent's own for a subagent (a bot when it has none). */
    fun glyph(kind: TaskKind, agent: String? = null): TaskGlyph = when (kind) {
        TaskKind.WORKFLOW -> TaskGlyph.FLOW
        TaskKind.DELEGATE -> TaskGlyph.DEVICE
        TaskKind.SUBAGENT -> agent?.lowercase()?.let { AGENTS[it] } ?: TaskGlyph.BOT
    }

    /** A Delegate call draws as a subagent, but its row says Delegate. */
    fun kind(t: RunningTask): TaskKind = when (t) {
        is RunningTask.Flow -> TaskKind.WORKFLOW
        is RunningTask.Agent -> if (Tasks.isDelegate(t.use)) TaskKind.DELEGATE else TaskKind.SUBAGENT
    }

    /** The tasks by kind, workflows first; each group keeps its order, empty groups are left out. */
    fun grouped(tasks: List<RunningTask>): List<Pair<TaskKind, List<RunningTask>>> =
        TaskKind.entries.mapNotNull { k -> tasks.filter { kind(it) == k }.takeIf { it.isNotEmpty() }?.let { k to it } }
}
