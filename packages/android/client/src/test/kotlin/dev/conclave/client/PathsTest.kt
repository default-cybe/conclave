package dev.conclave.client

import dev.conclave.client.logic.Paths
import dev.conclave.client.logic.ToolSummary
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** Paths as a session shows them; the same cases as packages/web/test/format.test.ts. */
class PathsTest {
    @Test
    fun insideTheSessionFolderRelativeToItElsewhereCutFromTheStart() {
        val cwd = "/tmp/conclave-demo-I67lq5/code/fernway-web"
        assertEquals("src/auth/redirect.ts", Paths.pathIn("$cwd/src/auth/redirect.ts", cwd))
        assertEquals("src/auth/redirect.ts", Paths.pathIn("$cwd/src/auth/redirect.ts", "$cwd/"))
        assertEquals("notes.md", Paths.pathIn("/home/kai/code/conclave/notes.md", "~/code/conclave"))
        assertEquals("/etc/caddy/Caddyfile", Paths.pathIn("/etc/caddy/Caddyfile", cwd))
        assertEquals("…/data/conf/site.yaml", Paths.pathIn("/var/lib/app/data/conf/site.yaml", cwd))
        assertEquals("~/notes/today.md", Paths.pathIn("/home/kai/notes/today.md", "~"))
        assertEquals("", Paths.pathIn(null, cwd))
        // a folder that only starts the same is not the session's
        assertEquals("…/code/fernway-website/x.ts", Paths.pathIn("/tmp/conclave-demo-I67lq5/code/fernway-website/x.ts", cwd))
    }

    @Test
    fun theProjectIsTheFolderName() {
        assertEquals("fernway-web", Paths.folderName("/tmp/conclave-demo-I67lq5/code/fernway-web"))
        assertEquals("conclave", Paths.folderName("~/code/conclave/"))
        assertEquals("", Paths.folderName("~"))
        assertEquals("", Paths.folderName("/home/kai"))
        assertEquals("", Paths.folderName("/"))
        assertEquals("", Paths.folderName(null))
    }

    @Test
    fun windowsPathsReadTheSameWay() {
        val cwd = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\conclave-demo-rJVZ5d\\code\\fernway-web"
        assertEquals("src/auth/redirect.ts", Paths.pathIn("$cwd\\src\\auth\\redirect.ts", cwd))
        assertEquals("src/main.ts", Paths.pathIn("c:\\code\\app\\src\\main.ts", "C:\\code\\app"))
        assertEquals("…/conf/site/site.yaml", Paths.pathIn("D:\\data\\conf\\site\\site.yaml", cwd))
        assertEquals("fernway-web", Paths.folderName("$cwd\\"))
        assertEquals("", Paths.folderName("C:\\Users\\sam"))
        assertEquals("~/notes/today.md", Paths.shortPath("C:\\Users\\sam\\notes\\today.md"))
        assertEquals("C:/code/app", Paths.slashes("C:\\code\\app"))
        // a POSIX name with a backslash in it stays as it is
        assertEquals("/tmp/a\\b", Paths.slashes("/tmp/a\\b"))
    }

    @Test
    fun theFileNameFromEitherForm() {
        assertEquals("redirect.ts", Paths.fileName("/tmp/x/src/auth/redirect.ts"))
        assertEquals("main.ts", Paths.fileName("C:\\code\\app\\src\\main.ts"))
        assertEquals("app", Paths.fileName("/code/app/"))
        assertEquals("notes.md", Paths.fileName("notes.md"))
    }

    @Test
    fun theFoldersGiveWayBeforeTheName() {
        assertEquals("src/auth/" to "redirect.ts", Paths.split("src/auth/redirect.ts"))
        assertEquals("" to "redirect.ts", Paths.split("redirect.ts"))
        assertEquals("…/conf/" to "site.yaml", Paths.split("…/conf/site.yaml"))
    }

    @Test
    fun toolRowsNameTheFileInTheSessionFolder() {
        val cwd = "/tmp/conclave-demo-w0FH5T/code/fernway-web"
        val read = buildJsonObject { put("file_path", "$cwd/src/auth/redirect.ts") }
        assertEquals("Read" to "src/auth/redirect.ts", ToolSummary.file("Read", read, cwd))
        assertEquals("Edit" to "src/auth/redirect.ts", ToolSummary.file("MultiEdit", read, cwd))
        assertEquals("Edit" to "nb.ipynb", ToolSummary.file("NotebookEdit", buildJsonObject { put("notebook_path", "$cwd/nb.ipynb") }, cwd))
        assertEquals("Read src/auth/redirect.ts", ToolSummary.of("Read", read, cwd))
        // no folder known: the end of the path
        assertEquals("Read …/src/auth/redirect.ts", ToolSummary.of("Read", read))
        assertNull(ToolSummary.file("Bash", buildJsonObject { put("command", "ls") }, cwd))
        assertNull(ToolSummary.file("Read", buildJsonObject { }, cwd))
    }
}
