package dev.conclave.app.ui.conversation

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import dev.conclave.app.ui.motion.Swap
import dev.conclave.app.ui.motion.motionNow
import dev.conclave.app.ui.motion.reducedMotion
import dev.conclave.app.ui.theme.CodeStyle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveColors
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.app.ui.theme.JetBrainsMono
import dev.conclave.client.logic.ChatMarkdown
import dev.conclave.client.logic.MdBlock
import dev.conclave.client.logic.MdInline
import dev.conclave.client.logic.MdStyle
import dev.conclave.client.motion.Ink
import dev.conclave.client.motion.InkClock
import kotlinx.coroutines.delay

/*
 * Chat prose: the reply's markdown, drawn so streamed text arrives as Ink
 * (type.html type-07, docs/design/CHAT-AND-MOTION.md 1.4): a soft front
 * runs along each line, the newest letters are violet and cool to ink about
 * 0.3s behind it. Words are released 40ms apart and never more than 320ms
 * behind the stream (dev.conclave.client.motion.InkClock). Nothing moves or
 * reflows: letters not yet released are covered in the background color,
 * and the tiers behind the front are the same text drawn again in their
 * color, clipped to their letters. Text already on screen never animates
 * again; with animations off the text simply lands.
 */

/** Tier colors behind the front, newest first: 30% and 72% violet, violet, then two steps back to the text color. */
private fun inkTiers(signal: Color, text: Color): List<Pair<Color, Float>> = listOf(
    signal to 0.3f,
    signal to 0.72f,
    signal to 1f,
    androidx.compose.ui.graphics.lerp(text, signal, 0.55f) to 1f,
    androidx.compose.ui.graphics.lerp(text, signal, 0.22f) to 1f,
)

/** The Ink of one streaming text, by source offset. */
class InkState {
    private val clock = InkClock()
    private var seen = -1
    private var length = 0

    /** Tier boundaries for the current frame (see InkClock.boundaries). */
    internal val bounds = IntArray(Ink.TIERS.size)

    /** True while something is unreleased or cooling; read while drawing. */
    internal var live = false

    /** Frame time in ns, written by the frame loop and read only while drawing. */
    val now = mutableLongStateOf(0L)

    /** Notes growth of the text. Called during composition, before the new text draws. */
    fun observe(text: String, active: Boolean) {
        val n = text.length
        if (seen < 0) {
            // what is on screen at mount is old text, unless it is the first chunk of a reply that mounts streaming
            seen = if (active && n <= Ink.FIRST_CHUNK) 0 else n
        }
        if (n < seen) {
            clock.shrink(n)
            seen = n
        }
        if (n > seen) {
            if (active) clock.arrive(text, seen, motionNow())
            seen = n
        }
        length = n
        tick()
    }

    /** Recomputes the tiers; true while something still moves. */
    fun tick(): Boolean {
        val t = motionNow()
        live = clock.active(t)
        if (live) clock.boundaries(t, length, bounds) else bounds.fill(length)
        return live
    }
}

@Composable
fun rememberInk(text: String, streaming: Boolean): InkState {
    val state = remember { InkState() }
    val reduced = reducedMotion()
    state.observe(text, streaming && !reduced)
    LaunchedEffect(text.length) {
        var more = state.live
        while (more) {
            withFrameNanos { frame ->
                more = state.tick()
                state.now.longValue = frame
            }
        }
    }
    return state
}

/**
 * Paints the Ink tiers over this text: letters not yet released are covered
 * in [cover], the newest ones are drawn again in violet, cooling to the
 * text color.
 */
private fun Modifier.ink(state: InkState?, layout: MutableState<TextLayoutResult?>, sourceOf: (Int) -> Int, length: Int, cover: Color, tiers: List<Pair<Color, Float>>): Modifier {
    if (state == null) return this
    return drawWithContent {
        drawContent()
        state.now.longValue
        if (!state.live || length == 0) return@drawWithContent
        val l = layout.value ?: return@drawWithContent
        val b = state.bounds
        // a block that ends before the oldest cooling letter has nothing to paint
        if (sourceOf(length - 1) < b[b.size - 1]) return@drawWithContent
        fun index(src: Int): Int {
            var i = 0
            while (i < length && sourceOf(i) < src) i++
            return i
        }
        var hi = length
        for (tier in b.indices) {
            val lo = index(b[tier])
            if (hi > lo) {
                val path = l.getPathForRange(lo, hi)
                drawPath(path, cover)
                if (tier > 0) {
                    val (color, alpha) = tiers[tier - 1]
                    clipPath(path) { drawText(l, color = color, alpha = alpha) }
                }
            }
            hi = lo
            if (lo == 0) break
        }
    }
}

