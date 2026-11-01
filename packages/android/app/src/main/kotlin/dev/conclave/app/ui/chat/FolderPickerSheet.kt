@file:OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)

package dev.conclave.app.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.conclave.app.ui.common.StateWordText
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.Locations
import dev.conclave.client.logic.MoveOutcome
import dev.conclave.client.model.Device
import dev.conclave.client.model.FileEntry
import dev.conclave.client.model.IdentifyResult
import dev.conclave.client.model.MatchLevel
import dev.conclave.client.model.MoveInput
import dev.conclave.client.model.Session
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Choose folder (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md 2.6): when a
 * session moves to a device where Conclave did not find its project, this
 * sheet browses that device from the hub's best guess. The closest folders
 * the hub found come first. As the owner moves through folders, one line
 * says how the folder compares with the old copy ("Same git history and
 * remote as the arch-desktop copy"). Pin keeps the folder as the project's
 * place on that device. A different history offers Use once and Use and
 * remember. Clone here and Continue without files are the way out when the
 * folder is not there at all.
 */
@Composable
fun FolderPickerSheet(req: ChooserRequest, session: Session, vm: LocationViewModel, devices: List<Device>, onDismiss: () -> Unit) {
    val c = Conclave.colors
    val scope = rememberCoroutineScope()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val loc by vm.location.collectAsStateWithLifecycle()
    val device = devices.firstOrNull { it.id == req.device }
    val home = device?.info?.home?.ifBlank { null }
    val deviceName = device?.name?.ifBlank { null } ?: if (req.device == "local") "the hub" else req.device
    val roots = device?.roots.orEmpty()
    val start = remember(req) { Locations.browseStart(req.result?.browseFrom ?: req.start, roots, home) }
    var path by remember(req) { mutableStateOf(start) }
    var typed by remember(req) { mutableStateOf(Locations.tildePath(start, home)) }
    var entries by remember(req) { mutableStateOf<List<FileEntry>?>(null) }
    var browseError by remember(req) { mutableStateOf<String?>(null) }
    var check by remember(req) { mutableStateOf<IdentifyResult?>(null) }
    var checking by remember(req) { mutableStateOf(false) }
    var mismatch by remember(req) { mutableStateOf<String?>(null) }
    var pin by remember(req) { mutableStateOf(false) }
    // which of Use this folder and Continue without files is moving, for its busy word
    var usingFolder by remember(req) { mutableStateOf(true) }
    val candidates = req.result?.candidates.orEmpty()
    val cloneUrl = req.result?.cloneUrl ?: loc?.cloneUrl
    val projectName = req.projectName?.ifBlank { null } ?: Locations.projectName(loc, session.cwd)
    val cloning = req.clone

    // list the folder
    LaunchedEffect(req, path) {
        entries = null
        browseError = null
        mismatch = null
        typed = Locations.tildePath(path, home)
        try {
            entries = vm.browse(req.device, path)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            browseError = errorText(e)
        }
    }

    // how the folder compares with the old copy, a moment after the owner stops moving
    LaunchedEffect(req, path, cloning) {
        if (cloning) return@LaunchedEffect
        check = null
        checking = true
        delay(250)
        check = try {
            vm.identify(req.device, path)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
        checking = false
    }

    fun use(keep: Boolean, allowMismatch: Boolean) {
        scope.launch {
            val r = vm.move(
                MoveInput(device = req.device, cwd = path, remember = if (keep) true else null, allowMismatch = if (allowMismatch) true else null),
                if (keep) "Saving" else "Moving",
            )
            if (r != null && Locations.outcome(r) == MoveOutcome.MISMATCH) mismatch = r.line.ifBlank { "This folder has another git history." }
        }
    }

    val differs = check?.level == MatchLevel.MISMATCH || mismatch != null
    val up = Locations.parentOf(path)
    val title = if (cloning) "Clone $projectName on $deviceName" else "Choose the folder on $deviceName"
    val description = when {
        cloning -> "Pick the folder to clone into. The copy goes in ${Locations.cloneInto(Locations.tildePath(path, home), projectName)}."
        else -> req.result?.line?.ifBlank { null } ?: "Pick the folder this session should use on $deviceName."
    }
    val working = busy != null

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = c.bgRaise) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(title, style = ConclaveType.title, color = c.fg)
            Text(description, style = ConclaveType.body, color = c.fg2)

            if (!cloning && candidates.isNotEmpty()) {
                Text("Closest folders", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(top = 4.dp))
                Column {
                    candidates.forEach { cand ->
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 48.dp)
                                .background(if (cand.path == path) c.bgHover else c.bgRaise, RoundedCornerShape(5.dp))
                                .clickable { path = cand.path }
                                .padding(horizontal = 8.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(Locations.tildePath(cand.path, home), style = CodeStyle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (cand.line.isNotBlank()) Text(cand.line, style = ConclaveType.meta, color = c.fg3, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            }
                            Spacer(Modifier.width(8.dp))
                            StateWordText(Locations.levelWord(cand.level), Locations.levelTone(cand.level))
                        }
                    }
                }
            }

            // where we are: up one folder, the path to type into, Go
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { up?.let { path = it } }, enabled = up != null) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Up one folder")
                }
                BasicTextField(
                    value = typed,
                    onValueChange = { typed = it },
                    singleLine = true,
                    textStyle = CodeStyle.copy(color = c.fg),
                    cursorBrush = SolidColor(c.signal),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { Locations.expandTilde(typed, home).takeIf { it.isNotBlank() }?.let { path = it } }),
                    modifier = Modifier.weight(1f).heightIn(min = 40.dp).background(c.bgSunk, RoundedCornerShape(5.dp))
                        .border(1.dp, c.rule2, RoundedCornerShape(5.dp)).padding(horizontal = 10.dp, vertical = 10.dp),
                )
                TextButton(onClick = { Locations.expandTilde(typed, home).takeIf { it.isNotBlank() }?.let { path = it } }) { Text("Go") }
            }

            if (!cloning) {
                Row(Modifier.fillMaxWidth().heightIn(min = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        mismatch ?: check?.line ?: if (checking) "Checking this folder" else "",
                        style = ConclaveType.meta,
                        color = if (differs) c.warn else c.fg2,
                        modifier = Modifier.weight(1f),
                    )
                    check?.let {
                        Spacer(Modifier.width(8.dp))
                        StateWordText(Locations.levelWord(it.level), Locations.levelTone(it.level))
                    }
                }
            }

            HorizontalDivider(thickness = 1.dp, color = c.rule)
            Column(Modifier.fillMaxWidth().heightIn(min = 96.dp, max = 300.dp).verticalScroll(rememberScrollState())) {
                val list = entries
                when {
                    browseError != null -> Text(browseError.orEmpty(), style = ConclaveType.meta, color = c.fault, modifier = Modifier.padding(vertical = 10.dp))
                    list == null -> Text("Reading the folder", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(vertical = 10.dp))
                    list.isEmpty() -> Text("No folders in here.", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(vertical = 10.dp))
                    else -> list.forEach { e ->
                        Text(
                            e.name + "/",
                            style = CodeStyle,
                            color = c.fg2,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable { path = e.path.ifBlank { path.trimEnd('/') + "/" + e.name } }
                                .padding(horizontal = 4.dp, vertical = 12.dp),
                        )
                    }
                }
            }
            if (roots.isNotEmpty()) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Roots on $deviceName:", style = ConclaveType.meta, color = c.fg3)
                    roots.forEach { r ->
                        Text(r, style = CodeStyle, color = c.fg3, modifier = Modifier.clickable { path = Locations.expandTilde(r, home) })
                    }
                }
            }

            if (!differs && !cloning) {
                Row(Modifier.fillMaxWidth().clickable { pin = !pin }, verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = pin, onCheckedChange = { pin = it })
                    Column {
                        Text("Pin this folder on $deviceName", style = ConclaveType.body, color = c.fg)
                        Text("Sessions of this project use it here from now on, and writes there do not ask again.", style = ConclaveType.meta, color = c.fg3)
                    }
                }
            }

            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                when {
                    differs -> {
                        Button(onClick = { use(keep = true, allowMismatch = true) }, enabled = !working) { Text(if (busy == "Saving") "Saving" else "Use and remember") }
                        OutlinedButton(onClick = { use(keep = false, allowMismatch = true) }, enabled = !working) { Text(if (busy == "Moving") "Moving" else "Use once") }
                        TextButton(onClick = onDismiss) { Text("Cancel") }
                    }
                    cloning -> {
                        Button(
                            onClick = { cloneUrl?.let { url -> scope.launch { vm.clone(req.device, url, Locations.cloneInto(path, projectName)) } } },
                            enabled = !working && cloneUrl != null,
                        ) { Text(if (busy == "Cloning") "Cloning" else "Clone here") }
                        TextButton(onClick = onDismiss) { Text("Cancel") }
                    }
                    else -> {
                        Button(onClick = { usingFolder = true; use(keep = pin, allowMismatch = false) }, enabled = !working) {
                            Text(if (usingFolder && (busy == "Moving" || busy == "Saving")) busy.orEmpty() else "Use this folder")
                        }
                        if (cloneUrl != null) {
                            OutlinedButton(onClick = { scope.launch { vm.clone(req.device, cloneUrl, Locations.cloneInto(path, projectName)) } }, enabled = !working) {
                                Text(if (busy == "Cloning") "Cloning" else "Clone here")
                            }
                        }
                        TextButton(onClick = { usingFolder = false; scope.launch { vm.move(MoveInput(device = req.device, withoutFiles = true)) } }, enabled = !working) {
                            Text(if (!usingFolder && busy == "Moving") "Moving" else "Continue without files")
                        }
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
        }
    }
}
