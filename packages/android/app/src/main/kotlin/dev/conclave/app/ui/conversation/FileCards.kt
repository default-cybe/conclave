package dev.conclave.app.ui.conversation

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.drawable.AnimatedImageDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ImageView
import android.widget.Toast
import androidx.annotation.RequiresApi
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.FileProvider
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.FileCardData
import dev.conclave.client.logic.FileCards
import dev.conclave.client.logic.Media
import dev.conclave.client.model.ImageBlock
import dev.conclave.client.model.ToolResultBlock
import dev.conclave.client.model.ToolUseBlock
import dev.conclave.client.sessionFile
import java.io.ByteArrayInputStream
import java.io.File
import java.nio.ByteBuffer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/*
 * Files a ShareFile call handed the owner, under a turn's work like the
 * maps cards (MapsCards.kt; the web's FileCard.tsx). A picture or video is
 * no card: it is a thumbnail in the row's strip (ToolFold.kt ThumbRow,
 * Media.thumbnail). Anything else is a compact card: name, type and size,
 * and one small save icon. The bytes come from the hub by the call's id
 * (GET /api/sessions/:id/files/:toolUseId, with the token), never by a path.
 * A tap on the card shows a PDF, text or a big picture in the in-app viewer
 * (MediaViewer.kt), swiping through the message's other files; any other
 * type it writes to the cache's shared/ folder (res/xml/file_paths.xml)
 * and hands the FileProvider link to the app for the type; the save icon
 * asks where with the system's create-document picker. An SVG up to 2 MB (a
 * generated chart or graph) draws in the card in a locked-down WebView
 * (inertWebView): one base64 data: <img> (FileCards.svgDocument), no script,
 * no network, no files, no navigation, destroyed when the card leaves.
 *
 * Pictures a GenerateImage call made come first, as a grid (the web's
 * ImageGrid): one shows large, two to four in two columns. They draw from the
 * call's result (meta.files) as soon as it ends, fetched with ?image=N, and a
 * tap opens the in-app viewer (MediaViewer.kt). The turn-end cards
 * of the same files are left out (FileCards.cards).
 */
@Composable
fun FileCardsView(uses: List<ToolUseBlock>, results: Map<String, ToolResultBlock>) {
    val sessionId = LocalSessionWork.current.session?.id ?: return
    val pics = FileCards.generated(uses, results)
    // pictures and videos are thumbnails under the row (ToolFold.kt)
    val cards = FileCards.cards(uses, results).filterNot { Media.thumbnail(it) }
    if (cards.isEmpty() && pics.isEmpty()) return
    val hub = LocalAppContainer.current.hub
    var viewing by remember { mutableStateOf<FileCardData?>(null) }
    Column(Modifier.fillMaxWidth().padding(top = 2.dp, bottom = 6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (pics.isNotEmpty()) ImageGrid(sessionId, pics, onView = { viewing = it })
        cards.forEach { FileCard(sessionId, it, onView = { c -> viewing = c }) }
    }
    viewing?.let { v ->
        val (list, start) = Media.pager(pics + cards, v)
        MediaViewer(remember(list) { list.map { it.viewerItem(hub, sessionId) } }, start) { viewing = null }
    }
}

@Composable
private fun ImageGrid(sessionId: String, cards: List<FileCardData>, onView: (FileCardData) -> Unit) {
    val one = cards.size == 1
    Column(Modifier.widthIn(max = if (one) 420.dp else 560.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        cards.chunked(if (one) 1 else 2).forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { GridCell(sessionId, it, one, Modifier.weight(1f), onView) }
                if (row.size == 1 && !one) Spacer(Modifier.weight(1f))
            }
        }
    }
}