fun MdInline.annotated(c: ConclaveColors): AnnotatedString = buildAnnotatedString {
    append(text)
    for (s in spans) {
        when (s.style) {
            MdStyle.BOLD -> addStyle(SpanStyle(fontWeight = FontWeight.SemiBold), s.start, s.end)
            MdStyle.ITALIC -> addStyle(SpanStyle(fontStyle = FontStyle.Italic), s.start, s.end)
            MdStyle.STRIKE -> addStyle(SpanStyle(textDecoration = TextDecoration.LineThrough), s.start, s.end)
            MdStyle.CODE -> addStyle(SpanStyle(fontFamily = JetBrainsMono, fontSize = 0.88.em, background = c.bgHover), s.start, s.end)
            MdStyle.LINK -> {
                val url = s.url
                if (url == null) {
                    // its address is still streaming: looks like a link, opens nothing yet
                    addStyle(SpanStyle(textDecoration = TextDecoration.Underline), s.start, s.end)
                } else {
                    addLink(LinkAnnotation.Url(url, TextLinkStyles(style = SpanStyle(textDecoration = TextDecoration.Underline))), s.start, s.end)
                }
            }
        }
    }
}

/**
 * The reply's text. [streaming] while it still grows: open emphasis shows
 * styled at once and new characters fade in.
 */
@Composable
fun ChatProse(
    text: String,
    streaming: Boolean,
    modifier: Modifier = Modifier,
    color: Color = Conclave.colors.fg,
    style: TextStyle = ConclaveType.chat,
) {
    val blocks = remember(text, streaming) { ChatMarkdown.parse(text, open = streaming) }
    val reveal = rememberInk(text, streaming)
    val c = Conclave.colors
    Column(modifier.fillMaxWidth()) {
        var prev: MdBlock? = null
        blocks.forEachIndexed { i, block ->
            if (i > 0) Spacer(Modifier.height(if (prev is MdBlock.Item && block is MdBlock.Item) 4.dp else 12.dp))
            Block(block, reveal, color, style, c)
            prev = block
        }
    }
}

@Composable
private fun InlineText(inline: MdInline, reveal: InkState?, style: TextStyle, color: Color, cover: Color, modifier: Modifier = Modifier) {
    val c = Conclave.colors
    val annotated = remember(inline, c) { inline.annotated(c) }
    val layout = remember { mutableStateOf<TextLayoutResult?>(null) }
    val tiers = remember(c, color) { inkTiers(c.signal, color) }
    Text(
        annotated,
        modifier.ink(reveal, layout, { inline.source[it] }, inline.text.length, cover, tiers),
        style = style,
        color = color,
        onTextLayout = { layout.value = it },
    )
}

@Composable
private fun Block(block: MdBlock, reveal: InkState, color: Color, style: TextStyle, c: ConclaveColors) {
    when (block) {
        is MdBlock.Paragraph -> InlineText(block.inline, reveal, style, color, c.bg)
        is MdBlock.Heading -> InlineText(
            block.inline,
            reveal,
            (if (block.level <= 2) ConclaveType.title else ConclaveType.title.copy(fontSize = style.fontSize)),
            color,
            c.bg,
        )
        is MdBlock.Item -> Row(Modifier.padding(start = (block.depth * 18).dp)) {
            // the marker arrives with the item's first letter, not before it
            val first = block.inline.source.firstOrNull()
            Box(
                Modifier.width(22.dp).drawWithContent {
                    reveal.now.longValue
                    if (first == null || !reveal.live || first < reveal.bounds[0]) drawContent()
                },
            ) {
                Text(if (block.ordered) block.marker else "•", style = style, color = c.fg3)
            }
            InlineText(block.inline, reveal, style, color, c.bg, Modifier.weight(1f))
        }
        is MdBlock.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
            Box(Modifier.width(1.dp).fillMaxHeight().background(c.rule2))
            Spacer(Modifier.width(12.dp))
            InlineText(block.inline, reveal, style, c.fg2, c.bg, Modifier.weight(1f))
        }
        is MdBlock.Code -> CodeBlock(block, reveal)
        is MdBlock.Table -> TableBlock(block, c)
        MdBlock.Rule -> HorizontalDivider(thickness = 1.dp, color = c.rule)
    }
}

