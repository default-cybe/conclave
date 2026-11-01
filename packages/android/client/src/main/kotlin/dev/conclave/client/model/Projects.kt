package dev.conclave.client.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Folders across devices: mirrors packages/core/src/client/projects.ts
// (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 2.12). A project is one
// identity (git roots, remotes, a Syncthing folder or a marker) with a
// location per device. Moving a session to another device finds where the
// project lives there. Enum fields have defaults, so a value a newer hub
// adds falls back instead of failing.

/**
 * How sure the hub is that a folder is the same project.
 * EXACT: same marker, same Syncthing folder, or same roots and a shared remote.
 * STRONG: same roots, or it has the last commit seen elsewhere.
 * WEAK: same folder or package name only. NONE: nothing in common.
 * MISMATCH: both are git repos with different histories.
 */
@Serializable
enum class MatchLevel(val wire: String) {
    @SerialName("exact") EXACT("exact"),
    @SerialName("strong") STRONG("strong"),
    @SerialName("weak") WEAK("weak"),
    @SerialName("none") NONE("none"),
    @SerialName("mismatch") MISMATCH("mismatch"),
}

/** How a location was found. NONE marks a move without the project files. */
@Serializable
enum class LocationVia(val wire: String) {
    @SerialName("origin") ORIGIN("origin"),
    @SerialName("same-path") SAME_PATH("same-path"),
    @SerialName("pinned") PINNED("pinned"),
    @SerialName("syncthing") SYNCTHING("syncthing"),
    @SerialName("prefix") PREFIX("prefix"),
    @SerialName("search") SEARCH("search"),
    @SerialName("chosen") CHOSEN("chosen"),
    @SerialName("none") NONE("none"),
}

@Serializable
data class SyncthingRef(val folderId: String = "", val rel: String = "")

/** What one folder on one device is, as the hub read it there. */
@Serializable
data class FolderIdentity(
    val path: String = "",
    /** False when the folder is not on the device. */
    val exists: Boolean = false,
    val isGit: Boolean = false,
    val toplevel: String? = null,
    val roots: List<String> = emptyList(),
    /** host/owner/repo, never with a user or token. */
    val remotes: List<String> = emptyList(),
    val shallow: Boolean = false,
    val head: String? = null,
    val branch: String? = null,
    val marker: String? = null,
    val syncthing: SyncthingRef? = null,
    val name: String = "",
    val packageName: String? = null,
)

@Serializable
data class ProjectIdentity(
    val gitRoots: List<String> = emptyList(),
    val remotes: List<String> = emptyList(),
    val shallow: Boolean = false,
    val syncthing: SyncthingRef? = null,
    val marker: String? = null,
    val head: String? = null,
)

/** Where a project lives on one device. [projectName] is set in a device's folder list. */
@Serializable
data class ProjectLocation(
    val projectId: String = "",
    val device: String = "",
    val deviceName: String? = null,
    val path: String = "",
    val via: LocationVia? = null,
    val pinned: Boolean = false,
    val verifiedAt: Long? = null,
    val head: String? = null,
    val projectName: String? = null,
)

@Serializable
data class Project(
    val id: String,
    val name: String = "",
    val identity: ProjectIdentity = ProjectIdentity(),
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val locations: List<ProjectLocation> = emptyList(),
)

/** A learned path pair: [fromPrefix] on one device is [toPrefix] on the other, both ways. */
@Serializable
data class PathPrefix(
    val id: String,
    val fromDevice: String = "",
    val fromPrefix: String = "",
    val toDevice: String = "",
    val toPrefix: String = "",
    val confirmations: Int = 0,
    val createdAt: Long = 0,
)

/** How current the copy on the target is, compared with where the session was. */
@Serializable
data class Freshness(
    /** True when the owner should look before going on. */
    val stale: Boolean = false,
    /** One line, e.g. "The macbook copy is 3 commits behind." */
    val line: String? = null,
    val behind: Int? = null,
    val ahead: Int? = null,
    val missingCommit: Boolean? = null,
    val dirtyElsewhere: Int? = null,
    val syncState: String? = null,
    val needFiles: Long? = null,
    val conflicts: Int? = null,
)

/** A folder the hub found that may be the project ("Closest folders"). */
@Serializable
data class FolderCandidate(
    val device: String = "",
    val path: String = "",
    val level: MatchLevel = MatchLevel.NONE,
    val via: LocationVia? = null,
    /** "Same git history and remote as the arch-desktop copy". */
    val line: String = "",
)

@Serializable
data class CloneInput(val url: String, val into: String)

