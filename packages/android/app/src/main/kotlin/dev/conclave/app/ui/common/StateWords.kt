package dev.conclave.app.ui.common

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.StateTone

/** The color for a state word: violet live, amber waiting, red failed, green ok, fg-3 and fg-2 for the rest. */
@Composable
fun toneColor(tone: StateTone): Color {
    val c = Conclave.colors
    return when (tone) {
        StateTone.SIGNAL -> c.signal
        StateTone.OK -> c.ok
        StateTone.WARN -> c.warn
        StateTone.FAULT -> c.fault
        StateTone.DIM -> c.fg3
        StateTone.NEUTRAL -> c.fg2
    }
}

/** A state as a word in its fixed place (spec 10.2): never a pill, a badge or a spinner. */
@Composable
fun StateWordText(word: String, tone: StateTone, modifier: Modifier = Modifier, style: TextStyle = ConclaveType.meta) {
    Text(word, modifier, style = style, color = toneColor(tone), maxLines = 1)
}