/** Copies to the clipboard. No toast: the button says Copied. */
fun copyText(context: Context, text: String) {
    val cm = context.getSystemService(ClipboardManager::class.java) ?: return
    cm.setPrimaryClip(ClipData.newPlainText("Conclave", text))
}

/** A copy icon that turns into a check for 1.5s (Swap, 120ms). */
@Composable
fun CopyIconButton(text: () -> String, modifier: Modifier = Modifier, label: String = "Copy") {
    val context = LocalContext.current
    var copied by remember { mutableStateOf(false) }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_500)
            copied = false
        }
    }
    val c = Conclave.colors
    IconButton(onClick = { copyText(context, text()); copied = true }, modifier = modifier.size(36.dp)) {
        Swap(on = copied, off = { Icon(Icons.Outlined.ContentCopy, contentDescription = label, modifier = Modifier.size(16.dp), tint = c.fg3) }) {
            Icon(Icons.Outlined.Check, contentDescription = "Copied", modifier = Modifier.size(16.dp), tint = c.fg2)
        }
    }
}

@Composable
private fun CodeBlock(block: MdBlock.Code, reveal: InkState) {
    val c = Conclave.colors
    Surface(
        color = c.bgSunk,
        shape = RoundedCornerShape(5.dp),
        border = BorderStroke(1.dp, c.rule),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column {
            Row(Modifier.fillMaxWidth().padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                // while the fence line streams in the language is not known yet: show nothing rather than a wrong word
                Text(block.lang.ifBlank { if (block.closed) "text" else "" }, style = ConclaveType.meta, color = c.fg3, modifier = Modifier.weight(1f))
                CopyIconButton({ block.text }, label = "Copy code")
            }
            val layout = remember { mutableStateOf<TextLayoutResult?>(null) }
            // code scrolls sideways inside its box, never the page
            Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = 12.dp, end = 12.dp, bottom = 12.dp)) {
                Text(
                    block.text,
                    modifier = Modifier.ink(reveal, layout, { block.textStart + it }, block.text.length, c.bgSunk, remember(c) { inkTiers(c.signal, c.fg) }),
                    style = CodeStyle,
                    color = c.fg,
                    softWrap = false,
                    onTextLayout = { layout.value = it },
                )
            }
        }
    }
}

@Composable
private fun TableBlock(block: MdBlock.Table, c: ConclaveColors) {
    val columns = maxOf(block.header.size, block.rows.maxOfOrNull { it.size } ?: 0)
    if (columns == 0) return
    // a column is as wide as its longest cell, within limits
    val widths = (0 until columns).map { col ->
        val longest = (listOf(block.header) + block.rows).maxOf { row -> row.getOrNull(col)?.text?.length ?: 0 }
        (longest * 8 + 24).coerceIn(72, 260).dp
    }
    Column(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
        TableRow(block.header, widths, c, header = true)
        HorizontalDivider(thickness = 1.dp, color = c.rule2, modifier = Modifier.width(widths.fold(0.dp) { a, b -> a + b }))
        block.rows.forEach { row ->
            TableRow(row, widths, c, header = false)
            HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.width(widths.fold(0.dp) { a, b -> a + b }))
        }
    }
}

@Composable
private fun TableRow(cells: List<MdInline>, widths: List<androidx.compose.ui.unit.Dp>, c: ConclaveColors, header: Boolean) {
    Row(Modifier.padding(vertical = 6.dp), verticalAlignment = Alignment.Top) {
        widths.forEachIndexed { i, w ->
            val cell = cells.getOrNull(i) ?: MdInline.EMPTY
            val annotated = remember(cell, c) { cell.annotated(c) }
            Text(
                annotated,
                modifier = Modifier.width(w).padding(end = 12.dp),
                style = if (header) ConclaveType.meta.copy(fontWeight = FontWeight.SemiBold) else ConclaveType.body,
                color = if (header) c.fg else c.fg2,
            )
        }
    }
}
