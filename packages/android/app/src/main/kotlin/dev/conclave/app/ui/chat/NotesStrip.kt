@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.Notes
import dev.conclave.client.model.Task
import dev.conclave.client.model.TaskInput
import dev.conclave.client.model.TaskStatus

/** Check off and add notes (client logic/Notes.kt); the hub's task events keep every screen's list in step. */
class NotesViewModel(hub: HubRepository) : HubViewModel(hub) {
    private fun upsert(t: Task) {
        hub.tasks.value = hub.tasks.value.filterNot { it.id == t.id } + t
    }

    fun check(t: Task, done: Boolean) = action { upsert(hub.api { it.updateTask(t.id, TaskInput(status = if (done) TaskStatus.DONE else TaskStatus.TODO)) }) }

    fun add(title: String) = action { upsert(hub.api { it.createTask(TaskInput(title = title, status = TaskStatus.TODO, labels = listOf(Notes.LABEL))) }) }
}

/**
 * The notes line under the top bar, as on the web: "3 to do: Call the bank",
 * a tap opens the checklist. Nothing until the first note; [adding] opens the
 * add sheet (Add a note in the conversation sheet sets it).
 */
@Composable
fun NotesStrip(vm: NotesViewModel, adding: Boolean, onAdding: (Boolean) -> Unit) {
    val c = Conclave.colors
    val tasks by LocalAppContainer.current.hub.tasks.collectAsStateWithLifecycle()
    val notes = remember(tasks) { Notes.shown(tasks, System.currentTimeMillis()) }
    var open by rememberSaveable { mutableStateOf(false) }
    if (adding) NoteAddSheet(onDismiss = { onAdding(false) }, onAdd = { vm.add(it); onAdding(false); open = true })
    if (notes.isEmpty()) return
    Column(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 40.dp).clickable(onClickLabel = if (open) "Hide notes" else "Show notes") { open = !open }.padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(Notes.line(notes), style = ConclaveType.meta, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Icon(if (open) Icons.Outlined.KeyboardArrowDown else Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, modifier = Modifier.size(14.dp), tint = c.fg4)
        }
        if (open) {
            notes.forEach { t ->
                HorizontalDivider(thickness = 1.dp, color = c.rule)
                val done = t.status == TaskStatus.DONE
                Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable { vm.check(t, !done) }.padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = done, onCheckedChange = { vm.check(t, it) })
                    Text(t.title, style = ConclaveType.body, color = if (done) c.fg3 else c.fg, textDecoration = if (done) TextDecoration.LineThrough else null, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            HorizontalDivider(thickness = 1.dp, color = c.rule)
            Text("Add a note", style = ConclaveType.body, color = c.fg2, modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable { onAdding(true) }.padding(horizontal = 16.dp, vertical = 12.dp))
        }
        HorizontalDivider(thickness = 1.dp, color = c.rule)
    }
}

@Composable
private fun NoteAddSheet(onDismiss: () -> Unit, onAdd: (String) -> Unit) {
    val c = Conclave.colors
    var text by remember { mutableStateOf("") }
    val save = { text.trim().takeIf { it.isNotEmpty() }?.let(onAdd) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = c.bgRaise) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().imePadding().padding(horizontal = 20.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Add a note", style = ConclaveType.title, color = c.fg)
            Text("Shown at the top of every chat.", style = ConclaveType.meta, color = c.fg3)
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                singleLine = true,
                placeholder = { Text("Call the bank") },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { save() }),
                modifier = Modifier.fillMaxWidth(),
            )
            Button(onClick = { save() }, enabled = text.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text("Add") }
        }
    }
}
