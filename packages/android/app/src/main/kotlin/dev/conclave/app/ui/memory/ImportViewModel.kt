package dev.conclave.app.ui.memory

import androidx.lifecycle.viewModelScope
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.errorText
import dev.conclave.client.cancelImport
import dev.conclave.client.fixImportRetention
import dev.conclave.client.importBatches
import dev.conclave.client.importEstimate
import dev.conclave.client.importScan
import dev.conclave.client.importScanAll
import dev.conclave.client.logic.ImportPick
import dev.conclave.client.logic.ImportWords
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.ExternalSessionInfo
import dev.conclave.client.model.ImportBatch
import dev.conclave.client.model.ImportEstimate
import dev.conclave.client.model.ImportMode
import dev.conclave.client.model.ImportProjectGroup
import dev.conclave.client.model.ImportQuery
import dev.conclave.client.model.ImportRequest
import dev.conclave.client.model.ImportRetention
import dev.conclave.client.model.ImportScanPage
import dev.conclave.client.model.obj
import dev.conclave.client.pauseImport
import dev.conclave.client.resumeImport
import dev.conclave.client.startImport
import dev.conclave.client.undoImport
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/** How far back the scan looks. */
enum class ImportSince(val days: Int?, val label: String) {
    ANY(null, "any time"),
    MONTH(30, "the last 30 days"),
    QUARTER(90, "the last 90 days"),
    YEAR(365, "the last year"),
}

/**
 * Starting a chat import from the phone (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md
 * 1.4, 1.5, 1.10 and 5): the scan of one device grouped by project, what
 * the owner ticked, the mode, the cost line and Start; then the batches with
 * their progress, Pause, Resume, Cancel and Undo. The job runs on the hub,
 * so it keeps going when the app closes. Uploading exports stays on the web.
 */
class ImportViewModel(hub: HubRepository) : HubViewModel(hub) {
    /** The device to scan; null until the owner picks, then the first online computer. */
    val device = MutableStateFlow<String?>(null)
    val source = MutableStateFlow<String?>(null)
    val since = MutableStateFlow(ImportSince.ANY)
    val hideImported = MutableStateFlow(false)
    val showSkipped = MutableStateFlow(false)

    val page = MutableStateFlow<ImportScanPage?>(null)
    val scanning = MutableStateFlow(false)
    val scanError = MutableStateFlow<String?>(null)
    val rows = MutableStateFlow<Map<String, List<ExternalSessionInfo>>>(emptyMap())
    val open = MutableStateFlow<Set<String>>(emptySet())
    val pick = MutableStateFlow(ImportPick())
    val mode = MutableStateFlow(ImportMode.CHATS_LEARN)
    val memoryOn = MutableStateFlow(true)
    val estimate = MutableStateFlow<ImportEstimate?>(null)
    val starting = MutableStateFlow(false)
    val fixing = MutableStateFlow<String?>(null)

    val batches = MutableStateFlow<List<ImportBatch>>(emptyList())
    val notLearned = MutableStateFlow(0)
    /** A batch action in flight, by batch id. */
    val acting = MutableStateFlow<Map<String, String>>(emptyMap())

    private var scanJob: Job? = null
    private var estimateJob: Job? = null
    private var scanned: String? = null
    private var lastDevice: String? = null
    private var scanSeq = 0
    private val wasLive = HashSet<String>()

    init {
        viewModelScope.launch {
            hub.events.collect { e ->
                when (e) {
                    is EngineEvent.ImportBatchUpdated -> onBatch(e.batch)
                    is EngineEvent.ConfigUpdated -> loadBatches()
                    else -> Unit
                }
            }
        }
        viewModelScope.launch {
            // memory off on the hub: start on Chats only, and say why learning will not run
            val on = runCatching { (hub.api { it.config() }.config.obj("memory")?.get("enabled") as? JsonPrimitive)?.booleanOrNull }.getOrNull()
            if (on == false) {
                memoryOn.value = false
                mode.value = ImportMode.CHATS
            }
        }
        loadBatches()
    }

