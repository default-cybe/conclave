package dev.conclave.app.ui.common

import android.text.format.DateFormat
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonColors
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.mikepenz.markdown.compose.components.markdownComponents
import com.mikepenz.markdown.compose.elements.highlightedCodeBlock
import com.mikepenz.markdown.compose.elements.highlightedCodeFence
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.rememberMarkdownState
import dev.conclave.app.data.AuthState
import dev.conclave.app.ui.motion.KnotRope
import dev.conclave.app.ui.motion.ToastState
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.app.ui.theme.LocalExtraColors
import dev.conclave.client.ConnectionState
import dev.conclave.client.motion.RopeMoment
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow

/** Current time, ticking every [intervalMs]. For countdowns. */
@Composable
fun rememberNow(intervalMs: Long = 1_000): State<Long> = produceState(System.currentTimeMillis(), intervalMs) {
    while (true) {
        value = System.currentTimeMillis()
        delay(intervalMs)
    }
}

/** Shows one-shot ViewModel messages in the toast stack; several at once stack. */
@Composable
fun MessagesEffect(messages: Flow<String>, snackbar: ToastState) {
    LaunchedEffect(messages, snackbar) {
        messages.collect { snackbar.post(it) }
    }
}

/**
 * A filled button whose label stays legible while it cannot be pressed:
 * fg-3, as placeholders are, not Material's ink at 38%.
 */
@Composable
fun solidButtonColors(): ButtonColors = ButtonDefaults.buttonColors(disabledContentColor = Conclave.colors.fg3)

/** An outlined button in ink on an edge line, so it reads as a choice in dark too, not as disabled. */
@Composable
fun outlineButtonColors(): ButtonColors = ButtonDefaults.outlinedButtonColors(contentColor = Conclave.colors.fg, disabledContentColor = Conclave.colors.fg3)

@Composable
fun outlineButtonBorder(): BorderStroke = BorderStroke(1.dp, Conclave.colors.edge)

@Composable
fun Pill(text: String, color: Color, modifier: Modifier = Modifier, leading: (@Composable () -> Unit)? = null) {
    Surface(modifier = modifier, shape = RoundedCornerShape(50), color = color.copy(alpha = 0.15f), contentColor = color) {
        Row(Modifier.padding(horizontal = 8.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            if (leading != null) {
                leading()
                Spacer(Modifier.width(4.dp))
            }
            Text(text, style = MaterialTheme.typography.labelSmall, maxLines = 1)
        }
    }
}

/** Clock time for a timestamp, "15:42" (or "3:42 PM" when the phone uses 12 hour time). */
@Composable
fun clockTime(ts: Long): String {
    val context = LocalContext.current
    val pattern = if (DateFormat.is24HourFormat(context)) "HH:mm" else "h:mm a"
    return Instant.ofEpochMilli(ts).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern(pattern))
}

/** [clockTime] as a plain function, for the words built outside composition ("Resumes 15:42"). */
@Composable
fun rememberClock(): (Long) -> String {
    val h24 = DateFormat.is24HourFormat(LocalContext.current)
    return remember(h24) {
        val f = DateTimeFormatter.ofPattern(if (h24) "HH:mm" else "h:mm a")
        val format: (Long) -> String = { ts -> Instant.ofEpochMilli(ts).atZone(ZoneId.systemDefault()).format(f) }
        format
    }
}

/** Hub state in words (spec 10.1): "madx online", "reconnecting" or "offline". */
@Composable
fun HubState(state: ConnectionState, name: String?, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    val (word, color) = when (state) {
        ConnectionState.OPEN -> "online" to c.ok
        ConnectionState.CONNECTING -> "reconnecting" to c.fg3
        ConnectionState.CLOSED -> "offline" to c.fault
    }
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Text(name?.ifBlank { null } ?: "Hub", style = ConclaveType.meta.copy(fontWeight = FontWeight.Medium), color = c.fg, maxLines = 1)
        Spacer(Modifier.width(5.dp))
        Text(word, style = ConclaveType.meta, color = color, maxLines = 1)
    }
}

