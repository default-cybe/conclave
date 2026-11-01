package dev.conclave.client

import dev.conclave.client.logic.ImportPick
import dev.conclave.client.logic.ImportWords
import dev.conclave.client.logic.PickState
import dev.conclave.client.logic.StateTone
import dev.conclave.client.model.Device
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.ExternalSessionInfo
import dev.conclave.client.model.ImportBatch
import dev.conclave.client.model.ImportBatchStatus
import dev.conclave.client.model.ImportEstimate
import dev.conclave.client.model.ImportMode
import dev.conclave.client.model.ImportQuery
import dev.conclave.client.model.ImportRequest
import dev.conclave.client.model.ImportSkip
import dev.conclave.client.model.ImportUndoResult
import dev.conclave.client.model.ImportedInfo
import dev.conclave.client.model.ImportedState
import dev.conclave.client.model.MachineInfo
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Starting a chat import from the phone: the scan decodes, the selection becomes the right request, and the words read right. */
class ImportTest {
    private lateinit var server: MockWebServer

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @AfterTest
    fun tearDown() {
        server.close()
    }

    private fun client() = ConclaveClient(server.url("/").toString(), "t")

    @Test
    fun scanSendsTheQueryTheHubReads() = runBlocking {
        server.enqueue(
            MockResponse(
                body = """{"items":[{"source":"claude-code","id":"a1","title":"Fix the build","cwd":"/home/kai/code/site","updatedAt":5,"messages":12,"device":"pc",
                  "key":"pc:claude-code:a1","path":"/home/kai/.claude/projects/x/a1.jsonl","fingerprint":"f","createdAt":1,"kind":"main","humanPrompts":4,"humanChars":300,"bytes":9000,"estTokens":2000,
                  "imported":{"sessionId":"s9","state":"behind","batchId":"b1","learned":false,"newThere":4}}],
                  "total":40,"scannedAt":7,"failed":[{"source":"codex","error":"permission denied"}],
                  "retention":[{"device":"pc","tool":"claude-code","file":"~/.claude/settings.json","setting":"cleanupPeriodDays","value":30,"risk":"high","text":"Claude Code deletes chats after 30 days.","fixable":true}],
                  "counts":{"new":30,"imported":10,"behind":1,"diverged":0,"skipped":3},
                  "groups":[{"key":"g1","name":"site","repo":"github.com/kai/site","sources":["claude-code","opencode-next"],"sessions":40,"imported":10,"skipped":3,"first":1,"last":5}],
                  "unknown":{"queue-operation":2}}""",
            ),
        )
        val page = client().importScan(device = "pc", sources = listOf("claude-code", "codex"), since = 100, includeImported = false, includeSkipped = true, limit = 1, refresh = true)
        val url = server.takeRequest().url
        assertEquals("/api/import/scan", url.encodedPath)
        assertEquals("pc", url.queryParameter("device"))
        assertEquals("claude-code,codex", url.queryParameter("sources"))
        assertEquals("100", url.queryParameter("since"))
        assertEquals("0", url.queryParameter("includeImported"))
        assertEquals("1", url.queryParameter("includeSkipped"))
        assertEquals("1", url.queryParameter("refresh"))
        assertNull(url.queryParameter("project"))
        assertEquals(40, page.total)
        assertEquals("site", page.groups!!.single().name)
        assertEquals(4, page.items.single().imported?.newThere)
        assertEquals("4 new there", ImportWords.rowState(page.items.single()).word)
        assertEquals("high", page.retention.single().risk)
        assertEquals("permission denied", page.failed.single().error)
        // a source the app does not know still shows by its id
        assertEquals("opencode-next", ImportWords.sourceName(page.groups!!.single().sources[1]))
        assertEquals("Claude Code", ImportWords.sourceName("claude-code"))
    }

