package dev.conclave.client

import dev.conclave.client.model.AcceptInviteRequest
import dev.conclave.client.model.InviteInfo
import dev.conclave.client.model.Me
import dev.conclave.client.model.MePatch
import dev.conclave.client.model.PairResponse

// Accounts (docs/design/ACCOUNTS.md), the same calls as me, updateMe, invite
// and acceptInvite in packages/core/src/client/index.ts. Managing people is
// the owner's, from the web app or `conclave people`.

/** Who this token is: name, role, and which keys their calls may use. A hub from before accounts answers 404: treat it as the owner. */
suspend fun ConclaveClient.me(): Me = get(p("api", "me"), Me.serializer())

/** Change your own name, email or default model. */
suspend fun ConclaveClient.updateMe(patch: MePatch) = sendUnit("PATCH", p("api", "me"), MePatch.serializer(), patch)

/** Who an invite link is for (no token sent). */
suspend fun ConclaveClient.invite(secret: String): InviteInfo =
    call("GET", p("api", "invite", secret), emptyMap(), null, InviteInfo.serializer(), auth = false)!!

/** Set a password from an invite link and sign in (no token sent). Good once. */
suspend fun ConclaveClient.acceptInvite(secret: String, password: String, name: String, platform: String = "android"): PairResponse {
    val body = json.encodeToString(AcceptInviteRequest.serializer(), AcceptInviteRequest(password, name, platform))
    return call("POST", p("api", "invite", secret), emptyMap(), body, PairResponse.serializer(), auth = false)!!
}

/** The secret in an invite link (https://hub/invite/<secret>), or null when it is not one. */
fun inviteSecretOf(link: String): String? = Regex("""/invite/([A-Za-z0-9_-]{20,64})/?(?:[?#].*)?$""").find(link.trim())?.groupValues?.get(1)
