package dev.conclave.app.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import dev.conclave.app.MainActivity
import dev.conclave.app.R
import dev.conclave.app.container
import dev.conclave.app.data.AuthState
import dev.conclave.client.logic.WidgetAccount
import dev.conclave.client.logic.WidgetPage
import dev.conclave.client.logic.WidgetWords
import java.util.concurrent.TimeUnit

/** Usage: plan limits and today's tokens. */
class UsageWidget : ConclaveWidget()

/** Inbox: what waits on you, the first three open their item. */
class InboxWidget : ConclaveWidget()

/** Calendar: today's next three events. */
class CalendarWidget : ConclaveWidget()

/** Usage, Inbox and Calendar in one widget the launcher swipes through. */
class CombinedWidget : ConclaveWidget()

/** RemoteViews: works from API 26 without a new UI dependency. */
open class ConclaveWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        Widgets.render(context)
        Widgets.request(context)
    }

    override fun onEnabled(context: Context) = Widgets.schedule(context)

    override fun onDisabled(context: Context) = Widgets.schedule(context)
}

/**
 * The home-screen widgets. Their pages live in memory for the signed-in
 * account only ([WidgetAccount]): another account, or signing out, clears
 * them. WorkManager refreshes them every 30 minutes while one is on the home
 * screen, and 10 seconds after a burst of live events or leaving the app.
 */
