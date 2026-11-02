package dev.conclave.app.widgets

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import dev.conclave.app.container
import dev.conclave.client.ConclaveApiException
import dev.conclave.client.alerts
import dev.conclave.client.logic.WidgetAccount
import dev.conclave.client.logic.WidgetWords
import dev.conclave.client.today
import java.time.ZoneId
import java.util.TimeZone
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope

/**
 * Reads the signed-in account's usage, Inbox and day for the home-screen
 * widgets, with that account's own token: a member's widgets show only what
 * the hub gives that member. Runs from WorkManager only (Widgets.kt), never
 * from a loop or a socket of its own.
 */
class WidgetWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = coroutineScope {
        val ctx = applicationContext
        if (!Widgets.installed(ctx)) return@coroutineScope Result.success()
        val client = ctx.container.hub.awaitClient() ?: return@coroutineScope Result.success()
        val key = WidgetAccount.key(client.token) ?: return@coroutineScope Result.success()
        val now = System.currentTimeMillis()
        val from = WidgetWords.dayStart(now, ZoneId.systemDefault())
        // same sign as JavaScript's Date.getTimezoneOffset(), as the Usage page sends it
        val tzOffset = -TimeZone.getDefault().getOffset(now) / 60_000

        val usage = async { runCatching { client.usage(from = from, to = now, tzOffset = tzOffset) } }
        val limits = async { runCatching { client.limits() } }
        val approvals = async { runCatching { client.approvals() } }
        val questions = async { runCatching { client.questions() } }
        val alerts = async { runCatching { client.alerts() } }
        val today = async { runCatching { client.today() } }
        val results = listOf(usage, limits, approvals, questions, alerts, today).map { it.await() }
        val failures = results.mapNotNull { it.exceptionOrNull() }

        val u = usage.await().getOrNull()
        val l = limits.await().getOrNull()
        val a = approvals.await().getOrNull()
        val q = questions.await().getOrNull()
        val t = today.await().getOrNull()
        // a page that could not load keeps what it showed, so a short outage does not blank the home screen
        val old = Widgets.pages(ctx)
        val pages = listOf(
            if (u != null && l != null) WidgetWords.usage(u, l) else old.getOrNull(0) ?: WidgetWords.unavailable("Usage", WidgetWords.USAGE),
            // alerts and proposals are extras: approvals and questions are what the Inbox count needs
            if (a != null && q != null) WidgetWords.inbox(a, q, alerts.await().getOrNull().orEmpty(), t, now)
            else old.getOrNull(1) ?: WidgetWords.unavailable("Inbox", WidgetWords.INBOX),
            if (t != null) WidgetWords.calendar(t, now) else old.getOrNull(2) ?: WidgetWords.unavailable("Calendar", WidgetWords.TODAY),
        )
        // the account may have changed while the calls ran: publish drops a reply for another one
        Widgets.publish(ctx, key, pages)

        val rejected = failures.any { it is ConclaveApiException && (it.status == 401 || it.status == 403) }
        if (failures.size == results.size && !rejected) Result.retry() else Result.success()
    }

    companion object {
        const val NAME = "conclave-widgets"
        const val PERIODIC = "conclave-widgets-periodic"
    }
}
