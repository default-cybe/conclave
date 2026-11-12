@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.conversation

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.drawable.AnimatedImageDrawable
import android.graphics.drawable.Drawable
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.Build
import android.os.ParcelFileDescriptor
import android.view.View
import android.webkit.WebView
import android.widget.ImageView
import android.widget.MediaController
import android.widget.Toast
import android.widget.VideoView
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.CodeBox
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.FileCardData
import dev.conclave.client.logic.FileCards
import dev.conclave.client.logic.Media
import dev.conclave.client.logic.MediaKind
import dev.conclave.client.sessionFile
import java.io.Closeable
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** One file in the viewer: what it is (a file card's facts) and where its bytes come from. */
internal class ViewerItem(val card: FileCardData, val load: suspend () -> ByteArray) {
    val key = "${card.toolUseId}:${card.image ?: -1}"
    val kind = Media.kind(card.mediaType, card.name)
}

/** A shared or generated file, fetched from the hub by its call id like the card does. */
internal fun FileCardData.viewerItem(hub: HubRepository, sessionId: String) =
    ViewerItem(this) { hub.api { it.sessionFile(sessionId, toolUseId, image) }.first }

/**
 * The in-app viewer (the web's file viewer): full screen on black, over
 * everything, in a Dialog like FullImage. The bar on top says the file's
 * name, type and size, with Share, Save and "Open with…" (the old
 * ACTION_VIEW) in its menu. A swipe moves between the files of the same
 * message (Media.pager). Pictures zoom with a pinch or a double tap and pan
 * when zoomed; a GIF or animated WebP plays (ImageDecoder, as the cards do);
 * a video plays in VideoView with the system's MediaController; a PDF is
 * its pages, drawn by PdfRenderer as they scroll in; text and code are the
 * app's CodeBox. Back or the arrow closes it.
 */
@Composable
internal fun MediaViewer(items: List<ViewerItem>, start: Int, onDismiss: () -> Unit) {
    if (items.isEmpty()) return
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val pager = rememberPagerState(initialPage = start.coerceIn(0, items.lastIndex)) { items.size }
        var zoomed by remember { mutableStateOf(false) }
        LaunchedEffect(pager.currentPage) { zoomed = false }
        val current = items[pager.currentPage.coerceIn(0, items.lastIndex)]
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            HorizontalPager(
                state = pager,
                modifier = Modifier.fillMaxSize(),
                // a zoomed picture pans; one at its own size swipes to the next
                userScrollEnabled = !zoomed,
                key = { items[it].key },
            ) { page ->
                ViewerPage(items[page], active = page == pager.settledPage, onZoom = { if (page == pager.currentPage) zoomed = it })
            }
            ViewerBar(current, if (items.size > 1) "${pager.currentPage + 1} of ${items.size}" else null, onDismiss, Modifier.align(Alignment.TopCenter))
        }
    }
}

private val BarHeight = 64.dp

/** The bar over the file: back, name, "PDF, 14.2 KB, 2 of 3", and the menu. */
@Composable
private fun ViewerBar(item: ViewerItem, position: String?, onBack: () -> Unit, modifier: Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val card = item.card
    var menu by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    // the file Save asked about, kept while the picker is open
    var saving by remember { mutableStateOf<ViewerItem?>(null) }
    fun run(target: ViewerItem, failed: String, done: String?, work: suspend (ByteArray) -> Unit) {
        if (busy) return
        busy = true
        scope.launch {
            val why = try {
                work(target.load())
                null
            } catch (e: CancellationException) {
                throw e
            } catch (_: ActivityNotFoundException) {
                "No app on this phone opens this file."
            } catch (e: Exception) {
                "$failed ${errorText(e)}"
            } finally {
                busy = false
            }
            (why ?: done)?.let { Toast.makeText(context, it, Toast.LENGTH_SHORT).show() }
        }
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(card.mediaType)) { uri ->
        val target = saving
        saving = null
        if (uri != null && target != null) {
            run(target, "Could not save the file.", "Saved") { bytes ->
                withContext(Dispatchers.IO) {
                    context.contentResolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw java.io.IOException("Could not write the file.")
                }
            }
        }
    }
    fun save() {
        val picture = FileCards.extension(card.mediaType) != null
        if (picture && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            run(item, "Could not save the picture.", "Saved to Pictures/Conclave") { bytes ->
                withContext(Dispatchers.IO) { saveToPictures(context, bytes, FileCards.pictureName(card.name, card.mediaType), card.mediaType) }
            }
        } else {
            saving = item
            pick.launch(FileCards.cacheName(card))
        }
    }
    fun share() = run(item, "Could not share the file.", null) { bytes ->
        val uri = sharedUri(context, item, bytes)
        val send = Intent(Intent.ACTION_SEND).setType(card.mediaType).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.startActivity(Intent.createChooser(send, "Share file"))
    }
    // the escape hatch: the app the phone has for this type, as the card's Open did before
    fun openWith() = run(item, "Could not get the file.", null) { bytes ->
        val uri = sharedUri(context, item, bytes)
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, card.mediaType).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.startActivity(Intent.createChooser(view, "Open with"))
    }
    TopAppBar(
        modifier = modifier,
        title = {
            Column {
                Text(card.title ?: card.name, style = ConclaveType.rowTitle, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    listOfNotNull(FileCards.facts(card), position).joinToString(", "),
                    style = ConclaveType.meta,
                    color = Color.White.copy(alpha = 0.7f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        },
        navigationIcon = {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Close viewer") }
        },
        actions = {
            Box {
                IconButton(onClick = { menu = true }, enabled = !busy) { Icon(Icons.Outlined.MoreVert, contentDescription = "More actions for ${card.name}") }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(
                        text = { Text("Share") },
                        leadingIcon = { Icon(Icons.Outlined.Share, contentDescription = null) },
                        onClick = { menu = false; share() },
                    )
                    DropdownMenuItem(
                        text = { Text("Save") },
                        leadingIcon = { Icon(Icons.Outlined.Download, contentDescription = null) },
                        onClick = { menu = false; save() },
                    )
                    DropdownMenuItem(
                        text = { Text("Open with…") },
                        leadingIcon = { Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = null) },
                        onClick = { menu = false; openWith() },
                    )
                }
            }
        },
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = Color.Black.copy(alpha = 0.6f),
            titleContentColor = Color.White,
            navigationIconContentColor = Color.White,
            actionIconContentColor = Color.White,
        ),
    )
}

