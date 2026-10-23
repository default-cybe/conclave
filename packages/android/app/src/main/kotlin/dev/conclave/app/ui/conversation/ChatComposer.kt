package dev.conclave.app.ui.conversation

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AttachFile
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.MicOff
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import dev.conclave.app.data.Attachments
import dev.conclave.app.ui.chat.rememberVoiceInput
import dev.conclave.app.ui.common.ModelPickerSheet
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.motion.SendStopButton
import dev.conclave.app.ui.motion.rim
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.Attach
import dev.conclave.client.logic.ContextUse
import dev.conclave.client.logic.Effort
import dev.conclave.client.logic.EffortFollow
import dev.conclave.client.logic.Start
import dev.conclave.client.model.Attachment
import dev.conclave.client.model.ChatSettings
import dev.conclave.client.model.CommandDef
import dev.conclave.client.model.ModelEffort
import dev.conclave.client.model.ModelGroup
import dev.conclave.client.model.ThinkingLevel
import dev.conclave.client.motion.RimState
import java.io.File
import kotlinx.coroutines.launch

/**
 * What the composer edits and what it calls. One composer for a new chat,
 * a new Assistant or Code session, an open chat and an open session.
 */
class ComposerModel(
    val draft: String,
    val onDraft: (String) -> Unit,
    val attachments: List<Attachment>,
    val onAttach: (Attachment) -> Unit,
    val onRemove: (Attachment) -> Unit,
    val model: String?,
    val onModel: (String) -> Unit,
    val running: Boolean,
    val busy: Boolean,
    val placeholder: String,
    val onSend: () -> Unit,
    val onStop: () -> Unit,
    /** The Effort levels the model has (ModelInfo.effort); null: the picker has no Effort row. */
    val effort: ModelEffort? = null,
    /** The Effort picked; null runs at [follow]'s level, else the model's default. */
    val effortValue: ThinkingLevel? = null,
    /** What runs with nothing picked: the agent's level (a session). Null for a chat. */
    val follow: EffortFollow? = null,
    /** Null goes back to [follow]'s level. */
    val onEffort: (ThinkingLevel?) -> Unit = {},
    /** Cyber access for a ChatGPT plan model: Default (null) then the model's programs; empty hides the row. */
    val cyberChoices: List<String?> = emptyList(),
    val cyberValue: String? = null,
    val onCyber: (String?) -> Unit = {},
    /** A chat's switches, for the note under the box when memory is off. Null for an agent session. */
    val switches: ChatSettings? = null,
    /** The light on the composer's edge: live while a reply runs, amber while it waits on you (CHAT-AND-MOTION 1.3). */
    val rim: RimState = RimState.IDLE,
    /** The context ring's numbers; null leaves the ring out. */
    val context: ContextUse? = null,
    /** Usage, from the ring's sheet. */
    val onUsage: (() -> Unit)? = null,
    /** The quiet row's left side: the permission mode, Code's folder and device. */
    val left: (@Composable RowScope.() -> Unit)? = null,
    /** "+" after Photos, Camera and Files: web and memory, the agent, where it runs, the mode, Ultra. */
    val plus: (@Composable (dismiss: () -> Unit) -> Unit)? = null,
    /** The hub's commands, offered while the message is "/" and part of a name. */
    val commands: List<CommandDef> = emptyList(),
    /** A quiet line under the box ("Starting the session"). */
    val note: String? = null,
)

/**
 * The composer (docs/DESIGN.md 40, MOBILE-V2 4), shaped like Claude Code's:
 * one rounded box in the second surface, a hairline round it in light, the
 * text on top (up to six lines), then "+" at the left and the mic and Send
 * at the right; Send folds into Stop while a reply runs. Under the box one
 * quiet row: the permission mode (and Code's folder) at the left, the model
 * with its effort as one picker ("Opus 5.5 Medium") and the context ring at
 * the right. "+" holds the files and the rest (web and memory, the agent,
 * the device, the mode, Ultra); "/" lists the hub's commands. The Rim on
 * the box's edge says what the reply is doing.
 */
