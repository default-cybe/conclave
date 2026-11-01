package dev.conclave.app

import android.app.Application
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import dev.conclave.app.data.AuthState
import dev.conclave.app.data.HubRepository
import dev.conclave.app.data.NetworkMonitor
import dev.conclave.app.data.SecureTokenStore
import dev.conclave.app.data.SettingsStore
import dev.conclave.app.notify.LiveConnectionService
import dev.conclave.app.notify.Notifications
import dev.conclave.app.notify.RefreshWorker
import dev.conclave.app.update.AppUpdater
import dev.conclave.client.logic.DraftStore
import dev.conclave.client.model.EngineEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.io.File
import java.util.concurrent.TimeUnit

/** Process-wide objects. Built once in [ConclaveApp.onCreate]. */
class AppContainer(context: Context) {
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val settings = SettingsStore(context, appScope)
    val tokens = SecureTokenStore(context)
    val network = NetworkMonitor(context)
    val hub = HubRepository(appScope, settings, tokens, network.online, network.changes)
    /** The app's own updates from the public releases (update/AppUpdater.kt). */
    val updates = AppUpdater(context, appScope)
    /** Each chat's unsent composer text and files, until sent, the chat is deleted, or sign out. */
    val drafts = DraftStore(File(context.filesDir, "drafts"))

    init {
        // shortcut: a chat deleted while this phone was offline keeps its draft file, sign out clears it
        appScope.launch { hub.events.collect { if (it is EngineEvent.SessionDeleted) drafts.clear(it.sessionId) } }
    }
}

class ConclaveApp : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        Notifications.createChannels(this)
        container.network.start()
        container.hub.start()
        schedulePeriodicRefresh()
        container.updates.checkIfDue(coldStart = true)
    }

    private fun schedulePeriodicRefresh() {
        val request = PeriodicWorkRequestBuilder<RefreshWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(this)
            .enqueueUniquePeriodicWork(RefreshWorker.NAME, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    /** Forgets the hub: the background connection, the addresses and the encrypted token. */
    suspend fun signOut() {
        setLiveService(false)
        container.hub.unpair()
        withContext(Dispatchers.IO) { container.drafts.clearAll() }
    }

    /**
     * Runs the background connection when it should run: paired, Notify this
     * device on, and notifications allowed (without them it would only cost
     * battery). Stops it otherwise.
     */
    suspend fun syncBackground() {
        val auth = container.hub.auth.first { it !is AuthState.Loading }
        val s = container.settings.current()
        setLiveService(auth is AuthState.Paired && s.notifyDevice && Notifications.canPost(this))
    }

    /** Starts or stops the background connection service. */
    fun setLiveService(on: Boolean) {
        val intent = Intent(this, LiveConnectionService::class.java)
        if (on) {
            try {
                ContextCompat.startForegroundService(this, intent)
            } catch (_: Exception) {
                // not allowed from the background right now; the next app start runs it
            }
        } else {
            stopService(intent)
        }
    }
}

val Context.container: AppContainer
    get() = (applicationContext as ConclaveApp).container
