package dev.conclave.client.model

import kotlinx.serialization.Serializable

// Accounts: mirrors packages/core/src/client/people.ts (docs/design/ACCOUNTS.md).
// Several people can share one hub, each with their own chats, memory, keys
// and devices. Roles and sources stay strings, so a newer value still decodes.

/** Who a token signs in as. Pairing and login replies carry it. */
@Serializable
data class AccountRef(
    val id: String = "owner",
    val name: String = "owner",
    /** "owner" or "member". */
    val role: String = "owner",
) {
    val isOwner: Boolean get() = role == "owner"
}

/** One provider as this account may use it. */
@Serializable
data class ProviderAccess(
    val provider: String,
    val name: String = provider,
    /** Whose key a call uses now: "hub", "own" or "none". */
    val source: String = "none",
    /** The owner lets this person use the hub's key. */
    val hubAllowed: Boolean = false,
    /** The person saved a key of their own. */
    val ownKey: Boolean = false,
    /** Monthly cap on the hub's key, in USD. Null: no cap. */
    val monthlyUsd: Double? = null,
    /** Spent on the hub's key this month. */
    val spentUsd: Double = 0.0,
    /** When the month's budget starts again (epoch ms). */
    val resetsAt: Long = 0,
) {
    /** The budget on the hub's key is spent: calls stop until [resetsAt]. */
    val overBudget: Boolean get() = source == "hub" && monthlyUsd != null && spentUsd >= monthlyUsd
}

@Serializable
data class MePreferences(
    val defaultModel: String? = null,
    val smallModel: String? = null,
    val defaultAgent: String? = null,
    val importWatch: Boolean = false,
)

/** GET /api/me: who this token is and what they may use. */
@Serializable
data class Me(
    val id: String = "owner",
    val name: String = "owner",
    val role: String = "owner",
    val email: String? = null,
    /** More than one person on this hub. */
    val people: Boolean = false,
    /** The hub's own computer may run this person's tools (the owner only). */
    val hubMachine: Boolean = true,
    val passwordSet: Boolean = false,
    val providers: List<ProviderAccess> = emptyList(),
    val preferences: MePreferences = MePreferences(),
) {
    val isOwner: Boolean get() = role == "owner"
    val ref: AccountRef get() = AccountRef(id, name, role)
}

/** PATCH /api/me. Null fields are left out; an empty string clears a default. */
@Serializable
data class MePatch(
    val name: String? = null,
    val email: String? = null,
    val defaultModel: String? = null,
)

/** GET /api/invite/:secret: who an invite is for, before they set a password. */
@Serializable
data class InviteInfo(val name: String = "", val hub: String = "", val expiresAt: Long = 0)

/** POST /api/invite/:secret: their password, and the name this device pairs as. */
@Serializable
data class AcceptInviteRequest(val password: String, val name: String, val platform: String)
