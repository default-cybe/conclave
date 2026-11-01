package dev.conclave.client.update

/*
 * When the app's own update asks (docs/DESIGN.md, Updates): a dialog at app
 * start, "Conclave X.Y.Z is ready", with Update now, Skip this version and
 * Don't show at startup. Skip hides the version until a newer one. With the
 * dialog off, the update shows as a dot on the side panel's account row and
 * in Settings, About, where a switch turns the dialog on again.
 */
object UpdatePrompt {

    /** The dialog's title. */
    fun title(version: String): String = "Conclave $version is ready"

    /** [version] was skipped: it is the skipped one, or older. A newer one asks again. */
    fun isSkipped(version: String, skipped: String?): Boolean =
        !skipped.isNullOrBlank() && AppUpdates.compareVersions(version, skipped) <= 0

    /**
     * The dialog shows: a version is ready ([version] not null), the dialog is
     * on ([atStartup]), the version was not skipped, and it has not shown
     * since the app started ([shown]).
     */
    fun showDialog(version: String?, skipped: String?, atStartup: Boolean, shown: Boolean = false): Boolean =
        version != null && atStartup && !shown && !isSkipped(version, skipped)

    /** The dot on the account row: a version is ready and was not skipped. */
    fun showDot(version: String?, skipped: String?): Boolean =
        version != null && !isSkipped(version, skipped)

    /**
     * Open the system installer by itself: an install waited for the install
     * permission ([pending]), the checked APK is still there, and Android now
     * allows this app to install apps.
     */
    fun resumeInstall(pending: Boolean, fileExists: Boolean, canInstall: Boolean): Boolean =
        pending && fileExists && canInstall

    private val HEADING = Regex("""^#{1,6}\s*""")
    private val MARKER = Regex("""^(?:[-*+]|\d+[.)])\s+""")
    private val LINK = Regex("""\[([^\]]+)]\([^)]*\)""")

    /**
     * The short what's new line under the title: the first line of the
     * release notes that is not a heading (the first heading when there is
     * nothing else), without markdown, at most [max] characters. Null when
     * the notes are empty.
     */
    fun whatsNew(notes: String, max: Int = 120): String? {
        val lines = notes.lines().map { it.trim() }.filter { it.isNotEmpty() }
        val pick = lines.firstOrNull { !HEADING.containsMatchIn(it) } ?: lines.firstOrNull() ?: return null
        val plain = pick
            .replace(HEADING, "")
            .removePrefix(">").trim()
            .replace(MARKER, "")
            .replace(LINK, "$1")
            .replace("**", "")
            .replace("__", "")
            .replace("`", "")
            .replace(Regex("""\s+"""), " ")
            .trim()
        if (plain.isEmpty()) return null
        if (plain.length <= max) return plain
        val cut = plain.substring(0, max - 1)
        val space = cut.lastIndexOf(' ')
        return (if (space > max / 2) cut.substring(0, space) else cut).trimEnd(',', ';', ':', '.', ' ') + "…"
    }
}