    @Test
    fun batchCallsAndTheEvent() = runBlocking {
        server.enqueue(MockResponse(body = """{"id":"b1","device":"pc","mode":"chats-learn","status":"importing","total":212,"createdAt":1,"updatedAt":2}"""))
        val b = client().startImport(ImportRequest(device = "pc", mode = ImportMode.CHATS_LEARN, keys = listOf("k1", "k2")))
        val start = server.takeRequest()
        assertEquals("/api/import/batches", start.url.encodedPath)
        assertEquals("""{"device":"pc","mode":"chats-learn","keys":["k1","k2"]}""", start.body?.utf8())
        assertEquals(ImportBatchStatus.IMPORTING, b.status)

        server.enqueue(MockResponse(body = """{"sessionsRemoved":3,"messagesRemoved":40,"memoriesRemoved":7,"supersedesCleared":0,"kept":[{"id":"m1","content":"x"}],"keptSessions":[{"id":"s1","title":"t"}]}"""))
        val undo = client().undoImport("b 1")
        assertEquals("/api/import/batches/b%201/undo", server.takeRequest().url.encodedPath)
        assertEquals(
            "Undid the import: 3 sessions, 40 messages and 7 memories removed. 1 memory you edited since was kept. 1 session you kept going in was kept.",
            ImportWords.undoLine(undo),
        )

        server.enqueue(MockResponse(body = """[{"device":"pc","tool":"claude-code","risk":"none","text":"Kept for 10 years.","fixable":false}]"""))
        client().fixImportRetention("pc", "claude-code")
        val fix = ConclaveJson.parseToJsonElement(server.takeRequest().body!!.utf8()).jsonObject
        assertEquals(setOf("device", "tool"), fix.keys)

        val e = (Frame.parse("""{"type":"import.batch","seq":3,"ts":1,"batch":{"id":"b1","status":"learning","mode":"learn","total":5,"learnedSessions":2}}""") as Frame.Event).envelope.event
        assertEquals(ImportBatchStatus.LEARNING, (e as EngineEvent.ImportBatchUpdated).batch.status)
    }

    @Test
    fun aWholeProjectIsReadPageAfterPage() = runBlocking {
        fun item(k: String) = """{"source":"codex","id":"$k","key":"$k"}"""
        server.enqueue(MockResponse(body = """{"items":[${item("a")},${item("b")}],"next":"c1","total":5}"""))
        server.enqueue(MockResponse(body = """{"items":[${item("c")},${item("d")}],"next":"c2","total":5}"""))
        server.enqueue(MockResponse(body = """{"items":[${item("e")}],"total":5}"""))
        val all = client().importScanAll(device = "pc", project = "g1", includeImported = true, pageSize = 2)
        assertEquals(listOf("a", "b", "c", "d", "e"), all.map { it.key })
        val first = server.takeRequest().url
        assertEquals("g1", first.queryParameter("project"))
        assertNull(first.queryParameter("cursor"))
        assertEquals("2", first.queryParameter("limit"))
        assertEquals("c1", server.takeRequest().url.queryParameter("cursor"))
        assertEquals("c2", server.takeRequest().url.queryParameter("cursor"))

        // a hub that hands back the same cursor stops after the repeat, and max caps the rows
        repeat(2) { server.enqueue(MockResponse(body = """{"items":[${item("x$it")}],"next":"same","total":9}""")) }
        assertEquals(2, client().importScanAll(device = "pc", project = "g2").size)
        repeat(2) { server.takeRequest() }
        server.enqueue(MockResponse(body = """{"items":[${item("p")},${item("q")},${item("r")}],"next":"more","total":9}"""))
        assertEquals(listOf("p", "q"), client().importScanAll(device = "pc", project = "g3", max = 2).map { it.key })
    }

    private fun row(key: String, skip: ImportSkip? = null, parent: String? = null) =
        ExternalSessionInfo(source = "codex", id = key, key = key, skip = skip, parentKey = parent)

