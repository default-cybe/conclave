package dev.conclave.client

import dev.conclave.client.logic.MapsCards
import dev.conclave.client.logic.SessionLive
import dev.conclave.client.logic.ToolLines
import dev.conclave.client.model.ContentBlock
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Maps cards on the phone: the hub's card data, their words, where a tap goes, and the tool line. */
class MapsTest {
    // a PlaceSearch result as the hub stores it (packages/core/src/maps/service.ts)
    private val placesJson = """
        {"type":"tool_result","toolUseId":"t1","content":"3 places for \"coffee\" near Home: ...","meta":{"durationMs":412,"maps":{
          "kind":"places","provider":"google","links":"google","places":[
            {"id":"ChIJlinde0000000000000001","name":"Café Linde","address":"Linienstraße 40, 10119 Berlin","lat":52.5281,"lng":13.4049,"rating":4.6,"ratings":1203,"openNow":true,"price":2,
             "mapsUrl":"https://maps.google.com/?cid=1","directionsUrl":"https://www.google.com/maps/dir/?api=1&destination=52.5281%2C13.4049&travelmode=transit","distanceMeters":340},
            {"id":"osm:N1001","name":"Kiosk Nord","lat":52.5369,"lng":13.3976,"mapsUrl":"https://www.google.com/maps/search/?api=1&query=52.5369%2C13.3976","directionsUrl":""}
          ]}}}
    """.trimIndent()

    private val routeJson = """
        {"type":"tool_result","toolUseId":"t2","content":"Transit from Home to Café Linde: 24 min","meta":{"maps":{
          "kind":"route","provider":"google","links":"google","route":{
            "id":"route_1","from":{"label":"Home","lat":52.5294,"lng":13.401},"to":{"label":"Café Linde","lat":52.5281,"lng":13.4049},
            "mode":"transit","durationSec":1440,"distanceMeters":5130,"departAt":1,"arriveAt":2,"leaveBy":1,
            "departText":"17:36","arriveText":"18:00","leaveByText":"17:36","zone":"Europe/Berlin","summary":"U8, M10",
            "directionsUrl":"https://www.google.com/maps/dir/?api=1&destination=52.5281%2C13.4049&travelmode=transit"}}}}
    """.trimIndent()

    private fun result(json: String) = ConclaveJson.decodeFromString(ContentBlock.serializer(), json) as ToolResultBlock

    private fun use(id: String, name: String, vararg pairs: Pair<String, String>) =
        ToolUseBlock(id, name, JsonObject(pairs.associate { (k, v) -> k to JsonPrimitive(v) }))

    @Test
    fun theHubsCardDataParses() {
        val c = MapsCards.of(result(placesJson))!!
        assertEquals("places", c.kind)
        assertEquals(2, c.places.size)
        assertEquals(4.6, c.places[0].rating)
        assertEquals(true, c.places[0].openNow)
        assertNull(c.places[1].rating)
        val r = MapsCards.of(result(routeJson))!!.route!!
        assertEquals("Café Linde", r.to.label)
        assertEquals("17:36", r.leaveByText)
    }

    @Test
    fun aFailedCallHasNoCardAndAMapPictureHasOne() {
        val failed = result(placesJson).copy(isError = true)
        assertNull(MapsCards.of(failed))
        assertNull(MapsCards.of(ToolResultBlock("x", JsonPrimitive("Map of Home"))))
        val map = result("""{"type":"tool_result","toolUseId":"t3","content":"Map","meta":{"maps":{"kind":"map","provider":"osm","image":{"id":"map_1","width":600,"height":320,"alt":"Map"}}}}""")
        val card = MapsCards.of(map)!!
        assertEquals("map_1", card.image!!.id)
        assertEquals(600f / 320f, MapsCards.aspect(card.image!!))
        // a picture with no id is nothing to fetch
        assertNull(MapsCards.of(result("""{"type":"tool_result","toolUseId":"t4","content":"Map","meta":{"maps":{"kind":"map","provider":"osm","image":{"id":"","width":600,"height":320}}}}""")))
    }

