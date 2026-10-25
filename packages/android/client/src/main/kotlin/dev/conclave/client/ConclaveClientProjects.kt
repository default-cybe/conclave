package dev.conclave.client

import dev.conclave.client.model.DeviceFolders
import dev.conclave.client.model.IdentifyResult
import dev.conclave.client.model.MoveInput
import dev.conclave.client.model.MoveResult
import dev.conclave.client.model.Project
import dev.conclave.client.model.SessionLocation
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Folders across devices (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 2.12),
// the same calls as moveSession ... deletePathPrefix in packages/core/src/client/index.ts.

/** Move a session to a device (and folder). A move that finds no folder answers resolved = false with candidates. */
suspend fun ConclaveClient.moveSession(id: String, input: MoveInput): MoveResult =
    send("POST", p("api", "sessions", id, "move"), MoveInput.serializer(), input, MoveResult.serializer())

/** Move to hub: copy the session's whole folder to the hub, then run there (core projects/hubcopy.ts). The hub answers at once; the copy reports in the session. */
suspend fun ConclaveClient.moveToHub(id: String) =
    sendUnit("POST", p("api", "sessions", id, "move"), MoveInput.serializer(), MoveInput(device = "local", copy = true))

/** What the location banner shows. [refresh] reads the device again instead of the cached state. */
suspend fun ConclaveClient.sessionLocation(id: String, refresh: Boolean = false): SessionLocation =
    get(p("api", "sessions", id, "location"), SessionLocation.serializer(), mapOf("refresh" to if (refresh) "1" else null))

/** How a folder on a device compares with the session's (or a project's) copy: one line and a level. */
suspend fun ConclaveClient.identifyFolder(device: String, path: String, sessionId: String? = null, projectId: String? = null): IdentifyResult =
    sendJson(
        "POST", p("api", "projects", "identify"),
        buildJsonObject {
            put("device", device)
            put("path", path)
            if (sessionId != null) put("sessionId", sessionId)
            if (projectId != null) put("projectId", projectId)
        },
        IdentifyResult.serializer(),
    )

suspend fun ConclaveClient.projects(): List<Project> = get(p("api", "projects"), ListSerializer(Project.serializer()))

suspend fun ConclaveClient.project(id: String): Project = get(p("api", "projects", id), Project.serializer())

/** Pin a folder as the project's location on a device. The hub checks it is the same project first (409 when not). */
suspend fun ConclaveClient.pinLocation(projectId: String, device: String, path: String): Project =
    sendJson(
        "PUT", p("api", "projects", projectId, "locations"),
        buildJsonObject {
            put("device", device)
            put("path", path)
        },
        Project.serializer(),
    )

suspend fun ConclaveClient.unpinLocation(projectId: String, device: String, path: String): Project =
    call("DELETE", p("api", "projects", projectId, "locations"), mapOf("device" to device, "path" to path), null, Project.serializer())!!

suspend fun ConclaveClient.deviceFolders(device: String): DeviceFolders =
    get(p("api", "devices", device, "folders"), DeviceFolders.serializer())

suspend fun ConclaveClient.deletePathPrefix(id: String) = sendUnit("DELETE", p("api", "path-prefixes", id))
