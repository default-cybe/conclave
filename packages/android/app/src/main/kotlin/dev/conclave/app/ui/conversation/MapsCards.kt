package dev.conclave.app.ui.conversation

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.MapsCards
import dev.conclave.client.logic.MapsPicture
import dev.conclave.client.logic.PictureOp
import dev.conclave.client.mapImage
import dev.conclave.client.model.MapsCardData
import dev.conclave.client.model.MapsImage
import dev.conclave.client.model.MapsPlace
import dev.conclave.client.model.MapsRoute
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import java.io.IOException
import kotlin.math.roundToInt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/*
 * Places, routes and map pictures from the maps tools, under a turn's
 * folded tool line (MOBILE-V2 5). Open in Maps sends a geo: link, so any
 * maps app opens the place; Directions opens the provider's link by
 * coordinates. A map picture comes from the hub (GET /api/maps/image/:id,
 * with the token like any call, so the maps key never reaches the phone):
 * a PNG from Google, or an SVG the hub drew from OpenStreetMap tiles, read
 * into shapes and drawn on a Canvas.
 */
@Composable
fun MapsCardsView(uses: List<ToolUseBlock>, results: Map<String, ToolResultBlock>) {
    val cards = MapsCards.cards(uses, results)
    if (cards.isEmpty()) return
    Column(Modifier.fillMaxWidth().padding(top = 2.dp, bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        cards.forEach { card ->
            when (card.kind) {
                "places" -> PlacesCard(card)
                "route" -> card.route?.let { RouteCard(it, card.attribution) }
                "map" -> card.image?.let { MapPictureCard(it) }
            }
        }
    }
}

private val CardShape = RoundedCornerShape(5.dp)

@Composable
private fun PlacesCard(card: MapsCardData) {
    val c = Conclave.colors
    Column(Modifier.fillMaxWidth().border(1.dp, c.rule2, CardShape)) {
        card.places.forEachIndexed { i, p ->
            if (i > 0) HorizontalDivider(color = c.rule)
            PlaceRow(p)
        }
        card.attribution?.let {
            HorizontalDivider(color = c.rule)
            Text(it, style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp))
        }
    }
}

@Composable
private fun PlaceRow(p: MapsPlace) {
    val c = Conclave.colors
    val context = LocalContext.current
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
        Row {
            Text(p.name, style = ConclaveType.rowTitle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            p.distanceMeters?.let {
                Spacer(Modifier.width(12.dp))
                Text(MapsCards.distance(it), style = ConclaveType.metaNum, color = c.fg3)
            }
        }
        MapsCards.facts(p)?.let { Text(it, style = ConclaveType.body.copy(fontSize = 14.sp), color = if (p.openNow == true) c.fg2 else c.fg3) }
        p.address?.let { Text(it, style = ConclaveType.body.copy(fontSize = 14.sp), color = c.fg3) }
        Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { open(context, MapsCards.geoUri(p), p.mapsUrl) }, modifier = Modifier.heightIn(min = 40.dp)) { Text("Open in Maps", maxLines = 1) }
            TextButton(onClick = { open(context, MapsCards.directionsUri(p), null) }, modifier = Modifier.heightIn(min = 40.dp)) { Text("Directions", maxLines = 1) }
        }
    }
}

@Composable
private fun RouteCard(r: MapsRoute, attribution: String?) {
    val c = Conclave.colors
    val context = LocalContext.current
    Column(Modifier.fillMaxWidth().border(1.dp, c.rule2, CardShape).padding(horizontal = 16.dp, vertical = 12.dp)) {
        Text(MapsCards.headline(r), style = ConclaveType.stat, color = c.fg)
        Text(
            MapsCards.times(r),
            style = ConclaveType.body.copy(fontSize = 14.5.sp, fontWeight = if (r.leaveByText != null) FontWeight.Medium else FontWeight.Normal),
            color = if (r.leaveByText != null) c.fg else c.fg2,
            modifier = Modifier.padding(top = 4.dp),
        )
        Text(MapsCards.where(r), style = ConclaveType.body.copy(fontSize = 14.sp), color = c.fg3)
        MapsCards.extra(r)?.let { Text(it, style = ConclaveType.body.copy(fontSize = 14.sp), color = c.fg3) }
        OutlinedButton(onClick = { open(context, MapsCards.directionsUri(r), null) }, modifier = Modifier.padding(top = 8.dp).heightIn(min = 40.dp)) { Text("Open in Maps", maxLines = 1) }
        attribution?.let { Text(it, style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(top = 6.dp)) }
    }
}

/** A map picture as it opened: a bitmap, or shapes with their tiles. */
private sealed class Picture {
    class Bitmap(val image: ImageBitmap) : Picture()
    class Drawn(val picture: MapsPicture, val tiles: Map<PictureOp.Image, ImageBitmap>) : Picture()
}

