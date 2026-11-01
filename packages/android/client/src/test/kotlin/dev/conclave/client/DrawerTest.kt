package dev.conclave.client

import dev.conclave.client.logic.Drawer
import dev.conclave.client.logic.GroupBy
import dev.conclave.client.logic.RecentDot
import dev.conclave.client.logic.Start
import dev.conclave.client.logic.StartMode
import dev.conclave.client.model.Device
import dev.conclave.client.model.MachineInfo
import dev.conclave.client.model.Project
import dev.conclave.client.model.ProjectLocation
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionKind
import dev.conclave.client.model.SessionStatus
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals

class DrawerTest {
    private val zone: ZoneId = ZoneOffset.UTC
    private fun at(day: Int, h: Int): Long = LocalDateTime.of(2026, 10, day, h, 0).toInstant(ZoneOffset.UTC).toEpochMilli()
    private val now = at(22, 18)

    private fun chat(id: String, updated: Long, title: String = id) = Session(id, title = title, kind = SessionKind.CHAT, updatedAt = updated)

    private fun code(id: String, updated: Long, device: String = "mac", cwd: String = "/Users/sam/$id", projectId: String? = null, status: SessionStatus = SessionStatus.IDLE) =
        Session(id, title = id, agent = "coder", device = device, cwd = cwd, projectId = projectId, status = status, updatedAt = updated)

    private val home = mapOf(
        "mac" to Device("mac", name = "MacBook", info = MachineInfo(home = "/Users/sam")),
        "local" to Device("local", name = "homelab", info = MachineInfo(home = "/home/sam")),
    )

    private val conclave = Project(
        "p1",
        name = "conclave",
        locations = listOf(
            ProjectLocation("p1", device = "mac", path = "/Users/sam/src/conclave"),
            ProjectLocation("p1", device = "local", path = "/home/sam/conclave"),
        ),
    )

    @Test
    fun groupByIsStoredByItsWireWordAndProjectIsTheDefault() {
        assertEquals(GroupBy.DEVICE, GroupBy.from("device"))
        assertEquals(GroupBy.TIME, GroupBy.from("time"))
        assertEquals(GroupBy.PROJECT, GroupBy.from(null))
        assertEquals(GroupBy.PROJECT, GroupBy.from("agent"))
        assertEquals(listOf("Project", "Device", "Time"), GroupBy.entries.map { it.label })
    }

    @Test
    fun timeGroupsAreTodayYesterdayThisWeekAndOlder() {
        assertEquals("Today", Drawer.timeGroup(at(22, 1), now, zone).second)
        assertEquals("Yesterday", Drawer.timeGroup(at(21, 23), now, zone).second)
        assertEquals("This week", Drawer.timeGroup(at(20, 12), now, zone).second)
        assertEquals("This week", Drawer.timeGroup(at(16, 12), now, zone).second)
        assertEquals("Older", Drawer.timeGroup(at(15, 12), now, zone).second)
        assertEquals("Older", Drawer.timeGroup(at(1, 12), now, zone).second)
        // a clock a little ahead on another device is still today
        assertEquals("Today", Drawer.timeGroup(at(22, 19), now, zone).second)
    }

    @Test
    fun byTimeTheGroupsComeInOrderWithTheNewestFirstInEach() {
        val sessions = listOf(
            chat("a", at(22, 9)),
            chat("b", at(22, 11)),
            chat("c", at(21, 9)),
            chat("d", at(18, 9)),
            chat("e", at(2, 9)),
        )
        val groups = Drawer.groups(sessions, StartMode.CHAT, GroupBy.TIME, now = now, zone = zone)
        assertEquals(listOf("Today", "Yesterday", "This week", "Older"), groups.map { it.title })
        assertEquals(listOf("b", "a"), groups[0].items.map { it.id })
    }

    @Test
    fun onlyTheModesConversationsAreListedAndNotTheArchiveSubagentsOrWorkflowAgents() {
        val workflow = buildJsonObject { putJsonObject("workflow") { put("runId", "run-1") } }
        val sessions = listOf(
            chat("chat", at(22, 9)),
            chat("archived", at(22, 10)).copy(archived = true),
            code("code", at(22, 11)),
            code("sub", at(22, 12)).copy(parentId = "code"),
            code("wf", at(22, 13)).copy(meta = workflow),
            Session("assistant", title = "Plan", agent = Start.ASSISTANT_AGENT, device = "local", updatedAt = at(22, 14)),
        )
        val ids = { m: StartMode? -> Drawer.groups(sessions, m, GroupBy.TIME, now = now, zone = zone).flatMap { g -> g.items.map { it.id } } }
        assertEquals(listOf("chat"), ids(StartMode.CHAT))
        assertEquals(listOf("code"), ids(StartMode.CODE))
        assertEquals(listOf("assistant"), ids(StartMode.ASSISTANT))
        assertEquals(listOf("assistant", "code", "chat"), ids(null))
    }

