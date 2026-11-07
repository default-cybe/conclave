package dev.conclave.client.logic

import dev.conclave.client.model.Task
import dev.conclave.client.model.TaskStatus
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/*
 * Notes: the account's to-do line at the top of every chat, as on the web
 * (packages/web/src/features/chat/notes.ts). They are tasks with the "note"
 * label, kept in the order of meta.noteOrder (else when they were made). A
 * note checked off stays a day, then only the Tasks screen has it.
 */
object Notes {
    const val LABEL = "note"
    private const val DAY = 86_400_000L

    private fun orderOf(t: Task): Double =
        (t.meta?.get("noteOrder") as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull ?: t.createdAt.toDouble()

    /** The line's notes: open ones in their order, then the ones checked off in the last day. */
    fun shown(tasks: List<Task>, now: Long): List<Task> {
        val notes = tasks.filter { LABEL in it.labels }
        val open = notes.filter { it.status != TaskStatus.DONE }.sortedBy(::orderOf)
        val done = notes.filter { it.status == TaskStatus.DONE && now - it.updatedAt < DAY }.sortedByDescending { it.updatedAt }
        return open + done
    }

    /** "3 to do: Call the bank", or "All done" once every note is checked off. */
    fun line(notes: List<Task>): String {
        val open = notes.filter { it.status != TaskStatus.DONE }
        return if (open.isEmpty()) "All done" else "${open.size} to do: ${open.first().title}"
    }
}