    fun query(): ImportQuery = ImportQuery(
        sources = source.value?.let { listOf(it) },
        since = since.value.days?.let { System.currentTimeMillis() - it * 86_400_000L },
        includeImported = !hideImported.value,
        includeSkipped = showSkipped.value,
    )

    /**
     * Read the device (its project groups). A new device or filter starts the
     * selection over; [refresh] reads the device again instead of the cached
     * rows. [again] reloads the same list after an import changed it,
     * keeping what the owner ticked and opened.
     */
    fun scan(dev: String, refresh: Boolean = false, again: Boolean = false) {
        val q = query()
        val key = "$dev|${q.copy(since = q.since?.let { it / 3_600_000L })}"
        if (!refresh && !again && key == scanned && page.value != null) return
        val fresh = key != scanned
        scanned = key
        lastDevice = dev
        if (fresh) {
            // a new device or filter starts over at once, so nothing from the last list can be ticked meanwhile
            page.value = null
            rows.value = emptyMap()
            open.value = emptySet()
            pick.value = ImportPick()
            estimate.value = null
            estimateJob?.cancel()
        }
        scanJob?.cancel()
        val n = ++scanSeq
        scanJob = viewModelScope.launch {
            scanning.value = true
            scanError.value = null
            try {
                val p = hub.api {
                    it.importScan(
                        device = dev, sources = q.sources, since = q.since,
                        includeImported = q.includeImported, includeSkipped = q.includeSkipped, limit = 1, refresh = refresh,
                    )
                }
                page.value = p
                if (!fresh) {
                    // the same list: read the projects already loaded again, so a ticked one still resolves to its chats
                    val loaded = rows.value.keys
                    p.groups.orEmpty().filter { it.key in loaded }.forEach { g ->
                        val items = readGroup(dev, g.key)
                        rows.update { it + (g.key to items) }
                    }
                }
                scheduleEstimate(dev)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                scanError.value = errorText(e)
            } finally {
                // a scan cut short by a newer one leaves the word to that one
                if (n == scanSeq) scanning.value = false
            }
        }
    }

    /** Every chat of a project, page after page, so a project ticked as a whole imports all of it. */
    private suspend fun readGroup(dev: String, key: String): List<ExternalSessionInfo> {
        val q = query()
        return hub.api {
            it.importScanAll(device = dev, project = key, sources = q.sources, since = q.since, includeImported = q.includeImported, includeSkipped = q.includeSkipped)
        }
    }

    private suspend fun groupRows(dev: String, g: ImportProjectGroup): List<ExternalSessionInfo> {
        rows.value[g.key]?.let { return it }
        val items = readGroup(dev, g.key)
        rows.update { it + (g.key to items) }
        return items
    }

    fun toggleOpen(dev: String, g: ImportProjectGroup) {
        if (g.key in open.value) {
            open.update { it - g.key }
            return
        }
        open.update { it + g.key }
        action { groupRows(dev, g) }
    }

    /** Tick or untick a whole project: its chats load first, so a Select all can leave them out. */
    fun pickGroup(dev: String, g: ImportProjectGroup, on: Boolean) = action {
        val list = groupRows(dev, g)
        pick.update { it.pickGroup(g.key, list, on) }
        scheduleEstimate(dev)
    }

    fun pickRow(dev: String, x: ExternalSessionInfo, group: String, on: Boolean) {
        pick.update { it.pickRow(x, group, on) }
        scheduleEstimate(dev)
    }

    fun selectAll(dev: String, on: Boolean) {
        pick.value = if (on) ImportPick(all = true) else ImportPick()
        scheduleEstimate(dev)
    }

    fun setMode(dev: String, m: ImportMode) {
        mode.value = m
        scheduleEstimate(dev)
    }

