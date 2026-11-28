package dev.conclave.client

import dev.conclave.client.model.SignInStart
import dev.conclave.client.model.SignInStatus
import dev.conclave.client.model.SubscriptionsStatus
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

// Provider keys and plan sign-in (Settings, Providers and Subscriptions), the
// same calls as setSecret, subscriptions ... refreshSubscriptionAccount in
// packages/core/src/client/index.ts. Keys go to the hub and never come back:
// the owner's to the hub's secrets, a member's to their own file (the hub
// refuses a member anything but a key for a provider on the hub).

/** Save a provider key ([value]) or remove it (null). */
suspend fun ConclaveClient.setProviderKey(provider: String, value: String?) =
    sendUnit(
        "PUT",
        p("api", "secrets"),
        buildJsonObject {
            put("kind", "providers")
            put("key", provider)
            put("value", value?.let(::JsonPrimitive) ?: JsonNull)
        },
    )

/** The providers with a key saved on the hub (secrets.providers) or one from its config or environment (secrets.keyed), from GET /api/config. */
fun providersWithKeys(secrets: JsonElement?): Set<String> {
    val o = secrets as? JsonObject ?: return emptySet()
    return listOf("providers", "keyed").flatMap { k -> (o[k] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull } }.toSet()
}

suspend fun ConclaveClient.subscriptions(): SubscriptionsStatus = get(p("api", "subscriptions"), SubscriptionsStatus.serializer())

/** Run the built-in CLIProxyAPI (the only change a member may make; how the hub reaches another one is the owner's, in the web app). */
suspend fun ConclaveClient.startBuiltinSubscriptions(): SubscriptionsStatus =
    sendJson("PUT", p("api", "subscriptions"), buildJsonObject { put("mode", "builtin") }, SubscriptionsStatus.serializer())

/** Start signing in to a plan: open [SignInStart.url], then poll [signInStatus]. */
suspend fun ConclaveClient.startSignIn(provider: String): SignInStart =
    sendJson("POST", p("api", "subscriptions", "signin"), buildJsonObject { put("provider", provider) }, SignInStart.serializer())

suspend fun ConclaveClient.signInStatus(state: String): SignInStatus = get(p("api", "subscriptions", "signin", state), SignInStatus.serializer())

/** The address the browser bar showed after the provider's localhost redirect failed to load. */
suspend fun ConclaveClient.finishSignIn(state: String, url: String): SignInStatus =
    sendJson("POST", p("api", "subscriptions", "signin", state, "callback"), buildJsonObject { put("url", url) }, SignInStatus.serializer())

suspend fun ConclaveClient.cancelSignIn(state: String): SignInStatus =
    sendJson("DELETE", p("api", "subscriptions", "signin", state), null, SignInStatus.serializer())

suspend fun ConclaveClient.removeSubscriptionAccount(name: String): SubscriptionsStatus =
    sendJson("DELETE", p("api", "subscriptions", "accounts", name), null, SubscriptionsStatus.serializer())

suspend fun ConclaveClient.refreshSubscriptionAccount(name: String): SubscriptionsStatus =
    sendJson("POST", p("api", "subscriptions", "accounts", name, "refresh"), null, SubscriptionsStatus.serializer())
