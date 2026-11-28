package dev.conclave.client.logic

import dev.conclave.client.model.MemberMemory
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull

/** One model tier (web defaults.tsx TIERS): config key models.tiers.<id>. */
data class Tier(val id: String, val label: String, val help: String, val empty: String)

/** One limit cell (web LIMIT_FIELDS): config key limits.<kind>.<id>, with the hub's range (core config/schema.ts CONFIG_NUMBERS). */
data class LimitField(val id: String, val label: String, val unit: String, val max: Double, val fraction: Boolean = false)

/**
 * Settings, Defaults on the phone (web settings/defaults.tsx for the owner,
 * member-defaults.tsx for a member): words, config paths and number checks.
 * The hub checks every value again: PATCH /api/config (the owner's) range
 * checks numbers and model refs; PATCH /api/me keeps a member's on their account.
 */
object HubDefaults {
    val TIERS = listOf(
        Tier("fast", "Fast", "Quick lookups and small jobs. Empty: the small model.", "Small model"),
        Tier("smart", "Smart", "Most subagent work. Empty: the session's own model.", "Session's model"),
        Tier("deep", "Deep", "Hard reasoning and reviews. Empty: the strongest model you have set up.", "Picked by the hub"),
    )

    val LIMIT_KINDS = listOf("session" to "Each chat or session", "routine" to "Each routine run", "subagent" to "Each subagent")

    val LIMIT_FIELDS = listOf(
        LimitField("tokens", "Output tokens", "tokens", 10_000_000_000.0),
        LimitField("costUsd", "Cost", "USD", 100_000.0, fraction = true),
        LimitField("minutes", "Working time", "min", 100_000.0),
    )

    /** Notes per turn: the web's choices. */
    val NOTES_PER_TURN = listOf(3, 6, 10, 15)

    /** core images/generate.ts DEFAULT_IMAGE_MODEL: what makes pictures while none is set. */
    const val DEFAULT_IMAGE_MODEL = "cliproxy/gpt-image-2.5"

    /** A limit as typed: blank is 0 (no limit); null when the hub would refuse it. */
    fun limitValue(text: String, f: LimitField): Double? {
        val t = text.trim().replace(",", "")
        if (t.isEmpty()) return 0.0
        val v = t.toDoubleOrNull() ?: return null
        if (v.isNaN() || v < 0 || v > f.max) return null
        if (!f.fraction && v != Math.floor(v)) return null
        return v
    }

    /** The number to send: a whole number without ".0". */
    fun limitJson(v: Double, f: LimitField): JsonPrimitive = if (f.fraction) JsonPrimitive(v) else JsonPrimitive(v.toLong())

    /** A saved limit as the field shows it: "" for none. */
    fun limitText(e: JsonElement?): String {
        val d = (e as? JsonPrimitive)?.doubleOrNull ?: return ""
        if (d <= 0) return ""
        return if (d == Math.floor(d)) d.toLong().toString() else d.toString()
    }

    /** "Output tokens", not "Output tokens, tokens". */
    fun limitLabel(f: LimitField): String = if (f.label.lowercase().endsWith(f.unit)) f.label else "${f.label}, ${f.unit}"

    /** A member's memory switch: their own, else the hub's, else [default] (web MemberMemorySettings). */
    fun memberFlag(own: MemberMemory?, hub: JsonObject?, key: String, default: Boolean): Boolean {
        val mine = when (key) {
            "enabled" -> own?.enabled
            "autoInject" -> own?.autoInject
            "recallEpisodes" -> own?.recallEpisodes
            "autoExtract" -> own?.autoExtract
            else -> null
        }
        return mine ?: ((hub?.get(key) as? JsonPrimitive)?.booleanOrNull ?: default)
    }

    fun memberNotes(own: MemberMemory?, hub: JsonObject?): Int = own?.injectLimit ?: (hub?.get("injectLimit") as? JsonPrimitive)?.intOrNull ?: 6

    /** A string at [keys] in the config, or null when unset or blank. */
    fun text(cfg: JsonObject?, vararg keys: String): String? {
        var e: JsonElement? = cfg
        for (k in keys) e = (e as? JsonObject)?.get(k)
        return (e as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.ifBlank { null }
    }

    /** The default device as the row shows it: "local" (or none) is the hub. */
    fun deviceName(id: String?, devices: List<Pair<String, String>>): String =
        if (id == null || id == "local") "The hub" else devices.firstOrNull { it.first == id }?.second ?: id
}