    @Test
    fun placeFactsShowWhatGoogleKnowsAndNothingForOpenStreetMap() {
        val c = MapsCards.of(result(placesJson))!!
        assertEquals("4.6 stars (1,203), open now, $$", MapsCards.facts(c.places[0]))
        assertEquals("Closed now, free", MapsCards.facts(c.places[0].copy(rating = null, openNow = false, price = 0)))
        assertNull(MapsCards.facts(c.places[1]))
    }

    @Test
    fun aRouteInWords() {
        val r = MapsCards.of(result(routeJson))!!.route!!
        assertEquals("24 min by transit", MapsCards.headline(r))
        assertEquals("Leave by 17:36, arrive 18:00", MapsCards.times(r))
        assertEquals("Leaving 17:12, arriving 17:36", MapsCards.times(r.copy(leaveByText = null, departText = "17:12", arriveText = "17:36")))
        assertEquals("Home to Café Linde, 5.1 km", MapsCards.where(r))
        assertEquals("U8, M10.", MapsCards.extra(r))
        assertEquals("Via Torstraße. Traffic adds 6 min.", MapsCards.extra(r.copy(mode = "drive", summary = "via Torstraße", trafficSec = 360)))
        assertEquals("5 min on foot", MapsCards.headline(r.copy(mode = "walk", durationSec = 300)))
        assertEquals("1 h 5 min", MapsCards.duration(3900))
        assertEquals("420 m", MapsCards.distance(420))
        assertEquals("120 km", MapsCards.distance(120_400))
    }

    @Test
    fun openInMapsIsAGeoLinkAndDirectionsUseTheProvidersLink() {
        val c = MapsCards.of(result(placesJson))!!
        assertEquals("geo:52.5281,13.4049?q=52.5281%2C13.4049%28Caf%C3%A9%20Linde%29", MapsCards.geoUri(c.places[0]))
        assertEquals(c.places[0].directionsUrl, MapsCards.directionsUri(c.places[0]))
        // a place without a link still gets directions by coordinates
        assertEquals("https://www.google.com/maps/dir/?api=1&destination=52.5369,13.3976", MapsCards.directionsUri(c.places[1]))
        val r = MapsCards.of(result(routeJson))!!.route!!
        assertEquals(r.directionsUrl, MapsCards.directionsUri(r))
    }

    @Test
    fun theToolLineSaysItPlainly() {
        val uses = listOf(use("t1", "PlaceSearch", "query" to "coffee", "near" to "home"), use("t2", "Directions", "to" to "ChIJlinde0000000000000001"), use("t3", "MapImage", "route" to "route_1"))
        val results = mapOf("t1" to result(placesJson), "t2" to result(routeJson), "t3" to ToolResultBlock("t3", JsonPrimitive("Map of the route")))
        assertEquals("Looked for coffee, got directions, drew a map", ToolLines.sentence(ToolLines.steps(uses, results)))
        val steps = ToolLines.steps(uses, results)
        assertEquals("to a place", steps[1].target)
        assertEquals("to Bernauer Straße 63", ToolLines.step(use("x", "Directions", "to" to "Bernauer Straße 63"), null).target)
        assertEquals(2, MapsCards.cards(uses, results).size)
        assertEquals("Getting directions" to null, SessionLive.step(uses[1]))
    }

    /** A picture as core maps/osm.ts draws it: a background, a tile, a missing tile, the route twice, a marker, the attribution. */
    private val osmSvg = """<svg xmlns="http://www.w3.org/2000/svg" width="600" height="320" viewBox="0 0 600 320" role="img"><title>Map of Home &amp; Café</title><rect width="600" height="320" fill="#e8e6e1"/>""" +
        """<image x="-12" y="-40" width="256" height="256" href="data:image/png;base64,iVBORw0KGgo="/>""" +
        """<rect x="244" y="-40" width="256" height="256" fill="#e8e6e1"/>""" +
        """<path d="M 100.0 120.5 L 180.2 140.0 L 300.0 200.0" fill="none" stroke="#ffffff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>""" +
        """<path d="M 100.0 120.5 L 180.2 140.0 L 300.0 200.0" fill="none" stroke="#2f6fde" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>""" +
        """<circle cx="100.0" cy="120.5" r="11" fill="#d6453d" stroke="#ffffff" stroke-width="2.5"/>""" +
        """<text x="100.0" y="120.5" dy="4" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="12" font-weight="700" fill="#ffffff">H</text>""" +
        """<rect x="400" y="302" width="200" height="18" fill="#ffffff" opacity="0.85"/>""" +
        """<text x="594" y="315" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="10.5" fill="#333333">© OpenStreetMap contributors</text></svg>"""

