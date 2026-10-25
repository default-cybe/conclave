@file:OptIn(ExperimentalMaterial3Api::class, FlowPreview::class)

package dev.conclave.app.ui.usage

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.CompanyName
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.ModelName
import dev.conclave.app.ui.common.SectionHeader
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.common.rememberNow
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.motion.RollText
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.ConclaveApiException
import dev.conclave.client.logic.ApiValue
import dev.conclave.client.logic.Format
import dev.conclave.client.logic.StarterWords
import dev.conclave.client.model.LimitState
import dev.conclave.client.model.LimitWindow
import dev.conclave.client.model.UsageBucket
import dev.conclave.client.model.UsageSummary
import java.time.LocalDate
import java.time.ZoneId
import java.util.TimeZone
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch

enum class UsageRange(val label: String, val days: Int) { WEEK("7 days", 7), MONTH("30 days", 30), QUARTER("90 days", 90) }

class UsageViewModel(hub: HubRepository) : HubViewModel(hub) {
    val range = MutableStateFlow(UsageRange.MONTH)
    val summary = MutableStateFlow<UsageSummary?>(null)
    /** This calendar month, for "Your plans saved you about $Z this month" whatever the range. */
    val month = MutableStateFlow<UsageSummary?>(null)
    val refreshing = MutableStateFlow(false)

    init {
        // the first load comes from the screen's resume; this reloads after new calls, once per burst
        viewModelScope.launch { hub.usageRecorded.drop(1).debounce(2_000).collect { refresh() } }
    }

    fun setRange(r: UsageRange) {
        range.value = r
        refresh()
    }

    /**
     * [force]: after the stored values show, the hub re-reads plan usage (POST /api/limits/refresh),
     * then the summaries load again so they include the log records that re-read imported.
     */
    fun refresh(force: Boolean = false) {
        viewModelScope.launch {
            refreshing.value = true
            try {
                load()
            } finally {
                refreshing.value = false
            }
            // the re-read can take 8s or more (it reads every machine's logs), so it runs after the spinner stops
            if (force && forceLimits()) load()
        }
    }

    private suspend fun load() {
        val now = System.currentTimeMillis()
        // Same sign as JavaScript's Date.getTimezoneOffset().
        val tzOffset = -TimeZone.getDefault().getOffset(now) / 60_000
        val monthStart = LocalDate.now().withDayOfMonth(1).atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
        coroutineScope {
            listOf(
                async { part<UsageSummary>({ summary.value = it }) { hub.api { it.usage(from = now - range.value.days * 86_400_000L, to = now, tzOffset = tzOffset) } } },
                async { part<UsageSummary>({ month.value = it }) { hub.api { it.usage(from = monthStart, to = now, tzOffset = tzOffset) } } },
                async { part<List<LimitState>>({ hub.limits.value = it }) { hub.api { it.limits() } } },
            ).awaitAll()
        }
    }

    /** True when the hub re-read the limits. A member gets 403 (the re-read is admin only) and keeps the stored values quietly. */
    private suspend fun forceLimits(): Boolean = try {
        hub.limits.value = hub.api { it.refreshLimits() }
        true
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        if (!(e is ConclaveApiException && e.status == 403)) say(errorText(e))
        false
    }

    /** One read of refresh(): a failure keeps the earlier value and says why, the other reads go on. */
    private suspend fun <T> part(set: (T) -> Unit, call: suspend () -> T) {
        try {
            set(call())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            say(errorText(e))
        }
    }

    fun refreshLimits() = action("Limits refreshed") { hub.limits.value = hub.api { it.refreshLimits() } }
}

