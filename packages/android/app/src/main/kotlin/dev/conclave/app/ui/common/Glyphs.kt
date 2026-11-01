package dev.conclave.app.ui.common

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/*
 * The top bar's own glyphs (MOBILE-V2 1): two lines for the side panel and a
 * pencil on a square for a new chat. Drawn as strokes on a 24 grid, so Icon
 * tints them like the Material icons around them.
 */

private fun glyph(name: String, block: ImageVector.Builder.() -> Unit): ImageVector =
    ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply(block).build()

private fun ImageVector.Builder.stroke(block: androidx.compose.ui.graphics.vector.PathBuilder.() -> Unit) {
    path(
        fill = null,
        stroke = SolidColor(Color.Black),
        strokeLineWidth = 1.8f,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
        pathBuilder = block,
    )
}

object Glyphs {
    /** Two lines, the lower one shorter: opens the side panel. */
    val Menu: ImageVector by lazy {
        glyph("Menu") {
            stroke {
                moveTo(4f, 8.5f)
                lineTo(20f, 8.5f)
                moveTo(4f, 15.5f)
                lineTo(14f, 15.5f)
            }
        }
    }

    /** A pencil on a square: a new chat. */
    val NewChat: ImageVector by lazy {
        glyph("NewChat") {
            stroke {
                // the square, open at its top right where the pencil comes in
                moveTo(11f, 4.5f)
                lineTo(7f, 4.5f)
                arcTo(2.5f, 2.5f, 0f, false, false, 4.5f, 7f)
                lineTo(4.5f, 17f)
                arcTo(2.5f, 2.5f, 0f, false, false, 7f, 19.5f)
                lineTo(17f, 19.5f)
                arcTo(2.5f, 2.5f, 0f, false, false, 19.5f, 17f)
                lineTo(19.5f, 13f)
            }
            stroke {
                // the pencil
                moveTo(17.2f, 3.8f)
                lineTo(20.2f, 6.8f)
                lineTo(12f, 15f)
                lineTo(8.5f, 15.5f)
                lineTo(9f, 12f)
                close()
            }
        }
    }
}
