package dev.conclave.client.logic

import dev.conclave.client.model.CiState
import dev.conclave.client.model.GithubRepo
import dev.conclave.client.model.PrDraft
import dev.conclave.client.model.PrState
import dev.conclave.client.model.PullRequestRef
import dev.conclave.client.model.RepoSessionDto
import dev.conclave.client.model.SessionRepo

/** The color a repo line takes: green when merged or checks passed, red for a failed check, violet while checks run. */
enum class RepoTone { OK, FAULT, LIVE, QUIET }

/**
 * The words for a repo session on the phone (docs/DESIGN.md 30): the same
 * sentences as the web's RepoBar and the hub's state line, built from what
 * the session carries in meta.repo.
 */
object RepoWords {
    /** The branch without the conclave/ every repo session branch starts with. */
    fun branchShort(branch: String): String = branch.removePrefix("conclave/")

    /** "acme/widgets on fix-login-ab12". */
    fun where(r: SessionRepo): String = "${r.repo} on ${branchShort(r.branch)}"

    /** "#12 open", "#12 draft", "#12 merged". */
    fun prShort(pr: PullRequestRef): String = "#${pr.number} ${stateWord(pr)}"

    private fun stateWord(pr: PullRequestRef): String = when (pr.state) {
        PrState.OPEN -> if (pr.draft) "draft" else "open"
        PrState.MERGED -> "merged"
        PrState.CLOSED -> "closed"
    }

    fun ci(ci: CiState?): String? = when (ci) {
        CiState.PENDING -> "Checks are running"
        CiState.SUCCESS -> "Checks passed"
        CiState.FAILURE -> "A check failed"
        else -> null
    }

    /** One sentence: where the pull request stands. */
    fun line(r: SessionRepo): String {
        val pr = r.pr
        return when {
            r.cleaned -> "Cleaned up. The branch stays on GitHub."
            pr == null -> "No pull request yet."
            pr.state == PrState.MERGED -> "Pull request #${pr.number} was merged."
            pr.state == PrState.CLOSED -> "Pull request #${pr.number} was closed without a merge."
            else -> "Pull request #${pr.number} is open${if (pr.draft) " as a draft" else ""}." + (ci(r.ci)?.let { " $it." } ?: "")
        }
    }

    fun tone(r: SessionRepo): RepoTone {
        val pr = r.pr ?: return RepoTone.QUIET
        if (r.cleaned) return RepoTone.QUIET
        return when {
            pr.state == PrState.MERGED -> RepoTone.OK
            pr.state == PrState.CLOSED -> RepoTone.QUIET
            r.ci == CiState.FAILURE -> RepoTone.FAULT
            r.ci == CiState.PENDING -> RepoTone.LIVE
            r.ci == CiState.SUCCESS -> RepoTone.OK
            else -> RepoTone.QUIET
        }
    }

    /** The pull request's page, when there is one and it is a web address. */
    fun link(r: SessionRepo): String? = r.pr?.url?.takeIf { it.startsWith("https://") || it.startsWith("http://") }

    /**
     * Which actions a repo session offers now (the web's repoActions). Push
     * while there are commits GitHub does not have; Open pull request once
     * there are commits and no pull request is open or merged; Clean up after
     * a merge or close.
     */
    fun actions(r: RepoSessionDto): RepoActions {
        if (r.cleaned) return RepoActions(push = false, openPr = false, viewPr = r.pr != null, cleanUp = false)
        // a folder worktree with no GitHub origin, or GitHub not connected: nothing to push to
        if (r.pullRequests == false) return RepoActions(push = false, openPr = false, viewPr = r.pr != null, cleanUp = r.canCleanUp)
        val commits = r.commits ?: 0
        val dirty = r.dirty ?: 0
        val live = r.pr != null && r.pr.state == PrState.OPEN
        val done = r.pr != null && r.pr.state != PrState.OPEN
        return RepoActions(
            push = r.online && !done && (r.pushed == "behind" || (r.pushed == "never" && (commits > 0 || dirty > 0)) || (live && dirty > 0)),
            openPr = r.online && !live && !done && (commits > 0 || dirty > 0),
            viewPr = r.pr != null,
            cleanUp = r.canCleanUp,
        )
    }