    @Test
    fun pinnedComeFirstWhateverTheGrouping() {
        val sessions = listOf(
            code("pinned", at(10, 9), cwd = "/Users/sam/src/conclave").copy(pinned = true),
            code("today", at(22, 9), cwd = "/Users/sam/src/conclave"),
        )
        for (by in GroupBy.entries) {
            val groups = Drawer.groups(sessions, StartMode.CODE, by, projects = listOf(conclave), devices = home.values.toList(), now = now, zone = zone)
            assertEquals("Pinned", groups.first().title, by.name)
            assertEquals(listOf("pinned"), groups.first().items.map { it.id })
            assertEquals(listOf("today"), groups.drop(1).flatMap { g -> g.items.map { it.id } })
        }
    }

    @Test
    fun byProjectOneGroupHoldsTheProjectOnEveryDevice() {
        val sessions = listOf(
            code("mac-known", at(22, 9), projectId = "p1", cwd = "/Users/sam/src/conclave/packages"),
            code("hub-found", at(22, 10), device = "local", cwd = "~/conclave/packages/android"),
            code("other", at(22, 8), cwd = "/Users/sam/src/notes"),
            code("other-too", at(21, 8), device = "local", cwd = "/srv/Notes"),
            code("home", at(22, 11), cwd = "~"),
            code("no-folder", at(22, 7), device = "local", cwd = ""),
        )
        val groups = Drawer.groups(sessions, StartMode.CODE, GroupBy.PROJECT, projects = listOf(conclave), devices = home.values.toList(), now = now, zone = zone)
        assertEquals(listOf("conclave", "notes", "No project"), groups.map { it.title })
        assertEquals(listOf("hub-found", "mac-known"), groups[0].items.map { it.id })
        // a folder of the same name on another device keeps them together until the hub knows them as one project
        assertEquals(listOf("other", "other-too"), groups[1].items.map { it.id })
        assertEquals(listOf("home", "no-folder"), groups[2].items.map { it.id })
    }

    @Test
    fun byProjectTheDeepestLocationWinsAndAnUnloadedProjectStillGroups() {
        val inner = Project("p2", name = "android app", locations = listOf(ProjectLocation("p2", device = "mac", path = "/Users/sam/src/conclave/packages/android/")))
        val projects = mapOf("p1" to conclave, "p2" to inner)
        assertEquals("p:p2" to "android app", Drawer.projectGroup(code("x", 1, cwd = "/Users/sam/src/conclave/packages/android/app"), projects, home))
        assertEquals("p:p1" to "conclave", Drawer.projectGroup(code("y", 1, cwd = "/Users/sam/src/conclave/docs"), projects, home))
        // a location on another device does not count
        assertEquals("f:conclave" to "conclave", Drawer.projectGroup(code("z", 1, device = "pc", cwd = "/Users/sam/src/conclave"), projects, home))
        // the project id is known but not the project: its folder names the group, under the project's key
        assertEquals("p:p9" to "site", Drawer.projectGroup(code("w", 1, cwd = "/Users/sam/site/", projectId = "p9"), projects, home))
        // a Windows folder
        assertEquals("f:game" to "Game", Drawer.projectGroup(code("v", 1, device = "pc", cwd = "C:\\Users\\sam\\Game"), projects, home))
        // a project without a name takes its folder's
        val nameless = mapOf("p3" to Project("p3"))
        assertEquals("p:p3" to "api", Drawer.projectGroup(code("u", 1, cwd = "/Users/sam/api", projectId = "p3"), nameless, home))
    }

    @Test
    fun byProjectChatsGoLastUnderChats() {
        val sessions = listOf(
            chat("chat", at(22, 12)),
            code("code", at(22, 9), cwd = "/Users/sam/src/conclave"),
            code("loose", at(22, 10), cwd = ""),
        )
        val groups = Drawer.groups(sessions, null, GroupBy.PROJECT, projects = listOf(conclave), devices = home.values.toList(), now = now, zone = zone)
        assertEquals(listOf("conclave", "No project", "Chats"), groups.map { it.title })
    }

