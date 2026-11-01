package dev.conclave.client.model

import kotlinx.serialization.Serializable

// Maps card data in a tool result (ToolResultMeta.maps): mirrors
// packages/core/src/maps/types.ts MapsCardData. The hub never puts a key
// or a provider URL with one in here.

/** One place: Google sends rating, open now and price; OpenStreetMap places have none. */
@Serializable
data class MapsPlace(
    val id: String = "",
    val name: String = "",
    val address: String? = null,
    val lat: Double = 0.0,
    val lng: Double = 0.0,
    val rating: Double? = null,
    val ratings: Int? = null,
    val openNow: Boolean? = null,
    /** 0 (free) to 4. */
    val price: Int? = null,
    /** Opens the place in Google Maps or Apple Maps (the owner's choice in Settings, Maps). */
    val mapsUrl: String = "",
    val directionsUrl: String = "",
    val distanceMeters: Int? = null,
)

@Serializable
data class MapsRouteEnd(
    val label: String = "",
    val lat: Double = 0.0,
    val lng: Double = 0.0,
)

@Serializable
data class MapsRoute(
    val id: String = "",
    val from: MapsRouteEnd = MapsRouteEnd(),
    val to: MapsRouteEnd = MapsRouteEnd(),
    /** walk, transit, drive or bicycle: what the times are for. */
    val mode: String = "transit",
    /** The mode asked for, when the provider could not do it. */
    val asked: String? = null,
    val durationSec: Int = 0,
    val trafficSec: Int? = null,
    val distanceMeters: Int = 0,
    val departAt: Long = 0,
    val arriveAt: Long = 0,
    val leaveBy: Long? = null,
    /** "17:40" in the owner's timezone, as the hub wrote them. */
    val departText: String = "",
    val arriveText: String = "",
    val leaveByText: String? = null,
    val arriveLocal: String? = null,
    val zone: String = "",
    val summary: String? = null,
    val note: String? = null,
    val directionsUrl: String = "",
)

@Serializable
data class MapsImage(
    val id: String = "",
    val width: Int = 600,
    val height: Int = 320,
    val alt: String = "",
)

/** kind is places, route or map. */
@Serializable
data class MapsCardData(
    val kind: String = "",
    val provider: String = "",
    /** google or apple: which app the links open. */
    val links: String = "google",
    val places: List<MapsPlace> = emptyList(),
    val route: MapsRoute? = null,
    val image: MapsImage? = null,
    val attribution: String? = null,
)