/** One generated picture: square and cropped in a grid, whole when alone. A tap opens it in the viewer (pinch to zoom). */
@Composable
private fun GridCell(sessionId: String, card: FileCardData, one: Boolean, modifier: Modifier, onView: (FileCardData) -> Unit) {
    val c = Conclave.colors
    val hub = LocalAppContainer.current.hub
    val target = with(LocalDensity.current) { 560.dp.roundToPx() }
    var failed by remember(card.toolUseId, card.image) { mutableStateOf(false) }
    val loaded by produceState<ImageBitmap?>(null, card.toolUseId, card.image) {
        val got = try {
            val (bytes, _) = hub.api { it.sessionFile(sessionId, card.toolUseId, card.image) }
            withContext(Dispatchers.Default) { decodeScaled(bytes, target) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            null
        }
        if (got == null) failed = true
        value = got
    }
    val shape = Modifier.clip(CardShape).border(1.dp, c.rule, CardShape)
    val l = loaded
    when {
        l != null -> Image(
            bitmap = l,
            contentDescription = card.title ?: "Generated image",
            contentScale = if (one) ContentScale.Fit else ContentScale.Crop,
            modifier = (if (one) modifier.heightIn(max = 420.dp) else modifier.aspectRatio(1f)).then(shape).clickable(onClickLabel = "Open full screen") { onView(card) },
        )
        failed -> Box(modifier.aspectRatio(1f).then(shape).background(c.bgSunk).padding(12.dp), contentAlignment = androidx.compose.ui.Alignment.Center) {
            Text("Could not load ${card.name}", style = ConclaveType.meta, color = c.fault)
        }
        else -> Box(modifier.aspectRatio(1f).then(shape).background(c.bgSunk))
    }
}

private val CardShape = RoundedCornerShape(5.dp)
private val SvgHeight = 240.dp

@RequiresApi(Build.VERSION_CODES.P)
internal fun decodeAnimated(bytes: ByteArray, target: Int): Drawable? = runCatching {
    ImageDecoder.decodeDrawable(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { decoder, info, _ ->
        var sample = 1
        while (maxOf(info.size.width, info.size.height) / (sample * 2) >= target) sample *= 2
        decoder.setTargetSampleSize(sample)
    }.takeIf { it is AnimatedImageDrawable }
}.getOrNull()

@Composable
private fun FileCard(sessionId: String, card: FileCardData, onView: (FileCardData) -> Unit) {
    val c = Conclave.colors
    val context = LocalContext.current
    val hub = LocalAppContainer.current.hub
    val scope = rememberCoroutineScope()
    var error by remember(card.toolUseId) { mutableStateOf<String?>(null) }
    var busy by remember(card.toolUseId) { mutableStateOf(false) }
    fun fetch(then: suspend (ByteArray) -> Unit) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try {
                val (bytes, _) = hub.api { it.sessionFile(sessionId, card.toolUseId) }
                then(bytes)
            } catch (e: CancellationException) {
                throw e
            } catch (_: ActivityNotFoundException) {
                error = "No app on this phone opens this file. Save it instead."
            } catch (e: Exception) {
                error = "Could not get the file. ${errorText(e)}"
            } finally {
                busy = false
            }
        }
    }
    // the in-app viewer for what it can show; anything else to the app for the type, as before
    fun open() = if (Media.viewable(card)) onView(card) else fetch { bytes ->
        val file = withContext(Dispatchers.IO) {
            val dir = File(File(context.cacheDir, "shared"), FileCards.cacheFolder(card)).apply { mkdirs() }
            File(dir, FileCards.cacheName(card)).apply { writeBytes(bytes) }
        }
        val uri = FileProvider.getUriForFile(context, context.packageName + ".files", file)
        context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, card.mediaType).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
    }
    val showSvg = FileCards.inlineSvg(card)
    val svg by produceState<String?>(null, card.toolUseId, showSvg) {
        if (!showSvg) return@produceState
        value = try {
            val (bytes, _) = hub.api { it.sessionFile(sessionId, card.toolUseId) }
            // grown past the cap since it was shared: a card only
            if (bytes.size > FileCards.SVG_MAX) null else withContext(Dispatchers.Default) { FileCards.svgDocument(bytes, card.title ?: card.name) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = "Could not get the file. ${errorText(e)}"
            null
        }
    }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(card.mediaType)) { uri ->
        if (uri != null) {
            fetch { bytes ->
                withContext(Dispatchers.IO) {
                    context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw java.io.IOException("Could not write the file.")
                }
            }
        }
    }
    // the whole card opens the file; the one small icon saves it
    Column(
        Modifier
            .widthIn(max = 560.dp)
            .fillMaxWidth()
            .clip(CardShape)
            .border(1.dp, c.rule2, CardShape)
            .clickable(enabled = !busy, onClickLabel = "Open ${card.name}") { open() }
            .padding(start = 16.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
    ) {
        svg?.let { SvgPreview(it, card.title ?: card.name, onFail = { error = "Could not show the image." }) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(card.title ?: card.name, style = ConclaveType.rowTitle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    (if (card.title != null) "${card.name}, " else "") + FileCards.facts(card),
                    style = ConclaveType.body.copy(fontSize = 14.sp),
                    color = c.fg3,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            IconButton(enabled = !busy, onClick = { save.launch(card.name) }) {
                Icon(Icons.Outlined.Download, contentDescription = "Save ${card.name}", tint = c.fg3, modifier = Modifier.size(20.dp))
            }
        }
        error?.let { Text(it, style = ConclaveType.meta, color = c.fault, modifier = Modifier.padding(top = 4.dp, end = 12.dp)) }
    }
}

/**
 * Save and Share under the full-screen viewer (Reply.kt FullImage). Save
 * writes the picture to Pictures/Conclave with MediaStore on Android 10+ (no
 * storage permission); on 8 and 9 it asks where with the create-document
 * picker, like a file card's Save. Share writes it to the cache's shared/
 * folder (res/xml/file_paths.xml) and hands the FileProvider link to the
 * share sheet. The name is FileCards.pictureName.
 */
@Composable
internal fun ImageActions(block: ImageBlock, name: String?, modifier: Modifier = Modifier) {
    val data = block.data
    if (data.isNullOrBlank()) return
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val type = block.mediaType.ifBlank { "image/png" }
    val fileName = FileCards.pictureName(name, type)
    var busy by remember { mutableStateOf(false) }
    fun run(done: String?, work: suspend (ByteArray) -> Unit) {
        if (busy) return
        busy = true
        scope.launch {
            val failed = try {
                work(withContext(Dispatchers.Default) { java.util.Base64.getDecoder().decode(data) })
                null
            } catch (e: CancellationException) {
                throw e
            } catch (_: ActivityNotFoundException) {
                "No app on this phone can share it."
            } catch (e: Exception) {
                "Could not ${if (done == null) "share" else "save"} the picture. ${errorText(e)}"
            } finally {
                busy = false
            }
            (failed ?: done)?.let { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() }
        }
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(type)) { uri ->
        if (uri != null) {
            run("Saved") { bytes ->
                withContext(Dispatchers.IO) {
                    context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw java.io.IOException("Could not write the file.")
                }
            }
        }
    }
    fun save() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            run("Saved to Pictures/Conclave") { bytes -> withContext(Dispatchers.IO) { saveToPictures(context, bytes, fileName, type) } }
        } else {
            pick.launch(fileName)
        }
    }
    fun share() = run(null) { bytes ->
        val file = withContext(Dispatchers.IO) {
            val dir = File(File(context.cacheDir, "shared"), "viewer").apply { mkdirs() }
            File(dir, fileName).apply { writeBytes(bytes) }
        }
        val uri = FileProvider.getUriForFile(context, context.packageName + ".files", file)
        val send = Intent(Intent.ACTION_SEND).setType(type).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.startActivity(Intent.createChooser(send, "Share picture"))
    }
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(enabled = !busy, onClick = { save() }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Save", color = androidx.compose.ui.graphics.Color.White, maxLines = 1) }
        TextButton(enabled = !busy, onClick = { share() }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Share", color = androidx.compose.ui.graphics.Color.White, maxLines = 1) }
    }
}