@Composable
fun UsageScreen(onBack: (() -> Unit)? = null) {
    val hub = LocalAppContainer.current.hub
    val vm: UsageViewModel = viewModel { UsageViewModel(hub) }
    val summary by vm.summary.collectAsStateWithLifecycle()
    val month by vm.month.collectAsStateWithLifecycle()
    val range by vm.range.collectAsStateWithLifecycle()
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val limits by hub.limits.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    // first open and every return to the app: read the latest numbers
    LifecycleResumeEffect(Unit) {
        vm.refresh()
        onPauseOrDispose { }
    }

    Scaffold(
        topBar = {
            TopBar("Usage", onBack = onBack, actions = {
                IconButton(onClick = { vm.refreshLimits() }, modifier = Modifier.size(48.dp)) { Icon(Icons.Outlined.Refresh, contentDescription = "Refresh limits", tint = Conclave.colors.fg2) }
            })
        },
        snackbarHost = { ToastHost(snackbar) },
    ) { padding ->
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = { vm.refresh(force = true) }, modifier = Modifier.padding(padding).fillMaxSize()) {
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
                Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    UsageRange.entries.forEach { r ->
                        FilterChip(selected = r == range, onClick = { vm.setRange(r) }, label = { Text(r.label) })
                    }
                }
                month?.totals?.let { PlanSavings(it) }
                if (limits.isNotEmpty()) {
                    SectionHeader("Limits")
                    limits.sortedBy { it.label.ifBlank { it.key } }.forEach { LimitCard(it) }
                }
                val s = summary
                if (s != null) {
                    SectionHeader("Totals")
                    KpiGrid(s)
                    SectionHeader("Cost per day")
                    CostChart(s.byDay)
                    if (s.byModel.isNotEmpty()) {
                        SectionHeader("By model")
                        ModelBreakdown(s.byModel)
                    }
                    // plan accounts bill $0: each one's bill beside what its calls are worth at API prices
                    val accounts = s.byAccount.filter { it.key.isNotBlank() && (it.calls > 0 || it.costUsd > 0) }
                    if (accounts.isNotEmpty()) {
                        SectionHeader("By account")
                        AccountBreakdown(accounts)
                    }
                }
            }
        }
    }
}

/** "Your plans saved you about $212 this month", only when a signed in plan served calls this month. */
@Composable
private fun PlanSavings(totals: UsageBucket) {
    val sentence = ApiValue.savedSentence(totals) ?: return
    val c = Conclave.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp)) {
        Text(sentence, style = ConclaveType.rowTitle, color = c.fg)
        Spacer(Modifier.height(2.dp))
        Text(ApiValue.savedDetail(totals), style = ConclaveType.meta, color = c.fg3)
    }
}

@Composable
private fun KpiGrid(s: UsageSummary) {
    val plans = ApiValue.planServed(s.totals)
    val tiles = listOfNotNull(
        (if (plans) "Billed" else "Cost") to Format.usd(s.totals.costUsd),
        if (plans) "At API prices" to Format.usd(ApiValue.worth(s.totals.costUsd, s.totals.apiValueUsd)) else null,
        "Calls" to s.totals.calls.toString(),
        "Input tokens" to Format.tokens(s.totals.inputTokens),
        "Output tokens" to Format.tokens(s.totals.outputTokens),
        "Cache hit rate" to Format.percent(s.cacheHitRate),
        "Saved by cache" to Format.usd(s.cacheSavingsUsd),
    )
    Column(Modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        tiles.chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { (label, value) ->
                    Surface(
                        shape = RoundedCornerShape(14.dp),
                        color = MaterialTheme.colorScheme.surfaceContainerLow,
                        modifier = Modifier.weight(1f),
                    ) {
                        Column(Modifier.padding(14.dp)) {
                            Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.height(4.dp))
                            // numbers roll when they change (Roll): only the changed digits move
                            RollText(value, MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.SemiBold), MaterialTheme.colorScheme.onSurface)
                        }
                    }
                }
            }
        }
    }
}

