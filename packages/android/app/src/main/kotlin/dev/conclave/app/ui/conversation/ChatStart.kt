package dev.conclave.app.ui.conversation

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.OfflineBanner
import dev.conclave.app.ui.common.TopBar
import dev.conclave.client.model.ChatSettings
import dev.conclave.client.model.ImageBlock
import dev.conclave.client.motion.RimState

/**
 * A chat sent from Home before the hub has made it (ChatStarts): the same
 * header, your message and the thinking mark in the places the chat will
 * show them, so the switch to the real chat does not move anything. Binds
 * to the chat the moment it exists; on a failure it goes back to Home, where
 * the words are back in the box.
 */
@Composable
fun ChatStartScreen(startKey: String, onBound: (String) -> Unit, onBack: () -> Unit) {
    val hub = LocalAppContainer.current.hub
    val starts by ChatStarts.all.collectAsStateWithLifecycle()
    val connection by hub.connection.collectAsStateWithLifecycle()
    val groups by hub.models.collectAsStateWithLifecycle()
    // the last state seen: after it is handled the entry goes, but this screen draws until the chat is in front
    val seen = remember { arrayOfNulls<ChatStarts.Start>(1) }
    val now = starts[startKey]
    if (now != null) seen[0] = now
    var handled by remember { mutableStateOf(false) }

    LaunchedEffect(now?.chatId, now?.error, now == null) {
        if (handled) return@LaunchedEffect
        when {
            // nothing to show (the app was restarted on this screen): back to Home
            now == null -> {
                handled = true
                onBack()
            }
            now.chatId != null -> {
                handled = true
                // the chat takes the bubble where it is: no second rise
                ChatHandoff.put(now.chatId, now.pending.copy(inPlace = true))
                onBound(now.chatId)
                ChatStarts.done(startKey)
            }
            now.error != null -> {
                handled = true
                onBack()
                ChatStarts.done(startKey)
            }
        }
    }
    val start = seen[0] ?: return
    val p = start.pending

    Column(Modifier.fillMaxSize().imePadding()) {
        TopBar(title = "New chat")
        OfflineBanner(connection)
        Box(Modifier.fillMaxWidth().weight(1f)) {
            LazyColumn(
                reverseLayout = true,
                modifier = Modifier.fillMaxHeight().widthIn(max = 752.dp).fillMaxWidth().align(Alignment.TopCenter),
            ) {
                item(key = "bottom") { Spacer(Modifier.height(12.dp)) }
                item(key = "r:${p.at}") {
                    Box(Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) { PendingReplyLine(p.at) }
                }
                item(key = p.key) {
                    Rise(p.key, Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 6.dp)) {
                        UserBubble(
                            message = null,
                            text = p.text,
                            images = p.attachments.filter { it.mediaType.startsWith("image/") && it.data != null }.map { ImageBlock(mediaType = it.mediaType, data = it.data) },
                            files = p.attachments.filterNot { it.mediaType.startsWith("image/") }.map { it.name ?: "File" },
                            onTap = {},
                        )
                    }
                }
            }
        }
        ChatComposer(
            ComposerModel(
                draft = "",
                onDraft = {},
                attachments = emptyList(),
                onAttach = {},
                onRemove = {},
                model = start.model,
                onModel = {},
                switches = ChatSettings(),
                running = false,
                busy = true,
                placeholder = "Reply",
                onSend = {},
                onStop = {},
                rim = RimState.LIVE,
            ),
            groups = groups,
            onError = {},
            enabled = false,
            modifier = Modifier.align(Alignment.CenterHorizontally).widthIn(max = 752.dp),
        )
    }
}
