package dev.conclave.app.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.StartMode

/**
 * Chat, Assistant, Code (docs/DESIGN.md 15, web features/home/ModeSwitch.tsx):
 * three words in one rounded track, the current one raised. It is the title
 * of Home's bar, where a press sets the mode of the new conversation, and
 * sits under New and Search in the side panel, where it picks the mode
 * whose conversations are listed.
 */
@Composable
fun ModeSwitch(mode: StartMode, onChange: (StartMode) -> Unit, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    Row(
        modifier
            .clip(RoundedCornerShape(20.dp))
            .background(c.surface2)
            .padding(2.dp)
            .selectableGroup(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        StartMode.entries.forEach { m ->
            val on = m == mode
            Box(
                Modifier
                    .heightIn(min = 36.dp)
                    .clip(RoundedCornerShape(18.dp))
                    .background(if (on) c.bgRaise else Color.Transparent)
                    .selectable(selected = on, role = Role.RadioButton, onClick = { onChange(m) })
                    .padding(horizontal = 12.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(m.label, style = ConclaveType.button.copy(fontSize = 14.sp), color = if (on) c.fg else c.fg3, maxLines = 1)
            }
        }
    }
}
