package dev.conclave.client

import dev.conclave.client.logic.ComposerText
import dev.conclave.client.logic.DraftStore
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The composer's field and its chat's draft (ChatComposer on Android). The
 * owner's report: "on android, still the old prompt shows up to new chat".
 * Each chat, and the new chat box, has its own draft; a field starts from it.
 */
class ComposerTextTest {
    /** One composer on screen: a field that starts from its chat's draft, as ChatComposer does now. */
    private class Box(var draft: String) {
        val sync = ComposerText()
        var field = draft

        fun type(text: String) {
            field = text
            if (sync.fieldChanged(text, draft)) draft = text
            sync.draftChanged(draft, field)?.let { field = it }
        }

        fun draftSet(text: String) {
            draft = text
            sync.draftChanged(draft, field)?.let { field = it }
        }
    }

    @Test
    fun aNewChatStartsEmptyAfterTheLastOneWasSent() {
        // the new chat box on Home: typed, then sent; the chat opened before the box saw the clear
        val home = Box("")
        home.type("prompt A")
        assertEquals("prompt A", home.draft)
        home.draft = "" // ChatHomeViewModel.start(): draft cleared and onOpen in the same call
        // New chat: Home comes back, the field starts from the draft
        val again = Box(home.draft)
        assertEquals("", again.field)
        again.type(again.field)
        assertEquals("", again.draft)
    }

    @Test
    fun aFieldRestoredWithTheSentTextWouldPushItBackUp() {
        // the bug: the field was saved UI state and came back holding the sent prompt while the draft was empty
        val sync = ComposerText()
        assertTrue(sync.fieldChanged("prompt A", ""))
        // a field that starts from its draft has nothing to push
        assertFalse(ComposerText().fieldChanged("", ""))
    }

    @Test
    fun sendingClearsTheField() {
        val chat = Box("")
        chat.type("hello")
        chat.draftSet("")
        assertEquals("", chat.field)
        assertNull(chat.sync.draftChanged("", ""))
    }

    @Test
    fun typingInChatAOrANewChatNeverReachesChatB() {
        val store = DraftStore(Files.createTempDirectory("drafts").toFile())
        val a = Box(store.text("ses_a"))
        a.type("for chat A")
        store.saveText("ses_a", a.draft)
        // the new chat box is held in memory by Home, never under a session's key
        val fresh = Box("")
        fresh.type("for a new chat")
        val b = Box(store.text("ses_b"))
        assertEquals("", b.field)
        assertEquals("", b.draft)
        assertEquals("for chat A", store.text("ses_a"))
    }
}