/** Pictures opened already, so scrolling back does not ask the hub again. */
private object Pictures {
    private val opened = object : LinkedHashMap<String, Picture>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Picture>?): Boolean = size > 24
    }

    @Synchronized
    fun get(id: String): Picture? = opened[id]

    @Synchronized
    fun put(id: String, p: Picture) {
        opened[id] = p
    }

    /** The bytes the hub sent, opened; null when they are neither a picture Android reads nor an SVG the hub drew. */
    fun open(bytes: ByteArray, type: String): Picture? {
        if (MapsPicture.isSvg(type, bytes)) {
            val picture = MapsPicture.parse(bytes.decodeToString()) ?: return null
            val tiles = picture.ops.filterIsInstance<PictureOp.Image>().mapNotNull { op ->
                BitmapFactory.decodeByteArray(op.png, 0, op.png.size)?.asImageBitmap()?.let { op to it }
            }.toMap()
            return Picture.Drawn(picture, tiles)
        }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()?.let { Picture.Bitmap(it) }
    }
}

/** A map picture: the image at its own shape, at most 560dp wide, and its words under it. */
@Composable
private fun MapPictureCard(img: MapsImage) {
    val c = Conclave.colors
    val hub = LocalAppContainer.current.hub
    var picture by remember(img.id) { mutableStateOf(Pictures.get(img.id)) }
    var error by remember(img.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(img.id) {
        if (picture != null) return@LaunchedEffect
        try {
            val (bytes, type) = hub.api { it.mapImage(img.id) }
            val p = withContext(Dispatchers.Default) { Pictures.open(bytes, type) } ?: throw IOException("The picture did not open.")
            Pictures.put(img.id, p)
            picture = p
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = errorText(e)
        }
    }
    val measurer = rememberTextMeasurer()
    Column(Modifier.widthIn(max = 560.dp).fillMaxWidth()) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(MapsCards.aspect(img))
                .clip(CardShape)
                .background(c.bgSunk)
                .border(1.dp, c.rule2, CardShape)
                .semantics { contentDescription = img.alt.ifBlank { "Map" } },
            contentAlignment = Alignment.Center,
        ) {
            when (val p = picture) {
                is Picture.Bitmap -> Image(p.image, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                is Picture.Drawn -> Canvas(Modifier.fillMaxSize()) { drawMapsPicture(p, measurer) }
                null -> error?.let { Text("Could not load the map. $it", style = ConclaveType.meta, color = c.fg3, textAlign = TextAlign.Center, modifier = Modifier.padding(16.dp)) }
            }
        }
        // the picture carries its own attribution (Google's mark, or the OpenStreetMap line the hub draws)
        if (img.alt.isNotBlank()) Text(img.alt, style = ConclaveType.meta, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
    }
}

/** The hub's SVG shapes in order, scaled from the picture's own size to the box. */
private fun DrawScope.drawMapsPicture(p: Picture.Drawn, measurer: TextMeasurer) {
    val pic = p.picture
    if (pic.width <= 0 || pic.height <= 0) return
    val sx = size.width / pic.width.toFloat()
    val sy = size.height / pic.height.toFloat()
    withTransform({ scale(sx, sy, pivot = Offset.Zero) }) {
        for (op in pic.ops) {
            when (op) {
                is PictureOp.Rect -> drawRect(Color(op.fill.toInt()), Offset(op.x.toFloat(), op.y.toFloat()), Size(op.w.toFloat(), op.h.toFloat()), alpha = op.opacity.toFloat().coerceIn(0f, 1f))
                is PictureOp.Image -> p.tiles[op]?.let { tile ->
                    drawImage(
                        tile,
                        srcOffset = IntOffset.Zero,
                        srcSize = IntSize(tile.width, tile.height),
                        dstOffset = IntOffset(op.x.roundToInt(), op.y.roundToInt()),
                        dstSize = IntSize(op.w.roundToInt(), op.h.roundToInt()),
                    )
                }
                is PictureOp.Line -> {
                    val path = Path()
                    op.points.forEachIndexed { i, (x, y) -> if (i == 0) path.moveTo(x.toFloat(), y.toFloat()) else path.lineTo(x.toFloat(), y.toFloat()) }
                    drawPath(path, Color(op.stroke.toInt()), alpha = op.opacity.toFloat().coerceIn(0f, 1f), style = Stroke(width = op.width.toFloat(), cap = StrokeCap.Round, join = StrokeJoin.Round))
                }
                is PictureOp.Circle -> {
                    val center = Offset(op.cx.toFloat(), op.cy.toFloat())
                    drawCircle(Color(op.fill.toInt()), op.r.toFloat(), center)
                    op.stroke?.let { if (op.strokeWidth > 0) drawCircle(Color(it.toInt()), op.r.toFloat(), center, style = Stroke(op.strokeWidth.toFloat())) }
                }
                is PictureOp.Text -> {
                    // the picture's font size is in its own units; the transform scales it with the rest
                    val layout = measurer.measure(
                        op.text,
                        TextStyle(color = Color(op.fill.toInt()), fontSize = op.size.toFloat().toSp(), fontWeight = if (op.bold) FontWeight.Bold else FontWeight.Normal),
                    )
                    val w = layout.size.width.toFloat()
                    val left = when (op.anchor) {
                        "middle" -> op.x.toFloat() - w / 2
                        "end" -> op.x.toFloat() - w
                        else -> op.x.toFloat()
                    }
                    val baseline = (op.y + op.dy).toFloat()
                    drawText(layout, topLeft = Offset(left, baseline - layout.firstBaseline))
                }
            }
        }
    }
}

/** Open a link in the app that handles it; a phone with no maps app gets the https link in a browser. */
private fun open(context: Context, uri: String, fallback: String?) {
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: ActivityNotFoundException) {
        if (fallback != null) runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(fallback)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
}
