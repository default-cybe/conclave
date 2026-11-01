package dev.conclave.app.ui.friends

import androidx.lifecycle.viewModelScope
import dev.conclave.app.data.FriendMoments
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.errorText
import dev.conclave.client.ConclaveApiException
import dev.conclave.client.acceptFriend
import dev.conclave.client.acceptFriendInvite
import dev.conclave.client.acceptShare
import dev.conclave.client.cancelFriendMessage
import dev.conclave.client.confirmFriendKey
import dev.conclave.client.createFriendInvite
import dev.conclave.client.declineFriend
import dev.conclave.client.declineShare
import dev.conclave.client.forkShare
import dev.conclave.client.friend
import dev.conclave.client.friendInbox
import dev.conclave.client.friendOutbox
import dev.conclave.client.friendReachability
import dev.conclave.client.handoffShare
import dev.conclave.client.logic.FriendWords
import dev.conclave.client.logic.ShareWords
import dev.conclave.client.markFriendRead
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.ForkShareInput
import dev.conclave.client.model.FriendDto
import dev.conclave.client.model.FriendInvite
import dev.conclave.client.model.FriendInviteInput
import dev.conclave.client.model.FriendReachability
import dev.conclave.client.model.HandoffShareInput
import dev.conclave.client.model.OutboxItemDto
import dev.conclave.client.model.ReceivedShareDto
import dev.conclave.client.model.SentShareDto
import dev.conclave.client.model.Session
import dev.conclave.client.receivedShare
import dev.conclave.client.referenceShare
import dev.conclave.client.removeFriend
import dev.conclave.client.retryFriendMessage
import dev.conclave.client.sendFriendNote
import dev.conclave.client.setFriendGrants
import dev.conclave.client.syncFriend
import dev.conclave.client.unsendShare
import dev.conclave.client.verifyFriend
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * What the friends and shares screens ask the hub (the web's
 * features/friends/actions.ts), each keeping the shared lists current so a
 * screen never waits for the hub's event. Failures say the hub's words.
 */
class FriendsViewModel(hub: HubRepository) : HubViewModel(hub) {
    /** The actions running now, by key ("accept:<id>", "sync:<id>", "invite", "link", "note"). */
    val busy = MutableStateFlow<Set<String>>(emptySet())

    /** Whether friends reach this hub; null until the hub answers (or when it cannot say). */
    val reach = MutableStateFlow<FriendReachability?>(null)

    /** The invite made here, shown with its QR code. */
    val invite = MutableStateFlow<FriendInvite?>(null)
    val inviteError = MutableStateFlow<String?>(null)

    /** A request sent from a friend's link: its safety code shows under the field. */
    val requested = MutableStateFlow<FriendDto?>(null)

    private fun running(key: String, on: Boolean) = busy.update { if (on) it + key else it - key }