/** The picture into Pictures/Conclave, hidden from other apps until it is whole; a clash of names gets " (1)" from MediaStore. */
@RequiresApi(Build.VERSION_CODES.Q)
internal fun saveToPictures(context: Context, bytes: ByteArray, name: String, type: String) {
    val resolver = context.contentResolver
    val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
        put(MediaStore.MediaColumns.MIME_TYPE, type)
        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Conclave")
        put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val uri = resolver.insert(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), values) ?: throw java.io.IOException("The phone refused a new picture.")
    try {
        resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw java.io.IOException("Could not write the file.")
        resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
    } catch (e: Exception) {
        // no half-written picture left in the gallery
        runCatching { resolver.delete(uri, null, null) }
        throw e
    }
}

/** An SVG card's drawing above its title: full width, [SvgHeight] tall, the card's corners. */
@Composable
private fun SvgPreview(svg: String, description: String, onFail: () -> Unit) {
    val fail by rememberUpdatedState(onFail)
    AndroidView(
        factory = { ctx ->
            // no WebView on this phone (or it failed to start): the card alone
            runCatching { inertWebView(ctx).apply { contentDescription = description; loadDataWithBaseURL(null, svg, "text/html", "utf-8", null) } }
                .getOrElse { fail(); View(ctx) }
        },
        onRelease = { (it as? WebView)?.apply { stopLoading(); destroy() } },
        modifier = Modifier.padding(top = 4.dp, end = 12.dp, bottom = 8.dp).fillMaxWidth().clip(CardShape).height(SvgHeight),
    )
}

/**
 * A WebView that can only draw the page it is handed: no JavaScript, no DOM
 * storage, no file or content access, no network, no mixed content, no new
 * windows, every navigation refused and every request but data: answered
 * empty. No JavaScript bridge, ever. Long press does nothing (no save-image menu).
 */
internal fun inertWebView(ctx: Context): WebView = WebView(ctx).apply {
    settings.apply {
        javaScriptEnabled = false
        javaScriptCanOpenWindowsAutomatically = false
        setSupportMultipleWindows(false)
        domStorageEnabled = false
        allowFileAccess = false
        allowContentAccess = false
        blockNetworkLoads = true
        blockNetworkImage = true
        mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        cacheMode = WebSettings.LOAD_NO_CACHE
        setGeolocationEnabled(false)
        setSupportZoom(false)
    }
    webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            if (request.url.scheme == "data") null else WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
    }
    setBackgroundColor(Color.TRANSPARENT)
    isVerticalScrollBarEnabled = false
    isHorizontalScrollBarEnabled = false
    isLongClickable = false
    setOnLongClickListener { true }
}
