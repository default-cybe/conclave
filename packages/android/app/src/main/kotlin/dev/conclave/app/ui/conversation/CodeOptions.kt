@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.conversation

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.conclave.app.data.CodeDefaults
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.Segmented
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.common.solidButtonColors
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.folderGit
import dev.conclave.client.github
import dev.conclave.client.githubBranches
import dev.conclave.client.githubRepos
import dev.conclave.client.logic.Panel
import dev.conclave.client.logic.Paths
import dev.conclave.client.logic.RepoWords
import dev.conclave.client.logic.Start
import dev.conclave.client.model.FolderGit
import dev.conclave.client.model.GithubBranches
import dev.conclave.client.model.GithubRepo
import dev.conclave.client.model.GithubStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/**
 * Code's "+" on Home after the files (docs/DESIGN.md 40): the agent, only
 * when there are custom ones (the default coding agent hands work to its
 * subagents itself), the computer when there are several, where it works (a
 * folder or a GitHub repository), Run in a worktree when the folder is in a
 * git repository, and Ultra. [onWhere] opens where it works, on GitHub when true.
 */
@Composable
fun CodePlus(d: CodeDefaults, setup: Start.Setup, onChange: (CodeDefaults) -> Unit, onWhere: (github: Boolean) -> Unit, dismiss: () -> Unit) {
    val hub = LocalAppContainer.current.hub
    val agents by hub.agents.collectAsStateWithLifecycle()
    val devices by hub.devices.collectAsStateWithLifecycle()
    val info by hub.hubInfo.collectAsStateWithLifecycle()
    val c = Conclave.colors
    val customs = Start.customAgents(agents, d.agent)
    if (customs.isNotEmpty()) {
        // another agent brings its own model and computer: only the permission mode, Effort and Ultra stay
        fun pick(agent: String?) = onChange(CodeDefaults(agent = agent, permissionMode = d.permissionMode, ultra = d.ultra, thinking = d.thinking, assistantModel = d.assistantModel))
        OptionLabel("Agent")
        ChoiceRow("${Start.CODE_AGENT}, the default", selected = setup.agent == Start.CODE_AGENT, detail = "Hands work to its subagents itself", onClick = { pick(null) })
        customs.forEach { a -> ChoiceRow(a.name, selected = setup.agent == a.name, detail = a.description.ifBlank { null }, onClick = { pick(a.name) }) }
        HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.padding(top = 6.dp))
    }
    val computers = Start.computers(devices)
    if (computers.size > 1 && d.repo == null) {
        OptionLabel("Run on")
        // the hub first, by its name: "homelab (hub)"
        computers.forEach { dev ->
            ChoiceRow(Start.placeName(dev.id, devices, info?.name), selected = setup.device == dev.id, detail = if (dev.online || dev.id == Start.HUB) null else "offline", onClick = {
                // a folder belongs to its computer: another one starts without one
                if (dev.id != setup.device) onChange(d.copy(device = dev.id, cwd = null, cwdDevice = null))
            })
        }
        HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.padding(top = 6.dp))
    }
    OptionLabel("Work in")
    ChoiceRow("A folder", selected = d.repo == null, onClick = {
        if (d.repo != null) {
            onChange(d.copy(repo = null, base = null))
        } else {
            dismiss()
            onWhere(false)
        }
    })
    ChoiceRow("A GitHub repository", selected = d.repo != null, detail = "A new worktree on its own branch", onClick = {
        dismiss()
        onWhere(true)
    })
    // offered only for a folder in a git repository, asked of the device
    val cwd = if (d.repo == null) setup.cwd else null
    var git by remember { mutableStateOf<FolderGit?>(null) }
    LaunchedEffect(setup.device, cwd) {
        git = null
        if (cwd == null) return@LaunchedEffect
        git = try {
            hub.api { it.folderGit(setup.device, cwd) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
    }
    val g = git
    if (cwd != null && g != null && g.git) {
        val from = g.branch?.let { " from $it" } ?: ""
        SwitchRow("Run in a worktree", "A new branch$from, so sessions do not clash. Merge or discard it when done.", d.worktree) { onChange(d.copy(worktree = it)) }
    }
    HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.padding(top = 6.dp))
    SwitchRow("Ultra", ULTRA_LINE, d.ultra) { onChange(d.copy(ultra = it)) }
}

/**
 * Where a Code session works: the device, then a folder on it (the ones
 * sessions used there, the home folder, or a path), or with [github] a
 * repository from GitHub and the branch to start from (docs/DESIGN.md 30):
 * the session then gets its own worktree on a new branch, so no folder.
 * Code shows it on the first send while it is not set; [onDone] then sends.
 */
