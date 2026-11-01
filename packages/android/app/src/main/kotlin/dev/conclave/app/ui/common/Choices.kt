package dev.conclave.app.ui.common

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType

/*
 * A switch between two or three ways (docs/DESIGN.md 13: no pills or chips,
 * on a phone too): the segmented control, the web's Segmented. The phone's
 * lists have no filters (MOBILE-V2 6).
 */

private val SegmentOuter = RoundedCornerShape(5.dp)
private val SegmentInner = RoundedCornerShape(3.dp)

/**
 * The house segmented control: text segments in a rule-2 outline, the
 * current one raised in fg, the others fg-3. Neutral ink, never violet.
 * 48dp tall; the segments share the width.
 */
@Composable
fun <T> Segmented(
    value: T,
    options: List<Pair<T, String>>,
    onChange: (T) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Conclave.colors
    Row(
        modifier.height(48.dp).border(1.dp, c.rule2, SegmentOuter).padding(2.dp).selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        options.forEach { (v, label) ->
            val on = v == value
            Box(
                Modifier
                    .weight(1f)
                    .fillMaxHeight()
                    .clip(SegmentInner)
                    .then(if (on) Modifier.background(c.bgRaise).border(1.dp, c.rule2, SegmentInner) else Modifier)
                    .selectable(selected = on, role = Role.RadioButton, onClick = { onChange(v) })
                    .padding(horizontal = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(label, style = ConclaveType.button, color = if (on) c.fg else c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
