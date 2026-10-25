package dev.conclave.client.model

import dev.conclave.client.ConclaveJson
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

// Repo sessions: mirrors SessionRepoMeta in packages/core/src/client/github.ts
// (docs/DESIGN.md 30). A repo session works in its own git worktree of a
// GitHub repository, on its own branch; the hub pushes it and opens the pull
// request. The session carries this summary in meta.repo. Enum fields have
// defaults, so a value a newer hub adds falls back instead of failing.

@Serializable
enum class PrState(val wire: String) {
    @SerialName("open") OPEN("open"),
    @SerialName("merged") MERGED("merged"),
    @SerialName("closed") CLOSED("closed"),
}

/** The pull request's checks: check runs and commit statuses together. NONE: there are none. */
@Serializable
enum class CiState(val wire: String) {
    @SerialName("pending") PENDING("pending"),
    @SerialName("success") SUCCESS("success"),
    @SerialName("failure") FAILURE("failure"),
    @SerialName("none") NONE("none"),
}

@Serializable
data class PullRequestRef(
    val number: Int = 0,
    val url: String = "",
    val state: PrState = PrState.OPEN,
    val draft: Boolean = false,
)

/** session.meta.repo: the repository, the session's branch, the base it came from, and its pull request. */
@Serializable
data class SessionRepo(
    /** owner/name. */
    val repo: String = "",
    val branch: String = "",
    val base: String = "",
    val pr: PullRequestRef? = null,
    val ci: CiState? = null,
    /** The worktree was removed after the merge (Clean up). */
    val cleaned: Boolean = false,
    /** A worktree of a git folder ("Run in a worktree"), not a GitHub repo session. */
    val folder: Boolean = false,
    /** Merge brought the branch into its base. */
    val merged: Boolean = false,
)

/** The repository of a repo session, or null for any other session. */
val Session.repo: SessionRepo?
    get() {
        val raw = meta?.get("repo") as? JsonObject ?: return null
        val r = runCatching { ConclaveJson.decodeFromJsonElement(SessionRepo.serializer(), raw) }.getOrNull() ?: return null
        return r.takeIf { it.repo.isNotBlank() && it.branch.isNotBlank() }
    }

// ---------------------------------------------------------------------------
// The HTTP contract of repo sessions (core/src/client/github.ts)
// ---------------------------------------------------------------------------

/** Who the hub's GitHub token is. The token itself never comes back. */
@Serializable
data class GithubStatus(
    val connected: Boolean = false,
    val source: String? = null,
    val login: String? = null,
    val name: String? = null,
    val repos: Int? = null,
    /** Why a set token does not work. */
    val error: String? = null,
)

/** One repository the token can see. */
@Serializable
data class GithubRepo(
    /** owner/name as GitHub spells it. */
    val fullName: String = "",
    val owner: String = "",
    val name: String = "",
    val private: Boolean = false,
    val defaultBranch: String = "main",
    val description: String? = null,
    /** Last push, epoch ms. */
    val pushedAt: Long? = null,
    val url: String = "",
    /** The token may push to it. */
    val canPush: Boolean = true,
)

@Serializable
data class GithubBranches(
    val defaultBranch: String = "main",
    /** Branch names, the default branch first. */
    val branches: List<String> = emptyList(),
)

/** POST /api/github/sessions: a session in a fresh worktree of a repository. */
@Serializable
data class RepoSessionInput(
    /** owner/name. */
    val repo: String,
    /** The branch to start from. Null: the repository's default branch. */
    val base: String? = null,
    /** The device that keeps the clone and the worktree. Null: the hub. */
    val device: String? = null,
    val agent: String? = null,
    val model: String? = null,
    val title: String? = null,
    /** Sent as the first message once the worktree is ready. */
    val prompt: String? = null,
    val permissionMode: PermissionMode? = null,
    /** Effort for the session (chat.thinking); null runs at the agent's level. */
    val chat: ChatSettingsPatch? = null,
)

/**
 * GET /api/sessions/:id/repo: the repo session in full. [pushed] is never,
 * current or behind.
 */
@Serializable
data class RepoSessionDto(
    val sessionId: String = "",
    val repo: String = "",
    val branch: String = "",
    val base: String = "",
    val pr: PullRequestRef? = null,
    val ci: CiState? = null,
    val cleaned: Boolean = false,
    val device: String = "local",
    val deviceName: String = "",
    val clonePath: String = "",
    val worktree: String = "",
    val baseSha: String = "",
    val defaultBranch: String = "",
    /** The repository's page on GitHub. */
    val url: String = "",
    /** The branch's page on GitHub, once it is pushed. */
    val branchUrl: String? = null,
    val head: String? = null,
    /** Commits on the branch beyond the base. */
    val commits: Int? = null,
    /** Uncommitted files in the worktree. */
    val dirty: Int? = null,
    val pushedSha: String? = null,
    val pushedAt: Long? = null,
    val pushed: String = "never",
    val prTitle: String? = null,
    val ciUrl: String? = null,
    val checkedAt: Long? = null,
    /** Clean up is offered: the pull request was merged or closed, or the branch was merged, and the worktree is still there. */
    val canCleanUp: Boolean = false,
    /** A worktree of a git folder ("Run in a worktree"). */
    val folder: Boolean = false,
    val merged: Boolean = false,
    /** Push and Open pull request can work. Null (an older hub): they can. */
    val pullRequests: Boolean? = null,
    /** Merge into the base is offered. */
    val canMerge: Boolean = false,
    /** The device is online, so git can run there. */
    val online: Boolean = false,
    /** One plain sentence about where things stand. */
    val line: String = "",
)

/** POST /api/sessions/:id/repo/push: with [commitMessage], what is not committed goes in a commit first. */
@Serializable
data class PushInput(val commitMessage: String? = null)

@Serializable
data class PushResult(
    val pushed: Boolean = false,
    val branch: String = "",
    val sha: String = "",
    val commits: Int = 0,
    val committed: Int? = null,
    val dirty: Int? = null,
    val line: String = "",
)

@Serializable
data class PrCommit(val sha: String = "", val subject: String = "")

/** GET /api/sessions/:id/repo/pr-draft: a title and body drafted from the session, for the owner to edit. */
@Serializable
data class PrDraft(
    val title: String = "",
    val body: String = "",
    val base: String = "",
    val head: String = "",
    val commits: List<PrCommit> = emptyList(),
)

/** POST /api/sessions/:id/repo/pr. */
@Serializable
data class OpenPrInput(val title: String, val body: String? = null, val draft: Boolean? = null)

/**
 * POST /api/sessions/:id/repo/cleanup: [force] removes the worktree with
 * uncommitted files, or before the merge. [discard] drops the local branch too.
 */
@Serializable
data class CleanupInput(val force: Boolean? = null, val discard: Boolean? = null)

/** POST /api/sessions/:id/repo/merge: [squash] makes one commit on the base. */
@Serializable
data class MergeInput(val squash: Boolean? = null)

/** GET /api/worktrees/folder: whether a folder on a device is in a git repository. */
@Serializable
data class FolderGit(val git: Boolean = false, val root: String? = null, val branch: String? = null, val github: String? = null)

/** POST /api/worktrees/sessions: "Run in a worktree" on a git folder of a device. */
@Serializable
data class WorktreeSessionInput(
    val folder: String,
    val device: String? = null,
    val agent: String? = null,
    val model: String? = null,
    val title: String? = null,
    /** Sent as the first message once the worktree is ready. */
    val prompt: String? = null,
    val permissionMode: PermissionMode? = null,
    val chat: ChatSettingsPatch? = null,
)
