package dev.conclave.app.update

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.Settings
import androidx.core.content.FileProvider
import dev.conclave.app.BuildConfig
import dev.conclave.app.data.TinkEd25519
import dev.conclave.client.update.AppUpdates
import dev.conclave.client.update.Minisign
import dev.conclave.client.update.SignatureException
import dev.conclave.client.update.UpdateArtifact
import dev.conclave.client.update.UpdateManifest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/** Where the app's own update stands (the dialog at app start, the account row's dot, Settings, About). */
sealed interface UpdateState {
    /** Up to date, or not checked yet. */
    data object Idle : UpdateState

    /** This build cannot check updates: why. */
    data class Off(val why: String) : UpdateState

    data class Available(val version: String, val notes: String, val apk: UpdateArtifact) : UpdateState

    /** A newer release the app cannot install itself (unsigned, no APK): why. */
    data class ByHand(val version: String, val why: String) : UpdateState

    data class Downloading(val version: String, val percent: Int) : UpdateState

    /** Downloaded and checked: the system installer opens; the person taps Install. */
    data class Ready(val version: String, val file: File) : UpdateState

    data class Failed(val version: String, val why: String, val apk: UpdateArtifact?) : UpdateState
}

/** The version waiting to be installed: offered, or downloaded and checked. Null otherwise. */
val UpdateState.waiting: String?
    get() = when (this) {
        is UpdateState.Available -> version
        is UpdateState.Ready -> version
        else -> null
    }

/**
 * The app's own updates (docs/DESIGN.md, Updates). On start and once a day it
 * reads conclave-update.json on the public releases. A newer, signed APK is
 * downloaded with DownloadManager into the app's own folder, checked for
 * size, SHA-256 and its minisign signature (the key in BuildConfig, from
 * packages/core/src/update/update-key.pub), and handed to the system
 * installer. Android asks the person to allow this app to install apps once
 * (REQUEST_INSTALL_PACKAGES) and to tap Install, as it does for every
 * sideloaded app; the release APK is signed with the same key as the one
 * installed, so it updates in place and keeps the pairing.
 *
 * The last manifest read is kept, so an update found earlier is offered
 * again at the next start without waiting for the next look. Whether it
 * asks (Skip this version, Don't show at startup) is in the settings store
 * (data/SettingsStore.kt, client UpdatePrompt).
 */
class AppUpdater(private val context: Context, private val scope: CoroutineScope) {
    private val key = Minisign.readKey(BuildConfig.UPDATE_KEY)
    private val prefs = context.getSharedPreferences("updates", Context.MODE_PRIVATE)
    private val http = OkHttpClient.Builder().callTimeout(30, TimeUnit.SECONDS).build()
    private val _state = MutableStateFlow(stateOf(saved()))
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    private var job: Job? = null

    /** On start and when the app comes back: look when a day has passed since the last look. */
    fun checkIfDue() {
        if (System.currentTimeMillis() - prefs.getLong(CHECKED_AT, 0L) >= AppUpdates.EVERY_MS) check()
    }

    /** Look at the newest release now. */
    fun check() {
        if (job?.isActive == true) return
        val s = _state.value
        if (s is UpdateState.Downloading || s is UpdateState.Ready) return
        job = scope.launch {
            val text = withContext(Dispatchers.IO) {
                try {
                    val req = Request.Builder().url(AppUpdates.MANIFEST_URL).header("User-Agent", "conclave-android/${BuildConfig.VERSION_NAME}").build()
                    http.newCall(req).execute().use { res -> if (res.isSuccessful) res.body.string() else null }
                } catch (_: Exception) {
                    null
                }
            }
            val m = text?.let { AppUpdates.parse(it) }
            // a manifest that reads is kept for the next start
            val edit = prefs.edit().putLong(CHECKED_AT, System.currentTimeMillis())
            if (m != null) edit.putString(MANIFEST, text)
            edit.apply()
            if (m != null) _state.value = stateOf(m)
        }
    }