/** Section heading (spec 10.3): sentence case, 600, a hairline rule under it. */
@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier, trailing: (@Composable () -> Unit)? = null) {
    val c = Conclave.colors
    Column(modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 20.dp)) {
        Row(Modifier.fillMaxWidth().padding(bottom = 9.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(text, style = ConclaveType.section, color = c.fg, modifier = Modifier.weight(1f))
            trailing?.invoke()
        }
        HorizontalDivider(thickness = 1.dp, color = c.rule2)
    }
}

@Composable
fun EmptyState(
    icon: ImageVector,
    title: String,
    body: String? = null,
    modifier: Modifier = Modifier,
    action: (@Composable () -> Unit)? = null,
) {
    Column(
        modifier.fillMaxWidth().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(icon, contentDescription = null, tint = Conclave.colors.fg3, modifier = Modifier.size(40.dp))
        Spacer(Modifier.height(12.dp))
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        if (body != null) {
            Spacer(Modifier.height(6.dp))
            Text(
                body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
        if (action != null) {
            Spacer(Modifier.height(16.dp))
            action()
        }
    }
}

@Composable
fun ErrorBanner(text: String, modifier: Modifier = Modifier, onRetry: (() -> Unit)? = null) {
    Surface(
        modifier = modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        shape = RoundedCornerShape(12.dp),
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.ErrorOutline, contentDescription = null)
            Spacer(Modifier.width(10.dp))
            Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            if (onRetry != null) TextButton(onClick = onRetry) { Text("Retry") }
        }
    }
}

/**
 * The hub's own name ("homelab"): the one it gives, or the one saved at
 * pairing until it answers. Null when neither is known.
 */
@Composable
fun hubName(): String? {
    val hub = LocalAppContainer.current.hub
    val info by hub.hubInfo.collectAsStateWithLifecycle()
    val auth by hub.auth.collectAsStateWithLifecycle()
    return info?.name?.ifBlank { null } ?: (auth as? AuthState.Paired)?.hubName?.ifBlank { null }
}

/**
 * The line under a header while the hub cannot be reached ("Can't reach
 * homelab. Retrying…"). It says why when the app knows (no network, a
 * refused token, a network the hub does not take, no address answering)
 * and what to do next. While it connects the knot runs; back online after
 * being offline, it plays success, says so, and goes
 * (docs/design/KNOT-MOTION.md).
 */
