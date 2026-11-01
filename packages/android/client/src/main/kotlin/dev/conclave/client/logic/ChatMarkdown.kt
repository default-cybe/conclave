package dev.conclave.client.logic

/*
 * A small markdown reader for chat replies on the phone. It keeps, for every
 * character it shows, the offset of that character in the source text, so the
 * app can fade in exactly the characters that just streamed in (the Compose
 * side of StreamReveal, docs/design/CHAT-AND-MOTION.md 1.8) without breaking
 * the formatting. It reads what chat replies use: paragraphs, headings, lists,
 * quotes, fenced code, tables, rules, and inline bold, italic, code, strike
 * and links. Anything else shows as text.
 */

enum class MdStyle { BOLD, ITALIC, CODE, STRIKE, LINK }

/** A styled run of [MdInline.text], end exclusive. [url] for links (null while its address still streams). */
data class MdSpan(val start: Int, val end: Int, val style: MdStyle, val url: String? = null)

/** Inline text with the markup taken out. [source] holds the source offset of each character of [text]. */
class MdInline(val text: String, val spans: List<MdSpan>, val source: IntArray) {
    override fun equals(other: Any?): Boolean =
        other is MdInline && other.text == text && other.spans == spans && other.source.contentEquals(source)

    override fun hashCode(): Int = (text.hashCode() * 31 + spans.hashCode()) * 31 + source.contentHashCode()

    override fun toString(): String = "MdInline($text, $spans)"

    companion object {
        val EMPTY = MdInline("", emptyList(), IntArray(0))
    }
}

sealed class MdBlock {
    data class Paragraph(val inline: MdInline) : MdBlock()
    data class Heading(val level: Int, val inline: MdInline) : MdBlock()

    /** One list item. [marker] is "1." for ordered items and empty for bullets; [depth] starts at 0. */
    data class Item(val ordered: Boolean, val marker: String, val depth: Int, val inline: MdInline) : MdBlock()
    data class Quote(val inline: MdInline) : MdBlock()

    /** A fenced block. [textStart] is the source offset of [text]; [closed] once its closing fence arrived. */
    data class Code(val lang: String, val text: String, val textStart: Int, val closed: Boolean) : MdBlock()
    data class Table(val header: List<MdInline>, val rows: List<List<MdInline>>) : MdBlock()
    data object Rule : MdBlock()
}

object ChatMarkdown {

    private class Line(val start: Int, val text: String) {
        val end get() = start + text.length
    }

    private val HEADING = Regex("""^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$""")
    private val RULE = Regex("""^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$""")
    private val ITEM = Regex("""^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$""")
    private val QUOTE = Regex("""^ {0,3}> ?""")
    private val DELIMITER = Regex("""^[ \t]*\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$""")

    private fun fenceOf(t: String): String? {
        val s = t.trimStart()
        if (t.length - s.length > 3) return null
        return when {
            s.startsWith("```") -> s.takeWhile { it == '`' }
            s.startsWith("~~~") -> s.takeWhile { it == '~' }
            else -> null
        }
    }

    private fun isTableStart(lines: List<Line>, i: Int): Boolean =
        i + 1 < lines.size && lines[i].text.contains('|') && DELIMITER.matches(lines[i + 1].text) && lines[i + 1].text.contains('-')

    private fun startsBlock(lines: List<Line>, i: Int): Boolean {
        val t = lines[i].text
        return fenceOf(t) != null || HEADING.matches(t) || RULE.matches(t) || QUOTE.containsMatchIn(t) || ITEM.matches(t) || isTableStart(lines, i)
    }

