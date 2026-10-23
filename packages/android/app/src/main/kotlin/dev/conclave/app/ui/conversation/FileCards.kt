package dev.conclave.app.ui.conversation

import android.content.ActivityNotFoundException
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.FileCardData
import dev.conclave.client.logic.FileCards
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.sessionFile
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/*
 * Files a ShareFile call handed the owner, under a turn's work like the
 * maps cards (MapsCards.kt; the web's FileCard.tsx). Name, type and size,
 * then Open and Save. The bytes come from the hub by the call's id
 * (GET /api/sessions/:id/files/:toolUseId, with the token), never by a path.
 * Open writes them to the cache's shared/ folder (res/xml/file_paths.xml)
 * and hands the FileProvider link to the app for the type; Save asks where
 * with the system's create-document picker.
 */
@Composable
fun FileCardsView(uses: List<ToolUseBlock>, results: Map<String, ToolResultBlock>) {
    val sessionId = LocalSessionWork.current.session?.id ?: return
    val cards = FileCards.cards(uses, results)
    if (cards.isEmpty()) return
    Column(Modifier.fillMaxWidth().padding(top = 2.dp, bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        cards.forEach { FileCard(sessionId, it) }
    }
}

private val CardShape = RoundedCornerShape(5.dp)

@Composable
private fun FileCard(sessionId: String, card: FileCardData) {
    val c = Conclave.colors
    val context = LocalContext.current
    val hub = LocalAppContainer.current.hub
    val scope = rememberCoroutineScope()
    var error by remember(card.toolUseId) { mutableStateOf<String?>(null) }
    var busy by remember(card.toolUseId) { mutableStateOf(false) }
    fun fetch(then: suspend (ByteArray) -> Unit) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try {
                val (bytes, _) = hub.api { it.sessionFile(sessionId, card.toolUseId) }
                then(bytes)
            } catch (e: CancellationException) {
                throw e
            } catch (_: ActivityNotFoundException) {
                error = "No app on this phone opens this file. Save it instead."
            } catch (e: Exception) {
                error = "Could not get the file. ${errorText(e)}"
            } finally {
                busy = false
            }
        }
    }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(card.mediaType)) { uri ->
        if (uri != null) {
            fetch { bytes ->
                withContext(Dispatchers.IO) {
                    context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw java.io.IOException("Could not write the file.")
                }
            }
        }
    }
    Column(Modifier.widthIn(max = 560.dp).fillMaxWidth().border(1.dp, c.rule2, CardShape).padding(horizontal = 16.dp, vertical = 12.dp)) {
        Text(card.title ?: card.name, style = ConclaveType.rowTitle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(
            (if (card.title != null) "${card.name}, " else "") + FileCards.facts(card),
            style = ConclaveType.body.copy(fontSize = 14.sp),
            color = c.fg3,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                enabled = !busy,
                onClick = {
                    fetch { bytes ->
                        val file = withContext(Dispatchers.IO) {
                            val dir = File(File(context.cacheDir, "shared"), FileCards.cacheFolder(card)).apply { mkdirs() }
                            File(dir, FileCards.cacheName(card)).apply { writeBytes(bytes) }
                        }
                        val uri = FileProvider.getUriForFile(context, context.packageName + ".files", file)
                        context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, card.mediaType).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                    }
                },
                modifier = Modifier.heightIn(min = 40.dp),
            ) { Text("Open", maxLines = 1) }
            TextButton(enabled = !busy, onClick = { save.launch(card.name) }, modifier = Modifier.heightIn(min = 40.dp)) { Text("Save", maxLines = 1) }
        }
        error?.let { Text(it, style = ConclaveType.meta, color = c.fault, modifier = Modifier.padding(top = 6.dp)) }
    }
}
