package dev.conclave.client.logic

import dev.conclave.client.model.Device
import dev.conclave.client.model.LocationState
import dev.conclave.client.model.MatchLevel
import dev.conclave.client.model.MoveRefusal
import dev.conclave.client.model.MoveResult
import dev.conclave.client.model.SessionLocation

/** An action on the location banner. */
enum class BannerAction(val label: String) {
    /** Move to the device the hub suggests ("Run on macbook"). */
    RUN_ON_SUGGESTION("Run on"),
    /** Pick another online computer. */
    RUN_ON_OTHER("Run on another device"),
    WAIT("Wait"),
    CHOOSE_FOLDER("Choose folder"),
    CLONE_HERE("Clone here"),
    CONTINUE_WITHOUT_FILES("Continue without files"),
    /** After Continue without files: look for the project's folder again. */
    LOOK_AGAIN("Look again"),
    HIDE("Hide"),
    CHECK_AGAIN("Check again"),
    CONTINUE("Continue"),
    ;

    /** Wait, Continue and Hide set the line aside until the state changes. */
    val hides: Boolean get() = this == WAIT || this == CONTINUE || this == HIDE
}

/** What the app does with a move's answer. */
enum class MoveOutcome {
    /** The session runs there now. */
    MOVED,

    /** The device is not connected: say so, nothing to choose. */
    OFFLINE,

    /** No folder found: open Choose folder with the candidates. */
    CHOOSE,

    /** The chosen folder has another history: offer Use once and Use and remember. */
    MISMATCH,
}

/**
 * Folders across devices on the phone (docs/design/ROUND-IMPORT-PATHS-WORKFLOWS.md
 * 2.6 and 2.13): the banner's actions, the words for a match, and the path
 * helpers the Choose folder sheet uses. The same rules as the web's
 * LocationBanner.tsx and FolderChooser.tsx.
 */
object Locations {

    fun levelWord(level: MatchLevel): String = when (level) {
        MatchLevel.EXACT -> "exact match"
        MatchLevel.STRONG -> "strong match"
        MatchLevel.WEAK -> "name only"
        MatchLevel.NONE -> "no match"
        MatchLevel.MISMATCH -> "different history"
    }

    fun levelTone(level: MatchLevel): StateTone = when (level) {
        MatchLevel.EXACT, MatchLevel.STRONG -> StateTone.OK
        MatchLevel.WEAK, MatchLevel.NONE -> StateTone.DIM
        MatchLevel.MISMATCH -> StateTone.WARN
    }

    /**
     * A state the owner set aside (Wait, Continue, Hide) stays hidden until
     * something in it changes: the device, the folder, the state or its line.
     */
    fun hiddenKey(loc: SessionLocation): String = listOf(loc.sessionId, loc.device, loc.cwd, loc.state.name, loc.line.orEmpty()).joinToString(":")

    /** True when the banner has something to say for [sessionId]. */
    fun shows(loc: SessionLocation?, sessionId: String, hidden: Set<String>): Boolean =
        loc != null && loc.state != LocationState.OK && loc.sessionId == sessionId && hiddenKey(loc) !in hidden

    /** The banner's line: the hub's, or a plain one for its state when the hub sent none. */
    fun bannerLine(loc: SessionLocation): String = loc.line?.ifBlank { null } ?: when (loc.state) {
        LocationState.OK -> ""
        LocationState.OFFLINE -> "${loc.deviceName.ifBlank { loc.device }} is offline."
        LocationState.MISSING -> "The folder ${loc.cwd} is not on ${loc.deviceName.ifBlank { loc.device }}."
        LocationState.STALE -> loc.freshness?.line ?: "The copy on ${loc.deviceName.ifBlank { loc.device }} may be behind."
        LocationState.MISMATCH -> "The folder on ${loc.deviceName.ifBlank { loc.device }} has another git history."
    }