    /** Runs [block] under [key], saying what failed. True when it went through. */
    private fun run(key: String, block: suspend () -> Unit): Job = viewModelScope.launch {
        running(key, true)
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            say(errorText(e))
        } finally {
            running(key, false)
        }
    }

    // ---------------------------------------------------------------- Friends page

    fun loadReach() = viewModelScope.launch {
        try {
            reach.value = hub.api { it.friendReachability() }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // an older hub, or none yet: the page goes on without the line
        }
    }

    fun makeInvite(includeLan: Boolean) = viewModelScope.launch {
        running("invite", true)
        inviteError.value = null
        try {
            invite.value = hub.api { it.createFriendInvite(FriendInviteInput(includeLan = if (includeLan) true else null)) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            inviteError.value = errorText(e)
        } finally {
            running("invite", false)
        }
    }

    /** Use a friend's link: the hub checks their hub's key, then sends the request. */
    fun useLink(link: String, onSent: () -> Unit) = run("link") {
        val f = hub.api { it.acceptFriendInvite(link) }
        hub.putFriend(f)
        requested.value = f
        onSent()
    }

    fun acceptRequest(f: FriendDto) = run("accept:${f.id}") {
        val r = hub.api { it.acceptFriend(f.id) }
        hub.putFriend(r)
        say("You and ${f.name} are friends.")
        if (r.isActive) FriendMoments.friendAdded(r.id)
    }

    /** Decline a request in, or withdraw one out. Their hub is not told. */
    fun declineRequest(f: FriendDto, then: () -> Unit = {}) = run("decline:${f.id}") {
        hub.api { it.declineFriend(f.id) }
        hub.putFriend(f.copy(status = "removed"))
        say(if (f.asked) "Declined ${f.name}'s request. Their hub is not told." else "Withdrew the request to ${f.name}.")
        then()
    }

    fun markVerified(f: FriendDto, verified: Boolean) = run("verify:${f.id}") {
        hub.putFriend(hub.api { it.verifyFriend(f.id, verified) })
    }

    /** The switch moves at once; the hub's answer settles it. */
    fun setReceiveShares(f: FriendDto, on: Boolean) = run("grants:${f.id}") {
        hub.putFriend(f.copy(grants = f.grants.copy(receiveShares = on)))
        try {
            hub.putFriend(hub.api { it.setFriendGrants(f.id, on) })
        } catch (e: Exception) {
            hub.putFriend(f)
            throw e
        }
    }

    fun removeFriend(f: FriendDto, then: () -> Unit = {}) = run("remove:${f.id}") {
        hub.api { it.removeFriend(f.id) }
        hub.putFriend(f.copy(status = "removed"))
        say("Removed ${f.name}. Their hub is asked to stop too.")
        then()
    }

    fun confirmKey(f: FriendDto) = run("key:${f.id}") {
        hub.putFriend(hub.api { it.confirmFriendKey(f.id) })
        say("Took ${f.name}'s new key. Compare the new safety code with them.")
    }

    /** Send what waits and fetch what their hub holds, now. */
    fun sync(f: FriendDto) = run("sync:${f.id}") {
        hub.putFriend(hub.api { it.syncFriend(f.id) })
    }

    // ---------------------------------------------------------------- One friend

    /** A friend the shared list does not hold (removed): asked of the hub. Null when it does not know them. */
    val fetched = MutableStateFlow<FriendDto?>(null)
    val missing = MutableStateFlow(false)

    /** Notes this hub sent the friend open on screen, current with the hub's events. */
    val outbox = MutableStateFlow<List<OutboxItemDto>>(emptyList())
    val outboxLoaded = MutableStateFlow(false)
    private var watching: Job? = null

    fun fetchFriend(id: String) = viewModelScope.launch {
        try {
            fetched.value = hub.api { it.friend(id) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (e is ConclaveApiException && e.status == 404) missing.value = true else say(errorText(e))
        }
    }

    private suspend fun reloadOutbox(id: String) {
        try {
            outbox.value = hub.api { it.friendOutbox(id) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // the thread shows what it has
        } finally {
            outboxLoaded.value = true
        }
    }

    /**
     * The friend's notes both ways: their older notes too (the shared list
     * holds the newest of every friend), then the outbox again on each of
     * the hub's events for them and every few seconds while a note waits.
     */
    fun openThread(id: String) {
        if (watching != null) return
        watching = viewModelScope.launch {
            launch {
                try {
                    hub.api { it.friendInbox(id) }.forEach { hub.putFriendNote(it) }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                }
            }
            launch { reloadOutbox(id) }
            launch {
                hub.events.collect { e ->
                    val mine = (e is EngineEvent.FriendUpdated && e.friend.id == id) || (e is EngineEvent.FriendMessage && e.message.friendId == id)
                    if (mine) reloadOutbox(id)
                }
            }
            while (isActive) {
                delay(4_000)
                if (outbox.value.any { it.type == "note" && it.state == "queued" }) reloadOutbox(id)
            }
        }
    }

    fun sendNote(f: FriendDto, text: String, onSent: () -> Unit) = run("note") {
        val item = hub.api { it.sendFriendNote(f.id, text) }
        outbox.update { list -> list.filterNot { it.id == item.id } + item }
        if (item.state == "queued") hub.friends.value.firstOrNull { it.id == f.id }?.let { hub.putFriend(it.copy(queued = it.queued + 1)) }
        onSent()
    }

    fun retryNote(id: String, friendId: String) = run("retry:$id") {
        hub.api { it.retryFriendMessage(id) }
        reloadOutbox(friendId)
    }

    fun cancelNote(id: String, friendId: String) = run("cancel:$id") {
        hub.api { it.cancelFriendMessage(id) }
        reloadOutbox(friendId)
    }

    /** What is on screen is read, here and on the owner's other devices. */
    private var marked = ""

    fun markRead(f: FriendDto, targets: List<String>) {
        val key = targets.joinToString(",")
        if (key.isEmpty() || key == marked) return
        marked = key
        viewModelScope.launch {
            // the newest note moves the friend's mark; each share card is read by its id
            var moved = false
            for (t in targets) {
                try {
                    hub.putFriend(hub.api { it.markFriendRead(f.id, t) })
                    moved = true
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // gone meanwhile, or a hub from before read marks: the next look tries again
                }
            }
            if (moved) hub.reloadReceivedShares() else marked = ""
        }
    }

    // ---------------------------------------------------------------- Shares

    /** Accept: the hub fetches the share from the friend's hub and checks its signature. */
    fun acceptShare(s: ReceivedShareDto, quiet: Boolean = false) = viewModelScope.launch {
        running("accept:${s.id}", true)
        hub.putReceivedShare(s.copy(state = "fetching", error = null))
        try {
            val r = hub.api { it.acceptShare(s.id) }
            hub.putReceivedShare(r)
            if (!quiet) say("Fetched '${r.title}' from ${r.friendName}'s hub. Its signature checks out against their key.")
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // the hub keeps the reason on the card too
            val back = try {
                hub.api { it.receivedShare(s.id) }
            } catch (_: Exception) {
                s.copy(error = errorText(e))
            }
            hub.putReceivedShare(back)
            say(errorText(e))
        } finally {
            running("accept:${s.id}", false)
        }
    }

    fun declineShare(s: ReceivedShareDto) = run("decline:${s.id}") {
        hub.putReceivedShare(hub.api { it.declineShare(s.id) })
        say("Declined '${s.title}'. ${s.friendName}'s hub is not told.")
    }

    /** Unsend: each friend's hub is asked to delete its copy. */
    fun unsendShare(s: SentShareDto) = run("unsend:${s.id}") {
        val r = hub.api { it.unsendShare(s.id) }
        hub.putSentShare(r)
        val names = r.recipients.map { it.friendName }
        say("Unsent '${r.title}'." + if (names.isEmpty()) "" else " ${ShareWords.namesWords(names)} ${if (names.size == 1) "is" else "are"} asked to delete the copy.")
    }

    /** After a fork, handoff or reference: the session is in the list, and the card lists it. */
    private suspend fun madeFrom(shareId: String, session: Session) {
        hub.putSession(session)
        try {
            hub.putReceivedShare(hub.api { it.receivedShare(shareId) })
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }

    fun forkShare(s: ReceivedShareDto, input: ForkShareInput, onDone: (Session) -> Unit) = run("fork:${s.id}") {
        val session = hub.api { it.forkShare(s.id, input) }
        madeFrom(s.id, session)
        onDone(session)
    }

    fun handoffShare(s: ReceivedShareDto, input: HandoffShareInput, onDone: (Session) -> Unit) = run("handoff:${s.id}") {
        val session = hub.api { it.handoffShare(s.id, input) }
        madeFrom(s.id, session)
        onDone(session)
    }

    fun referenceShare(s: ReceivedShareDto) = run("reference:${s.id}") {
        val session = hub.api { it.referenceShare(s.id) }
        madeFrom(s.id, session)
        say("Kept as a reference. Your agents can find it in past chats, marked as ${s.friendName}'s.")
    }
}
