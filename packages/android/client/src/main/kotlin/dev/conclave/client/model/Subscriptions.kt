package dev.conclave.client.model

import kotlinx.serialization.Serializable

// Subscription sign-in through the hub's CLIProxyAPI: mirrors
// packages/core/src/client/subscriptions.ts. States and flows stay strings,
// so a newer value still decodes. Tokens never leave the hub.

/** One plan the running CLIProxyAPI can sign in to (claude, codex, antigravity, ...). */
@Serializable
data class SubscriptionProvider(
    val id: String,
    val name: String = id,
    /** What signing in gives, in words ("Claude Pro or Max"). */
    val plan: String = "",
    /** "redirect" (ends on a localhost page) or "device" (a code typed on the provider's page). */
    val flow: String = "redirect",
    val accounts: Int = 0,
    /** Shown under "More" rather than with the main rows. */
    val more: Boolean = false,
)

/** A signed in account. state: active, refreshing, disabled, unavailable, error or unknown. */
@Serializable
data class SubscriptionAccount(
    val name: String,
    val provider: String = "",
    val providerName: String = provider,
    val label: String? = null,
    val state: String = "unknown",
    val detail: String? = null,
    val canRefresh: Boolean = false,
    val updatedAt: Long? = null,
)

@Serializable
data class SubscriptionModel(val id: String = "", val ref: String = "", val name: String = "")

@Serializable
data class SubscriptionModelGroup(val account: String = "", val label: String = "", val models: List<SubscriptionModel> = emptyList())

/** GET /api/subscriptions: the owner's hub-wide CLIProxyAPI, or a member's own. */
@Serializable
data class SubscriptionsStatus(
    /** off, builtin or external */
    val mode: String = "off",
    /** off, installing, starting, on or error */
    val state: String = "off",
    val since: Long = 0,
    val detail: String? = null,
    val error: String? = null,
    val version: String? = null,
    /** Sign-in and the accounts list work here. */
    val management: Boolean = false,
    val managementNote: String? = null,
    val providers: List<SubscriptionProvider> = emptyList(),
    val accounts: List<SubscriptionAccount> = emptyList(),
    val models: List<SubscriptionModelGroup> = emptyList(),
    /** This request came from the hub's own computer. */
    val local: Boolean = false,
)

/** POST /api/subscriptions/signin. */
@Serializable
data class SignInStart(
    val state: String,
    val provider: String = "",
    /** The provider's sign-in page. */
    val url: String,
    val flow: String = "redirect",
    val userCode: String? = null,
    val expiresAt: Long = 0,
    /** The hub catches the localhost redirect itself; false: paste the address from the browser bar. */
    val caught: Boolean = false,
    val callbackHost: String? = null,
)

/** status: wait, ok, error or cancelled. */
@Serializable
data class SignInStatus(
    val state: String = "",
    val status: String = "wait",
    val error: String? = null,
    val account: SubscriptionAccount? = null,
)