    /**
     * The one action a phone keeps over the composer (the conversation
     * sheet has the rest): Clean up, else Open pull request, else Push.
     */
    fun mainAction(a: RepoActions): RepoAction? = when {
        a.cleanUp -> RepoAction.CLEAN_UP
        a.openPr -> RepoAction.OPEN_PR
        a.push -> RepoAction.PUSH
        else -> null
    }

    /** A folder worktree ("Run in a worktree") with commits not merged yet: Merge into its base. */
    fun canMerge(r: RepoSessionDto): Boolean = r.folder && !r.cleaned && r.online && r.canMerge

    /** A folder worktree not merged or cleaned up yet: Discard drops the worktree and its branch. */
    fun canDiscard(r: RepoSessionDto): Boolean = r.folder && !r.cleaned && r.online && !r.merged

    /** What Discard loses, before it asks. */
    fun discardBody(r: RepoSessionDto): String {
        val commits = r.commits ?: 0
        val dirty = r.dirty ?: 0
        return "The worktree on ${r.deviceName.ifBlank { "the device" }} and ${branchShort(r.branch)} go." +
            (if (commits > 0) " $commits ${if (commits == 1) "commit is" else "commits are"} not merged and are lost." else "") +
            (if (dirty > 0) " ${dirtyWords(dirty)} They are lost." else "")
    }

    /** Check now is offered while there is something on GitHub to read: an open pull request, or a pushed branch. */
    fun canCheck(r: RepoSessionDto): Boolean = !r.cleaned && (r.pr?.state == PrState.OPEN || r.pushed != "never")

    /** "2 files are not committed.", "1 file is not committed." */
    fun dirtyWords(n: Int): String = "$n ${if (n == 1) "file is" else "files are"} not committed."

    /** The commit message the dialogs start with: the session's title, else a plain one. */
    fun commitMessage(title: String): String = title.trim().takeIf { it.isNotEmpty() && it != "New chat" && it != "New session" } ?: "Work from Conclave"

    /** "acme/widgets, fix-login-ab12 into main.": what Open pull request opens. */
    fun prWhere(repo: String, draft: PrDraft): String = "$repo, ${branchShort(draft.head)} into ${draft.base}."

    /** What Clean up does, before it asks. */
    fun cleanUpBody(r: RepoSessionDto): String {
        val dirty = r.dirty ?: 0
        if (r.folder && r.pr == null) return "The worktree on ${r.deviceName.ifBlank { "the device" }} and ${branchShort(r.branch)} go." + (if (dirty > 0) " ${dirtyWords(dirty)} They are lost." else "")
        return "The worktree on ${r.deviceName.ifBlank { "the device" }} goes. ${branchShort(r.branch)} stays on GitHub." +
            (if (dirty > 0) " ${dirtyWords(dirty)} They are lost." else "") +
            (if (r.canCleanUp) "" else " The pull request is not merged or closed yet.")
    }

    /** Clean up after a merge needs no force; with files not committed, or before the merge, it does. */
    fun cleanUpForce(r: RepoSessionDto): Boolean = !r.canCleanUp || (r.dirty ?: 0) > 0

    /** The words of a repo session's last change, for a toast: the hub's line, else ours. */
    fun opened(r: RepoSessionDto): String = r.pr?.let { "Opened pull request #${it.number}." } ?: r.line

    /** A repository in the picker: "private, read only, 3d ago". */
    fun repoDetail(r: GithubRepo, now: Long): String = listOfNotNull(
        if (r.private) "private" else null,
        if (r.canPush) null else "read only",
        r.pushedAt?.let { Format.relative(it, now) },
    ).joinToString(", ")

    /** Where a new repo session starts: "acme/widgets from main". */
    fun startWords(repo: String, base: String?): String = if (base.isNullOrBlank()) repo else "$repo from $base"
}

/** What a repo session offers now. */
data class RepoActions(val push: Boolean, val openPr: Boolean, val viewPr: Boolean, val cleanUp: Boolean)

enum class RepoAction(val label: String) { PUSH("Push"), OPEN_PR("Open pull request"), CLEAN_UP("Clean up") }