    fun request(dev: String): ImportRequest? = pick.value.toRequest(dev, mode.value, query(), rows.value)

    /** The cost line follows the selection and the mode, a moment after the owner stops ticking. */
    private fun scheduleEstimate(dev: String) {
        estimateJob?.cancel()
        val req = request(dev)
        if (req == null) {
            estimate.value = null
            return
        }
        estimateJob = viewModelScope.launch {
            delay(350)
            estimate.value = try {
                hub.api { it.importEstimate(req) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            }
        }
    }

    fun start(dev: String) {
        val req = request(dev) ?: return
        starting.value = true
        viewModelScope.launch {
            try {
                val b = hub.api { it.startImport(req) }
                onBatch(b)
                say("${ImportWords.modeLabel(b.mode)} started for ${ImportWords.plural(b.total - b.skipped, "chat")}. It keeps going when you leave this screen.")
                pick.value = ImportPick()
                estimate.value = null
                loadBatches()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                say(errorText(e))
            } finally {
                starting.value = false
            }
        }
    }

    fun fix(r: ImportRetention) {
        fixing.value = r.tool
        viewModelScope.launch {
            try {
                val after = hub.api { it.fixImportRetention(r.device, r.tool) }
                page.update { it?.copy(retention = after) }
                say("${ImportWords.sourceName(r.tool)} keeps chats for 10 years now.")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                say(errorText(e))
            } finally {
                fixing.value = null
            }
        }
    }

    // ------------------------------------------------------------ batches

    fun loadBatches() {
        viewModelScope.launch {
            try {
                val r = hub.api { it.importBatches() }
                batches.value = r.batches.sortedByDescending { it.createdAt }.take(20)
                notLearned.value = r.notLearned
                r.batches.filter { ImportWords.isLive(it) }.forEach { wasLive += it.id }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // an older hub has no batches: the section stays away
            }
        }
    }

    private fun onBatch(b: ImportBatch) {
        batches.update { list -> (listOf(b) + list.filterNot { it.id == b.id }).sortedByDescending { it.createdAt }.take(20) }
        // a batch that finished changes "not learned yet" and the scan's state words
        val live = ImportWords.isLive(b)
        if (b.id in wasLive && !live) {
            wasLive -= b.id
            loadBatches()
            lastDevice?.let { scan(it, again = true) }
        } else if (live) {
            wasLive += b.id
        }
    }

    private fun batchAction(b: ImportBatch, verb: String, done: String? = null, block: suspend () -> Unit) {
        acting.update { it + (b.id to verb) }
        viewModelScope.launch {
            try {
                block()
                if (done != null) say(done)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                say(errorText(e))
            } finally {
                acting.update { it - b.id }
            }
        }
    }

    fun pause(b: ImportBatch) = batchAction(b, "Pausing") { onBatch(hub.api { it.pauseImport(b.id) }) }

    fun resume(b: ImportBatch) = batchAction(b, "Resuming") { onBatch(hub.api { it.resumeImport(b.id) }) }

    fun cancel(b: ImportBatch) = batchAction(b, "Cancelling", "Cancelled. What was done is kept.") { onBatch(hub.api { it.cancelImport(b.id) }) }

    fun undo(b: ImportBatch) = batchAction(b, "Undoing") {
        val r = hub.api { it.undoImport(b.id) }
        say(ImportWords.undoLine(r))
        loadBatches()
        lastDevice?.let { scan(it, again = true) }
    }

    /** "Learn from 212 imported chats not learned yet". */
    fun learnNotLearned() {
        viewModelScope.launch {
            try {
                val b = hub.api { it.startImport(ImportRequest(device = "local", mode = ImportMode.LEARN, notLearned = true)) }
                onBatch(b)
                say("Learning from ${ImportWords.plural(b.total, "imported chat")}. It keeps going when you leave this screen.")
                loadBatches()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                say(errorText(e))
            }
        }
    }
}