    @Test
    fun byDeviceOneGroupPerDeviceNewestFirst() {
        val sessions = listOf(
            code("a", at(22, 9)),
            code("b", at(22, 12), device = "local"),
            code("c", at(22, 10)),
            code("d", at(22, 8), device = "pi"),
            code("e", at(22, 7), device = ""),
        )
        val groups = Drawer.groups(sessions, StartMode.CODE, GroupBy.DEVICE, devices = home.values.toList(), now = now, zone = zone)
        assertEquals(listOf("homelab", "MacBook", "pi"), groups.map { it.title })
        assertEquals(listOf("b", "e"), groups[0].items.map { it.id })
        assertEquals(listOf("c", "a"), groups[1].items.map { it.id })
        assertEquals("d:local" to "Hub", Drawer.deviceGroup(code("f", 1, device = "local"), emptyMap()))
    }

    @Test
    fun searchKeepsWhatMatchesInItsGroups() {
        val sessions = listOf(
            chat("plan", at(22, 9), title = "Plan the week"),
            chat("trip", at(22, 8), title = "Trip to Lisbon"),
            code("fix", at(22, 10), cwd = "/Users/sam/src/conclave").copy(title = "Fix the login"),
            code("notes", at(21, 10), device = "local", cwd = "/srv/notes").copy(title = "Tidy up"),
        )
        val ids = { m: StartMode?, by: GroupBy, q: String ->
            Drawer.groups(sessions, m, by, projects = listOf(conclave), devices = home.values.toList(), query = q, now = now, zone = zone).flatMap { g -> g.items.map { it.id } }
        }
        assertEquals(listOf("plan"), ids(StartMode.CHAT, GroupBy.TIME, " PLAN "))
        assertEquals(listOf("plan", "trip"), ids(StartMode.CHAT, GroupBy.TIME, ""))
        assertEquals(emptyList(), ids(StartMode.CHAT, GroupBy.TIME, "conclave"))
        // a session by its folder, its agent, or the project or device it is grouped under
        assertEquals(listOf("notes"), ids(StartMode.CODE, GroupBy.TIME, "notes"))
        assertEquals(listOf("fix", "notes"), ids(StartMode.CODE, GroupBy.TIME, "coder"))
        assertEquals(listOf("fix"), ids(StartMode.CODE, GroupBy.PROJECT, "conclave"))
        assertEquals(listOf("notes"), ids(StartMode.CODE, GroupBy.DEVICE, "homelab"))
        // the groups keep their titles
        assertEquals(listOf("conclave"), Drawer.groups(sessions, StartMode.CODE, GroupBy.PROJECT, projects = listOf(conclave), devices = home.values.toList(), query = "login", now = now, zone = zone).map { it.title })
    }

    @Test
    fun rowsCarryTheirTitleAndDot() {
        val sessions = listOf(
            code("run", at(22, 9), status = SessionStatus.RUNNING),
            code("ask", at(22, 8)),
            Session("blank", device = "mac", cwd = "/Users/sam/x", updatedAt = at(22, 7)),
        )
        val items = Drawer.groups(sessions, StartMode.CODE, GroupBy.TIME, waiting = setOf("ask"), now = now, zone = zone).single().items
        assertEquals(listOf(RecentDot.RUNNING, RecentDot.WAITING, RecentDot.NONE), items.map { it.dot })
        assertEquals("New session", items[2].title)
    }

    @Test
    fun theAccountRowNamesTheOwnerAndTheHubsState() {
        val named = Drawer.account("Kai", "homelab", ConnectionState.OPEN)
        assertEquals("K", named.initial)
        assertEquals("Kai", named.name)
        assertEquals("homelab · online", named.line)
        // no name set: the hub's name, and its state alone
        val unnamed = Drawer.account(" ", "homelab", ConnectionState.CLOSED)
        assertEquals("homelab", unnamed.name)
        assertEquals("H", unnamed.initial)
        assertEquals("Offline, retrying", unnamed.line)
        assertEquals("No network", Drawer.account(null, null, ConnectionState.CLOSED, noNetwork = true).line)
        assertEquals("Hub", Drawer.account(null, null, ConnectionState.CONNECTING).name)
        assertEquals("Connecting", Drawer.account(null, null, ConnectionState.CONNECTING).line)
    }

    @Test
    fun theAvatarLetterIsTheFirstLetterOrDigit() {
        assertEquals("É", Drawer.initial("élodie"))
        assertEquals("S", Drawer.initial("  @sam"))
        assertEquals("4", Drawer.initial("42"))
        assertEquals("?", Drawer.initial(""))
        // no letter: the first character whole, never half of it
        assertEquals("😀", Drawer.initial(" 😀 "))
    }
}