    @Test
    fun anOpenStreetMapPictureReadsIntoThingsToDraw() {
        val p = dev.conclave.client.logic.MapsPicture.parse(osmSvg)!!
        assertEquals(600.0, p.width)
        assertEquals(320.0, p.height)
        val ops = p.ops
        val kinds = ops.map { it::class.simpleName }
        assertEquals(listOf("Rect", "Image", "Rect", "Line", "Line", "Circle", "Text", "Rect", "Text"), kinds)
        val tile = ops[1] as dev.conclave.client.logic.PictureOp.Image
        assertEquals(-12.0, tile.x)
        assertEquals(8, tile.png.size)
        val route = ops[4] as dev.conclave.client.logic.PictureOp.Line
        assertEquals(3, route.points.size)
        assertEquals(0xFF2F6FDEL, route.stroke)
        assertEquals(5.0, route.width)
        assertEquals(0.9, (ops[3] as dev.conclave.client.logic.PictureOp.Line).opacity)
        val letter = ops[6] as dev.conclave.client.logic.PictureOp.Text
        assertEquals("H", letter.text)
        assertEquals("middle", letter.anchor)
        assertEquals(true, letter.bold)
        assertEquals("© OpenStreetMap contributors", (ops[8] as dev.conclave.client.logic.PictureOp.Text).text)
        assertEquals(0.85, (ops[7] as dev.conclave.client.logic.PictureOp.Rect).opacity)
        assertEquals(true, dev.conclave.client.logic.MapsPicture.isSvg("image/svg+xml", ByteArray(0)))
        assertEquals(true, dev.conclave.client.logic.MapsPicture.isSvg("", osmSvg.toByteArray()))
        assertEquals(false, dev.conclave.client.logic.MapsPicture.isSvg("image/png", byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47)))
        assertNull(dev.conclave.client.logic.MapsPicture.parse("<html/>"))
    }

    @Test
    fun aPictureWithNumbersThatAreNotNumbersStillDraws() {
        // "NaN" and "Infinity" read as doubles: rounded for a tile's place they would close the app
        val svg = """<svg xmlns="http://www.w3.org/2000/svg" width="600" height="320">""" +
            """<image x="NaN" y="Infinity" width="-Infinity" height="256" href="data:image/png;base64,iVBORw0KGgo="/>""" +
            """<circle cx="NaN" cy="1" r="Infinity" fill="#d6453d" stroke-width="NaN"/>""" +
            """<text x="1" y="2" font-size="NaN" fill="#333333">A</text><text x="1" y="2" font-size="-4" fill="#333333">B</text></svg>"""
        val p = dev.conclave.client.logic.MapsPicture.parse(svg)!!
        for (op in p.ops) {
            val nums = when (op) {
                is dev.conclave.client.logic.PictureOp.Image -> listOf(op.x, op.y, op.w, op.h)
                is dev.conclave.client.logic.PictureOp.Circle -> listOf(op.cx, op.cy, op.r, op.strokeWidth)
                is dev.conclave.client.logic.PictureOp.Text -> listOf(op.x, op.y, op.dy, op.size)
                else -> emptyList()
            }
            assertTrue(nums.all { it.isFinite() }, "$op")
        }
        assertTrue(p.ops.filterIsInstance<dev.conclave.client.logic.PictureOp.Text>().all { it.size >= 1.0 })
        assertNull(dev.conclave.client.logic.MapsPicture.parse("""<svg width="NaN" height="320"></svg>"""))
        assertNull(dev.conclave.client.logic.MapsPicture.parse("""<svg width="0" height="320"></svg>"""))
    }
}