object Widgets {
    private val snapshot = WidgetAccount()
    private val providers = listOf(UsageWidget::class.java, InboxWidget::class.java, CalendarWidget::class.java, CombinedWidget::class.java)
    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    private fun ids(context: Context, provider: Class<*>): IntArray =
        AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, provider))

    fun installed(context: Context): Boolean = providers.any { ids(context, it).isNotEmpty() }

    /**
     * The 30-minute refresh while a widget is placed, gone with the last one.
     * shortcut: keeping periodic work enqueued also stops WorkManager's
     * component toggle from looping onUpdate, the known widget pitfall.
     */
    fun schedule(context: Context) {
        val work = WorkManager.getInstance(context)
        if (!installed(context)) {
            work.cancelUniqueWork(WidgetWorker.PERIODIC)
            return
        }
        val request = PeriodicWorkRequestBuilder<WidgetWorker>(30, TimeUnit.MINUTES).setConstraints(online).build()
        work.enqueueUniquePeriodicWork(WidgetWorker.PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
        request(context)
    }

    /** One refresh soon. Bursts (streamed usage, several asks) fold into one: the first one waits, the rest are kept out. */
    fun request(context: Context) {
        if (!installed(context)) return
        val once = OneTimeWorkRequestBuilder<WidgetWorker>().setInitialDelay(10, TimeUnit.SECONDS).setConstraints(online).build()
        WorkManager.getInstance(context).enqueueUniqueWork(WidgetWorker.NAME, ExistingWorkPolicy.KEEP, once)
    }

    /** The signed-in account changed (pairing, login, sign out): drop the old pages and show the new account's. */
    @Synchronized
    fun bind(context: Context, token: String?) {
        snapshot.bind(WidgetAccount.key(token))
        render(context)
        if (token != null) request(context)
    }

    @Synchronized
    fun publish(context: Context, key: String, pages: List<WidgetPage>) {
        if (snapshot.publish(key, pages)) render(context)
    }

    /** The signed-in account's pages: Usage, Inbox, Calendar; empty before the first refresh. */
    fun pages(context: Context): List<WidgetPage> = snapshot.read(key(context))

    private fun key(context: Context): String? = WidgetAccount.key(context.container.hub.client.value?.token)

    @Synchronized
    fun render(context: Context) {
        val hub = context.container.hub
        // a cold start that has not read the pairing yet: the launcher keeps the last views until the worker runs
        if (hub.auth.value is AuthState.Loading) return
        val paired = hub.client.value != null
        val pages = pages(context)
        val manager = AppWidgetManager.getInstance(context)
        providers.forEachIndexed { index, provider ->
            for (id in ids(context, provider)) {
                if (provider == CombinedWidget::class.java) {
                    manager.updateAppWidget(id, stack(context, id, paired))
                    manager.notifyAppWidgetViewDataChanged(id, R.id.widget_stack)
                } else {
                    val page = pages.getOrNull(index) ?: placeholder(index, paired)
                    manager.updateAppWidget(id, page(context, page, id, collection = false))
                }
            }
        }
    }

    private val TITLES = listOf("Usage", "Inbox", "Calendar")
    private val LINKS = listOf(WidgetWords.USAGE, WidgetWords.INBOX, WidgetWords.TODAY)

    private fun placeholder(index: Int, paired: Boolean) =
        WidgetPage(TITLES[index], if (paired) "Loading…" else "Sign in to Conclave", LINKS[index])

    private fun stack(context: Context, id: Int, paired: Boolean) = RemoteViews(context.packageName, R.layout.widget_stack).apply {
        // the data makes each widget's adapter its own (Android caches adapters by intent)
        val adapter = Intent(context, WidgetStackService::class.java).setData(Uri.parse("conclave-widget://stack/$id"))
        @Suppress("DEPRECATION") // RemoteCollectionItems needs API 31; minSdk is 26
        setRemoteAdapter(R.id.widget_stack, adapter)
        setEmptyView(R.id.widget_stack, R.id.widget_empty)
        setTextViewText(R.id.widget_empty, if (paired) "Loading…" else "Sign in to Conclave")
        setOnClickPendingIntent(R.id.widget_empty, open(context, id * 10, WidgetWords.INBOX))
        // items fill in their own link; the template must stay mutable for that
        val template = Intent(context, MainActivity::class.java).setAction(Intent.ACTION_VIEW)
        setPendingIntentTemplate(R.id.widget_stack, PendingIntent.getActivity(context, id * 10 + 9, template,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE))
    }

    private val ROWS = listOf(R.id.widget_row_1, R.id.widget_row_2, R.id.widget_row_3)

    /** One page. In the combined widget ([collection]) taps fill in the stack's template; alone each tap has its own intent. */
    fun page(context: Context, page: WidgetPage, id: Int, collection: Boolean): RemoteViews =
        RemoteViews(context.packageName, R.layout.widget_page).apply {
            setTextViewText(R.id.widget_title, page.title)
            setTextViewText(R.id.widget_detail, page.detail)
            ROWS.forEachIndexed { n, view ->
                val row = page.rows.getOrNull(n)
                setViewVisibility(view, if (row == null) View.GONE else View.VISIBLE)
                if (row == null) return@forEachIndexed
                setTextViewText(view, row.text)
                if (collection) setOnClickFillInIntent(view, Intent().setData(Uri.parse(row.link)))
                else setOnClickPendingIntent(view, open(context, id * 10 + n + 1, row.link))
            }
            if (collection) setOnClickFillInIntent(R.id.widget_page, Intent().setData(Uri.parse(page.link)))
            else setOnClickPendingIntent(R.id.widget_page, open(context, id * 10, page.link))
        }

    private fun open(context: Context, request: Int, link: String): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link), context, MainActivity::class.java)
        return PendingIntent.getActivity(context, request, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}

/** The combined widget's pages: the launcher's StackView swipes through them. */
class WidgetStackService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = object : RemoteViewsFactory {
        private var pages: List<WidgetPage> = emptyList()
        override fun onCreate() = Unit
        override fun onDataSetChanged() { pages = Widgets.pages(this@WidgetStackService) }
        override fun onDestroy() { pages = emptyList() }
        override fun getCount(): Int = pages.size
        override fun getViewAt(position: Int): RemoteViews? =
            pages.getOrNull(position)?.let { Widgets.page(this@WidgetStackService, it, position, collection = true) }
        override fun getLoadingView(): RemoteViews? = null
        override fun getViewTypeCount(): Int = 1
        override fun getItemId(position: Int): Long = position.toLong()
        override fun hasStableIds(): Boolean = true
    }
}
