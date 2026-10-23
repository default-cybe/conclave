package dev.conclave.app.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.ConfirmDialog
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.motion.Swap
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.cleanupSession
import dev.conclave.client.logic.RepoWords
import dev.conclave.client.model.CleanupInput
import dev.conclave.client.model.OpenPrInput
import dev.conclave.client.model.PrDraft
import dev.conclave.client.model.PushInput
import dev.conclave.client.model.RepoSessionDto
import dev.conclave.client.model.Session
import dev.conclave.client.model.repo
import dev.conclave.client.openPullRequest
import dev.conclave.client.prDraft
import dev.conclave.client.pushSession
import dev.conclave.client.sessionRepo
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/**
 * A repo session's state from the hub and what can be done with it (docs/
 * DESIGN.md 30; the web's RepoBar.tsx): Push (a commit first when files are
 * not committed), Open pull request from the hub's draft, Check now, and
 * Clean up. The hub reads the pull request from GitHub every two minutes
 * while it is open; Check now reads it at once.
 */
class RepoViewModel(hub: HubRepository, private val sessionId: String) : HubViewModel(hub) {
    val repo = MutableStateFlow<RepoSessionDto?>(null)

    /** Which action runs: "push", "draft", "pr", "clean", "check". */
    val busy = MutableStateFlow<String?>(null)

    /** The pull request the hub drafted, while its dialog is open. */
    val draft = MutableStateFlow<PrDraft?>(null)

    fun reload(refresh: Boolean = false) = viewModelScope.launch {
        if (refresh) busy.value = "check"
        try {
            repo.value = hub.api { it.sessionRepo(sessionId, refresh) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (refresh) say(errorText(e))
        } finally {
            if (refresh) busy.value = null
        }
    }

    private fun run(what: String, block: suspend () -> Unit) = viewModelScope.launch {
        busy.value = what
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            say(errorText(e))
        } finally {
            busy.value = null
            try {
                repo.value = hub.api { it.sessionRepo(sessionId) }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
            }
        }
    }

    /** Push; with [commitMessage] what is not committed goes in a commit first. */
    fun push(commitMessage: String?, then: () -> Unit = {}) = run("push") {
        val r = hub.api { it.pushSession(sessionId, PushInput(commitMessage)) }
        say(r.line.ifBlank { "Pushed." })
        then()
    }

    /** The hub drafts the pull request from the session; the dialog opens with it. */
    fun startPr() = run("draft") {
        draft.value = hub.api { it.prDraft(sessionId) }
    }

    fun openPr(title: String, body: String, asDraft: Boolean, commitMessage: String?) = run("pr") {
        // what is not committed goes in a commit first, so the pull request has it
        if (commitMessage != null) hub.api { it.pushSession(sessionId, PushInput(commitMessage)) }
        val r = hub.api { it.openPullRequest(sessionId, OpenPrInput(title.trim(), body, if (asDraft) true else null)) }
        draft.value = null
        repo.value = r
        say(RepoWords.opened(r))
    }

    fun cleanUp(force: Boolean, then: () -> Unit = {}) = run("clean") {
        val r = hub.api { it.cleanupSession(sessionId, CleanupInput(if (force) true else null)) }
        repo.value = r
        say(r.line.ifBlank { "Cleaned up." })
        then()
    }
}

/** A repo dialog that is open. */
enum class RepoAsk { COMMIT, CLEAN, ARCHIVE }

/**
 * The dialogs of a repo session's actions: Commit and push, Open a pull
 * request (when the hub's draft is in), Clean up, and Archive and clean up.
 */
