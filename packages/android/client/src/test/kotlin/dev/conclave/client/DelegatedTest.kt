package dev.conclave.client

import dev.conclave.client.logic.Delegated
import dev.conclave.client.logic.DelegatedRow
import dev.conclave.client.logic.Drawer
import dev.conclave.client.logic.GroupBy
import dev.conclave.client.logic.Panel
import dev.conclave.client.logic.RecentDot
import dev.conclave.client.logic.StartMode
import dev.conclave.client.logic.Tasks
import dev.conclave.client.model.Device
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionKind
import dev.conclave.client.model.SessionStatus
import dev.conclave.client.model.ToolUseBlock
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Delegated work in the side panel (logic/Drawer.kt, docs/DESIGN.md 43):
 * a Delegate call's sessions are a group of their own in every mode, not in
 * the mode's list; moved to the main list they are a normal session of their
 * kind there, their parentId kept, and the call that started one still
 * finds it.
 */
class DelegatedTest {
    private val now = 1_800_000_000_000L
    private fun min(n: Int) = n * 60_000L

    private fun place(to: String, device: String, name: String, call: String) = buildJsonObject {
        put("to", to); put("device", device); put("deviceName", name); put("folder", "/home/kai/capstone"); put("toolUseId", call)
    }

    private fun delegated(id: String, title: String, agent: String, parent: String, device: String, mark: JsonObject, updated: Long, status: SessionStatus = SessionStatus.IDLE, archived: Boolean = false) =
        Session(id, title = title, agent = agent, parentId = parent, device = device, status = status, archived = archived, tags = listOf("subagent", "delegated"), updatedAt = updated, meta = buildJsonObject { put("subagent", true); put("delegate", mark) })

    /** What the hub sends once the session moved to the main list (core session/delegated.ts movedSession). */
    private fun moved(s: Session) = s.copy(
        tags = emptyList(),
        updatedAt = now,
        meta = buildJsonObject { put("movedFrom", JsonObject(Delegated.mark(s)!! + ("at" to JsonPrimitive(now)))) },
    )

    private val devices = listOf(Device("arch", name = "MadX Arch"), Device("local", name = "homelab"))
    private val chat = Session("chat", title = "Capstone", agent = "chat", kind = SessionKind.CHAT, updatedAt = now - min(2))
    private val plan = Session("plan", title = "Plan my week", agent = "assistant", updatedAt = now - min(50))
    private val names = delegated("names", "Find names in the capstone PDFs", "explore", "chat", "arch", place("code", "arch", "MadX Arch", "d1"), now - min(5))
    private val draft = delegated("draft", "Draft the reply", "assistant", "chat", "local", place("assistant", "local", "homelab", "d2"), now - min(1), SessionStatus.RUNNING)
    private val pdf = delegated("pdf", "Find the booking PDF", "explore", "plan", "arch", place("code", "arch", "MadX Arch", "d3"), now - min(90))
    private val old = delegated("old", "Old job", "explore", "chat", "local", place("code", "local", "homelab", "d4"), now - min(9), archived = true)
    private val sub = Session("sub", title = "A subagent", agent = "explore", parentId = "chat", tags = listOf("subagent"), updatedAt = now, meta = buildJsonObject { put("subagent", true) })
    private val all = listOf(chat, plan, names, draft, pdf, old, sub)

    private fun main(list: List<Session>, mode: StartMode) = Drawer.groups(list, mode, GroupBy.TIME, now = now).flatMap { g -> g.items.map { it.id } }

    @Test
    fun delegatedWorkIsAGroupOfItsOwnAndNotInAnyModesList() {
        assertEquals(listOf("draft", "names", "pdf"), Drawer.delegated(all, devices = devices).map { it.id })
        assertEquals(listOf("chat"), main(all, StartMode.CHAT))
        assertEquals(listOf("plan"), main(all, StartMode.ASSISTANT))
        assertEquals(emptyList<String>(), main(all, StartMode.CODE))
        assertTrue(Delegated.isDelegated(names))
        assertFalse(Delegated.isDelegated(sub))
        assertFalse(Panel.shown(names))
        assertEquals("Delegated work", Delegated.WORDS)
        assertEquals("Move to main list", Delegated.MOVE)
    }