/** The copy Share, Open with, the video player and the PDF reader use: the cache's shared/ folder, one folder per file. */
private suspend fun cacheCopy(context: Context, item: ViewerItem, bytes: ByteArray): File = withContext(Dispatchers.IO) {
    val folder = FileCards.cacheFolder(item.card) + (item.card.image?.let { "_$it" } ?: "")
    val dir = File(File(context.cacheDir, "shared"), folder).apply { mkdirs() }
    File(dir, FileCards.cacheName(item.card)).apply { writeBytes(bytes) }
}

private suspend fun sharedUri(context: Context, item: ViewerItem, bytes: ByteArray): Uri =
    FileProvider.getUriForFile(context, context.packageName + ".files", cacheCopy(context, item, bytes))

private sealed class Loaded {
    data object Loading : Loaded()
    class Ready(val bytes: ByteArray) : Loaded()
    class Failed(val why: String) : Loaded()
}

/** One page of the pager: the file's bytes, then the view for its kind. Only the pages on screen hold bytes. */
@Composable
private fun ViewerPage(item: ViewerItem, active: Boolean, onZoom: (Boolean) -> Unit) {
    val state by produceState<Loaded>(Loaded.Loading, item.key) {
        value = try {
            Loaded.Ready(item.load())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Loaded.Failed("Could not get the file. ${errorText(e)}")
        }
    }
    val name = item.card.title ?: item.card.name
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        when (val s = state) {
            Loaded.Loading -> CircularProgressIndicator(color = Color.White, modifier = Modifier.semantics { contentDescription = "Loading $name" })
            is Loaded.Failed -> Message(s.why)
            is Loaded.Ready -> when (item.kind) {
                MediaKind.IMAGE -> StillPage(s.bytes, name, active, onZoom)
                MediaKind.ANIMATED -> AnimatedPage(s.bytes, name, active, onZoom)
                MediaKind.SVG -> SvgPage(s.bytes, name)
                MediaKind.VIDEO -> VideoPage(item, s.bytes, name, active)
                MediaKind.PDF -> PdfPage(item, s.bytes, name)
                MediaKind.TEXT -> TextPage(s.bytes)
                null -> Message("This file cannot be shown here. Use Open with in the menu.")
            }
        }
    }
}

@Composable
private fun Message(text: String) {
    Text(text, style = ConclaveType.body, color = Color.White, textAlign = TextAlign.Center, modifier = Modifier.padding(24.dp))
}

/**
 * Pinch to zoom (1x to 5x), double tap to zoom in at the tap or back out,
 * and a pan while zoomed, kept inside the picture. At 1x a swipe goes to
 * the pager. Back to 1x when the page leaves the screen.
 */
