package dev.conclave.client

import dev.conclave.client.logic.ChatMarkdown
import dev.conclave.client.logic.MdBlock
import dev.conclave.client.logic.MdInline
import dev.conclave.client.logic.MdSpan
import dev.conclave.client.logic.MdStyle
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

class ChatMarkdownTest {

    private fun one(src: String, open: Boolean = false): MdInline = (ChatMarkdown.parse(src, open).single() as MdBlock.Paragraph).inline

    @Test
    fun readsTheBlocksChatRepliesUse() {
        val src = """
            ## Set it up

            Yes. When a site address ends in `.ts.net`, Caddy asks tailscaled.

            - first
            - second
              more of second
            1. one
            2) two

            > a quote
            > on two lines

            ```sh
            echo 'TS_PERMIT_CERT_UID=caddy'
            systemctl restart tailscaled
            ```

            | Name | Port |
            |---|---:|
            | caddy | 443 |
            | **madx** | 7420 |

            ---
            Done.
        """.trimIndent()
        val blocks = ChatMarkdown.parse(src)
        assertEquals(
            listOf("Heading", "Paragraph", "Item", "Item", "Item", "Item", "Quote", "Code", "Table", "Rule", "Paragraph"),
            blocks.map { it::class.simpleName },
        )
        val heading = blocks[0] as MdBlock.Heading
        assertEquals(2, heading.level)
        assertEquals("Set it up", heading.inline.text)
        val second = blocks[3] as MdBlock.Item
        assertEquals("second\nmore of second", second.inline.text)
        assertFalse(second.ordered)
        assertEquals("2.", (blocks[5] as MdBlock.Item).marker)
        assertEquals("a quote\non two lines", (blocks[6] as MdBlock.Quote).inline.text)
        val code = blocks[7] as MdBlock.Code
        assertEquals("sh", code.lang)
        assertEquals("echo 'TS_PERMIT_CERT_UID=caddy'\nsystemctl restart tailscaled", code.text)
        assertTrue(code.closed)
        assertEquals(code.text, src.substring(code.textStart, code.textStart + code.text.length))
        val table = blocks[8] as MdBlock.Table
        assertEquals(listOf("Name", "Port"), table.header.map { it.text })
        assertEquals(listOf(listOf("caddy", "443"), listOf("madx", "7420")), table.rows.map { r -> r.map { it.text } })
        assertEquals(listOf(MdSpan(0, 4, MdStyle.BOLD)), table.rows[1][0].spans)
    }

    @Test
    fun inlineStylesAndSourceOffsets() {
        val src = "Use **bold** and *it* with `code` and [docs](https://caddyserver.com/docs)."
        val inline = one(src)
        assertEquals("Use bold and it with code and docs.", inline.text)
        assertEquals(
            listOf(
                MdSpan(4, 8, MdStyle.BOLD),
                MdSpan(13, 15, MdStyle.ITALIC),
                MdSpan(21, 25, MdStyle.CODE),
                MdSpan(30, 34, MdStyle.LINK, "https://caddyserver.com/docs"),
            ),
            inline.spans,
        )
        // every shown character points back at itself in the source
        inline.text.forEachIndexed { i, c -> assertEquals(c, src[inline.source[i]]) }
    }

    @Test
    fun nestedAndBareLinks() {
        val inline = one("See **[the docs](https://x.org/a)** or https://tailscale.com/kb/1153.")
        assertEquals("See the docs or https://tailscale.com/kb/1153.", inline.text)
        assertTrue(MdSpan(4, 12, MdStyle.BOLD) in inline.spans)
        assertTrue(MdSpan(4, 12, MdStyle.LINK, "https://x.org/a") in inline.spans)
        assertTrue(inline.spans.any { it.style == MdStyle.LINK && it.url == "https://tailscale.com/kb/1153" })
    }

    @Test
    fun leavesSnakeCaseAndStraySymbolsAlone() {
        assertEquals("snake_case_name and 2 * 3 * 4", one("snake_case_name and 2 * 3 * 4").text)
        assertTrue(one("snake_case_name and 2 * 3 * 4").spans.isEmpty())
        assertEquals("a *literal* star", one("a \\*literal\\* star").text)
    }

    @Test
    fun streamingNeverFlashesMarkers() {
        // closed: the markers stay as typed until the closer arrives
        assertEquals("half **bold", one("half **bold").text)
        // open (still streaming): already bold, no stars on screen
        val open = one("half **bold", open = true)
        assertEquals("half bold", open.text)
        assertEquals(listOf(MdSpan(5, 9, MdStyle.BOLD)), open.spans)
        assertEquals("run ls", one("run `ls", open = true).text)
        // a link whose address is still arriving shows only its words
        val link = one("see ([Caddy docs](https://caddyserver.com/doc", open = true)
        assertEquals("see (Caddy docs", link.text)
        assertEquals(listOf(MdSpan(5, 15, MdStyle.LINK, null)), link.spans)
        assertEquals("see Cad", one("see [Cad", open = true).text)
        // once done, the same text keeps its brackets (it never closed)
        assertEquals("see [Cad", one("see [Cad").text)
    }

    @Test
    fun openCodeFenceWhileStreaming() {
        val blocks = ChatMarkdown.parse("Here:\n\n```python\nconn.settimeout(10)\n")
        val code = blocks.last()
        assertIs<MdBlock.Code>(code)
        assertFalse(code.closed)
        assertEquals("python", code.lang)
        assertEquals("conn.settimeout(10)", code.text)
    }

    @Test
    fun paragraphsSplitOnBlankLines() {
        val blocks = ChatMarkdown.parse("One line\nsame paragraph\n\nNext one")
        assertEquals(listOf("One line\nsame paragraph", "Next one"), blocks.map { (it as MdBlock.Paragraph).inline.text })
        assertTrue(ChatMarkdown.parse("").isEmpty())
    }
}
