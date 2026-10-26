@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.workflows

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AccountTree
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.EmptyState
import dev.conclave.app.ui.common.ErrorBanner
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.LoadingBox
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.deleteWorkflowPreset
import dev.conclave.client.logic.Launch
import dev.conclave.client.logic.LaunchArgs
import dev.conclave.client.logic.LaunchForm
import dev.conclave.client.model.StartWorkflowInput
import dev.conclave.client.model.WorkflowPreset
import dev.conclave.client.model.WorkflowRun
import dev.conclave.client.model.WorkflowSummary
import dev.conclave.client.saveWorkflowPreset
import dev.conclave.client.startWorkflow
import dev.conclave.client.workflowPresets
import dev.conclave.client.workflows
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

/**
 * The workflow library and its launch form: pick a workflow, fill its declared
 * args (meta.args) in a typed form, or edit JSON when it declares none, and
 * start the run. Args can be saved as named presets and picked again.
 */
class LibraryViewModel(hub: HubRepository) : HubViewModel(hub) {
    val list = MutableStateFlow<List<WorkflowSummary>?>(null)
    val error = MutableStateFlow<String?>(null)
    val presets = MutableStateFlow<List<WorkflowPreset>>(emptyList())
    val starting = MutableStateFlow(false)

    init {
        load()
    }

    fun load() {
        viewModelScope.launch {
            try {
                list.value = hub.api { it.workflows() }
                error.value = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error.value = errorText(e)
            }
        }
    }

    /** A workflow was picked; its presets come along. */
    fun open(workflow: WorkflowSummary) {
        viewModelScope.launch {
            try {
                presets.value = hub.api { it.workflowPresets(workflow.id) }
            } catch (_: Exception) {
                presets.value = emptyList()
            }
        }
    }

    fun savePreset(workflow: WorkflowSummary, name: String, args: JsonElement?) {
        action("Preset saved") {
            hub.api { it.saveWorkflowPreset(workflow.id, name, args ?: JsonNull) }
            presets.value = hub.api { it.workflowPresets(workflow.id) }
        }
    }

    fun removePreset(workflow: WorkflowSummary, preset: WorkflowPreset) {
        action {
            hub.api { it.deleteWorkflowPreset(workflow.id, preset.id) }
            presets.value = hub.api { it.workflowPresets(workflow.id) }
        }
    }

    fun start(workflow: WorkflowSummary, args: JsonElement?, onStarted: (WorkflowRun) -> Unit) {
        action {
            starting.value = true
            try {
                val run = hub.api { it.startWorkflow(StartWorkflowInput(name = workflow.id, args = args)) }
                onStarted(run)
            } finally {
                starting.value = false
            }
        }
    }
}

@Composable
fun WorkflowLibraryScreen(onBack: () -> Unit, onOpenRun: (String) -> Unit) {
    val hub = LocalAppContainer.current.hub
    val vm: LibraryViewModel = viewModel { LibraryViewModel(hub) }
    val list by vm.list.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val presets by vm.presets.collectAsStateWithLifecycle()
    val starting by vm.starting.collectAsStateWithLifecycle()
    var picked by remember { mutableStateOf<WorkflowSummary?>(null) }
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)

    Scaffold(topBar = { TopBar("Workflow library", onBack = onBack) }, snackbarHost = { ToastHost(snackbar) }) { padding ->
        val l = list
        when {
            l == null && error != null -> Column(Modifier.padding(padding).fillMaxSize()) { ErrorBanner(error.orEmpty(), onRetry = { vm.load() }) }
            l == null -> LoadingBox()
            else ->
                LazyColumn(Modifier.padding(padding).fillMaxSize()) {
                    if (l.isEmpty()) {
                        item { EmptyState(Icons.Outlined.AccountTree, "No workflows", "Scripts under ~/.conclave/workflows and the built-in library appear here.") }
                    }
                    items(l, key = { it.id }) { w ->
                        Column(
                            Modifier
                                .fillMaxWidth()
                                .clickable(enabled = w.runnable) {
                                    picked = w
                                    vm.open(w)
                                }
                                .padding(horizontal = 16.dp, vertical = 10.dp),
                        ) {
                            Text(w.name, style = ConclaveType.rowTitle, fontWeight = FontWeight.Medium)
                            Text(w.description, style = ConclaveType.body, maxLines = 2)
                        }
                        HorizontalDivider()
                    }
                }
        }
    }

    picked?.let { w ->
        LaunchDialog(
            workflow = w,
            presets = presets,
            starting = starting,
            onDismiss = { picked = null },
            onSavePreset = { name, args -> vm.savePreset(w, name, args) },
            onRemovePreset = { p -> vm.removePreset(w, p) },
            onStart = { args ->
                vm.start(w, args) { run ->
                    picked = null
                    onOpenRun(run.id)
                }
            },
        )
    }
}

