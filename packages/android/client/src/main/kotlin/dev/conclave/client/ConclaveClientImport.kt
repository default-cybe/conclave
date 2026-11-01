package dev.conclave.client

import dev.conclave.client.model.ExternalSessionInfo
import dev.conclave.client.model.ImportBatch
import dev.conclave.client.model.ImportBatchesResponse
import dev.conclave.client.model.ImportEstimate
import dev.conclave.client.model.ImportRequest
import dev.conclave.client.model.ImportRetention
import dev.conclave.client.model.ImportScanPage
import dev.conclave.client.model.ImportSyncResult
import dev.conclave.client.model.ImportUndoResult
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Chat import (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 1.13), the same
// calls as importScan ... fixImportRetention in packages/core/src/client/index.ts.

/**
 * One page of past chats on [device]. [project] narrows to one project group
 * (its key). [includeImported] false hides chats already imported and
 * current; [includeSkipped] false leaves out the skipped ones. [refresh]
 * reads the device again instead of the cached rows.
 */
suspend fun ConclaveClient.importScan(
    device: String = "local",
    sources: List<String>? = null,
    since: Long? = null,
    project: String? = null,
    includeImported: Boolean? = null,
    includeSkipped: Boolean? = null,
    q: String? = null,
    cursor: String? = null,
    limit: Int? = null,
    refresh: Boolean = false,
): ImportScanPage = get(p("api", "import", "scan"), ImportScanPage.serializer(), importScanQuery(device, sources, since, project, includeImported, includeSkipped, q, cursor, limit, refresh))

/**
 * Every chat of one project group, page after page, up to [max]. A project
 * ticked as a whole becomes the keys of its chats, so a page left unread
 * would leave chats out of the import.
 */
suspend fun ConclaveClient.importScanAll(
    device: String,
    project: String,
    sources: List<String>? = null,
    since: Long? = null,
    includeImported: Boolean? = null,
    includeSkipped: Boolean? = null,
    pageSize: Int = 500,
    max: Int = 5000,
): List<ExternalSessionInfo> {
    val out = ArrayList<ExternalSessionInfo>()
    var cursor: String? = null
    val seen = HashSet<String>()
    do {
        val page = importScan(device = device, sources = sources, since = since, project = project, includeImported = includeImported, includeSkipped = includeSkipped, cursor = cursor, limit = pageSize)
        out += page.items
        val next = page.next?.takeIf { it.isNotBlank() }
        // a cursor seen before would loop forever
        cursor = if (next != null && seen.add(next) && page.items.isNotEmpty()) next else null
    } while (cursor != null && out.size < max)
    return if (out.size > max) out.subList(0, max).toList() else out
}

/** The query string as the hub reads it: lists joined with commas, booleans as 1 and 0. */
internal fun importScanQuery(
    device: String,
    sources: List<String>?,
    since: Long?,
    project: String?,
    includeImported: Boolean?,
    includeSkipped: Boolean?,
    q: String?,
    cursor: String?,
    limit: Int?,
    refresh: Boolean,
): Map<String, Any?> = mapOf(
    "device" to device,
    "sources" to sources?.takeIf { it.isNotEmpty() }?.joinToString(","),
    "since" to since,
    "project" to project,
    "includeImported" to includeImported?.let { if (it) 1 else 0 },
    "includeSkipped" to includeSkipped?.let { if (it) 1 else 0 },
    "q" to q,
    "cursor" to cursor,
    "limit" to limit,
    "refresh" to if (refresh) 1 else null,
)

/** Tokens and cost per model option for a selection, before anything runs. */
suspend fun ConclaveClient.importEstimate(input: ImportRequest): ImportEstimate =
    send("POST", p("api", "import", "estimate"), ImportRequest.serializer(), input, ImportEstimate.serializer())

/** Starts the job on the hub. It keeps going when the app closes. */
suspend fun ConclaveClient.startImport(input: ImportRequest): ImportBatch =
    send("POST", p("api", "import", "batches"), ImportRequest.serializer(), input, ImportBatch.serializer())

suspend fun ConclaveClient.importBatches(): ImportBatchesResponse = get(p("api", "import", "batches"), ImportBatchesResponse.serializer())

suspend fun ConclaveClient.pauseImport(id: String): ImportBatch = sendJson("POST", p("api", "import", "batches", id, "pause"), null, ImportBatch.serializer())

suspend fun ConclaveClient.resumeImport(id: String): ImportBatch = sendJson("POST", p("api", "import", "batches", id, "resume"), null, ImportBatch.serializer())

/** Stops the job; what was done is kept (Undo removes it). */
suspend fun ConclaveClient.cancelImport(id: String): ImportBatch = sendJson("POST", p("api", "import", "batches", id, "cancel"), null, ImportBatch.serializer())

/** Removes the sessions, messages and memories the batch made. Memories and sessions the owner kept using are kept. */
suspend fun ConclaveClient.undoImport(id: String): ImportUndoResult = sendJson("POST", p("api", "import", "batches", id, "undo"), null, ImportUndoResult.serializer())

/** Brings one imported session up to date with its source. */
suspend fun ConclaveClient.syncImported(sessionId: String): ImportSyncResult =
    sendJson("POST", p("api", "import", "sessions", sessionId, "sync"), null, ImportSyncResult.serializer())

/** Vendor settings on [device] that delete old chats. */
suspend fun ConclaveClient.importRetention(device: String = "local"): List<ImportRetention> =
    get(p("api", "import", "retention"), ListSerializer(ImportRetention.serializer()), mapOf("device" to device))

/** "Keep 10 years": sets the tool's cleanup period on the device. Returns the settings after. */
suspend fun ConclaveClient.fixImportRetention(device: String, tool: String): List<ImportRetention> =
    sendJson(
        "POST", p("api", "import", "retention"),
        buildJsonObject {
            put("device", device)
            put("tool", tool)
        },
        ListSerializer(ImportRetention.serializer()),
    )
