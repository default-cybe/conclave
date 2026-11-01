package dev.conclave.app.ui.pairing

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The scanner frame on Connect: the camera inside a rounded square with
 * violet corner marks, reporting the first QR code it reads. Without camera
 * access it shows the mark and "Point at the code" with Allow camera. A new
 * [androidx.compose.runtime.key] around it scans again.
 */
@Composable
fun QrFrame(onResult: (String) -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val currentOnResult by rememberUpdatedState(onResult)
    val c = Conclave.colors
    var granted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    // the camera or the code reader could not start: say so, the address form still works
    var failed by remember { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    LaunchedEffect(Unit) {
        if (!granted) permission.launch(Manifest.permission.CAMERA)
    }
    val shape = RoundedCornerShape(28.dp)
    Box(modifier.clip(shape).background(c.bgSunk).border(1.dp, c.rule, shape), contentAlignment = Alignment.Center) {
        if (failed) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Outlined.QrCodeScanner, contentDescription = null, tint = c.fg3, modifier = Modifier.size(32.dp))
                Spacer(Modifier.height(10.dp))
                Text("The scanner did not start", style = ConclaveType.body, color = c.fg3)
                Spacer(Modifier.height(4.dp))
                Text("Type the address and code instead", style = ConclaveType.body, color = c.fg3)
            }
        } else if (granted) {
            val holder = remember { ScannerHolder() }
            DisposableEffect(Unit) {
                onDispose { holder.release() }
            }
            AndroidView(
                factory = { ctx ->
                    PreviewView(ctx).also { view ->
                        // a TextureView, so the rounded clip applies to the picture too
                        view.implementationMode = PreviewView.ImplementationMode.COMPATIBLE
                        holder.bind(ctx, lifecycleOwner, view, onFailed = { failed = true }) { value -> currentOnResult(value) }
                    }
                },
                modifier = Modifier.matchParentSize(),
            )
        } else {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(Icons.Outlined.QrCodeScanner, contentDescription = null, tint = c.fg3, modifier = Modifier.size(32.dp))
                Spacer(Modifier.height(10.dp))
                Text("Point at the code", style = ConclaveType.body, color = c.fg3)
                Spacer(Modifier.height(4.dp))
                TextButton(onClick = { permission.launch(Manifest.permission.CAMERA) }) {
                    Text("Allow camera", style = ConclaveType.button, color = c.signal)
                }
            }
        }
        val accent = c.signal
        Canvas(Modifier.matchParentSize()) { corners(accent) }
    }
}

/** Four rounded corner marks, 40dp in from the edges, 44dp long. */
private fun DrawScope.corners(color: Color) {
    val inset = 40.dp.toPx()
    val len = 44.dp.toPx()
    val r = 14.dp.toPx()
    val w = 3.dp.toPx()
    val right = size.width - inset
    val bottom = size.height - inset
    val arc = Size(2 * r, 2 * r)
    val stroke = Stroke(width = w)
    // top left
    drawArc(color, 180f, 90f, false, Offset(inset, inset), arc, style = stroke)
    drawLine(color, Offset(inset, inset + r), Offset(inset, inset + len), w)
    drawLine(color, Offset(inset + r, inset), Offset(inset + len, inset), w)
    // top right
    drawArc(color, 270f, 90f, false, Offset(right - 2 * r, inset), arc, style = stroke)
    drawLine(color, Offset(right, inset + r), Offset(right, inset + len), w)
    drawLine(color, Offset(right - r, inset), Offset(right - len, inset), w)
    // bottom left
    drawArc(color, 90f, 90f, false, Offset(inset, bottom - 2 * r), arc, style = stroke)
    drawLine(color, Offset(inset, bottom - r), Offset(inset, bottom - len), w)
    drawLine(color, Offset(inset + r, bottom), Offset(inset + len, bottom), w)
    // bottom right
    drawArc(color, 0f, 90f, false, Offset(right - 2 * r, bottom - 2 * r), arc, style = stroke)
    drawLine(color, Offset(right, bottom - r), Offset(right, bottom - len), w)
    drawLine(color, Offset(right - r, bottom), Offset(right - len, bottom), w)
}

/** Owns the CameraX use cases and the ML Kit scanner for one scanner session. */
private class ScannerHolder {
    private var provider: ProcessCameraProvider? = null
    private var scanner: BarcodeScanner? = null
    private val done = AtomicBoolean(false)
    private val released = AtomicBoolean(false)

    fun bind(context: Context, owner: LifecycleOwner, view: PreviewView, onFailed: () -> Unit, onResult: (String) -> Unit) {
        val future = ProcessCameraProvider.getInstance(context)
        val mainExecutor = ContextCompat.getMainExecutor(context)
        future.addListener({
            if (released.get()) return@addListener
            // this runs on the main thread: anything it throws would close the app
            try {
                start(future.get(), owner, view, mainExecutor, onResult)
            } catch (_: Throwable) {
                release()
                onFailed()
            }
        }, mainExecutor)
    }

    private fun start(
        cameraProvider: ProcessCameraProvider,
        owner: LifecycleOwner,
        view: PreviewView,
        mainExecutor: java.util.concurrent.Executor,
        onResult: (String) -> Unit,
    ) {
        provider = cameraProvider
        val options = BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()
        val client = BarcodeScanning.getClient(options)
        scanner = client
        val preview = Preview.Builder().build()
        preview.setSurfaceProvider(view.surfaceProvider)
        val analysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .build()
        analysis.setAnalyzer(mainExecutor) { proxy -> analyze(client, proxy, onResult) }
        try {
            cameraProvider.unbindAll()
            cameraProvider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        } catch (_: Exception) {
            // No usable back camera. The address form still works.
        }
    }

    @androidx.annotation.OptIn(ExperimentalGetImage::class)
    private fun analyze(client: BarcodeScanner, proxy: ImageProxy, onResult: (String) -> Unit) {
        val media = proxy.image
        if (media == null || done.get()) {
            proxy.close()
            return
        }
        val input = InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
        client.process(input)
            .addOnSuccessListener { codes ->
                val value = codes.firstNotNullOfOrNull { it.rawValue }
                if (value != null && done.compareAndSet(false, true)) onResult(value)
            }
            .addOnCompleteListener { proxy.close() }
    }

    fun release() {
        released.set(true)
        provider?.unbindAll()
        scanner?.close()
    }
}