    @Test
    fun aRowSaysWhoDidItWhereAndWhereItCameFrom() {
        val rows = Drawer.delegated(all, waiting = setOf("names"), devices = devices)
        assertEquals(DelegatedRow("draft", "Draft the reply", "Assistant on homelab", "from Capstone chat", RecentDot.RUNNING), rows[0])
        assertEquals(DelegatedRow("names", "Find names in the capstone PDFs", "Code on MadX Arch", "from Capstone chat", RecentDot.WAITING), rows[1])
        assertEquals("from Plan my week in Assistant", rows[2].from)
        // the device's name as the call saw it when the phone does not know the device; no parent, no second line
        val alone = Drawer.delegated(listOf(names))
        assertEquals("Code on MadX Arch", alone.single().who)
        assertNull(alone.single().from)
        assertEquals("from New chat", Delegated.from(chat.copy(title = "New chat")))
        assertEquals("from Fix auth in Code", Delegated.from(Session("c", title = "Fix auth", agent = "coder")))
        assertEquals(1, Drawer.delegated(all, limit = 1).size)
    }

    @Test
    fun searchFindsDelegatedWorkByTitleWhoAndWhere() {
        assertEquals(listOf("names"), Drawer.delegated(all, devices = devices, query = "capstone pdfs").map { it.id })
        assertEquals(listOf("names", "pdf"), Drawer.delegated(all, devices = devices, query = "madx").map { it.id })
        assertEquals(listOf("pdf"), Drawer.delegated(all, devices = devices, query = "plan my week").map { it.id })
        assertEquals(emptyList<DelegatedRow>(), Drawer.delegated(all, devices = devices, query = "nothing like it"))
    }

    @Test
    fun movedToTheMainListItIsANormalSessionOfItsKindAndKeepsItsParent() {
        val m = moved(names)
        val after = all.map { if (it.id == "names") m else it }
        assertEquals("chat", m.parentId)
        assertTrue(Delegated.moved(m))
        assertFalse(Delegated.underParent(m))
        assertEquals(listOf("draft", "pdf"), Drawer.delegated(after, devices = devices).map { it.id })
        assertEquals(listOf("names"), main(after, StartMode.CODE))
        assertEquals(listOf("chat"), main(after, StartMode.CHAT))
        // the assistant's job goes to the Assistant list
        val asst = all.map { if (it.id == "draft") moved(draft.copy(status = SessionStatus.IDLE)) else it }
        assertEquals(listOf("draft", "plan"), main(asst, StartMode.ASSISTANT))
        // the chat's call still finds it, by the call id it kept, and names where it ran
        val call = ToolUseBlock("d1", "Delegate", buildJsonObject { put("to", "code"); put("prompt", "List the names."); put("description", "Find names in the capstone PDFs") })
        val renamed = after.map { if (it.id == "names") it.copy(title = "Capstone names, kept") else it }
        assertEquals("names", Tasks.child(call, null, "chat", renamed)?.id)
        assertEquals("Code on MadX Arch", Tasks.handedTo(call, null, m))
    }

    @Test
    fun moveToMainListPostsToTheHub() = runBlocking {
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse(body = """{"id":"names","parentId":"chat","tags":[],"meta":{"movedFrom":{"to":"code","at":1}}}"""))
            val s = ConclaveClient(server.url("/").toString(), "t").moveToMainList("names")
            assertEquals("chat", s.parentId)
            assertTrue(Delegated.moved(s))
            val req = server.takeRequest()
            assertEquals("POST", req.method)
            assertEquals("/api/sessions/names/main-list", req.url.encodedPath)
        } finally {
            server.close()
        }
    }
}
