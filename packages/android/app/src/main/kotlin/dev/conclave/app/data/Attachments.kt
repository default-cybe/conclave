package dev.conclave.app.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import dev.conclave.client.logic.Attach
import dev.conclave.client.model.Attachment
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.Base64

/** Turns content URIs (photo picker, camera, share sheet) into base64 attachments. */
object Attachments {
    private const val MAX_EDGE = 1600
    private const val MAX_BYTES = 8 * 1024 * 1024

    suspend fun fromUri(context: Context, uri: Uri): Attachment = withContext(Dispatchers.IO) {
        val resolver = context.contentResolver
        val type = resolver.getType(uri) ?: "application/octet-stream"
        val name = displayName(context, uri)
        if (type.startsWith("image/") && type != "image/gif") {
            val jpeg = downscaleImage(context, uri)
            Attachment(mediaType = "image/jpeg", data = Base64.getEncoder().encodeToString(jpeg), name = name)
        } else {
            val bytes = resolver.openInputStream(uri)?.use { readAtMost(it, name) } ?: throw IOException("Cannot read $name")
            // a zip some app hands over as octet-stream goes as a zip: the hub unpacks it
            Attachment(mediaType = Attach.mediaTypeOf(type, name), data = Base64.getEncoder().encodeToString(bytes), name = name)
        }
    }

    /** The whole stream, or an error as soon as it passes [MAX_BYTES]: a large file never sits in memory whole. */
    private fun readAtMost(input: InputStream, name: String): ByteArray {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) return out.toByteArray()
            out.write(buf, 0, n)
            if (out.size() > MAX_BYTES) throw IOException("$name is larger than 8 MB")
        }
    }

    private fun displayName(context: Context, uri: Uri): String {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                val idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (idx >= 0) c.getString(idx)?.let { return it }
            }
        }
        return uri.lastPathSegment ?: "attachment"
    }

    /** Decodes with subsampling, scales the long edge to [MAX_EDGE] and re-encodes as JPEG. */
    private fun downscaleImage(context: Context, uri: Uri): ByteArray {
        val resolver = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        var sample = 1
        val longEdge = maxOf(bounds.outWidth, bounds.outHeight)
        while (longEdge / (sample * 2) >= MAX_EDGE) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        val decoded = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) }
            ?: throw IOException("Cannot decode image")
        val scale = MAX_EDGE.toFloat() / maxOf(decoded.width, decoded.height)
        val bitmap = if (scale < 1f) {
            Bitmap.createScaledBitmap(decoded, (decoded.width * scale).toInt(), (decoded.height * scale).toInt(), true)
        } else {
            decoded
        }
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out)
        if (bitmap !== decoded) bitmap.recycle()
        decoded.recycle()
        return out.toByteArray()
    }
}