@Composable
fun OfflineBanner(state: ConnectionState, modifier: Modifier = Modifier) {
    val problem by LocalAppContainer.current.hub.problem.collectAsStateWithLifecycle()
    val name = hubName() ?: "your hub"
    val ground = MaterialTheme.colorScheme.surfaceContainerHigh
    var wasOffline by remember { mutableStateOf(false) }
    var back by remember { mutableStateOf(false) }
    var backPlayed by remember { mutableStateOf(false) }
    LaunchedEffect(state) {
        if (state == ConnectionState.CLOSED) wasOffline = true
        if (state != ConnectionState.OPEN) {
            back = false
        } else if (wasOffline) {
            wasOffline = false
            backPlayed = false
            back = true
        }
    }
    LaunchedEffect(backPlayed) {
        if (!backPlayed) return@LaunchedEffect
        delay(1200)
        back = false
    }
    if (state == ConnectionState.OPEN) {
        if (!back) return
        Row(
            modifier.fillMaxWidth().background(ground).padding(horizontal = 16.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            KnotRope(RopeMoment.SUCCESS, size = 16.dp, surface = ground, onDone = { backPlayed = true })
            Spacer(Modifier.width(8.dp))
            Text("Back online.", style = MaterialTheme.typography.labelMedium, color = Conclave.colors.ok)
        }
        return
    }
    val p = problem
    Row(
        modifier.fillMaxWidth().background(ground).padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (state == ConnectionState.CONNECTING && p == null) {
            KnotRope(RopeMoment.RUN, size = 16.dp, surface = ground)
        } else {
            Icon(Icons.Outlined.CloudOff, contentDescription = null, modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(8.dp))
        Text(
            when {
                p != null -> p.short
                state == ConnectionState.CONNECTING -> "Connecting to $name…"
                else -> "Can't reach $name. Retrying…"
            },
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * First load: the knot runs where the rows will come (waiting on the hub,
 * docs/design/KNOT-MOTION.md), shown only after 300ms, so a fast load shows
 * nothing at all (as the web's LoadingRows). No spinner, and nothing made of
 * dots: dots never mean working.
 */
@Composable
fun LoadingBox(modifier: Modifier = Modifier, @Suppress("UNUSED_PARAMETER") rows: Int = 4) {
    var show by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        delay(300)
        show = true
    }
    Column(modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 8.dp).semantics { contentDescription = "Loading" }) {
        if (!show) return@Column
        KnotRope(RopeMoment.RUN, size = 32.dp, modifier = Modifier.padding(vertical = 12.dp))
    }
}

@Composable
fun ConfirmDialog(
    title: String,
    text: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    destructive: Boolean = false,
    extra: (@Composable () -> Unit)? = null,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column {
                Text(text)
                extra?.invoke()
            }
        },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(confirmLabel, color = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Markdown with Material 3 styling and highlighted code blocks. */
@Composable
fun MarkdownText(text: String, modifier: Modifier = Modifier) {
    val extra = LocalExtraColors.current
    val state = rememberMarkdownState(text, retainState = true)
    Markdown(
        markdownState = state,
        colors = markdownColor(
            text = MaterialTheme.colorScheme.onSurface,
            codeBackground = extra.codeBg,
            inlineCodeBackground = MaterialTheme.colorScheme.surfaceContainerHighest,
        ),
        typography = markdownTypography(
            h1 = MaterialTheme.typography.headlineSmall,
            h2 = MaterialTheme.typography.titleLarge,
            h3 = MaterialTheme.typography.titleMedium,
            h4 = MaterialTheme.typography.titleSmall,
            h5 = MaterialTheme.typography.titleSmall,
            h6 = MaterialTheme.typography.titleSmall,
            text = MaterialTheme.typography.bodyLarge,
            paragraph = MaterialTheme.typography.bodyLarge,
            code = CodeStyle,
            inlineCode = MaterialTheme.typography.bodyLarge.copy(fontFamily = CodeStyle.fontFamily),
        ),
        components = markdownComponents(
            codeBlock = highlightedCodeBlock,
            codeFence = highlightedCodeFence,
        ),
        modifier = modifier.fillMaxWidth(),
    )
}

/** Monospace block with horizontal scroll, for tool input and output. */
@Composable
fun CodeBox(text: String, modifier: Modifier = Modifier, maxLines: Int = Int.MAX_VALUE) {
    val extra = LocalExtraColors.current
    Surface(
        modifier = modifier.fillMaxWidth(),
        color = extra.codeBg,
        shape = RoundedCornerShape(5.dp),
        border = BorderStroke(1.dp, Conclave.colors.rule),
    ) {
        Box(Modifier.horizontalScroll(rememberScrollState()).padding(10.dp)) {
            Text(text, style = CodeStyle, maxLines = maxLines, overflow = TextOverflow.Clip, softWrap = false)
        }
    }
}

/** A key and value row whose value is a model with its mark ("Default model  [claude] Sonnet 5.5"). */
@Composable
fun KeyModel(key: String, model: String?, modifier: Modifier = Modifier, empty: String = "Hub default") {
    Row(modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(key, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(120.dp))
        if (model.isNullOrBlank()) {
            Text(empty, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
        } else {
            ModelName(
                model,
                Modifier.weight(1f, fill = false),
                size = 14.dp,
                style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
            )
        }
    }
}

@Composable
fun KeyValue(key: String, value: String, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(key, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(120.dp))
        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
    }
}