    @Test
    fun aPickBecomesKeysOrTheQuery() {
        val g1 = listOf(row("a"), row("b"), row("c", skip = ImportSkip.TOO_SHORT), row("d", parent = "a"))
        val g2 = listOf(row("e"), row("f"))
        val rows = mapOf("g1" to g1, "g2" to g2)
        val q = ImportQuery(includeImported = true, includeSkipped = false)

        var p = ImportPick()
        assertTrue(p.nothing)
        assertNull(p.toRequest("pc", ImportMode.CHATS, q, rows))

        // a whole project, one chat left out, plus a skipped one picked by hand
        p = p.pickGroup("g1", g1, true).pickRow(g1[1], "g1", false).pickRow(g1[2], "g1", true)
        assertEquals(PickState.SOME, p.groupState("g1", g1))
        assertTrue(p.picked(g1[0], "g1"))
        assertFalse(p.picked(g1[1], "g1"))
        assertTrue(p.picked(g1[2], "g1"))
        val r = p.toRequest("pc", ImportMode.CHATS_LEARN, q, rows)!!
        assertEquals(listOf("c", "a"), r.keys)
        assertEquals(true, r.includeSkipped)
        assertNull(r.query)

        // Select all sends the query, minus a project ticked off
        p = ImportPick(all = true).pickGroup("g2", g2, false)
        assertEquals(PickState.NONE, p.groupState("g2", g2))
        assertEquals(PickState.ALL, p.groupState("g1", g1))
        val all = p.toRequest("pc", ImportMode.CHATS, q, rows)!!
        assertEquals(q, all.query)
        assertEquals(listOf("e", "f"), all.exclude)
        assertNull(all.keys)
        // ticking it back clears the exclusions
        assertNull(p.pickGroup("g2", g2, true).toRequest("pc", ImportMode.CHATS, q, rows)!!.exclude)

        // skipped and subagent rows are not offered under Select all
        assertFalse(ImportPick(all = true).pickable(g1[2], showSkipped = true))
        assertTrue(ImportPick().pickable(g1[2], showSkipped = true))
        assertFalse(ImportPick().pickable(g1[2], showSkipped = false))
        assertFalse(ImportPick().pickable(g1[3], showSkipped = true))

        // single chats
        p = ImportPick().pickRow(g2[0], "g2", true)
        assertEquals(PickState.SOME, p.groupState("g2", g2))
        assertEquals(listOf("e"), p.toRequest("pc", ImportMode.LEARN, q, rows)!!.keys)
        assertTrue(p.pickRow(g2[0], "g2", false).nothing)
    }

    @Test
    fun rowAndBatchWords() {
        assertEquals("continued in both places", ImportWords.rowState(row("a").copy(imported = ImportedInfo("s", ImportedState.DIVERGED))).word)
        assertEquals("learned, not imported", ImportWords.rowState(row("a").copy(imported = ImportedInfo(null, learned = true))).word)
        assertEquals("imported, learned", ImportWords.rowState(row("a").copy(imported = ImportedInfo("s", learned = true))).word)
        assertEquals("skipped, too short", ImportWords.rowState(row("a", skip = ImportSkip.TOO_SHORT)).word)
        assertEquals(StateTone.NEUTRAL, ImportWords.rowState(row("a")).tone)

        val b = ImportBatch(id = "b1", device = "pc", mode = ImportMode.CHATS_LEARN, status = ImportBatchStatus.LEARNING, total = 212, imported = 180, updated = 12, skipped = 20, learnedSessions = 40, memoriesAdded = 41, memoriesReview = 6, costUsd = 0.58)
        assertEquals("Chats and learn memory, 212 chats from arch-desktop", ImportWords.batchTitle(b, mapOf("pc" to "arch-desktop")))
        assertEquals("Learn memory only, 1 chat from an uploaded export", ImportWords.batchTitle(b.copy(mode = ImportMode.LEARN, total = 1, device = "upload:x"), emptyMap()))
        assertEquals(listOf("180 imported", "12 updated", "20 skipped", "40 chats read", "41 memories", "6 to review", "$0.58"), ImportWords.batchCounts(b))
        assertEquals(listOf("180 imported", "12 updated", "20 skipped"), ImportWords.batchCounts(b.copy(mode = ImportMode.CHATS)))
        val p = ImportWords.batchProgress(b)
        assertEquals(Triple(40, 192, "Learning"), Triple(p.done, p.total, p.verb))
        val imp = ImportWords.batchProgress(b.copy(status = ImportBatchStatus.IMPORTING))
        assertEquals(Triple(212, 212, "Importing"), Triple(imp.done, imp.total, imp.verb))
        assertEquals(9L, ImportWords.batchState(b.copy(status = ImportBatchStatus.WAITING_RESET, resumeAt = 9)).resumeAt)
        assertEquals("2 the quote was not in the chat, 1 looked like a secret", ImportWords.droppedWords(mapOf("secret" to 1, "evidence" to 2, "mystery" to 4, "kind" to 0)))

        val now = 1_000L
        val done = b.copy(status = ImportBatchStatus.DONE, undoUntil = now + 1)
        assertTrue(ImportWords.canUndo(done, now))
        assertFalse(ImportWords.canUndo(done.copy(undoUntil = now), now))
        assertFalse(ImportWords.canUndo(done.copy(status = ImportBatchStatus.UNDONE), now))
        assertFalse(ImportWords.canUndo(b.copy(undoUntil = now + 1), now))
        assertFalse(ImportWords.canUndo(done.copy(imported = 0, updated = 0, memoriesAdded = 0, memoriesReview = 0), now))
        assertTrue(ImportWords.canUndo(done.copy(imported = 0, updated = 0, memoriesAdded = 0, memoriesReview = 0, status = ImportBatchStatus.CANCELLED), now))
        assertTrue(ImportWords.isLive(b.copy(status = ImportBatchStatus.WAITING_RESET)))
        assertFalse(ImportWords.isWorking(b.copy(status = ImportBatchStatus.WAITING_RESET)))
    }

