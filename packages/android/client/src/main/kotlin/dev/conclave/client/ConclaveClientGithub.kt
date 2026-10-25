package dev.conclave.client

import dev.conclave.client.model.CleanupInput
import dev.conclave.client.model.FolderGit
import dev.conclave.client.model.MergeInput
import dev.conclave.client.model.WorktreeSessionInput
import dev.conclave.client.model.GithubBranches
import dev.conclave.client.model.GithubRepo
import dev.conclave.client.model.GithubStatus
import dev.conclave.client.model.OpenPrInput
import dev.conclave.client.model.PrDraft
import dev.conclave.client.model.PushInput
import dev.conclave.client.model.PushResult
import dev.conclave.client.model.RepoSessionDto
import dev.conclave.client.model.RepoSessionInput
import dev.conclave.client.model.Session
import kotlinx.serialization.builtins.ListSerializer

// Repo sessions on GitHub (docs/DESIGN.md 30), the same calls as github ...
// cleanupSession in packages/core/src/client/index.ts. The token stays on
// the hub; these only ask the hub.

/** Who the hub's GitHub token is. */
suspend fun ConclaveClient.github(): GithubStatus = get(p("api", "github"), GithubStatus.serializer())

/** Repositories the token can see, most recently pushed first; [q] filters by name and description. */
suspend fun ConclaveClient.githubRepos(q: String? = null, refresh: Boolean = false): List<GithubRepo> =
    get(p("api", "github", "repos"), ListSerializer(GithubRepo.serializer()), mapOf("q" to q?.trim()?.ifEmpty { null }, "refresh" to if (refresh) true else null))

/** Branches of owner/name, the default branch first. */
suspend fun ConclaveClient.githubBranches(repo: String): GithubBranches {
    val owner = repo.substringBefore('/')
    val name = repo.substringAfter('/', "")
    return get(p("api", "github", "repos", owner, name, "branches"), GithubBranches.serializer())
}

/** A session in a fresh worktree of a repository, on a new conclave/ branch. */
suspend fun ConclaveClient.createRepoSession(input: RepoSessionInput): Session =
    send("POST", p("api", "github", "sessions"), RepoSessionInput.serializer(), input, Session.serializer())

/** The session's repository, branch, pull request and checks. [refresh] reads GitHub first (Check now). */
suspend fun ConclaveClient.sessionRepo(id: String, refresh: Boolean = false): RepoSessionDto =
    get(p("api", "sessions", id, "repo"), RepoSessionDto.serializer(), mapOf("refresh" to if (refresh) true else null))

suspend fun ConclaveClient.pushSession(id: String, input: PushInput = PushInput()): PushResult =
    send("POST", p("api", "sessions", id, "repo", "push"), PushInput.serializer(), input, PushResult.serializer())

/** A pull request title and body drafted from the session, to edit before opening it. */
suspend fun ConclaveClient.prDraft(id: String): PrDraft = get(p("api", "sessions", id, "repo", "pr-draft"), PrDraft.serializer())

suspend fun ConclaveClient.openPullRequest(id: String, input: OpenPrInput): RepoSessionDto =
    send("POST", p("api", "sessions", id, "repo", "pr"), OpenPrInput.serializer(), input, RepoSessionDto.serializer())

/** Remove the worktree; the branch stays on GitHub. With discard the local branch goes too. */
suspend fun ConclaveClient.cleanupSession(id: String, input: CleanupInput = CleanupInput()): RepoSessionDto =
    send("POST", p("api", "sessions", id, "repo", "cleanup"), CleanupInput.serializer(), input, RepoSessionDto.serializer())

/** Merge a folder worktree's branch into its base in the main checkout. */
suspend fun ConclaveClient.mergeSession(id: String, input: MergeInput = MergeInput()): RepoSessionDto =
    send("POST", p("api", "sessions", id, "repo", "merge"), MergeInput.serializer(), input, RepoSessionDto.serializer())

/** Whether a folder on a device is in a git repository ("Run in a worktree" is offered then). */
suspend fun ConclaveClient.folderGit(device: String, path: String): FolderGit =
    get(p("api", "worktrees", "folder"), FolderGit.serializer(), mapOf("device" to device, "path" to path))

/** A session in a new worktree of a git folder, on a new conclave/ branch from its current branch. */
suspend fun ConclaveClient.createWorktreeSession(input: WorktreeSessionInput): Session =
    send("POST", p("api", "worktrees", "sessions"), WorktreeSessionInput.serializer(), input, Session.serializer())