@Composable
private fun Zoomable(active: Boolean, onZoom: (Boolean) -> Unit, description: String, content: @Composable (Modifier) -> Unit) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    var size by remember { mutableStateOf(IntSize.Zero) }
    val zoomChanged by rememberUpdatedState(onZoom)
    fun clamp(o: Offset, s: Float): Offset {
        val mx = size.width * (s - 1f) / 2f
        val my = size.height * (s - 1f) / 2f
        return Offset(o.x.coerceIn(-mx, mx), o.y.coerceIn(-my, my))
    }
    LaunchedEffect(active) {
        if (!active) {
            scale = 1f
            offset = Offset.Zero
        }
    }
    val isZoomed = scale > 1f
    LaunchedEffect(isZoomed) { zoomChanged(isZoomed) }
    val zoom = rememberTransformableState { z, pan, _ ->
        scale = (scale * z).coerceIn(1f, 5f)
        offset = if (scale == 1f) Offset.Zero else clamp(offset + pan, scale)
    }
    content(
        Modifier
            .fillMaxSize()
            .onSizeChanged { size = it }
            .pointerInput(Unit) {
                detectTapGestures(onDoubleTap = { p ->
                    if (scale > 1f) {
                        scale = 1f
                        offset = Offset.Zero
                    } else {
                        // the point tapped stays under the finger
                        val center = Offset(size.width / 2f, size.height / 2f)
                        scale = 2.5f
                        offset = clamp((center - p) * (scale - 1f), scale)
                    }
                })
            }
            .transformable(zoom, canPan = { scale > 1f })
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
                translationX = offset.x
                translationY = offset.y
            }
            .semantics { contentDescription = description },
    )
}

@Composable
private fun StillPage(bytes: ByteArray, name: String, active: Boolean, onZoom: (Boolean) -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        // sharp at 2x zoom, within a bitmap the phone can hold
        val target = (maxOf(constraints.maxWidth, constraints.maxHeight) * 2).coerceAtMost(4096)
        val bitmap by produceState<ImageBitmap?>(null, bytes, target) { value = withContext(Dispatchers.Default) { decodeScaled(bytes, target) } }
        val b = bitmap
        if (b == null) {
            CircularProgressIndicator(color = Color.White)
        } else {
            Zoomable(active, onZoom, name) { m -> Image(bitmap = b, contentDescription = null, contentScale = ContentScale.Fit, modifier = m) }
        }
    }
}

/** A GIF or WebP: plays on Android 9+ (AnimatedImageDrawable, as the cards do), its first frame below or when it is a still WebP. */
@Composable
private fun AnimatedPage(bytes: ByteArray, name: String, active: Boolean, onZoom: (Boolean) -> Unit) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return StillPage(bytes, name, active, onZoom)
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val target = maxOf(constraints.maxWidth, constraints.maxHeight)
        val drawable by produceState<Result<Drawable?>?>(null, bytes, target) { value = Result.success(withContext(Dispatchers.Default) { decodeAnimated(bytes, target) }) }
        val d = drawable ?: return@BoxWithConstraints CircularProgressIndicator(color = Color.White)
        val anim = d.getOrNull()
        if (anim == null) return@BoxWithConstraints StillPage(bytes, name, active, onZoom)
        DisposableEffect(anim, active) {
            if (active) (anim as? AnimatedImageDrawable)?.start() else (anim as? AnimatedImageDrawable)?.stop()
            onDispose { (anim as? AnimatedImageDrawable)?.stop() }
        }
        Zoomable(active, onZoom, name) { m ->
            AndroidView(
                factory = { ctx -> ImageView(ctx).apply { scaleType = ImageView.ScaleType.FIT_CENTER; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO } },
                update = { it.setImageDrawable(anim) },
                modifier = m,
            )
        }
    }
}

/** An SVG: the card's locked-down WebView (inertWebView), the whole screen. */
@Composable
private fun SvgPage(bytes: ByteArray, name: String) {
    if (bytes.size > FileCards.SVG_MAX) return Message("This drawing is too large to show here. Use Open with in the menu.")
    val page = remember(bytes) { FileCards.svgDocument(bytes, name) }
    AndroidView(
        factory = { ctx ->
            runCatching { inertWebView(ctx).apply { contentDescription = name; loadDataWithBaseURL(null, page, "text/html", "utf-8", null) } }.getOrElse { View(ctx) }
        },
        onRelease = { (it as? WebView)?.apply { stopLoading(); destroy() } },
        modifier = Modifier.fillMaxSize().statusBarsPadding().padding(top = BarHeight),
    )
}

/**
 * A video: the platform's VideoView with its MediaController (the app has
 * no media library), from the cache copy. It plays while its page is the
 * one on screen and pauses when it leaves.
 */
