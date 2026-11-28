package dev.conclave.client.logic

import dev.conclave.client.model.obj
import dev.conclave.client.model.string
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * What a session keeps in its meta for the session sheet: the Security lane
 * (core security/lanes.ts, web chat/Security.tsx LaneChip) and the connectors
 * turned off for it (core session/connectors.ts, web sheets/Connectors.tsx).
 */
object SessionExtras {
    /** One lane: its value, the menu's label and the chip's short word. */
    data class Lane(val value: String, val label: String, val short: String)

    /** In rank order, as core LANES. */
    val LANES = listOf(
        Lane("ctf", "CTF", "CTF"),
        Lane("variant", "variant (violation hunt)", "variant"),
        Lane("exploit", "exploit dev", "exploit"),
        Lane("re", "RE (REA)", "RE"),
        Lane("source", "white-box source", "source"),
        Lane("web", "web black-box (Caido)", "web"),
    )

    /** The lane in use (meta.lane.lane), or null when the session has none or an unknown one. */
    fun laneOf(meta: JsonObject?): Lane? {
        val v = meta?.obj("lane")?.string("lane") ?: return null
        return LANES.firstOrNull { it.value == v }
    }

    /** The servers off for this session (meta.mcpOff); anything that is not a list of names reads as none. */
    fun mcpOff(meta: JsonObject?): List<String> =
        (meta?.get("mcpOff") as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }.orEmpty()

    /** The mcpOff list after turning [name] on or off; an empty list turns every server back on. */
    fun toggled(off: List<String>, name: String, on: Boolean): List<String> =
        if (on) off.filter { it != name } else (off + name).distinct()
}