    /**
     * The banner's actions, the main one first.
     * - offline: Run on the suggested device (or another online computer), Wait
     * - missing: Choose folder, Run on the suggested device, Continue without
     *   files (or Look again and Hide once the session runs without them), Clone here
     * - stale: Continue, Check again
     * - mismatch: Choose folder
     */
    fun bannerActions(loc: SessionLocation, otherComputers: Int): List<BannerAction> = when (loc.state) {
        LocationState.OK -> emptyList()
        LocationState.OFFLINE -> buildList {
            when {
                loc.suggestion != null -> add(BannerAction.RUN_ON_SUGGESTION)
                otherComputers > 0 -> add(BannerAction.RUN_ON_OTHER)
            }
            add(BannerAction.WAIT)
        }
        LocationState.MISSING -> buildList {
            add(BannerAction.CHOOSE_FOLDER)
            if (loc.suggestion != null) add(BannerAction.RUN_ON_SUGGESTION)
            if (loc.exists == true) {
                add(BannerAction.LOOK_AGAIN)
                add(BannerAction.HIDE)
            } else {
                add(BannerAction.CONTINUE_WITHOUT_FILES)
            }
            if (!loc.cloneUrl.isNullOrBlank()) add(BannerAction.CLONE_HERE)
        }
        LocationState.STALE -> listOf(BannerAction.CONTINUE, BannerAction.CHECK_AGAIN)
        LocationState.MISMATCH -> listOf(BannerAction.CHOOSE_FOLDER)
    }

    /** The label on a button: "Run on macbook" for the suggestion. */
    fun actionLabel(action: BannerAction, loc: SessionLocation): String =
        if (action == BannerAction.RUN_ON_SUGGESTION) "Run on ${loc.suggestion?.deviceName?.ifBlank { null } ?: loc.suggestion?.device ?: "the other device"}" else action.label

    /** Computers a session can move to: online, not a phone, not where it is now. */
    fun moveTargets(devices: List<Device>, current: String): List<Device> =
        devices.filter { it.online && it.id != current && !isPhone(it) }
            .sortedWith(compareBy<Device> { it.id != "local" }.thenBy { it.name.ifBlank { it.id }.lowercase() })

    fun isPhone(d: Device): Boolean = d.info?.platform?.lowercase() in setOf("android", "ios")

    fun outcome(r: MoveResult): MoveOutcome = when {
        r.resolved -> MoveOutcome.MOVED
        r.reason == MoveRefusal.OFFLINE -> MoveOutcome.OFFLINE
        r.reason == MoveRefusal.MISMATCH -> MoveOutcome.MISMATCH
        else -> MoveOutcome.CHOOSE
    }

    /** Show a path with ~ for the device's home. */
    fun tildePath(path: String, home: String?): String {
        if (home.isNullOrBlank() || home == "/" || home == "~") return path
        val h = home.trimEnd('/')
        if (path == h) return "~"
        return if (path.startsWith("$h/")) "~" + path.substring(h.length) else path
    }

    /** A typed path back to a full one: "~/code" with home /home/kai is /home/kai/code. */
    fun expandTilde(typed: String, home: String?): String {
        val t = typed.trim()
        if (home.isNullOrBlank() || home == "~") return t
        val h = home.trimEnd('/')
        return when {
            t == "~" -> h.ifEmpty { "/" }
            t.startsWith("~/") -> h + t.substring(1)
            else -> t
        }
    }

    /** The folder above [path], or null at the top. Works for "/a/b", "~/a" and "C:/a". */
    fun parentOf(path: String): String? {
        val p = path.trimEnd('/')
        if (p.isEmpty()) return null
        val i = p.lastIndexOf('/')
        if (i < 0) return null
        if (i == 0) return "/"
        return p.substring(0, i)
    }

    fun baseName(path: String): String = path.trimEnd('/').substringAfterLast('/').ifEmpty { path }

    /** Where a clone goes: the project's own folder name under the chosen folder. */
    fun cloneInto(parent: String, projectName: String): String = parent.trimEnd('/') + "/" + projectName.trim().trim('/').ifEmpty { "project" }

    /**
     * The project's name for a clone. The session's cwd may be a folder
     * inside the project, so the project's own name comes first.
     */
    fun projectName(loc: SessionLocation?, cwd: String): String =
        loc?.projectName?.ifBlank { null } ?: baseName(cwd).ifBlank { "project" }

    /** Where Choose folder starts: the hub's best guess, then the device's first root, then its home. */
    fun browseStart(browseFrom: String?, roots: List<String>, home: String?): String {
        browseFrom?.ifBlank { null }?.let { return it }
        roots.firstOrNull()?.let { return expandTilde(it, home) }
        return home?.ifBlank { null } ?: "~"
    }
}