@Composable
fun ChatComposer(
    m: ComposerModel,
    groups: List<ModelGroup>,
    onError: (String) -> Unit,
    modifier: Modifier = Modifier,
    /** Lines the box shows before it grows. */
    minLines: Int = 1,
    /** False while a new chat opens: the box shows but takes no input. */
    enabled: Boolean = true,
) {
    val c = Conclave.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var plusOpen by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf(false) }
    var contextOpen by remember { mutableStateOf(false) }
    var voiceBase by remember { mutableStateOf("") }
    var cameraUri by remember { mutableStateOf<Uri?>(null) }

    // what is attached now, for files read after the pick (the list grows as each one lands)
    val attached = rememberUpdatedState(m.attachments)
    /** 15 at most (Attach.MAX): the first that fit are read, the rest refused with "Up to 15 files per message. Zip the rest." */
    fun add(uris: List<Uri>) {
        if (uris.isEmpty()) return
        val room = Attach.room(attached.value.size)
        if (uris.size > room) onError(Attach.TOO_MANY)
        scope.launch {
            var have = attached.value
            for (i in 0 until minOf(uris.size, room)) {
                try {
                    val a = Attachments.fromUri(context, uris[i])
                    val why = Attach.refusal(have, a)
                    if (why != null) {
                        onError(why)
                        continue
                    }
                    have = have + a
                    m.onAttach(a)
                } catch (e: Exception) {
                    onError(errorText(e))
                }
            }
        }
    }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(Attach.MAX)) { uris -> add(uris) }
    val files = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> add(uris) }
    val takePicture = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val uri = cameraUri
        if (ok && uri != null) add(listOf(uri))
        cameraUri = null
    }
    fun launchCamera() {
        val dir = File(context.cacheDir, "camera").apply { mkdirs() }
        val file = File(dir, "capture-${System.currentTimeMillis()}.jpg")
        val uri = FileProvider.getUriForFile(context, context.packageName + ".files", file)
        cameraUri = uri
        takePicture.launch(uri)
    }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) launchCamera() else onError("Camera permission denied")
    }
    val voice = rememberVoiceInput(
        onText = { partial -> m.onDraft(listOf(voiceBase, partial).filter { it.isNotBlank() }.joinToString(" ")) },
        onFinal = { final -> m.onDraft(listOf(voiceBase, final).filter { it.isNotBlank() }.joinToString(" ")) },
        onError = onError,
    )
    val listening by voice.listening
    fun startVoice() {
        if (!voice.available) {
            onError("No speech recognizer on this device")
            return
        }
        voiceBase = m.draft
        voice.start()
    }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startVoice() else onError("Microphone permission denied")
    }

    // "/" and part of a name: the hub's commands that match, over the box
    val slash = remember(m.draft, m.commands) { Start.slashMatches(m.draft, m.commands) }
    val shape = RoundedCornerShape(24.dp)
    Column(modifier.fillMaxWidth().navigationBarsPadding().padding(start = 12.dp, end = 12.dp, bottom = 4.dp)) {
        if (enabled && slash.isNotEmpty()) SlashMenu(slash, onPick = { cmd -> m.onDraft("/" + cmd.name + " ") })
        Column(
            Modifier
                .fillMaxWidth()
                // the Rim runs on the hairline's middle in light, on the box's edge in dark
                .rim(m.rim, radius = 24.dp, border = if (c.dark) 0.dp else 1.dp)
                .clip(shape)
                .background(c.surface2)
                // no border in dark, a hairline in light
                .then(if (c.dark) Modifier else Modifier.border(1.dp, c.rule, shape))
                .padding(start = 16.dp, end = 6.dp, top = 12.dp, bottom = 6.dp),
        ) {
            // one row that scrolls sideways at a fixed height: the field below stays on screen with 15 files
            AttachmentStrip(m.attachments, onRemove = m.onRemove, modifier = Modifier.padding(end = 10.dp, bottom = 6.dp))
            BasicTextField(
                value = m.draft,
                onValueChange = m.onDraft,
                textStyle = ConclaveType.chat.copy(color = c.fg),
                cursorBrush = SolidColor(c.signal),
                minLines = minLines,
                maxLines = maxOf(6, minLines),
                enabled = enabled,
                modifier = Modifier.fillMaxWidth().padding(end = 10.dp).heightIn(min = 26.dp).semantics { contentDescription = m.placeholder },
                decorationBox = { inner ->
                    Box {
                        if (m.draft.isEmpty()) Text(m.placeholder, style = ConclaveType.chat, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        inner()
                    }
                },
            )
            // the box's own row: "+" at the left, the mic and Send at the right (the Tune sheet and the model went under the box)
            Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                ComposerIcon(Icons.Outlined.Add, "Add files and more", enabled) { plusOpen = true }
                Spacer(Modifier.weight(1f))
                ComposerIcon(if (listening) Icons.Outlined.MicOff else Icons.Outlined.Mic, if (listening) "Stop voice input" else "Voice input", enabled, tint = if (listening) c.signal else c.fg2) {
                    if (listening) {
                        voice.stop()
                    } else if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        startVoice()
                    } else {
                        micPermission.launch(Manifest.permission.RECORD_AUDIO)
                    }
                }
                SendButton(m)
            }
        }
        // the quiet row: the permission mode (and Code's folder) at the left, the model with its effort and the ring at the right
        QuietRow(
            left = m.left,
            right = {
                QuietChip(
                    Effort.words(m.model, m.effortValue, m.effort, m.follow),
                    onClickLabel = "Choose the model and effort",
                    onClick = { picking = true },
                    enabled = enabled,
                    strong = true,
                    maxWidth = 200.dp,
                )
                val use = m.context
                if (use != null) ContextRing(use, onClick = { contextOpen = true }, enabled = enabled)
            },
            modifier = Modifier.padding(start = 4.dp),
        )
        if (m.switches?.memory == false) {
            Text(
                "Memory is off for this chat. It will not read or save notes.",
                style = ConclaveType.meta,
                color = c.fg3,
                modifier = Modifier.padding(bottom = 4.dp, start = 12.dp),
            )
        }
        val note = m.note
        if (note != null) Text(note, style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(bottom = 4.dp, start = 12.dp))
    }

    if (plusOpen) {
        OptionsSheet("Add", onDismiss = { plusOpen = false }) {
            AddRow(Icons.Outlined.Image, "Photos") {
                plusOpen = false
                photos.launch(PickVisualMediaRequest(mediaType = ActivityResultContracts.PickVisualMedia.ImageOnly))
            }
            AddRow(Icons.Outlined.PhotoCamera, "Camera") {
                plusOpen = false
                if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    launchCamera()
                } else {
                    cameraPermission.launch(Manifest.permission.CAMERA)
                }
            }
            AddRow(Icons.Outlined.AttachFile, "Files") {
                plusOpen = false
                // pictures, PDFs, text and zips: the hub unpacks a zip (core attachments/zip.ts)
                files.launch(Attach.PICKER_TYPES)
            }
            val more = m.plus
            if (more != null) {
                HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.padding(vertical = 6.dp))
                more { plusOpen = false }
            }
        }
    }
    if (picking) {
        // the Effort row on top: the levels this model has; a model without Effort shows none
        val e = m.effort?.takeIf { Effort.choices(it).isNotEmpty() }
        val header: (@Composable () -> Unit)? = if (e != null || m.cyberChoices.isNotEmpty()) {
            {
                if (e != null) EffortPicker(e, m.effortValue, m.follow, m.onEffort)
                CyberPicker(m.cyberChoices, m.cyberValue, m.onCyber)
            }
        } else {
            null
        }
        ModelPickerSheet(
            title = if (e != null) "Model and effort" else "Model",
            groups = groups,
            current = m.model,
            onPick = {
                picking = false
                m.onModel(it)
            },
            onDismiss = { picking = false },
            header = header,
        )
    }
    val use = m.context
    if (contextOpen && use != null) ContextSheet(use, onUsage = m.onUsage, onDismiss = { contextOpen = false })
}