@Composable
private fun VideoPage(item: ViewerItem, bytes: ByteArray, name: String, active: Boolean) {
    val context = LocalContext.current
    val file by produceState<Result<File>?>(null, item.key) { value = runCatching { cacheCopy(context, item, bytes) } }
    val f = file ?: return CircularProgressIndicator(color = Color.White)
    val path = f.getOrNull() ?: return Message("Could not get the file ready. ${errorText(f.exceptionOrNull() ?: Exception())}")
    var failed by remember(item.key) { mutableStateOf(false) }
    var view by remember { mutableStateOf<VideoView?>(null) }
    LaunchedEffect(view, active) {
        val v = view ?: return@LaunchedEffect
        if (active) v.start() else v.pause()
    }
    if (failed) return Message("This phone cannot play this video. Use Open with in the menu.")
    AndroidView(
        factory = { ctx ->
            VideoView(ctx).apply {
                contentDescription = name
                val controls = MediaController(ctx)
                controls.setAnchorView(this)
                setMediaController(controls)
                setOnErrorListener { _, _, _ -> failed = true; true }
                setVideoURI(Uri.fromFile(path))
                view = this
            }
        },
        onRelease = { it.stopPlayback() },
        modifier = Modifier.fillMaxWidth(),
    )
}

/** A PDF opened by PdfRenderer. One page renders at a time (the renderer allows no more); closed when the page leaves. */
private class PdfDoc(file: File) : Closeable {
    private val fd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    private val renderer = try {
        PdfRenderer(fd)
    } catch (e: Exception) {
        fd.close()
        throw e
    }
    private var closed = false

    /** Every page's size in points, read up front so each row holds its place before it draws. */
    val sizes: List<IntSize> = synchronized(this) {
        (0 until renderer.pageCount).map { i -> renderer.openPage(i).use { IntSize(it.width, it.height) } }
    }

    fun render(page: Int, width: Int): ImageBitmap? = synchronized(this) {
        if (closed) return null
        renderer.openPage(page).use { p ->
            val height = (width.toLong() * p.height / p.width.coerceAtLeast(1)).toInt().coerceIn(1, 8192)
            val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            bmp.eraseColor(android.graphics.Color.WHITE)
            p.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            bmp.asImageBitmap()
        }
    }

    override fun close() = synchronized(this) {
        if (!closed) {
            closed = true
            renderer.close()
            fd.close()
        }
    }
}

@Composable
private fun PdfPage(item: ViewerItem, bytes: ByteArray, name: String) {
    val context = LocalContext.current
    val doc by produceState<Result<PdfDoc>?>(null, item.key) {
        val opened = withContext(Dispatchers.IO) { runCatching { PdfDoc(cacheCopy(context, item, bytes)) } }
        value = opened
        awaitDispose { opened.getOrNull()?.close() }
    }
    val d = doc ?: return CircularProgressIndicator(color = Color.White)
    val pdf = d.getOrNull() ?: return Message("Could not open this PDF. It may be locked with a password. Use Open with in the menu.")
    val count = pdf.sizes.size
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val width = constraints.maxWidth.coerceIn(1, 2048)
        LazyColumn(
            modifier = Modifier.fillMaxSize().statusBarsPadding().semantics { contentDescription = "$name, $count pages" },
            contentPadding = PaddingValues(start = 8.dp, end = 8.dp, top = BarHeight, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(count, key = { it }) { i ->
                val s = pdf.sizes[i]
                // the row has the page's shape before it draws: no jumps while scrolling
                Box(Modifier.fillMaxWidth().aspectRatio(s.width.coerceAtLeast(1).toFloat() / s.height.coerceAtLeast(1)).background(Color.White)) {
                    val bmp by produceState<ImageBitmap?>(null, i, width) { value = withContext(Dispatchers.IO) { runCatching { pdf.render(i, width) }.getOrNull() } }
                    bmp?.let { Image(bitmap = it, contentDescription = "Page ${i + 1} of $count", contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize()) }
                }
            }
        }
    }
}

/** Text or code: monospace in the app's CodeBox, scrolling both ways; the first Media.TEXT_MAX bytes of a bigger file. */
@Composable
private fun TextPage(bytes: ByteArray) {
    val text by produceState<String?>(null, bytes) {
        value = withContext(Dispatchers.Default) {
            if (bytes.size <= Media.TEXT_MAX) bytes.decodeToString()
            else bytes.copyOf(Media.TEXT_MAX.toInt()).decodeToString() + "\n\n[Only the first ${FileCards.sizeWords(Media.TEXT_MAX)} is shown. Use Open with in the menu for the rest.]"
        }
    }
    val t = text ?: return CircularProgressIndicator(color = Color.White)
    Column(Modifier.fillMaxSize().statusBarsPadding().padding(top = BarHeight).verticalScroll(rememberScrollState()).padding(12.dp)) {
        CodeBox(t)
    }
}
