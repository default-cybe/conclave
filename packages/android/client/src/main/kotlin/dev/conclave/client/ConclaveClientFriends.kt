package dev.conclave.client

import dev.conclave.client.model.ApplyShareInput
import dev.conclave.client.model.ApplyShareResult
import dev.conclave.client.model.ApplySharePlan
import dev.conclave.client.model.ForkShareInput
import dev.conclave.client.model.FriendDto
import dev.conclave.client.model.FriendInvite
import dev.conclave.client.model.FriendInviteInput
import dev.conclave.client.model.FriendReachability
import dev.conclave.client.model.HandoffDraft
import dev.conclave.client.model.HandoffShareInput
import dev.conclave.client.model.InboxItemDto
import dev.conclave.client.model.OutboxItemDto
import dev.conclave.client.model.ReceivedShareDto
import dev.conclave.client.model.SendShareInput
import dev.conclave.client.model.SentShareDto
import dev.conclave.client.model.Session
import dev.conclave.client.model.SharePreview
import dev.conclave.client.model.ShareViewDto
import dev.conclave.client.model.UpdateShareInput
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// Friends and shares (docs/design/FRIENDS.md, docs/DESIGN.md 27), the same
// calls as friends ... applyShare in packages/core/src/client/index.ts.

// ----- friends -----

suspend fun ConclaveClient.friends(): List<FriendDto> = get(p("api", "friends"), ListSerializer(FriendDto.serializer()))

suspend fun ConclaveClient.friend(id: String): FriendDto = get(p("api", "friends", id), FriendDto.serializer())

/** Can a friend's hub reach this one: the remote access mode and the address friends get. */
suspend fun ConclaveClient.friendReachability(): FriendReachability = get(p("api", "friends", "reachability"), FriendReachability.serializer())

/** A one time link and QR code, valid 24 hours. */
suspend fun ConclaveClient.createFriendInvite(input: FriendInviteInput = FriendInviteInput()): FriendInvite =
    send("POST", p("api", "friends", "invites"), FriendInviteInput.serializer(), input, FriendInvite.serializer())

/** Use a friend's link: the hub checks their hub's key, then sends the request. */
suspend fun ConclaveClient.acceptFriendInvite(link: String, name: String? = null): FriendDto = sendJson(
    "POST", p("api", "friends", "accept"),
    buildJsonObject {
        put("link", link)
        if (name != null) put("name", name)
    },
    FriendDto.serializer(),
)

/** Accept a pending request from another hub. */
suspend fun ConclaveClient.acceptFriend(id: String): FriendDto = sendJson("POST", p("api", "friends", id, "accept"), null, FriendDto.serializer())

/** Decline a request in, or withdraw one out. Their hub is not told. */
suspend fun ConclaveClient.declineFriend(id: String) = sendUnit("POST", p("api", "friends", id, "decline"))

/** The owner compared the safety code (false takes the mark away). */
suspend fun ConclaveClient.verifyFriend(id: String, verified: Boolean = true): FriendDto =
    sendJson("POST", p("api", "friends", id, "verify"), buildJsonObject { put("verified", verified) }, FriendDto.serializer())

/** Notes and shares from this friend land in the Inbox, or are turned away. */
suspend fun ConclaveClient.setFriendGrants(id: String, receiveShares: Boolean): FriendDto =
    sendJson("PUT", p("api", "friends", id, "grants"), buildJsonObject { put("receiveShares", receiveShares) }, FriendDto.serializer())

suspend fun ConclaveClient.renameFriend(id: String, name: String): FriendDto =
    sendJson("PATCH", p("api", "friends", id), buildJsonObject { put("name", name) }, FriendDto.serializer())

/** Take the new key a blocked friend's hub showed. */
suspend fun ConclaveClient.confirmFriendKey(id: String): FriendDto = sendJson("POST", p("api", "friends", id, "confirm-key"), null, FriendDto.serializer())

/** Send what waits and fetch what the friend's hub holds for this one, now. */
suspend fun ConclaveClient.syncFriend(id: String): FriendDto = sendJson("POST", p("api", "friends", id, "sync"), null, FriendDto.serializer())

/** Stop being friends: the outbox is cancelled and the friend's hub is told, best effort. */
suspend fun ConclaveClient.removeFriend(id: String) = sendUnit("DELETE", p("api", "friends", id))

suspend fun ConclaveClient.sendFriendNote(id: String, text: String): OutboxItemDto =
    sendJson("POST", p("api", "friends", id, "notes"), buildJsonObject { put("text", text) }, OutboxItemDto.serializer())

/** Mark a friend's notes and share cards read up to an id (a note's or a received share's), or all of them. */
suspend fun ConclaveClient.markFriendRead(id: String, upTo: String? = null): FriendDto =
    sendJson("POST", p("api", "friends", id, "read"), buildJsonObject { if (upTo != null) put("upTo", upTo) }, FriendDto.serializer())

