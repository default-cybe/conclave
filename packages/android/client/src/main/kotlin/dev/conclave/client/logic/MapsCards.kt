package dev.conclave.client.logic

import dev.conclave.client.model.MapsCardData
import dev.conclave.client.model.MapsPlace
import dev.conclave.client.model.MapsRoute
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import java.net.URLEncoder
import java.util.Locale

/*
 * Maps cards on the phone (packages/web/src/features/maps/words.ts, the
 * same words): a place with its facts, a route with its time, mode and
 * leave-by, and where a tap goes. "Open in Maps" is a geo: link, so any
 * maps app opens it; directions open the provider's link by coordinates.
 */
object MapsCards {

    val TOOLS = setOf("PlaceSearch", "PlaceDetails", "Directions", "MapImage")

    /** The card a result carries, when the app can draw it: places, routes and map pictures. A failed call has none. */
    fun of(result: ToolResultBlock?): MapsCardData? {
        val c = result?.takeUnless { it.isError }?.meta?.maps ?: return null
        return when (c.kind) {
            "places" -> c.takeIf { it.places.isNotEmpty() }
            "route" -> c.takeIf { it.route != null }
            "map" -> c.takeIf { it.image?.id?.isNotBlank() == true }
            else -> null
        }
    }

    /** The picture's shape: its width over its height, a sane one when the hub sent none. */
    fun aspect(i: dev.conclave.client.model.MapsImage): Float =
        if (i.width > 0 && i.height > 0) (i.width.toFloat() / i.height).coerceIn(0.5f, 3f) else 600f / 320f

    /** The cards of a turn's calls, in order. */
    fun cards(uses: List<ToolUseBlock>, results: Map<String, ToolResultBlock>): List<MapsCardData> =
        uses.filter { it.name in TOOLS }.mapNotNull { of(results[it.id]) }

    /** "4.6 stars (1,203), open now, $$", or null for an OpenStreetMap place, which has none of them. */
    fun facts(p: MapsPlace): String? {
        val parts = ArrayList<String>()
        p.rating?.let { r -> parts += "${String.format(Locale.US, "%.1f", r)} stars" + (p.ratings?.let { " (${count(it)})" } ?: "") }
        p.openNow?.let { parts += if (it) "open now" else "closed now" }
        p.price?.let { parts += if (it <= 0) "free" else "$".repeat(it.coerceAtMost(4)) }
        if (parts.isEmpty()) return null
        return parts.joinToString(", ").replaceFirstChar { it.uppercaseChar() }
    }

    /** "24 min by transit". */
    fun headline(r: MapsRoute): String = "${duration(r.durationSec)} ${by(r.mode)}"

    /** "Leave by 17:36, arrive 18:00", or "Leaving 17:12, arriving 17:36". */
    fun times(r: MapsRoute): String =
        r.leaveByText?.let { "Leave by $it, arrive ${r.arriveText}" }
            ?: ("Leaving ${r.departText}, arriving ${r.arriveText}" + (r.arriveLocal?.let { " ($it)" } ?: ""))

    /** "Home to Café Linde, 5.1 km". */
    fun where(r: MapsRoute): String = "${r.from.label} to ${r.to.label}, ${distance(r.distanceMeters)}"

    /** The lines taken, traffic, and what the provider could not do. Null when there is nothing. */
    fun extra(r: MapsRoute): String? {
        val bits = ArrayList<String>()
        r.summary?.let { s -> bits += if (s.startsWith("via ")) "V${s.drop(1)}." else "$s." }
        r.trafficSec?.let { bits += "Traffic adds ${duration(it)}." }
        r.note?.let { bits += it }
        return bits.joinToString(" ").ifBlank { null }
    }

    /** "Open in Maps": any maps app on the phone, by coordinates, named. */
    fun geoUri(p: MapsPlace): String {
        val ll = "${coord(p.lat)},${coord(p.lng)}"
        return "geo:$ll?q=" + URLEncoder.encode("$ll(${p.name})", "UTF-8").replace("+", "%20")
    }

    /** Directions from where the phone is: the provider's link by coordinates, which Google Maps or Apple Maps open. */
    fun directionsUri(p: MapsPlace): String = p.directionsUrl.ifBlank { "https://www.google.com/maps/dir/?api=1&destination=${coord(p.lat)},${coord(p.lng)}" }

    fun directionsUri(r: MapsRoute): String = r.directionsUrl.ifBlank { "https://www.google.com/maps/dir/?api=1&destination=${coord(r.to.lat)},${coord(r.to.lng)}" }

    /** What a phone's working line says while a maps call runs. */
    fun working(name: String): String? = when (name) {
        "PlaceSearch" -> "Searching places"
        "PlaceDetails" -> "Looking up a place"
        "Directions" -> "Getting directions"
        "MapImage" -> "Drawing a map"
        else -> null
    }

    /** "4 min", "1 h 5 min"; under a minute is "1 min". */
    fun duration(sec: Int): String {
        val min = maxOf(1, Math.round(sec / 60.0).toInt())
        if (min < 60) return "$min min"
        val h = min / 60
        val m = min % 60
        return if (m == 0) "$h h" else "$h h $m min"
    }

    /** "850 m", "5.1 km", "120 km". */
    fun distance(m: Int): String {
        if (m < 950) return "${maxOf(10, Math.round(m / 10.0).toInt() * 10)} m"
        val km = m / 1000.0
        return if (km < 20) String.format(Locale.US, "%.1f", km).removeSuffix(".0") + " km" else "${Math.round(km)} km"
    }

    private fun by(mode: String): String = when (mode) {
        "walk" -> "on foot"
        "drive" -> "by car"
        "bicycle" -> "by bicycle"
        else -> "by transit"
    }

    private fun count(n: Int): String = String.format(Locale.US, "%,d", n)

    private fun coord(v: Double): String = String.format(Locale.US, "%.6f", v).trimEnd('0').trimEnd('.')
}
