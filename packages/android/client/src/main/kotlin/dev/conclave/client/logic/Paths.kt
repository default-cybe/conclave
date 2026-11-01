package dev.conclave.client.logic

/*
 * Paths as a session shows them, the same rules as packages/web/src/lib/format.ts
 * (slashes, shortPath, pathIn, fileName, folderName): a file relative to the
 * session's folder, the project by its folder's name, ~ for home. Windows paths
 * read the same way.
 */
object Paths {

    private val DRIVE = Regex("""^[A-Za-z]:[\\/]""")

    /** /home/sam, /Users/sam and C:/Users/sam. */
    private val HOME = Regex("""^(/(home|Users)|[A-Za-z]:/Users)/[^/]+""")

    /** A Windows path with forward slashes ("C:\Users\sam\x" is "C:/Users/sam/x"), so one set of rules reads both. */
    fun slashes(p: String): String =
        if (DRIVE.containsMatchIn(p) || ('\\' in p && '/' !in p)) p.replace('\\', '/') else p

    /** The home folder as ~. */
    private fun home(p: String): String = HOME.replaceFirst(slashes(p), "~")

    private fun homeRel(p: String): String = home(p).trimEnd('/')

    /** Last path segments, with ~ for home: "…/data/conf/site.yaml". */
    fun shortPath(p: String?, segments: Int = 2): String {
        if (p.isNullOrEmpty()) return ""
        val h = home(p)
        val parts = h.split('/').filter { it.isNotEmpty() }
        if (parts.size <= segments + 1) return h
        return "…/" + parts.takeLast(segments).joinToString("/")
    }

    /**
     * A file as a session talks about it: relative to the session's folder
     * when it is inside it ("src/auth/redirect.ts"), else as [shortPath]
     * gives it ("…/conclave/notes.md"). The file name is always there.
     * Windows paths compare without case, as Windows does.
     */
    fun pathIn(p: String?, cwd: String?): String {
        if (p.isNullOrEmpty()) return ""
        val base = if (cwd.isNullOrEmpty()) "" else homeRel(cwd)
        val full = homeRel(p)
        val drive = cwd != null && DRIVE.containsMatchIn(cwd)
        fun fold(s: String) = if (drive) s.lowercase() else s
        if (base.isNotEmpty() && base != "~" && fold(full).startsWith(fold(base) + "/")) return full.substring(base.length + 1)
        return shortPath(p, 3)
    }

    /** The file's own name, from a path in either form ("redirect.ts"). */
    fun fileName(p: String): String = slashes(p).trimEnd('/').substringAfterLast('/').ifEmpty { p }

    /** The last part of a folder, the name people use for the project ("fernway-web"). Empty for the home folder. */
    fun folderName(cwd: String?): String {
        if (cwd.isNullOrEmpty() || cwd == "/") return ""
        val rel = homeRel(cwd)
        return if (rel == "~") "" else rel.substringAfterLast('/')
    }

    /**
     * A shown path cut before its file name: ("src/auth/", "redirect.ts").
     * On a narrow row the folders give way first, the name last.
     */
    fun split(path: String): Pair<String, String> {
        val cut = path.lastIndexOf('/') + 1
        return path.substring(0, cut) to path.substring(cut)
    }
}