@Composable
fun CodeWhereSheet(
    d: CodeDefaults,
    onChange: (CodeDefaults) -> Unit,
    onDone: () -> Unit,
    onDismiss: () -> Unit,
    done: String = "Start",
    github: Boolean = false,
    /** Opens on GitHub rather than on the folders. */
    startGithub: Boolean = false,
) {
    val hub = LocalAppContainer.current.hub
    val devices by hub.devices.collectAsStateWithLifecycle()
    val sessions by hub.sessions.collectAsStateWithLifecycle()
    val info by hub.hubInfo.collectAsStateWithLifecycle()
    val c = Conclave.colors
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var typed by remember { mutableStateOf("") }
    var fromGithub by remember { mutableStateOf(github && (startGithub || d.repo != null)) }
    val device = d.device
    val folders = remember(sessions, device) { if (device == null) emptyList() else Panel.recentFolders(sessions, device) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = state, containerColor = c.bgRaise) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(bottom = 16.dp)) {
            Text("Where should it work?", style = ConclaveType.title, color = c.fg, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            OptionLabel("Device")
            // the hub first, then the computers; a phone never runs code
            val ids = Start.computers(devices).map { it.id }
            ids.forEach { id ->
                ChoiceRow(deviceLabel(id, devices, info?.name), selected = device == id, onClick = {
                    // a folder belongs to its device: another device starts without one
                    onChange(d.copy(device = id, cwd = if (id == device) d.cwd else null))
                })
            }
            if (github) {
                Segmented(
                    value = fromGithub,
                    options = listOf(false to "Folder", true to "GitHub"),
                    onChange = { on ->
                        fromGithub = on
                        // a folder and a repository do not mix: the one left goes
                        if (!on && d.repo != null) onChange(d.copy(repo = null, base = null))
                    },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
                )
            }
            if (fromGithub) {
                GithubPlace(d, onChange)
            } else if (device != null) {
                HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.padding(top = 6.dp))
                OptionLabel("Folder")
                ChoiceRow("Home folder", selected = d.cwd == "~", onClick = { onChange(d.copy(cwd = "~", repo = null, base = null)) })
                folders.forEach { f ->
                    ChoiceRow(Paths.folderName(f), selected = d.cwd == f, detail = Paths.shortPath(f, 3), onClick = { onChange(d.copy(cwd = f, repo = null, base = null)) })
                }
                Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = typed,
                        onValueChange = { typed = it },
                        placeholder = { Text("Another folder, a path") },
                        singleLine = true,
                        textStyle = CodeStyle,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { if (typed.isNotBlank()) onChange(d.copy(cwd = typed.trim(), repo = null, base = null)) }),
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.width(8.dp))
                    TextButton(onClick = { onChange(d.copy(cwd = typed.trim(), repo = null, base = null)) }, enabled = typed.isNotBlank()) { Text("Use") }
                }
                val custom = d.cwd
                if (custom != null && custom != "~" && custom !in folders) {
                    ChoiceRow(Paths.folderName(custom).ifEmpty { custom }, selected = true, detail = Paths.shortPath(custom, 3), onClick = {})
                }
            }
            Spacer(Modifier.height(8.dp))
            Button(
                onClick = onDone,
                enabled = d.device != null && (if (fromGithub) d.repo != null else d.cwd != null),
                colors = solidButtonColors(),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp).height(52.dp),
            ) { Text(done) }
        }
    }
}

/**
 * A repository the hub's GitHub token can see, searched as you type, most
 * recently pushed first; then the branch to start from, the default unless
 * you pick another.
 */
@Composable
private fun GithubPlace(d: CodeDefaults, onChange: (CodeDefaults) -> Unit) {
    val hub = LocalAppContainer.current.hub
    val c = Conclave.colors
    var status by remember { mutableStateOf<GithubStatus?>(null) }
    var q by remember { mutableStateOf("") }
    var repos by remember { mutableStateOf<List<GithubRepo>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var branches by remember { mutableStateOf<GithubBranches?>(null) }
    val now = remember { System.currentTimeMillis() }
    LaunchedEffect(Unit) {
        status = try {
            hub.api { it.github() }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            GithubStatus(connected = false, error = errorText(e))
        }
    }
    LaunchedEffect(q, status?.connected) {
        if (status?.connected != true) return@LaunchedEffect
        if (q.isNotEmpty()) delay(200)
        try {
            repos = hub.api { it.githubRepos(q.trim().ifEmpty { null }) }
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = errorText(e)
        }
    }
    val repo = d.repo
    LaunchedEffect(repo) {
        branches = null
        if (repo == null) return@LaunchedEffect
        branches = try {
            hub.api { it.githubBranches(repo) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
    }
    val st = status
    if (st != null && !st.connected) {
        Text(
            (st.error ?: "Connect GitHub to start from a repository.") + " In the web app: Settings, GitHub.",
            style = ConclaveType.body,
            color = c.fg2,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
        )
        return
    }
    OutlinedTextField(
        value = q,
        onValueChange = { q = it },
        placeholder = { Text("Search repositories") },
        singleLine = true,
        keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Search),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp),
    )
    val list = repos
    when {
        error != null -> Text(error!!, style = ConclaveType.meta, color = c.fault, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
        list == null -> Text("Loading repositories", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
        list.isEmpty() -> Text(if (q.isNotBlank()) "No repository matches \"$q\"." else "The token sees no repositories.", style = ConclaveType.body, color = c.fg3, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
    }
    // the one picked stays in sight while the search moves on
    val shown = (list.orEmpty().take(30) + listOfNotNull(if (repo != null && list.orEmpty().take(30).none { it.fullName == repo }) GithubRepo(fullName = repo) else null))
    shown.forEach { r ->
        val detail = listOfNotNull(RepoWords.repoDetail(r, now).ifEmpty { null }, r.description?.ifBlank { null }).joinToString(". ")
        ChoiceRow(r.fullName, selected = repo == r.fullName, detail = detail.ifEmpty { null }, onClick = { onChange(d.copy(repo = r.fullName, base = null, cwd = null)) })
    }
    if (repo != null) {
        HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.padding(top = 6.dp))
        OptionLabel("Start from")
        val b = branches
        if (b == null) {
            ChoiceRow(d.base ?: "Default branch", selected = true, onClick = {})
        } else {
            val current = d.base ?: b.defaultBranch
            (listOf(b.defaultBranch) + b.branches).distinct().take(40).forEach { name ->
                ChoiceRow(
                    name,
                    selected = current == name,
                    detail = if (name == b.defaultBranch) "default" else null,
                    onClick = { onChange(d.copy(base = if (name == b.defaultBranch) null else name)) },
                )
            }
        }
    }
}