@Composable
fun RepoDialogs(session: Session, vm: RepoViewModel, ask: RepoAsk?, onAsk: (RepoAsk?) -> Unit, onArchive: () -> Unit) {
    val c = Conclave.colors
    val repo by vm.repo.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val draft by vm.draft.collectAsStateWithLifecycle()
    val dirty = repo?.dirty ?: 0
    val fallback = remember(session.title) { RepoWords.commitMessage(session.title) }

    when (ask) {
        RepoAsk.COMMIT -> {
            var message by remember { mutableStateOf(fallback) }
            AlertDialog(
                onDismissRequest = { onAsk(null) },
                title = { Text("Commit and push?") },
                text = {
                    Column {
                        Text("${RepoWords.dirtyWords(dirty)} The hub commits them on ${repo?.let { RepoWords.branchShort(it.branch) } ?: "the branch"}, then pushes.")
                        OutlinedTextField(value = message, onValueChange = { message = it }, label = { Text("Commit message") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 12.dp))
                    }
                },
                confirmButton = {
                    TextButton(onClick = { vm.push(message.trim().ifEmpty { fallback }, then = { onAsk(null) }) }, enabled = busy == null) {
                        Swap(on = busy == "push", off = { Text("Commit and push") }) { Text("Pushing") }
                    }
                },
                dismissButton = { TextButton(onClick = { onAsk(null) }) { Text("Cancel") } },
            )
        }
        RepoAsk.CLEAN -> repo?.let { r ->
            ConfirmDialog(
                title = "Clean up?",
                text = RepoWords.cleanUpBody(r),
                confirmLabel = "Clean up",
                destructive = dirty > 0,
                onConfirm = {
                    onAsk(null)
                    vm.cleanUp(RepoWords.cleanUpForce(r))
                },
                onDismiss = { onAsk(null) },
            )
        }
        RepoAsk.ARCHIVE -> {
            val meta = session.repo
            AlertDialog(
                onDismissRequest = { onAsk(null) },
                title = { Text("Archive and clean up?") },
                text = {
                    Text(
                        if (meta != null) {
                            "The worktree of ${meta.repo} is still there. Clean up removes it; ${RepoWords.branchShort(meta.branch)} stays on GitHub. Files that are not committed are lost."
                        } else {
                            "The worktree is still there. Clean up removes it."
                        },
                    )
                },
                confirmButton = {
                    val both = {
                        vm.cleanUp(force = true) {
                            onAsk(null)
                            onArchive()
                        }
                    }
                    TextButton(onClick = { both() }, enabled = busy == null) {
                        Swap(on = busy == "clean", off = { Text("Archive and clean up") }) { Text("Cleaning up") }
                    }
                },
                dismissButton = {
                    TextButton(onClick = {
                        onAsk(null)
                        onArchive()
                    }) { Text("Archive only") }
                },
            )
        }
        null -> Unit
    }

    draft?.let { d ->
        var title by remember(d) { mutableStateOf(d.title) }
        var body by remember(d) { mutableStateOf(d.body) }
        var asDraft by remember(d) { mutableStateOf(false) }
        var message by remember(d) { mutableStateOf(fallback) }
        AlertDialog(
            onDismissRequest = { vm.draft.value = null },
            title = { Text("Open a pull request") },
            text = {
                Column {
                    repo?.let { Text("${RepoWords.prWhere(it.repo, d)} Drafted from the session; change it as you like.", style = ConclaveType.meta, color = c.fg3) }
                    OutlinedTextField(value = title, onValueChange = { title = it }, label = { Text("Title") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 10.dp))
                    OutlinedTextField(value = body, onValueChange = { body = it }, label = { Text("Description") }, minLines = 4, maxLines = 10, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                    if (dirty > 0) {
                        OutlinedTextField(
                            value = message,
                            onValueChange = { message = it },
                            label = { Text("Commit message") },
                            supportingText = { Text("${RepoWords.dirtyWords(dirty)} They go in a commit first.") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                        )
                    }
                    Row(Modifier.fillMaxWidth().clickable { asDraft = !asDraft }.heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = asDraft, onCheckedChange = { asDraft = it })
                        Text("Open as a draft", style = ConclaveType.body, color = c.fg)
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { vm.openPr(title, body, asDraft, if (dirty > 0) message.trim().ifEmpty { fallback } else null) }, enabled = title.isNotBlank() && busy == null) {
                    Swap(on = busy == "pr", off = { Text("Open pull request") }) { Text("Opening") }
                }
            },
            dismissButton = { TextButton(onClick = { vm.draft.value = null }) { Text("Cancel") } },
        )
    }
}
