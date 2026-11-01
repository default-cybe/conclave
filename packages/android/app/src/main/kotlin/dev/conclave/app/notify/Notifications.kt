package dev.conclave.app.notify

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import dev.conclave.app.MainActivity
import dev.conclave.app.R
import android.provider.Settings
import dev.conclave.client.logic.DeepLink
import dev.conclave.client.model.Notice

/** What a system notification says: a hub notice (from the background connection) or a local one. */
data class NoticePayload(
    val title: String = "Conclave",
    val body: String = "",
    val link: String? = null,
    val approvalId: String? = null,
    val sessionId: String? = null,
    val level: String? = null,
    val thread: String? = null,
) {
    companion object {
        fun of(n: Notice) = NoticePayload(n.title.ifBlank { "Conclave" }, n.body, n.link, n.approvalId, n.sessionId, n.level, n.thread)
    }
}

object Notifications {
    const val CHANNEL_APPROVALS = "approvals"
    const val CHANNEL_SESSIONS = "sessions"
    const val CHANNEL_LIMITS = "limits"
    const val CHANNEL_ROUTINES = "routines"
    const val CHANNEL_MEETINGS = "meetings"
    const val CHANNEL_LIVE = "live"

    const val LIVE_NOTIFICATION_ID = 1

    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        val channels = listOf(
            NotificationChannel(CHANNEL_APPROVALS, "Approvals", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Tool calls waiting for your decision"
            },
            NotificationChannel(CHANNEL_SESSIONS, "Sessions", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "A chat finished or needs input"
            },
            NotificationChannel(CHANNEL_LIMITS, "Limit resets", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Usage limits hit or reset"
            },
            NotificationChannel(CHANNEL_ROUTINES, "Routines", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Scheduled routine results"
            },
            // a reminder is time bound: it makes a sound, as an approval does
            NotificationChannel(CHANNEL_MEETINGS, "Meeting reminders", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Reminders before a scheduled meeting, and when it starts"
            },
            // the ongoing notice Android needs for the background connection; the owner can hide this category
            NotificationChannel(CHANNEL_LIVE, "Background connection", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Shown while Conclave stays connected to your hub. Turn this category off to hide it; notifications still arrive."
                setShowBadge(false)
            },
        )
        nm.createNotificationChannels(channels)
    }

    fun canPost(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    fun approvalNotificationId(approvalId: String): Int = 0x10000 or (approvalId.hashCode() and 0xFFFF)

    private fun openIntent(context: Context, link: String?, requestCode: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            if (link != null) data = Uri.parse(link)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        return PendingIntent.getActivity(
            context, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun actionIntent(context: Context, approvalId: String, decision: String, notificationId: Int): PendingIntent {
        val intent = Intent(context, ApprovalActionReceiver::class.java).apply {
            action = ApprovalActionReceiver.ACTION
            putExtra(ApprovalActionReceiver.EXTRA_APPROVAL_ID, approvalId)
            putExtra(ApprovalActionReceiver.EXTRA_DECISION, decision)
            putExtra(ApprovalActionReceiver.EXTRA_NOTIFICATION_ID, notificationId)
        }
        return PendingIntent.getBroadcast(
            context, (approvalId + decision).hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun sessionLink(sessionId: String?): String? = sessionId?.let { "conclave://session/$it" }

    /** Hub links are app paths like "/s/<id>" or "/workflows/runs/<id>": MainActivity reads them as they are. Others open the session. */
    private fun normalizeLink(link: String?, sessionId: String?): String? =
        link?.takeIf { DeepLink.parse(it) != null } ?: sessionLink(sessionId)

    @SuppressLint("MissingPermission")
    private fun post(context: Context, id: Int, builder: NotificationCompat.Builder) {
        if (!canPost(context)) return
        NotificationManagerCompat.from(context).notify(id, builder.build())
    }

    fun showApproval(context: Context, approvalId: String, title: String, body: String, sessionId: String?) {
        val id = approvalNotificationId(approvalId)
        val link = sessionLink(sessionId) ?: "conclave://approvals"
        val builder = NotificationCompat.Builder(context, CHANNEL_APPROVALS)
            .setSmallIcon(R.drawable.ic_stat_conclave)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openIntent(context, link, id))
            .addAction(
                // approving runs a tool on the owner's machine: from a locked phone only after unlocking (Android 12+)
                NotificationCompat.Action.Builder(0, "Approve", actionIntent(context, approvalId, ApprovalActionReceiver.DECISION_ALLOW, id))
                    .setAuthenticationRequired(true)
                    .build(),
            )
            .addAction(0, "Deny", actionIntent(context, approvalId, ApprovalActionReceiver.DECISION_DENY, id))
        post(context, id, builder)
    }

    /** Replaces the approval notification with the outcome, then lets it time out. */
    fun showApprovalOutcome(context: Context, notificationId: Int, text: String) {
        val builder = NotificationCompat.Builder(context, CHANNEL_APPROVALS)
            .setSmallIcon(R.drawable.ic_stat_conclave)
            .setContentTitle(text)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setAutoCancel(true)
            .setTimeoutAfter(4_000)
        post(context, notificationId, builder)
    }

    fun cancel(context: Context, id: Int) {
        NotificationManagerCompat.from(context).cancel(id)
    }

    /** A hub notice from the background connection. Picks the channel from the content. */
    fun showNotice(context: Context, payload: NoticePayload) {
        if (payload.approvalId != null) {
            // the link names the chat the card shows in (a subagent's request is its chat's), the session the one that asks
            showApproval(context, payload.approvalId, payload.title, payload.body, sessionFromLink(payload.link) ?: payload.sessionId)
            return
        }
        val text = (payload.title + " " + payload.body).lowercase()
        val channel = when {
            DeepLink.parse(payload.link) is DeepLink.Meetings -> CHANNEL_MEETINGS
            "limit" in text || "reset" in text || "quota" in text -> CHANNEL_LIMITS
            "routine" in text -> CHANNEL_ROUTINES
            else -> CHANNEL_SESSIONS
        }
        // a job's notices share an id, so each replaces the last
        val id = (payload.thread ?: (payload.title + payload.body + (payload.link ?: ""))).hashCode()
        val builder = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_conclave)
            .setContentTitle(payload.title)
            .setContentText(payload.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(payload.body))
            .setAutoCancel(true)
            .setContentIntent(openIntent(context, normalizeLink(payload.link, payload.sessionId), id))
        post(context, id, builder)
    }

    /** The session a hub link opens: /s/<id> or /chat/<id>. */
    fun sessionFromLink(link: String?): String? = when (val l = DeepLink.parse(link)) {
        is DeepLink.Session -> l.id
        is DeepLink.Chat -> l.id
        else -> null
    }

    /** Send a test: a local notification, as the hub's would look. The hub's own test only reaches browsers. */
    fun showTest(context: Context): Boolean {
        if (!canPost(context)) return false
        showNotice(
            context,
            NoticePayload(title = "Conclave", body = "Notifications work. Finished work and approvals show up like this."),
        )
        return true
    }

    /** The system screen for one notification category, where the owner can turn it off. */
    fun channelSettings(context: Context, channel: String): Intent =
        Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            .putExtra(Settings.EXTRA_CHANNEL_ID, channel)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /**
     * The quiet ongoing notice of the background connection (Android needs one
     * for a foreground service). Lowest importance: no sound, no status bar
     * icon. "Hide" opens the category in system settings.
     */
    fun liveNotification(context: Context, text: String): android.app.Notification {
        val hide = PendingIntent.getActivity(
            context, LIVE_NOTIFICATION_ID + 1, channelSettings(context, CHANNEL_LIVE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(context, CHANNEL_LIVE)
            .setSmallIcon(R.drawable.ic_stat_conclave)
            .setContentTitle(text)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setLocalOnly(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED)
            .setContentIntent(openIntent(context, null, LIVE_NOTIFICATION_ID))
            .addAction(0, "Hide", hide)
            .build()
    }
}