    @Test
    fun estimateLines() {
        val e = ConclaveJson.decodeFromString(
            ImportEstimate.serializer(),
            """{"sessions":212,"skipped":{"too-short":10,"automation":2},"alreadyImported":5,"windows":300,"tokensIn":1,"tokensOut":1,"consolidationCalls":3,
               "options":[{"model":"anthropic/claude-haiku-5-5","costUsd":0.61,"configured":true,"usable":true},{"model":"claude-code/default","costUsd":0,"free":true,"usable":true}],"model":"anthropic/claude-haiku-5-5"}""",
        )
        val (lead, rest) = ImportWords.estimateLine(e, ImportMode.CHATS_LEARN)
        assertEquals("212 chats, about $0.61 on Haiku 5.5.", lead)
        assertEquals("Or free on Claude Code.", rest)
        assertEquals("212 chats, 5 already here. Nothing is sent to a model." to null, ImportWords.estimateLine(e, ImportMode.CHATS))
        assertEquals("Nothing to import with these filters." to null, ImportWords.estimateLine(e.copy(sessions = 0), ImportMode.LEARN))
        assertEquals("12 skipped: 10 too short, 2 automation.", ImportWords.skippedLine(e))
        assertEquals("", ImportWords.skippedLine(e.copy(skipped = emptyMap())))
        assertEquals("Learn from 1 chat", ImportWords.startLabel(false, ImportMode.LEARN, 1))
        assertEquals("Import 12 chats", ImportWords.startLabel(false, ImportMode.CHATS, 12))
        assertEquals("Pick chats first", ImportWords.startLabel(true, ImportMode.CHATS, 0))
    }

    @Test
    fun scanDevicesAreComputersWithACodingCli() {
        val devices = listOf(
            Device("phone", "Pixel", online = true, info = MachineInfo(platform = "android", clis = mapOf("claude" to "1"))),
            Device("pve", "pve", online = true, info = MachineInfo(platform = "linux", clis = mapOf("git" to "2"))),
            Device("mac", "macbook", online = false, info = MachineInfo(platform = "darwin", clis = mapOf("codex" to "1"))),
            Device("pc", "arch-desktop", online = true, info = MachineInfo(platform = "linux", clis = mapOf("claude" to "1"))),
            Device("local", "madx", online = true),
        )
        val list = ImportWords.scanDevices(devices)
        assertEquals(listOf("pc", "local", "mac"), list.map { it.id })
        assertEquals("pc", ImportWords.defaultDevice(list))
        assertEquals("local", ImportWords.defaultDevice(emptyList()))
    }
}