/** The launch form: typed fields from meta.args, or a JSON box when the script declares none, plus presets. */
@Composable
private fun LaunchDialog(
    workflow: WorkflowSummary,
    presets: List<WorkflowPreset>,
    starting: Boolean,
    onDismiss: () -> Unit,
    onSavePreset: (String, JsonElement?) -> Unit,
    onRemovePreset: (WorkflowPreset) -> Unit,
    onStart: (JsonElement?) -> Unit,
) {
    val schema = workflow.argsSchema
    val texts = remember { mutableStateMapOf<String, String>() }
    val bools = remember { mutableStateMapOf<String, Boolean>() }
    var rawArgs by remember { mutableStateOf("") }
    var presetName by remember { mutableStateOf("") }
    var argsError by remember { mutableStateOf<String?>(null) }

    /** A preset replaces the whole form: typed fields, switches and the JSON box (keys the schema does not name). */
    fun applyPreset(p: WorkflowPreset) {
        argsError = null
        val f = Launch.formOf(schema, p.args)
        texts.clear()
        texts.putAll(f.texts)
        bools.clear()
        bools.putAll(f.bools)
        rawArgs = f.raw
    }

    /** The args to start or save with; a bad field or box shows in argsError and the caller stops. */
    fun currentArgs(): LaunchArgs {
        val r = Launch.argsOf(schema, LaunchForm(texts.toMap(), bools.toMap(), rawArgs))
        argsError = r.error
        return r
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Run ${workflow.name}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(workflow.description, style = ConclaveType.body)
                if (presets.isNotEmpty()) {
                    Text("Presets", style = ConclaveType.section)
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        for (p in presets) {
                            TextButton(onClick = { applyPreset(p) }) { Text(p.name) }
                            TextButton(onClick = { onRemovePreset(p) }) { Text("×") }
                        }
                    }
                }
                if (schema == null) {
                    OutlinedTextField(value = rawArgs, onValueChange = { rawArgs = it }, label = { Text("Args (JSON)") }, isError = argsError != null, modifier = Modifier.fillMaxWidth())
                } else {
                    for ((name, field) in schema) {
                        if (field.type == "boolean") {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Switch(checked = bools[name] == true, onCheckedChange = { b -> bools[name] = b })
                                Text(field.description ?: name, style = ConclaveType.section)
                            }
                        } else {
                            OutlinedTextField(
                                value = texts[name].orEmpty(),
                                onValueChange = { v -> texts[name] = v },
                                label = { Text(field.description ?: name) },
                                isError = argsError != null,
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                    OutlinedTextField(value = rawArgs, onValueChange = { rawArgs = it }, label = { Text("More args (JSON)") }, isError = argsError != null, modifier = Modifier.fillMaxWidth())
                }
                argsError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = ConclaveType.body) }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(value = presetName, onValueChange = { presetName = it }, label = { Text("Save as preset") }, modifier = Modifier.weight(1f))
                    TextButton(
                        enabled = presetName.isNotBlank(),
                        onClick = {
                            val r = currentArgs()
                            if (r.error == null) {
                                onSavePreset(presetName.trim(), r.args)
                                presetName = ""
                            }
                        },
                    ) { Text("Save") }
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !starting,
                onClick = {
                    val r = currentArgs()
                    if (r.error == null) onStart(r.args)
                },
            ) { Text(if (starting) "Starting…" else "Start") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