/** Single series bar chart. Tap a bar to read its value; the table view lists every day. */
@Composable
private fun CostChart(days: List<UsageBucket>) {
    var selected by remember(days) { mutableIntStateOf(-1) }
    var showTable by remember { mutableStateOf(false) }
    // Neutral bars (spec 11.8): meter ink, the selected day in full ink.
    val barColor = Conclave.colors.meterOn
    val selectedColor = Conclave.colors.fg
    val axisColor = Conclave.colors.rule
    val max = days.maxOfOrNull { it.costUsd }?.takeIf { it > 0 } ?: 1.0
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
    ) {
        Column(Modifier.padding(14.dp)) {
            val label = days.getOrNull(selected)?.let { "${shortDay(it.key)}: ${Format.usd(it.costUsd)}${ApiValue.worthLine(it.costUsd, it.apiValueUsd)?.let { w -> ", $w" } ?: ""}, ${it.calls} calls" }
                ?: "Max ${Format.usd(max)}, average ${Format.usd(if (days.isEmpty()) 0.0 else days.sumOf { it.costUsd } / days.size)}"
            Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(10.dp))
            if (days.isEmpty()) {
                Text("No usage in this range", style = MaterialTheme.typography.bodyMedium)
            } else {
                Canvas(
                    Modifier
                        .fillMaxWidth()
                        .height(140.dp)
                        .pointerInput(days) {
                            detectTapGestures { offset ->
                                val slot = size.width.toFloat() / days.size
                                val i = (offset.x / slot).toInt().coerceIn(0, days.lastIndex)
                                selected = if (selected == i) -1 else i
                            }
                        },
                ) {
                    val gap = 2.dp.toPx()
                    val slot = size.width / days.size
                    val barWidth = (slot - gap).coerceAtLeast(1f)
                    val radius = minOf(4.dp.toPx(), barWidth / 2)
                    days.forEachIndexed { i, d ->
                        val h = (d.costUsd / max).toFloat() * size.height
                        if (h <= 0f) return@forEachIndexed
                        val left = i * slot + gap / 2
                        val top = size.height - h
                        val path = Path().apply {
                            addRoundRect(
                                RoundRect(
                                    left = left,
                                    top = top,
                                    right = left + barWidth,
                                    bottom = size.height,
                                    topLeftCornerRadius = CornerRadius(radius, radius),
                                    topRightCornerRadius = CornerRadius(radius, radius),
                                    bottomRightCornerRadius = CornerRadius.Zero,
                                    bottomLeftCornerRadius = CornerRadius.Zero,
                                ),
                            )
                        }
                        drawPath(path, color = if (i == selected) selectedColor else barColor)
                    }
                    drawLine(axisColor, Offset(0f, size.height), Offset(size.width, size.height), strokeWidth = 1.dp.toPx())
                }
                Spacer(Modifier.height(6.dp))
                Row {
                    Text(shortDay(days.first().key), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.weight(1f))
                    Text(shortDay(days.last().key), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                TextButton(onClick = { showTable = !showTable }) { Text(if (showTable) "Hide table" else "Show table") }
                if (showTable) {
                    days.asReversed().forEach { d ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                            Text(shortDay(d.key), style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                            Text("${d.calls} calls", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(80.dp))
                            // a day a plan served: what it was worth at API prices, then the bill
                            if (ApiValue.planServed(d)) Text("worth ${Format.usd(ApiValue.worth(d.costUsd, d.apiValueUsd))}, ", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(Format.usd(d.costUsd), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
                        }
                    }
                }
            }
        }
    }
}

private fun shortDay(key: String): String =
    if (key.length >= 10 && key[4] == '-') key.substring(5, 10) else key

/** By model: the model mark and name, cost, a 3dp neutral share meter and the token counts. */
@Composable
private fun ModelBreakdown(models: List<UsageBucket>) {
    val c = Conclave.colors
    val sorted = models.sortedByDescending { it.costUsd }
    val max = sorted.firstOrNull()?.costUsd?.takeIf { it > 0 } ?: 1.0
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            sorted.take(12).forEach { m ->
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        ModelName(
                            m.key,
                            Modifier.weight(1f),
                            size = 14.dp,
                            style = ConclaveType.rowTitle,
                            color = c.fg,
                            asModel = true,
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(Format.usd(m.costUsd), style = ConclaveType.rowTitle.copy(fontFeatureSettings = "tnum"), color = c.fg)
                    }
                    Spacer(Modifier.height(6.dp))
                    Canvas(Modifier.fillMaxWidth().height(3.dp)) {
                        val w = (m.costUsd / max).toFloat() * size.width
                        val r = CornerRadius(size.height / 2, size.height / 2)
                        drawRoundRect(color = c.meterOff, size = size, cornerRadius = r)
                        if (w > 0f) drawRoundRect(color = c.meterOn, size = Size(w.coerceAtLeast(size.height), size.height), cornerRadius = r)
                    }
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "${m.calls} calls, ${Format.tokens(m.inputTokens)} in, ${Format.tokens(m.outputTokens)} out" + (ApiValue.worthLine(m.costUsd, m.apiValueUsd)?.let { ", $it" } ?: ""),
                        style = ConclaveType.metaNum,
                        color = c.fg3,
                    )
                }
            }
        }
    }
}