/**
 * POST /api/sessions/:id/move. Without [cwd] the hub finds the folder.
 * [remember] pins the location and learns the path pair; [allowMismatch]
 * uses a folder with another git history (Use once, Use and remember);
 * [withoutFiles] goes on in the device's home; [clone] clones the remote
 * first. Null fields are not sent.
 */
@Serializable
data class MoveInput(
    val device: String,
    val cwd: String? = null,
    val remember: Boolean? = null,
    val allowMismatch: Boolean? = null,
    val withoutFiles: Boolean? = null,
    val clone: CloneInput? = null,
    /** With device "local": copy the whole folder to the hub first (Move to hub). */
    val copy: Boolean? = null,
)

/** Why a move found no folder. */
@Serializable
enum class MoveRefusal {
    /** The device is not connected. */
    @SerialName("offline") OFFLINE,
    /** No folder there matched. */
    @SerialName("not-found") NOT_FOUND,
    /** The chosen folder has another history. */
    @SerialName("mismatch") MISMATCH,
}

/**
 * The move's answer, both shapes in one class. [resolved] true: the session
 * now runs in [cwd] ([session] is the updated session). False: [reason],
 * the [candidates] for Choose folder, a remote to clone and where to start
 * browsing. [line] says it in one sentence either way.
 */
@Serializable
data class MoveResult(
    val resolved: Boolean = false,
    val line: String = "",
    val cwd: String? = null,
    val via: LocationVia? = null,
    val level: MatchLevel? = null,
    val freshness: Freshness? = null,
    val session: Session? = null,
    val reason: MoveRefusal? = null,
    val candidates: List<FolderCandidate> = emptyList(),
    val cloneUrl: String? = null,
    val browseFrom: String? = null,
)

/** What the location banner shows. OK shows nothing. */
@Serializable
enum class LocationState {
    @SerialName("ok") OK,
    @SerialName("offline") OFFLINE,
    @SerialName("missing") MISSING,
    @SerialName("stale") STALE,
    @SerialName("mismatch") MISMATCH,
}

@Serializable
data class LocationMove(
    val fromSeq: Long = 0,
    val device: String = "",
    val deviceName: String? = null,
    val root: String = "",
    val via: LocationVia? = null,
    val level: MatchLevel? = null,
    val at: Long? = null,
)

/** Another online device that has the folder: "Run on macbook". */
@Serializable
data class LocationSuggestion(
    val device: String,
    val deviceName: String = "",
    val cwd: String = "",
    val via: LocationVia? = null,
    val level: MatchLevel? = null,
)

/** GET /api/sessions/:id/location: everything the banner needs. */
@Serializable
data class SessionLocation(
    val sessionId: String = "",
    val device: String = "",
    val deviceName: String = "",
    val online: Boolean = false,
    val cwd: String = "",
    /** Null while the device is offline. After Continue without files it is the home folder, so true. */
    val exists: Boolean? = null,
    val projectId: String? = null,
    val projectName: String? = null,
    val level: MatchLevel? = null,
    val via: LocationVia? = null,
    val freshness: Freshness? = null,
    val state: LocationState = LocationState.OK,
    val line: String? = null,
    val history: List<LocationMove> = emptyList(),
    val suggestion: LocationSuggestion? = null,
    val cloneUrl: String? = null,
    val browseFrom: String? = null,
)

/** POST /api/projects/identify: what a folder is and how it compares with the session's project. */
@Serializable
data class IdentifyResult(
    val device: String = "",
    val path: String = "",
    val identity: FolderIdentity = FolderIdentity(),
    val project: Project? = null,
    val level: MatchLevel = MatchLevel.NONE,
    val line: String = "",
)

@Serializable
data class SyncthingFolder(val id: String = "", val label: String = "", val path: String = "", val paused: Boolean = false)

@Serializable
data class MappingSuggestion(
    val id: String,
    val projectId: String = "",
    val projectName: String = "",
    val fromDevice: String = "",
    val fromPath: String = "",
    val toDevice: String = "",
    val toPath: String = "",
    val reason: String = "",
)

@Serializable
data class DeviceSyncthing(
    val available: Boolean = false,
    val folders: List<SyncthingFolder> = emptyList(),
    /** "12 folders, all up to date". */
    val line: String = "",
)

/** GET /api/devices/:id/folders. */
@Serializable
data class DeviceFolders(
    val device: String = "",
    val deviceName: String = "",
    val online: Boolean = false,
    val locations: List<ProjectLocation> = emptyList(),
    val prefixes: List<PathPrefix> = emptyList(),
    val suggestions: List<MappingSuggestion> = emptyList(),
    val syncthing: DeviceSyncthing = DeviceSyncthing(),
)

/** Where a moved session was and is now (event session.moved). */
@Serializable
data class SessionPlace(val device: String = "", val cwd: String = "")
