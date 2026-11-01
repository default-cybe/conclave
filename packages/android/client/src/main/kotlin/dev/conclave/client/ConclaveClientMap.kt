package dev.conclave.client

import dev.conclave.client.model.MapSnapshot

// The Map (docs/DESIGN.md 29), the same call as map in
// packages/core/src/client/index.ts. map.delta events come on the socket
// while live(map = ...) says the Map is open.

/**
 * The hub, its devices, projects and the last 24 hours of work. With [at]
 * (epoch ms, within the last 24 hours): the same, rebuilt from stored rows
 * at that time. [tz] is the phone's offset as Date#getTimezoneOffset gives
 * it, for "today" (MapWords.tzOffset).
 */
suspend fun ConclaveClient.map(at: Long? = null, tz: Int? = null): MapSnapshot =
    get(p("api", "map"), MapSnapshot.serializer(), mapOf("at" to at, "tz" to tz))

/**
 * A maps card's picture (docs/DESIGN.md 31): a PNG from Google, or an SVG
 * the hub drew from OpenStreetMap tiles (MapsPicture reads it), with its
 * content type. Fetched with the hub token like any call; the provider's
 * key never leaves the hub.
 */
suspend fun ConclaveClient.mapImage(id: String): Pair<ByteArray, String> = getBytes(p("api", "maps", "image", id))
