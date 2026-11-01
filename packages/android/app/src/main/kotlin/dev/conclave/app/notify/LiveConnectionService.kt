package dev.conclave.app.notify

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import dev.conclave.app.container
import dev.conclave.app.data.AuthState
import dev.conclave.app.data.HubProblem
import dev.conclave.client.ConnectionState
import dev.conclave.client.model.EngineEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * The background connection: how notifications reach this phone, with no
 * push service in between. A foreground service keeps the WebSocket to the
 * owner's hub open while the app is closed and turns the hub's notices into
 * system notifications.
 *
 * Only notices the hub marks `alert` become notifications: those passed the
 * owner's rules (Settings, Notifications on the hub) and were not held
 * because someone is using Conclave. An approval gets Approve and Deny.
 *
 * Battery: the socket waits while there is no network, retries with a
 * longer backoff in the background, sends no frames of its own there (the
 * hub knows it is in the background through presence), and the service
 * stops when the owner signs out or turns Notify this device off. Its
 * ongoing notice sits in the lowest importance category, which the owner
 * can hide in system settings.
 */
class LiveConnectionService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var release: (() -> Unit)? = null
    private var shown: String? = null
    private var started = false

    override fun onBind(intent: Intent?): IBinder? = null

    private fun goForeground(text: String): Boolean {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else {
            0
        }
        return try {
            ServiceCompat.startForeground(this, Notifications.LIVE_NOTIFICATION_ID, Notifications.liveNotification(this, text), type)
            shown = text
            true
        } catch (e: Exception) {
            // Android 12+ refuses to start a foreground service from the background
            // (for example after a sticky restart). Stop quietly; opening the app starts it again.
            stopSelf()
            false
        }
    }

    override fun onCreate() {
        super.onCreate()
        if (goForeground("Connecting to your hub")) begin()
    }

    /** Hold the connection and watch it, once the service is in the foreground. */
    private fun begin() {
        if (started) return
        started = true
        val c = container
        val hub = c.hub
        release = hub.acquireLive()
        // the ongoing line says where things stand; it changes only when that does
        scope.launch {
            combine(hub.connection, hub.problem, hub.hubInfo) { state, problem, info ->
                val name = info?.name?.ifBlank { null } ?: "your hub"
                when {
                    problem == HubProblem.NoNetwork -> "Waiting for a network"
                    problem is HubProblem.Rejected -> "Pair again to get notifications"
                    problem is HubProblem.NotYourHub -> "Not connected: this address is not your hub"
                    state == ConnectionState.OPEN -> "Connected to $name"
                    state == ConnectionState.CONNECTING -> "Connecting to $name"
                    else -> "Can't reach $name, retrying"
                }
            }.distinctUntilChanged().collect { text -> if (text != shown) goForeground(text) }
        }
        scope.launch { hub.events.collect { event -> onEvent(event) } }
        // signed out, or Notify this device turned off: stop
        scope.launch {
            hub.auth.first { it is AuthState.Unpaired }
            stopSelf()
        }
        scope.launch {
            c.settings.state.filterNotNull().first { !it.notifyDevice }
            stopSelf()
        }
    }

    private fun onEvent(event: EngineEvent) {
        val c = container
        when (event) {
            is EngineEvent.NoticeEvent -> {
                val n = event.notice
                // the hub's rules and its hold already decided; while the app is on screen the owner sees it there
                if (!n.alert || c.hub.visible.value) return
                val payload = NoticePayload.of(n)
                val approval = n.approvalId
                if (approval != null) {
                    // a subagent's approval opens the chat it shows in (its link), not the subagent
                    Notifications.showApproval(this, approval, payload.title, payload.body, Notifications.sessionFromLink(n.link) ?: n.sessionId)
                    c.appScope.launch { c.settings.addNotifiedApproval(approval) }
                } else {
                    Notifications.showNotice(this, payload)
                }
            }
            // answered here, on the web or by the agent: the notification goes
            is EngineEvent.ApprovalResolved -> Notifications.cancel(this, Notifications.approvalNotificationId(event.id))
            else -> Unit
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // every startForegroundService call must be followed by startForeground
        if (!goForeground(shown ?: "Connecting to your hub")) return START_NOT_STICKY
        begin()
        return START_STICKY
    }

    override fun onDestroy() {
        release?.invoke()
        release = null
        scope.cancel()
        super.onDestroy()
    }
}
