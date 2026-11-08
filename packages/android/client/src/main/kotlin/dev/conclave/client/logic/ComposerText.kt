package dev.conclave.client.logic

/**
 * Keeps a composer's text field and its chat's draft in step. The draft (the
 * chat's ViewModel, kept on disk per chat by DraftStore) is the one source:
 * a field starts from it and is never restored from saved UI state. A saved
 * field outlived the clear after the first send from Home (the chat opened
 * before the box saw the empty draft) and pushed the sent prompt back up as
 * the next new chat's draft. One per composer on screen.
 */
class ComposerText {
    // what the field sent up and the draft has not echoed back yet: an echo is not a change from outside
    private val sent = ArrayDeque<String>()

    /** The field changed: true when its text should go up as the draft. */
    fun fieldChanged(text: String, draft: String): Boolean {
        if (text == draft) return false
        sent.addLast(text)
        if (sent.size > 64) sent.removeFirst()
        return true
    }

    /**
     * The draft changed: the text the field must show now (voice, a slash
     * command, cleared after Send), or null when it is the echo of the
     * field's own typing or already shown.
     */
    fun draftChanged(draft: String, field: String): String? {
        val echo = sent.indexOf(draft)
        if (echo >= 0) {
            repeat(echo + 1) { sent.removeFirst() }
            return null
        }
        if (draft == field) return null
        sent.clear()
        return draft
    }
}
