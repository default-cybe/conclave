@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.conversation

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
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
import dev.conclave.client.githubConnect
import dev.conclave.client.githubRepos
import dev.conclave.client.logic.Locations
import dev.conclave.client.logic.Panel
import dev.conclave.client.logic.Paths
import dev.conclave.client.logic.RepoWords
import dev.conclave.client.logic.Start
import dev.conclave.client.model.FileEntry
import dev.conclave.client.model.FolderGit
import dev.conclave.client.model.GithubBranches
import dev.conclave.client.model.GithubRepo
import dev.conclave.client.model.GithubStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Code's "+" on Home after the files (docs/DESIGN.md 40): the computer when
 * there are several, where it works (a folder or a GitHub repository), Run
 * in a worktree when the folder is in a git repository, and Ultra (Home has
 * no mode chip to hold it). The agent and memory are chips beside the
 * model. [onWhere] opens where it works, on GitHub when true.
 */
@Composable
fun CodePlus(d: CodeDefaults, setup: Start.Setup, onChange: (CodeDefaults) -> Unit, onWhere: (github: Boolean) -> Unit, dismiss: () -> Unit) {
    val hub = LocalAppContainer.current.hub
    val devices by hub.devices.collectAsStateWithLifecycle()
    val info by hub.hubInfo.collectAsStateWithLifecycle()
    val c = Conclave.colors
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
    val home = devices.firstOrNull { it.id == device }?.info?.home?.ifBlank { null }
    // Recent as in Codex: the folder's name over its muted path (Panel.recentRows)
    val rows = remember(sessions, device, home) { if (device == null) emptyList() else Panel.recentRows(sessions, device, home) }
    val folders = rows.map { it.path }
    var browsing by remember { mutableStateOf(false) }
    // the folder picked is asked of its device before Start; the hub refuses a missing one too (core machine/folder-check.ts)
    val chosen = if (fromGithub) null else d.cwd
    val online = device == Start.HUB || devices.firstOrNull { it.id == device }?.online == true
    val deviceName = devices.firstOrNull { it.id == device }?.name?.ifBlank { null } ?: info?.name ?: device ?: ""
    var check by remember { mutableStateOf(FolderState.OK) }
    // an offline device cannot be checked: Start waits for an explicit "Use anyway"
    var anyway by remember(device, chosen) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(device, chosen, online) {
        check = FolderState.OK
        if (device == null || chosen == null || !online) return@LaunchedEffect
        check = FolderState.CHECKING
        check = try {
            if (hub.api { it.folderCheck(device, chosen) }.exists) FolderState.OK else FolderState.MISSING
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            FolderState.OK
        }
    }
    val offline = device != null && chosen != null && !online
    val folderReady = check == FolderState.OK && (!offline || anyway)
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
                rows.forEach { r ->
                    ChoiceRow(r.name, selected = d.cwd == r.path, detail = r.detail, onClick = { onChange(d.copy(cwd = r.path, repo = null, base = null)) })
                }
                ChoiceRow("Browse…", selected = false, onClick = { browsing = true })
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
                if (chosen != null && check == FolderState.MISSING) {
                    // the same words as the web and the hub's 400
                    Text("No folder at $chosen on $deviceName", style = ConclaveType.meta, color = c.fault, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
                    TextButton(onClick = {
                        scope.launch {
                            check = try {
                                if (hub.api { it.makeFolder(device, chosen) }.exists) FolderState.OK else FolderState.MISSING
                            } catch (e: CancellationException) {
                                throw e
                            } catch (_: Exception) {
                                FolderState.MISSING
                            }
                        }
                    }, modifier = Modifier.padding(horizontal = 12.dp)) { Text("Create folder") }
                } else if (offline) {
                    Text("$deviceName is offline, the folder can't be checked", style = ConclaveType.meta, color = c.fg2, modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
                    if (!anyway) TextButton(onClick = { anyway = true }, modifier = Modifier.padding(horizontal = 12.dp)) { Text("Use anyway") }
                }
            }
            if (browsing && device != null) {
                BrowseFolderSheet(device, deviceName, home, start = d.cwd, onSelect = {
                    browsing = false
                    onChange(d.copy(cwd = it, repo = null, base = null))
                }, onDismiss = { browsing = false })
            }
            Spacer(Modifier.height(8.dp))
            Button(
                onClick = onDone,
                enabled = d.device != null && (if (fromGithub) d.repo != null else d.cwd != null && folderReady),
                colors = solidButtonColors(),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp).height(52.dp),
            ) { Text(done) }
        }
    }
}

