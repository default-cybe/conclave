package dev.conclave.client.logic

import dev.conclave.client.model.DocumentBlock
import dev.conclave.client.model.ImageBlock
import dev.conclave.client.model.Message
import dev.conclave.client.model.MessageKind
import dev.conclave.client.model.Role
import dev.conclave.client.model.TextBlock
import dev.conclave.client.model.isReminder
import dev.conclave.client.model.obj
import dev.conclave.client.model.plainText
import dev.conclave.client.model.string

/**
 * A background task that ended and reported back (core types.ts
 * AgentResultRef): a Task or Delegate subagent ([id]: its session) or a
 * workflow run ([id]: the run). The hub writes a notice line and hands the
 * report to the model in a user message that holds only a reminder; the
 * app draws the two as one compact row, "Message from subagent ...", that
 * opens to the report. The same rules as packages/web/src/features/chat/agentResult.ts.
 */
data class AgentResult(
    val type: String,
    val id: String,
    val label: String,
    val agent: String? = null,
    /** completed, failed or stopped. */
    val state: String,
    /** The report, once the message that carries it is in the list. */
    val report: String? = null,
) {
    /** "Message from subagent count widgets" or "Message from workflow deep-research". */
    val title: String get() = "Message from ${if (type == "workflow") "workflow" else "subagent"} $label".trim()

    /** done, failed or stopped. */
    val stateWord: String get() = if (state == "completed") "done" else state

    val failed: Boolean get() = state == "failed"
}

object AgentResults {
    private val SUBAGENT = Regex("""<subagent_result session="([^"]*)" agent="([^"]*)" state="([^"]*)" description="([^"]*)">\n?([\s\S]*?)\n?</subagent_result>""")
    private val WORKFLOW = Regex("""<workflow_result run="([^"]*)" name="([^"]*)" status="([^"]*)">\n?([\s\S]*?)\n?</workflow_result>""")
    /** A hub from before meta.agentResult wrote only this line. */
    private val OLD_NOTICE = Regex("""^Background task (finished|failed): (.+?)\.?$""")

    /** The reports in a block of text the hub wrote for the model. */
    fun parse(text: String): List<AgentResult> =
        SUBAGENT.findAll(text).map { m ->
            val (id, agent, state, label, report) = m.destructured
            AgentResult("subagent", id, label, agent, if (state == "completed") "completed" else "failed", report.trim())
        }.toList() + WORKFLOW.findAll(text).map { m ->
            val (id, label, status, report) = m.destructured
            AgentResult("workflow", id, label, null, when (status) { "done" -> "completed"; "stopped" -> "stopped"; else -> "failed" }, report.trim())
        }.toList()

    /** The reports a user message hands the model. */
    fun resultsIn(m: Message): List<AgentResult> =
        if (m.role != Role.USER) emptyList()
        else m.content.filterIsInstance<TextBlock>().filter { "_result " in it.text }.flatMap { parse(it.text) }

    /** The task a notice line is about: meta.agentResult, or the words of a hub from before it. Null for any other notice. */
    fun ofNotice(m: Message): AgentResult? {
        if (m.kind != MessageKind.NOTICE) return null
        val meta = m.meta
        val ref = meta?.obj("agentResult")
        if (meta?.string("kind") == "agent-result" && ref != null) {
            val type = ref.string("type") ?: return null
            return AgentResult(type, ref.string("id") ?: "", ref.string("label") ?: "", ref.string("agent"), ref.string("state") ?: "completed")
        }
        val old = OLD_NOTICE.find(m.content.plainText()) ?: return null
        return AgentResult("subagent", "", old.groupValues[2], null, if (old.groupValues[1] == "finished") "completed" else "failed")
    }

    /** How the hub writes a label into the block's attribute (core engine/subagent.ts attr). */
    private fun attr(v: String): String = v.replace(Regex("[\r\n]+"), " ").replace('"', '\'').replace('<', '(').replace('>', ')')

    /** The report of [ref] from the message that carries it, at or after seq [after]: by id, or by label for an old notice. */
    fun reportFor(messages: List<Message>, ref: AgentResult, after: Long = 0): String? {
        for (m in messages) {
            if (m.role != Role.USER || m.seq < after) continue
            for (r in resultsIn(m)) {
                if (r.type != ref.type) continue
                if (if (ref.id.isNotEmpty()) r.id == ref.id else r.label == attr(ref.label)) return r.report
            }
        }
        return null
    }

    /** The row for a notice line, with its report when the list has it. */
    fun forNotice(messages: List<Message>, notice: Message): AgentResult? =
        ofNotice(notice)?.let { it.copy(report = reportFor(messages, it, notice.seq)) }

    /**
     * A user message the owner never wrote: only hub context (a background
     * task's report, hook feedback), maybe after tool results, or nothing at
     * all. It draws no bubble.
     */
    fun isContextOnly(m: Message): Boolean =
        m.role == Role.USER && m.content.none { b -> (b is TextBlock && b.text.isNotBlank() && !b.isReminder()) || b is ImageBlock || b is DocumentBlock }
}