    /** The manifest read last, if any. */
    private fun saved(): UpdateManifest? {
        val text: String = prefs.getString(MANIFEST, null) ?: return null
        return AppUpdates.parse(text)
    }

    /** What a manifest offers this build; Idle (or Off without a key) when it is up to date or there is none. */
    private fun stateOf(m: UpdateManifest?): UpdateState = when (val o = m?.let { AppUpdates.offer(it, BuildConfig.VERSION_NAME, key) }) {
        null -> if (key == null) UpdateState.Off(Minisign.NO_KEY) else UpdateState.Idle
        is AppUpdates.Offer.Install -> UpdateState.Available(o.version, o.notes, o.apk)
        is AppUpdates.Offer.ByHand -> UpdateState.ByHand(o.version, o.why)
    }

    /** Download, check, and open the system installer. */
    fun install(version: String, apk: UpdateArtifact) {
        val k = key ?: return
        if (_state.value is UpdateState.Downloading) return
        job?.cancel()
        job = scope.launch {
            _state.value = UpdateState.Downloading(version, 0)
            try {
                val file = download(version, apk)
                withContext(Dispatchers.IO) { AppUpdates.verify(file.inputStream(), apk, k, TinkEd25519) }
                _state.value = UpdateState.Ready(version, file)
                openInstaller(file)
            } catch (e: SignatureException) {
                _state.value = UpdateState.Failed(version, e.message ?: "The download did not check out.", apk)
            } catch (e: Exception) {
                _state.value = UpdateState.Failed(version, e.message ?: "The download stopped. Try again.", apk)
            }
        }
    }

    private suspend fun download(version: String, apk: UpdateArtifact): File {
        val name = apk.file.filter { it.isLetterOrDigit() || it == '.' || it == '-' || it == '_' }.ifEmpty { "conclave.apk" }
        val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: throw IllegalStateException("This phone has no room for downloads right now.")
        val file = File(dir, name)
        // an older try, or an older version: never installed from here
        dir.listFiles()?.filter { it.name.endsWith(".apk") }?.forEach { it.delete() }
        val dm = context.getSystemService(DownloadManager::class.java) ?: throw IllegalStateException("Downloads are not available on this phone.")
        val request = DownloadManager.Request(Uri.parse(apk.url))
            .setTitle("Conclave $version")
            .setDescription("Update")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
            .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, name)
        val id = dm.enqueue(request)
        while (true) {
            delay(700)
            val cursor = dm.query(DownloadManager.Query().setFilterById(id)) ?: throw IllegalStateException("The download was cancelled.")
            cursor.use { c ->
                if (!c.moveToFirst()) throw IllegalStateException("The download was cancelled.")
                when (c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))) {
                    DownloadManager.STATUS_SUCCESSFUL -> return file
                    DownloadManager.STATUS_FAILED -> {
                        dm.remove(id)
                        throw IllegalStateException("The download failed. Check the connection and try again.")
                    }
                    else -> {
                        val done = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                        val percent = if (apk.size > 0) ((done * 100) / apk.size).toInt().coerceIn(0, 100) else 0
                        _state.value = UpdateState.Downloading(version, percent)
                    }
                }
            }
        }
    }

    /**
     * The system installer for a checked APK. Without the install permission
     * Android's own screen to allow it opens first; Install again after that.
     * Returns false when it opened that screen.
     */
    fun openInstaller(file: File): Boolean {
        if (!context.packageManager.canRequestPackageInstalls()) {
            val allow = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            runCatching { context.startActivity(allow) }
            return false
        }
        val uri = FileProvider.getUriForFile(context, context.packageName + ".files", file)
        val view = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching { context.startActivity(view) }.isSuccess
    }

    companion object {
        private const val CHECKED_AT = "checkedAt"
        private const val MANIFEST = "manifest"
    }
}
