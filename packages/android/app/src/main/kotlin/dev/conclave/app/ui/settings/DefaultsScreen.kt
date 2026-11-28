package dev.conclave.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.ModelPickerSheet
import dev.conclave.app.ui.common.Segmented
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.HubDefaults
import dev.conclave.client.logic.LimitField
import dev.conclave.client.model.MePatch
import dev.conclave.client.model.MemberMemory
import dev.conclave.client.updateMe
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Settings, Defaults (web settings/defaults.tsx; a member's is
 * member-defaults.tsx). The owner's rows are the hub's config (PATCH
 * /api/config, which range-checks numbers and model refs). A member sees only
 * their own defaults, saved on their account (PATCH /api/me), never the
 * hub's. [memoryOnly]: the Memory page's Settings, the memory rows alone.
 */
@Composable
fun DefaultsScreen(onBack: () -> Unit, memoryOnly: Boolean = false) {
    val hub = LocalAppContainer.current.hub
    val me by hub.me.collectAsStateWithLifecycle()
    val models by hub.models.collectAsStateWithLifecycle()
    val agents by hub.agents.collectAsStateWithLifecycle()
    val devices by hub.devices.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val snackbar = rememberToasts()
    val c = Conclave.colors
    val isOwner = me?.isOwner != false
    var cfg by remember { mutableStateOf<JsonObject?>(null) }
    // which model is being picked: a config path for the owner, a MePatch field for a member
    var picking by remember { mutableStateOf<String?>(null) }
    var choosing by remember { mutableStateOf<String?>(null) }
    var limit by remember { mutableStateOf<Pair<String, LimitField>?>(null) }

    fun say(t: String) {
        scope.launch { snackbar.showSnackbar(t) }
    }

    /** The owner's: one config value (null clears it), then the config again, as the hub kept it. */
    fun setHub(value: JsonElement, vararg keys: String) {
        scope.launch {
            try {
                hub.api { it.updateConfig(patchAt(value, *keys)) }
                cfg = hub.api { it.config() }.config
            } catch (e: Exception) {
                say(errorText(e))
            }
        }
    }

    /** A member's own: an empty string clears a default. */
    fun setMe(patch: MePatch) {
        scope.launch {
            try {
                hub.api { it.updateMe(patch) }
                hub.refreshCatalog()
            } catch (e: Exception) {
                say("Could not save. ${errorText(e)}")
            }
        }
    }

    // the owner reads the hub's config; a member reads it only for the hub's memory defaults their own fall back to
    LaunchedEffect(Unit) { cfg = runCatching { hub.api { it.config() }.config }.getOrNull() }
    val p = me?.preferences
    val names = remember(models) { models.flatMap { it.models }.associate { it.ref to it.name.ifBlank { it.id } } }
    fun model(ref: String?, empty: String = "Not set") = ref?.let { names[it] ?: it } ?: empty
    val deviceList = devices.filter { it.id != "local" }.map { it.id to it.name.ifBlank { it.id } }

    Scaffold(topBar = { TopBar(if (memoryOnly) "Memory settings" else "Defaults", onBack = onBack) }, snackbarHost = { ToastHost(snackbar) }, containerColor = c.bg) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 32.dp)) {
            val k = cfg
            if (isOwner && k == null) {
                Note("Loading.")
                return@Column
            }
            if (!memoryOnly) {
                if (isOwner) {
                    Group("New sessions", first = true)
                    NavRow("Default model", model(HubDefaults.text(k, "defaultModel")), onClick = { picking = "defaultModel" })
                    NavRow("Default agent", HubDefaults.text(k, "defaultAgent") ?: "assistant", onClick = { choosing = "agent" })
                    NavRow("Default device", HubDefaults.deviceName(HubDefaults.text(k, "defaultDevice"), deviceList), onClick = { choosing = "device" })
                    NavRow("Small model", model(HubDefaults.text(k, "smallModel")), onClick = { picking = "smallModel" })
                    NavRow("Image model", model(HubDefaults.text(k, "imageModel") ?: HubDefaults.DEFAULT_IMAGE_MODEL), onClick = { picking = "imageModel" })
                    NavRow("Model that reads images", model(HubDefaults.text(k, "models", "vision"), "Small or default model"), onClick = { picking = "models.vision" })
                    NavRow("Second opinions", model(HubDefaults.text(k, "modes", "reviewer")), onClick = { picking = "modes.reviewer" })

                    Group("Model tiers")
                    Note("Workflow steps, subagents and agents ask for a tier instead of a model. Empty: the hub picks as shown.")
                    HubDefaults.TIERS.forEach { t ->
                        NavRow(t.label, model(HubDefaults.text(k, "models", "tiers", t.id), t.empty), onClick = { picking = "models.tiers.${t.id}" })
                    }

                    Group("Per conversation")
                    ToggleRow("Same model for all work", "New chats and sessions start with Delegate, Task and workflow agents on the conversation's model.", k!!.flag(false, "models", "sameModel")) { setHub(JsonPrimitive(it), "models", "sameModel") }

                    Group("When a plan runs out")
                    ToggleRow("Resume after the reset", "A session that hit a limit continues on its own when the window resets.", k.flag(true, "limits", "autoResume")) { setHub(JsonPrimitive(it), "limits", "autoResume") }
                    ToggleRow("Wait if the reset is under 5 minutes", "A long chat waits for a reset that close instead of switching models.", k.flag(true, "limits", "waitShortResets")) { setHub(JsonPrimitive(it), "limits", "waitShortResets") }

                    Group("Spend and time limits")
                    Note("Each chat, routine run or subagent stops when it, and everything it starts, reaches one of these. Empty: no limit.")
                    HubDefaults.LIMIT_KINDS.forEach { (kind, label) ->
                        val words = HubDefaults.LIMIT_FIELDS.joinToString(", ") { f -> HubDefaults.limitText(k.path("limits", kind, f.id)).ifEmpty { "no limit" }.let { v -> "${f.label} $v" } }
                        NavRow(label, words, onClick = { limit = kind to HubDefaults.LIMIT_FIELDS[0] })
                    }
                } else {
                    Group("New sessions", first = true)
                    Note("Left empty, the hub's default. Only models you can use are offered.")
                    NavRow("Default model", model(p?.defaultModel, "The hub's default"), onClick = { picking = "defaultModel" })
                    NavRow("Default agent", p?.defaultAgent ?: "The hub's default", onClick = { choosing = "agent" })
                    NavRow("Default computer", HubDefaults.deviceName(p?.defaultDevice, deviceList), onClick = { choosing = "device" })
                    NavRow("Small model", model(p?.smallModel, "The hub's default"), onClick = { picking = "smallModel" })
                    NavRow("Second opinion model", model(p?.reviewer), onClick = { picking = "reviewer" })
                }
            }

            // memory: the hub's switches for the owner, a member's own (falling back to the hub's)
            Group("Memory", first = memoryOnly)
            val hubMem = k?.get("memory") as? JsonObject
            val own = p?.memory
            fun flag(key: String, d: Boolean) = if (isOwner) k!!.flag(d, "memory", key) else HubDefaults.memberFlag(own, hubMem, key, d)
            fun setFlag(key: String, on: Boolean) = if (isOwner) setHub(JsonPrimitive(on), "memory", key) else setMe(MePatch(memory = memberMemory(key, on)))
            val memOn = flag("enabled", true)
            ToggleRow("Use memory", "Off: sessions neither read nor save notes.", memOn) { setFlag("enabled", it) }
            if (memOn) {
                ToggleRow("Give relevant notes", "Notes that match your message ride along with it.", flag("autoInject", true)) { setFlag("autoInject", it) }
                Text("Notes per turn. More notes cost more tokens on every turn.", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
                val notes = if (isOwner) ((hubMem?.get("injectLimit") as? JsonPrimitive)?.content?.toIntOrNull() ?: 6) else HubDefaults.memberNotes(own, hubMem)
                Segmented(
                    value = notes,
                    options = HubDefaults.NOTES_PER_TURN.map { it to it.toString() },
                    onChange = { n -> if (isOwner) setHub(JsonPrimitive(n), "memory", "injectLimit") else setMe(MePatch(memory = MemberMemory(injectLimit = n))) },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                )
                ToggleRow("Past session summaries", "Recall may bring back what earlier sessions did.", flag("recallEpisodes", false)) { setFlag("recallEpisodes", it) }
                ToggleRow("Save what sessions learn", "After a turn, new facts about you are saved as notes.", flag("autoExtract", true)) { setFlag("autoExtract", it) }
            }
            if (!memoryOnly && isOwner) Note("Hidden models, plan fallback lists and the prompt cache are in the web app: Settings, Defaults.")
        }
    }

    picking?.let { key ->
        val current = if (isOwner) HubDefaults.text(cfg, *key.split('.').toTypedArray()) else when (key) {
            "defaultModel" -> p?.defaultModel
            "smallModel" -> p?.smallModel
            else -> p?.reviewer
        }
        // shortcut: image models are told apart by "image" in the id (the phone's catalog has no kind), until ModelInfo carries one
        val groups = if (key == "imageModel") models.map { g -> g.copy(models = g.models.filter { "image" in it.id }) } else models
        val clearable = key.startsWith("models.") || !isOwner
        ModelPickerSheet(
            title = when (key) {
                "imageModel" -> "Image model"
                "models.vision" -> "Model that reads images"
                "modes.reviewer", "reviewer" -> "Second opinion model"
                "smallModel" -> "Small model"
                "defaultModel" -> "Default model"
                else -> HubDefaults.TIERS.firstOrNull { "models.tiers.${it.id}" == key }?.let { "${it.label} model" } ?: "Model"
            },
            groups = groups,
            current = current,
            extra = buildList {
                if (key == "imageModel") add(HubDefaults.DEFAULT_IMAGE_MODEL to "Default image model")
                if (clearable && current != null) add("" to "Clear (use the default)")
            },
            onPick = { ref ->
                picking = null
                val keys = key.split('.').toTypedArray()
                if (isOwner) {
                    setHub(if (ref.isEmpty()) JsonNull else JsonPrimitive(ref), *keys)
                } else {
                    setMe(
                        when (key) {
                            "defaultModel" -> MePatch(defaultModel = ref)
                            "smallModel" -> MePatch(smallModel = ref)
                            else -> MePatch(reviewer = ref)
                        },
                    )
                }
            },
            onDismiss = { picking = null },
        )
    }

    choosing?.let { what ->
        val options: List<Pair<String, String>> = if (what == "agent") agents.map { it.name to it.name } else listOf((if (isOwner) "local" else "") to "The hub") + deviceList
        val current = if (isOwner) HubDefaults.text(cfg, if (what == "agent") "defaultAgent" else "defaultDevice") else if (what == "agent") p?.defaultAgent else p?.defaultDevice
        AlertDialog(
            onDismissRequest = { choosing = null },
            title = { Text(if (what == "agent") "Default agent" else if (isOwner) "Default device" else "Default computer") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    options.forEach { (id, label) ->
                        CheckRow(label, selected = id == (current ?: if (what == "agent") "" else options.first().first), inset = 0.dp) {
                            choosing = null
                            when {
                                isOwner -> setHub(JsonPrimitive(id), if (what == "agent") "defaultAgent" else "defaultDevice")
                                what == "agent" -> setMe(MePatch(defaultAgent = id))
                                else -> setMe(MePatch(defaultDevice = id))
                            }
                        }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { choosing = null }) { Text("Close") } },
        )
    }

    limit?.let { (kind, _) ->
        val label = HubDefaults.LIMIT_KINDS.first { it.first == kind }.second
        val texts = remember(kind) { HubDefaults.LIMIT_FIELDS.map { f -> mutableStateOf(HubDefaults.limitText(cfg?.path("limits", kind, f.id))) } }
        val values = HubDefaults.LIMIT_FIELDS.mapIndexed { i, f -> HubDefaults.limitValue(texts[i].value, f) }
        AlertDialog(
            onDismissRequest = { limit = null },
            title = { Text(label) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Empty: no limit.", style = ConclaveType.meta, color = c.fg3)
                    HubDefaults.LIMIT_FIELDS.forEachIndexed { i, f ->
                        OutlinedTextField(
                            value = texts[i].value,
                            onValueChange = { texts[i].value = it },
                            label = { Text(HubDefaults.limitLabel(f)) },
                            placeholder = { Text("No limit") },
                            isError = values[i] == null,
                            singleLine = true,
                            textStyle = CodeStyle,
                            keyboardOptions = KeyboardOptions(keyboardType = if (f.fraction) KeyboardType.Decimal else KeyboardType.Number),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(enabled = values.all { it != null }, onClick = {
                    limit = null
                    // only the cells changed: an untouched empty cell keeps the hub's own default (a routine's 1M tokens, 120 min)
                    val changed = HubDefaults.LIMIT_FIELDS.mapIndexedNotNull { i, f ->
                        if (texts[i].value.trim() == HubDefaults.limitText(cfg?.path("limits", kind, f.id))) null else f.id to HubDefaults.limitJson(values[i]!!, f)
                    }
                    if (changed.isNotEmpty()) setHub(JsonObject(changed.toMap()), "limits", kind)
                }) { Text("Save") }
            },
            dismissButton = { Row { TextButton(onClick = { limit = null }) { Text("Cancel") } } },
        )
    }
}

private fun memberMemory(key: String, on: Boolean): MemberMemory = when (key) {
    "enabled" -> MemberMemory(enabled = on)
    "autoInject" -> MemberMemory(autoInject = on)
    "recallEpisodes" -> MemberMemory(recallEpisodes = on)
    else -> MemberMemory(autoExtract = on)
}
