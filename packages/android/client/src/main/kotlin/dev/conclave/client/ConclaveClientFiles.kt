package dev.conclave.client

// Shared files, the same call as sessionFile in
// packages/core/src/client/index.ts. A ShareFile result's meta.file is the
// card; the bytes come from the hub by the call's id, never by a path.

/** The path of a shared file: /api/sessions/{id}/files/{toolUseId}. Ids are path-encoded by OkHttp. */
internal fun sessionFilePath(id: String, toolUseId: String): List<String> = listOf("api", "sessions", id, "files", toolUseId)

/** A file a ShareFile call in session [id] shared, with its content type. Fetched with the hub token like any call. */
suspend fun ConclaveClient.sessionFile(id: String, toolUseId: String): Pair<ByteArray, String> = getBytes(sessionFilePath(id, toolUseId))
