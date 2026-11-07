package dev.conclave.client

import dev.conclave.client.logic.Notes
import dev.conclave.client.model.Task
import dev.conclave.client.model.TaskStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

class NotesTest {
    private val now = 1_800_000_000_000L
    private val hour = 3_600_000L

    private fun note(title: String, order: Int? = null, status: TaskStatus = TaskStatus.TODO, updatedAt: Long = now - hour, labels: List<String> = listOf("note")) =
        Task(id = title, title = title, status = status, labels = labels, createdAt = now - hour, updatedAt = updatedAt, meta = order?.let { JsonObject(mapOf("noteOrder" to JsonPrimitive(it))) })

    @Test
    fun hiddenWithoutNotes() {
        assertTrue(Notes.shown(listOf(note("Fix login", labels = emptyList())), now).isEmpty())
    }

    @Test
    fun firstOpenNoteInOrder() {
        val shown = Notes.shown(listOf(note("Call the bank", 2), note("Renew passport", 1), note("Book flights", 3)), now)
        assertEquals(listOf("Renew passport", "Call the bank", "Book flights"), shown.map { it.title })
        assertEquals("3 to do: Renew passport", Notes.line(shown))
    }

    @Test
    fun checkedNoteStaysADay() {
        val shown = Notes.shown(listOf(note("Pay rent", status = TaskStatus.DONE), note("Old", status = TaskStatus.DONE, updatedAt = now - 25 * hour), note("Call the bank")), now)
        assertEquals(listOf("Call the bank", "Pay rent"), shown.map { it.title })
        assertEquals("1 to do: Call the bank", Notes.line(shown))
        assertEquals("All done", Notes.line(shown.drop(1)))
    }
}