/**
 * Browse… in CodeWhereSheet: the device's folders over GET
 * /api/devices/:device/files (as Choose folder does, FolderPickerSheet.kt).
 * Tap a folder to go in, Up to go back, Select to use the folder shown.
 */
@Composable
private fun BrowseFolderSheet(device: String, deviceName: String, home: String?, start: String?, onSelect: (String) -> Unit, onDismiss: () -> Unit) {
    val hub = LocalAppContainer.current.hub
    val c = Conclave.colors
    var path by remember { mutableStateOf(Locations.expandTilde(start?.takeIf { it.isNotBlank() } ?: "~", home).ifBlank { home ?: "/" }) }
    var entries by remember { mutableStateOf<List<FileEntry>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(path) {
        entries = null
        error = null
        try {
            entries = hub.api { it.browse(device, path) }.filter { it.type == "dir" || it.type == "symlink" }.filter { !it.name.startsWith(".") }.sortedBy { it.name.lowercase() }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = errorText(e)
        }
    }
    val up = Locations.parentOf(path)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = c.bgRaise) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = 16.dp)) {
            Text("Open folder on $deviceName", style = ConclaveType.title, color = c.fg, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { up?.let { path = it } }, enabled = up != null) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Up one folder")
                }
                Text(Locations.tildePath(path, home), style = CodeStyle, color = c.fg2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
            HorizontalDivider(thickness = 1.dp, color = c.rule)
            Column(Modifier.fillMaxWidth().heightIn(min = 120.dp, max = 420.dp).verticalScroll(rememberScrollState())) {
                val list = entries
                when {
                    error != null -> Text(error.orEmpty(), style = ConclaveType.meta, color = c.fault, modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp))
                    list == null -> Text("Reading the folder", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp))
                    list.isEmpty() -> Text("No folders in here.", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp))
                    else -> list.forEach { e -> ChoiceRow(e.name, selected = false, onClick = { path = e.path.ifBlank { path.trimEnd('/') + "/" + e.name } }) }
                }
            }
            Button(
                onClick = { onSelect(Locations.tildePath(path, home)) },
                enabled = error == null,
                colors = solidButtonColors(),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp).height(52.dp),
            ) { Text("Select this folder") }
        }
    }
}

/** The folder picked in CodeWhereSheet: there (or not checkable: OK), being asked, or not on the device. */
private enum class FolderState { OK, CHECKING, MISSING }

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
            (st.error ?: "Connect GitHub to start from a repository.") + " Paste a fine-grained token from github.com/settings/personal-access-tokens/new. It stays on the hub.",
            style = ConclaveType.body,
            color = c.fg2,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
        )
        // the same call as the web's Settings, GitHub; the hub takes it from the owner only and says so otherwise
        var token by remember { mutableStateOf("") }
        var connecting by remember { mutableStateOf(false) }
        var connectError by remember { mutableStateOf<String?>(null) }
        val scope = rememberCoroutineScope()
        OutlinedTextField(
            value = token,
            onValueChange = { token = it },
            placeholder = { Text("GitHub token") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp),
        )
        connectError?.let { Text(it, style = ConclaveType.meta, color = c.fault, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp)) }
        Button(
            onClick = {
                connecting = true
                connectError = null
                scope.launch {
                    try {
                        // connected: the repository list loads (LaunchedEffect on status.connected)
                        status = hub.api { it.githubConnect(token.trim()) }
                        token = ""
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        connectError = errorText(e)
                    } finally {
                        connecting = false
                    }
                }
            },
            enabled = !connecting && token.isNotBlank(),
            colors = solidButtonColors(),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp).height(52.dp),
        ) { Text(if (connecting) "Connecting" else "Connect GitHub") }
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
