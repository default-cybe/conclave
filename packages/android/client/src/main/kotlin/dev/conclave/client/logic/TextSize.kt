package dev.conclave.client.logic

/**
 * Text size (Settings, Appearance; the web app's lib/textSize.ts): the
 * transcript's text (replies, your messages, tool rows, code) at a scale of
 * the default, where a reply reads 16sp as in Claude's Android app. The
 * screen around the transcript stays as it is. docs/design/CHAT-AND-MOTION.md 6.5.
 */
enum class TextSize(val wire: String, val label: String, val scale: Float) {
    SMALL("small", "Small", 0.875f),
    DEFAULT("default", "Default", 1f),
    LARGE("large", "Large", 1.125f),
    LARGER("larger", "Larger", 1.25f);

    /** A size in sp at this scale: the chat body's 16 is 14, 16, 18 or 20. */
    fun sp(base: Float): Float = base * scale

    /** The transcript's font scale: the phone's own (Settings, Display) times this one. */
    fun fontScale(system: Float): Float = system * scale

    companion object {
        /** A reply at Default, in sp (ConclaveType.chat). */
        const val CHAT_BODY = 16f

        /** The saved choice; none yet, or one this version does not know, is the default. */
        fun from(wire: String?): TextSize = entries.firstOrNull { it.wire == wire } ?: DEFAULT
    }
}