/** A row of the "+" sheet: an icon and a word. */
@Composable
private fun AddRow(icon: ImageVector, label: String, onClick: () -> Unit) {
    val c = Conclave.colors
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 52.dp).padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(20.dp), tint = c.fg2)
        Spacer(Modifier.width(16.dp))
        Text(label, style = ConclaveType.rowTitle, color = c.fg)
    }
}

/** An icon button of the composer's row: 48dp to touch, the glyph 20dp. */
@Composable
private fun ComposerIcon(icon: ImageVector, label: String, enabled: Boolean, tint: Color = Conclave.colors.fg2, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.size(48.dp)) {
        Icon(icon, contentDescription = label, modifier = Modifier.size(20.dp), tint = tint)
    }
}

/**
 * Send, a 36dp circle: filled with the accent when there is text, an fg-4
 * outline when empty, the stop square while a reply runs and the box is
 * empty (Send to stop).
 */
@Composable
private fun SendButton(m: ComposerModel) {
    val c = Conclave.colors
    val hasInput = m.draft.isNotBlank() || m.attachments.isNotEmpty()
    val stop = m.running && !hasInput
    val enabled = stop || (hasInput && !m.busy)
    SendStopButton(
        running = stop,
        ready = hasInput && !m.busy,
        enabled = enabled,
        onClick = { if (stop) m.onStop() else m.onSend() },
        size = 48.dp,
        face = 36.dp,
        radius = 18.dp,
        glyph = 18.dp,
        fill = c.signal,
        fillInk = c.bg,
        outline = true,
    )
}
