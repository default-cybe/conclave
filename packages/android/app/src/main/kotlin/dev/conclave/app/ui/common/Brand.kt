package dev.conclave.app.ui.common

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import dev.conclave.app.ui.motion.KnotPaths
import dev.conclave.app.ui.motion.drawKnot
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.MonaSans
import dev.conclave.client.motion.knotBrand

/** The knot's box next to text: this many times the height the old wave mark had, so it keeps its weight. */
private const val BOX_PER_HEIGHT = 1.5f

/**
 * The Conclave mark (spec 9.6, docs/design/brand/README.md): the trefoil
 * knot as a ribbon with real crossings in [color], with one light in
 * [crest] (signal violet) at home on its right lobe. Square: [size] is the
 * box; [height] (the old wave mark's height) still works and gives a box
 * 1.5 times it. [mono] draws the light in [color] too, for one color
 * contexts. The halos at the crossings take [surface], the page by default.
 */
@Composable
fun Mark(
    modifier: Modifier = Modifier,
    height: Dp = 14.dp,
    mono: Boolean = false,
    color: Color = Conclave.colors.fg,
    crest: Color = Conclave.colors.signal,
    label: String? = null,
    size: Dp? = null,
    surface: Color = Conclave.colors.bg,
) {
    val box = size ?: (height * BOX_PER_HEIGHT)
    val paths = remember { KnotPaths() }
    val pose = remember { knotBrand() }
    val described = if (label != null) Modifier.semantics { contentDescription = label } else Modifier
    Canvas(modifier.size(box).then(described)) {
        drawKnot(paths, pose, box.value.toDouble(), color, if (mono) color else crest, surface)
    }
}

/** The mark plus the "Conclave" wordmark: Mona Sans 600, tracking -0.01em (spec 9.6). */
@Composable
fun Wordmark(modifier: Modifier = Modifier, size: Float = 17f, mark: Boolean = true) {
    val c = Conclave.colors
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        if (mark) {
            Mark(size = (size * 1.4f).dp)
            Spacer(Modifier.width((size * 0.6f).dp))
        }
        Text(
            "Conclave",
            style = TextStyle(
                fontFamily = MonaSans,
                fontWeight = FontWeight.SemiBold,
                fontSize = size.sp,
                lineHeight = size.sp,
                letterSpacing = (-0.01).em,
            ),
            color = c.fg,
            maxLines = 1,
        )
    }
}