    /**
     * Blocks of [src]. With [open] (the reply is still streaming) an
     * emphasis or code span that has not closed yet already shows styled, so
     * its markers never flash on screen.
     */
    fun parse(src: String, open: Boolean = false): List<MdBlock> {
        val lines = ArrayList<Line>()
        var at = 0
        while (at <= src.length) {
            val nl = src.indexOf('\n', at)
            val end = if (nl < 0) src.length else nl
            lines.add(Line(at, src.substring(at, end).trimEnd('\r')))
            if (nl < 0) break
            at = nl + 1
        }
        val out = ArrayList<MdBlock>()
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val t = line.text
            if (t.isBlank()) {
                i++
                continue
            }
            val fence = fenceOf(t)
            if (fence != null) {
                val lang = t.trimStart().drop(fence.length).trim().substringBefore(' ')
                val body = ArrayList<Line>()
                var j = i + 1
                var closed = false
                while (j < lines.size) {
                    val c = lines[j].text.trimStart()
                    if (c.startsWith(fence) && c.trimEnd().all { it == fence[0] }) {
                        closed = true
                        break
                    }
                    body.add(lines[j])
                    j++
                }
                // while it streams, a fresh empty last line is not part of the code yet
                if (!closed && body.isNotEmpty() && body.last().text.isEmpty()) body.removeAt(body.lastIndex)
                val textStart = body.firstOrNull()?.start ?: minOf(src.length, line.end + 1)
                val text = if (body.isEmpty()) "" else src.substring(body.first().start, body.last().end)
                out.add(MdBlock.Code(lang, text, textStart, closed))
                i = if (closed) j + 1 else j
                continue
            }
            val heading = HEADING.matchEntire(t)
            if (heading != null) {
                val g = heading.groups[2]
                val range = if (g == null) IntRange.EMPTY else line.start + g.range.first until line.start + g.range.last + 1
                out.add(MdBlock.Heading(heading.groupValues[1].length, inline(src, listOf(range), open && i == lines.lastIndex)))
                i++
                continue
            }
            if (RULE.matches(t)) {
                out.add(MdBlock.Rule)
                i++
                continue
            }
            if (isTableStart(lines, i)) {
                val header = cells(src, line)
                val rows = ArrayList<List<MdInline>>()
                var j = i + 2
                while (j < lines.size && lines[j].text.isNotBlank() && lines[j].text.contains('|')) {
                    rows.add(cells(src, lines[j]))
                    j++
                }
                out.add(MdBlock.Table(header, rows))
                i = j
                continue
            }
            if (QUOTE.containsMatchIn(t)) {
                val segs = ArrayList<IntRange>()
                var j = i
                while (j < lines.size) {
                    val m = QUOTE.find(lines[j].text) ?: break
                    segs.add(lines[j].start + m.range.last + 1 until lines[j].end)
                    j++
                }
                out.add(MdBlock.Quote(inline(src, segs, open && j >= lines.size)))
                i = j
                continue
            }
            val item = ITEM.matchEntire(t)
            if (item != null) {
                val indent = item.groupValues[1].replace("\t", "    ").length
                val marker = item.groupValues[2]
                val ordered = marker[0].isDigit()
                val content = item.groups[3]!!
                val segs = arrayListOf(line.start + content.range.first until line.end)
                var j = i + 1
                // lines that continue the item: anything that does not start a block of its own
                while (j < lines.size && lines[j].text.isNotBlank() && !startsBlock(lines, j)) {
                    val c = lines[j]
                    val lead = c.text.length - c.text.trimStart().length
                    segs.add(c.start + lead until c.end)
                    j++
                }
                out.add(
                    MdBlock.Item(
                        ordered = ordered,
                        marker = if (ordered) marker.dropLast(1) + "." else "",
                        depth = (indent / 2).coerceAtMost(3),
                        inline = inline(src, segs, open && j >= lines.size),
                    ),
                )
                i = j
                continue
            }
            // a paragraph runs until a blank line or a line that starts another block
            val segs = ArrayList<IntRange>()
            var j = i
            while (j < lines.size && lines[j].text.isNotBlank() && (j == i || !startsBlock(lines, j))) {
                val c = lines[j]
                val lead = c.text.length - c.text.trimStart().length
                segs.add(c.start + lead until c.end)
                j++
            }
            out.add(MdBlock.Paragraph(inline(src, segs, open && j >= lines.size)))
            i = j
        }
        return out
    }

    private fun cells(src: String, line: Line): List<MdInline> {
        var t = line.text
        var base = line.start
        val lead = t.length - t.trimStart().length
        t = t.trim()
        base += lead
        if (t.startsWith("|")) {
            t = t.drop(1)
            base += 1
        }
        if (t.endsWith("|") && !t.endsWith("\\|")) t = t.dropLast(1)
        val out = ArrayList<MdInline>()
        var cellStart = 0
        var k = 0
        while (k <= t.length) {
            if (k == t.length || (t[k] == '|' && (k == 0 || t[k - 1] != '\\'))) {
                val raw = t.substring(cellStart, k)
                val l = raw.length - raw.trimStart().length
                val r = raw.trimEnd().length
                out.add(if (r <= l) MdInline.EMPTY else inline(src, listOf(base + cellStart + l until base + cellStart + r), false))
                cellStart = k + 1
            }
            k++
        }
        return out
    }

    /** Inline text of the source ranges [segments], joined with line breaks. */
    fun inline(src: String, segments: List<IntRange>, open: Boolean = false): MdInline {
        val raw = StringBuilder()
        val rawSrc = ArrayList<Int>()
        segments.forEachIndexed { n, r ->
            if (n > 0) {
                raw.append('\n')
                rawSrc.add(r.first - 1)
            }
            for (k in r) {
                raw.append(src[k])
                rawSrc.add(k)
            }
        }
        val p = InlineParser(raw.toString(), rawSrc.toIntArray(), open)
        p.parse(0, raw.length)
        return MdInline(p.text.toString(), p.spans.sortedWith(compareBy({ it.start }, { -it.end })), p.source.toIntArray())
    }

    private class InlineParser(val raw: String, val rawSrc: IntArray, val open: Boolean) {
        val text = StringBuilder()
        val source = ArrayList<Int>()
        val spans = ArrayList<MdSpan>()

        private fun emit(k: Int) {
            text.append(raw[k])
            source.add(rawSrc[k])
        }

        /** [literal]: show the range as typed (code, and links whose text is the address). */
        private fun styled(from: Int, to: Int, style: MdStyle, url: String? = null, literal: Boolean = style == MdStyle.CODE) {
            val start = text.length
            if (literal) {
                for (k in from until to) emit(k)
            } else {
                parse(from, to)
            }
            if (text.length > start) spans.add(MdSpan(start, text.length, style, url))
        }

        private fun isPunct(c: Char) = c in "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"

        /** Closing delimiter [d] in [from, to): not right after a space. */
        private fun closer(d: String, from: Int, to: Int): Int {
            var k = from
            while (k <= to - d.length) {
                if (raw[k] == '\\') {
                    k += 2
                    continue
                }
                if (raw.startsWith(d, k) && k > from && !raw[k - 1].isWhitespace()) {
                    // "**" must not close a single "*"
                    if (d.length == 1 && k + 1 < to && raw[k + 1] == d[0]) {
                        k += 2
                        continue
                    }
                    if (d == "_" && k + 1 < to && raw[k + 1].isLetterOrDigit()) {
                        k++
                        continue
                    }
                    return k
                }
                k++
            }
            return -1
        }

        fun parse(from: Int, to: Int) {
            var k = from
            while (k < to) {
                val c = raw[k]
                // escapes
                if (c == '\\' && k + 1 < to && isPunct(raw[k + 1])) {
                    emit(k + 1)
                    k += 2
                    continue
                }
                // code spans
                if (c == '`') {
                    var n = 0
                    while (k + n < to && raw[k + n] == '`') n++
                    val fence = "`".repeat(n)
                    val close = raw.indexOf(fence, k + n).takeIf { it in (k + n)..(to - n) }
                    if (close != null) {
                        var a = k + n
                        var b = close
                        if (b - a >= 2 && raw[a] == ' ' && raw[b - 1] == ' ') {
                            a++
                            b--
                        }
                        styled(a, b, MdStyle.CODE)
                        k = close + n
                        continue
                    }
                    if (open && k + n < to) {
                        styled(k + n, to, MdStyle.CODE)
                        k = to
                        continue
                    }
                    for (x in k until k + n) emit(x)
                    k += n
                    continue
                }
                // links: [text](url)
                if (c == '[') {
                    val close = raw.indexOf(']', k + 1).takeIf { it in (k + 1) until to }
                    if (close != null && close + 1 < to && raw[close + 1] == '(') {
                        val end = raw.indexOf(')', close + 2).takeIf { it in (close + 2) until to }
                        if (end != null) {
                            val url = raw.substring(close + 2, end).trim().substringBefore(' ').removeSurrounding("<", ">")
                            if (url.isNotEmpty() && ' ' !in url) {
                                styled(k + 1, close, MdStyle.LINK, url)
                                k = end + 1
                                continue
                            }
                        } else if (open && raw.substring(close + 2, to).none { it.isWhitespace() }) {
                            // the address is still streaming: show the link's words, never the half address
                            styled(k + 1, close, MdStyle.LINK, null)
                            k = to
                            continue
                        }
                    }
                    if (open && close == null && raw.substring(k + 1, to).none { it == '\n' }) {
                        // "[words" at the end of a streaming text: the bracket waits for its pair
                        k++
                        continue
                    }
                }
                // autolinks: <https://...> and bare https://...
                if (c == '<' && (raw.startsWith("<https://", k) || raw.startsWith("<http://", k))) {
                    val end = raw.indexOf('>', k + 1).takeIf { it in (k + 1) until to }
                    if (end != null && raw.substring(k + 1, end).none { it.isWhitespace() }) {
                        styled(k + 1, end, MdStyle.LINK, raw.substring(k + 1, end), literal = true)
                        k = end + 1
                        continue
                    }
                }
                if ((c == 'h') && (raw.startsWith("https://", k) || raw.startsWith("http://", k)) && (k == from || !raw[k - 1].isLetterOrDigit())) {
                    var end = k
                    while (end < to && !raw[end].isWhitespace() && raw[end] != '<' && raw[end] != '>') end++
                    while (end > k && raw[end - 1] in ".,;:!?)'\"") end--
                    if (end > k + 8) {
                        styled(k, end, MdStyle.LINK, raw.substring(k, end), literal = true)
                        k = end
                        continue
                    }
                }
                // emphasis and strike
                val delim = when {
                    raw.startsWith("**", k) -> "**"
                    raw.startsWith("__", k) -> "__"
                    raw.startsWith("~~", k) -> "~~"
                    c == '*' -> "*"
                    c == '_' -> "_"
                    else -> null
                }
                if (delim != null) {
                    val afterOpen = k + delim.length
                    val opens = afterOpen < to && !raw[afterOpen].isWhitespace() &&
                        (delim[0] != '_' || k == from || !raw[k - 1].isLetterOrDigit())
                    if (opens) {
                        val style = when (delim) {
                            "**", "__" -> MdStyle.BOLD
                            "~~" -> MdStyle.STRIKE
                            else -> MdStyle.ITALIC
                        }
                        val close = closer(delim, afterOpen, to)
                        if (close >= 0) {
                            styled(afterOpen, close, style)
                            k = close + delim.length
                            continue
                        }
                        if (open && delim != "_" && delim != "__") {
                            styled(afterOpen, to, style)
                            k = to
                            continue
                        }
                    }
                    for (x in k until afterOpen) emit(x)
                    k = afterOpen
                    continue
                }
                emit(k)
                k++
            }
        }
    }
}