suspend fun ConclaveClient.friendOutbox(friend: String? = null): List<OutboxItemDto> =
    get(p("api", "friends", "outbox"), ListSerializer(OutboxItemDto.serializer()), mapOf("friend" to friend))

suspend fun ConclaveClient.friendInbox(friend: String? = null): List<InboxItemDto> =
    get(p("api", "friends", "inbox"), ListSerializer(InboxItemDto.serializer()), mapOf("friend" to friend))

suspend fun ConclaveClient.retryFriendMessage(id: String): OutboxItemDto =
    sendJson("POST", p("api", "friends", "outbox", id, "retry"), null, OutboxItemDto.serializer())

suspend fun ConclaveClient.cancelFriendMessage(id: String): OutboxItemDto =
    call("DELETE", p("api", "friends", "outbox", id), emptyMap(), null, OutboxItemDto.serializer())!!

// ----- shares -----

/** The review before sending: what goes, and what the sanitizer took out, item by item. [input] has no friends. */
suspend fun ConclaveClient.previewShare(input: SendShareInput): SharePreview =
    send("POST", p("api", "shares", "preview"), SendShareInput.serializer(), input.copy(to = null, title = null, note = null), SharePreview.serializer())

/** Send a chat or session to friends: signed, sealed for each, fetched only when they accept. */
suspend fun ConclaveClient.sendShare(input: SendShareInput): SentShareDto =
    send("POST", p("api", "shares"), SendShareInput.serializer(), input, SentShareDto.serializer())

suspend fun ConclaveClient.sentShares(): List<SentShareDto> = get(p("api", "shares", "sent"), ListSerializer(SentShareDto.serializer()))

suspend fun ConclaveClient.sentShare(id: String): SentShareDto = get(p("api", "shares", "sent", id), SentShareDto.serializer())

/** A new revision of the same share, from the session as it is now. */
suspend fun ConclaveClient.updateShare(id: String, input: UpdateShareInput = UpdateShareInput()): SentShareDto =
    send("POST", p("api", "shares", "sent", id, "update"), UpdateShareInput.serializer(), input, SentShareDto.serializer())

/** Unsend: the friends' hubs are asked to delete their copy. */
suspend fun ConclaveClient.unsendShare(id: String): SentShareDto = call("DELETE", p("api", "shares", "sent", id), emptyMap(), null, SentShareDto.serializer())!!

suspend fun ConclaveClient.receivedShares(): List<ReceivedShareDto> = get(p("api", "shares", "received"), ListSerializer(ReceivedShareDto.serializer()))

suspend fun ConclaveClient.receivedShare(id: String): ReceivedShareDto = get(p("api", "shares", "received", id), ReceivedShareDto.serializer())

/** Fetch the share from the friend's hub and check its signature. Nothing is fetched before this. */
suspend fun ConclaveClient.acceptShare(id: String): ReceivedShareDto = sendJson("POST", p("api", "shares", "received", id, "accept"), null, ReceivedShareDto.serializer())

suspend fun ConclaveClient.declineShare(id: String): ReceivedShareDto = sendJson("POST", p("api", "shares", "received", id, "decline"), null, ReceivedShareDto.serializer())

/** Read only, as quoted data from the friend's hub. */
suspend fun ConclaveClient.viewShare(id: String): ShareViewDto = get(p("api", "shares", "received", id, "view"), ShareViewDto.serializer())

/** Continue as a fork on this hub's models. The first turn runs guarded. */
suspend fun ConclaveClient.forkShare(id: String, input: ForkShareInput = ForkShareInput()): Session =
    send("POST", p("api", "shares", "received", id, "fork"), ForkShareInput.serializer(), input, Session.serializer())

suspend fun ConclaveClient.handoffDraft(id: String): HandoffDraft = get(p("api", "shares", "received", id, "handoff"), HandoffDraft.serializer())

/** A fresh session that starts from the brief. */
suspend fun ConclaveClient.handoffShare(id: String, input: HandoffShareInput): Session =
    send("POST", p("api", "shares", "received", id, "handoff"), HandoffShareInput.serializer(), input, Session.serializer())

/** Keep it as a read only reference this hub's agents can read like a past chat. */
suspend fun ConclaveClient.referenceShare(id: String): Session = sendJson("POST", p("api", "shares", "received", id, "reference"), null, Session.serializer())

/** Check where the share's code would land. Nothing changes until applyShare with the plan's id. */
suspend fun ConclaveClient.planApplyShare(id: String, input: ApplyShareInput): ApplySharePlan =
    send("POST", p("api", "shares", "received", id, "apply-plan"), ApplyShareInput.serializer(), input, ApplySharePlan.serializer())

/** Approve a plan: the code lands on its new branch. No hook or script from the share runs. */
suspend fun ConclaveClient.applyShare(id: String, planId: String): ApplyShareResult =
    sendJson("POST", p("api", "shares", "received", id, "apply"), buildJsonObject { put("planId", planId) }, ApplyShareResult.serializer())