/** By account: each plan or key with "Billed $0, worth $95.60 at API prices", most worth first. */
@Composable
private fun AccountBreakdown(accounts: List<UsageBucket>) {
    val c = Conclave.colors
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp),
    ) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            accounts.sortedByDescending { ApiValue.worth(it.costUsd, it.apiValueUsd) }.forEach { a ->
                Column {
                    Text(a.key, style = ConclaveType.rowTitle, color = c.fg)
                    Spacer(Modifier.height(2.dp))
                    Text("${ApiValue.billedLine(a.costUsd, a.apiValueUsd)}, ${a.calls} calls", style = ConclaveType.metaNum, color = c.fg3)
                }
            }
        }
    }
}

@Composable
private fun LimitCard(limit: LimitState) {
    val c = Conclave.colors
    val now by rememberNow()
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
    ) {
        Column(Modifier.padding(14.dp)) {
            // Company mark and plan name (spec 11.8), then where the numbers come from.
            Row(verticalAlignment = Alignment.CenterVertically) {
                CompanyName(
                    limit.provider,
                    Modifier.weight(1f),
                    // the hub's label names the account already ("Claude Max 20x · Account 2"); else add its id
                    name = limit.account?.takeIf { it.isNotBlank() && !limit.label.contains(it) }?.let { a -> if (limit.label.isBlank()) a else "${limit.label} · $a" } ?: limit.label,
                    size = 16.dp,
                    style = ConclaveType.rowTitle,
                    color = c.fg,
                )
                Spacer(Modifier.width(8.dp))
                val age = Format.relative(limit.updatedAt, now).takeIf { it.isNotEmpty() }?.let { ", updated $it" }.orEmpty()
                when {
                    limit.blocked == true -> Text("blocked$age", style = ConclaveType.meta, color = c.fault)
                    limit.source == "error" -> Text("not read", style = ConclaveType.meta, color = c.fault)
                    else -> Text("read from ${sourceName(limit.source)}$age", style = ConclaveType.meta, color = c.fg3)
                }
            }
            Spacer(Modifier.height(10.dp))
            if (limit.windows.isEmpty()) {
                Text(limit.note ?: "No limit windows reported", style = MaterialTheme.typography.bodySmall)
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    limit.windows.take(3).forEach { w -> Gauge(w, Modifier.weight(1f)) }
                }
            }
            // the window starter of a plan, read only: it is turned on in the web app's Settings
            limit.starter?.let { st -> StarterWords.line(st, now) }?.let { line ->
                Spacer(Modifier.height(10.dp))
                Text(
                    "Window starter. $line",
                    style = ConclaveType.meta,
                    color = when (limit.starter?.state) {
                        "stopped" -> c.fault
                        "paused", "setup" -> c.warn
                        else -> c.fg3
                    },
                )
            }
        }
    }
}

/** Where limit numbers come from, in words: headers, OAuth, logs or the API. */
private fun sourceName(source: String): String = when (source) {
    "oauth" -> "OAuth"
    "api" -> "the API"
    "ledger" -> "the ledger"
    else -> source
}

@Composable
private fun Gauge(window: LimitWindow, modifier: Modifier = Modifier) {
    val now by rememberNow()
    val c = Conclave.colors
    val used = window.usedPercent ?: window.limit?.takeIf { it > 0 }?.let { lim -> window.remaining?.let { 100.0 * (lim - it) / lim } }
    // Neutral below 70%, amber from 70%, red from 90% (spec 10.9).
    val color = when {
        used == null -> c.edge
        used >= 90 -> c.fault
        used >= 70 -> c.warn
        else -> c.meterOn
    }
    val track = c.meterOff
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(contentAlignment = Alignment.Center) {
            Canvas(Modifier.size(84.dp)) {
                val stroke = 8.dp.toPx()
                val inset = stroke / 2
                val arcSize = Size(size.width - stroke, size.height - stroke)
                val topLeft = Offset(inset, inset)
                drawArc(track, startAngle = 150f, sweepAngle = 240f, useCenter = false, topLeft = topLeft, size = arcSize, style = Stroke(stroke, cap = StrokeCap.Round))
                if (used != null && used > 0) {
                    val sweep = (240f * (used / 100.0).toFloat()).coerceIn(0f, 240f)
                    drawArc(color, startAngle = 150f, sweepAngle = sweep, useCenter = false, topLeft = topLeft, size = arcSize, style = Stroke(stroke, cap = StrokeCap.Round))
                }
            }
            Text(used?.let { "${it.toInt()}%" } ?: "n/a", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        }
        Text(window.name, style = MaterialTheme.typography.labelMedium)
        window.resetsAt?.let { at ->
            Text(
                if (at > now) "resets in ${Format.countdown(at - now)}" else "reset",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
