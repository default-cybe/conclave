@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.home

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.MessagesEffect
import dev.conclave.app.ui.common.SectionHeader
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.motion.ToastHost
import dev.conclave.app.ui.motion.rememberToasts
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.approveProposal
import dev.conclave.client.declineProposal
import dev.conclave.client.logic.TodayWords
import dev.conclave.client.model.Proposal
import dev.conclave.client.model.Today
import dev.conclave.client.today
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/** Today on the phone: the day plan, today's calendar and the proposals waiting (docs/DESIGN.md, Calendar and mail). */
class TodayViewModel(hub: HubRepository) : HubViewModel(hub) {
    val today = MutableStateFlow<Today?>(null)
    val refreshing = MutableStateFlow(false)
    val busy = MutableStateFlow<String?>(null)

    fun refresh() {
        viewModelScope.launch {
            refreshing.value = true
            try {
                today.value = hub.api { it.today() }
            } catch (e: Exception) {
                say(dev.conclave.app.ui.common.errorText(e))
            } finally {
                refreshing.value = false
            }
        }
    }

    fun decide(p: Proposal, approve: Boolean) = action {
        busy.value = p.id
        try {
            val next = hub.api { if (approve) it.approveProposal(p.id) else it.declineProposal(p.id) }
            say(TodayWords.outcome(next))
            today.value = today.value?.let { t -> t.copy(proposals = t.proposals.filterNot { it.id == p.id }) }
        } finally {
            busy.value = null
        }
    }
}

@Composable
fun TodayScreen(onBack: () -> Unit) {
    val hub = LocalAppContainer.current.hub
    val vm: TodayViewModel = viewModel { TodayViewModel(hub) }
    val today by vm.today.collectAsStateWithLifecycle()
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val snackbar = rememberToasts()
    MessagesEffect(vm.messages, snackbar)
    LaunchedEffect(Unit) { vm.refresh() }
    val c = Conclave.colors

    Scaffold(topBar = { TopBar("Today", onBack = onBack, newChat = false) }, snackbarHost = { ToastHost(snackbar) }) { padding ->
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = { vm.refresh() }, modifier = Modifier.padding(padding).fillMaxSize()) {
            val t = today
            LazyColumn(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
                if (t == null) return@LazyColumn
                val zone = TodayWords.zone(t.timezone)
                t.plan?.let { plan ->
                    item(key = "plan") {
                        Text(plan.summary, style = ConclaveType.body, color = c.fg, modifier = Modifier.padding(top = 8.dp, bottom = 4.dp))
                    }
                    plan.items.forEachIndexed { n, i ->
                        item(key = "pi:$n") {
                            Row(Modifier.fillMaxWidth().heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text(i.time ?: "", style = ConclaveType.metaNum, color = c.fg3, modifier = Modifier.width(56.dp))
                                Text(i.text, style = ConclaveType.body, color = c.fg)
                            }
                        }
                    }
                }
                val pending = TodayWords.pending(t)
                if (pending.isNotEmpty()) {
                    item(key = "h:proposals") { SectionHeader(TodayWords.waiting(t) ?: "Waiting for you") }
                    items(pending, key = { it.id }) { p -> ProposalCard(p, zone, busy == p.id, onApprove = { vm.decide(p, true) }, onDecline = { vm.decide(p, false) }) }
                }
                val events = TodayWords.events(t)
                if (t.events != null) {
                    item(key = "h:calendar") { SectionHeader("Calendar") }
                    if (events.isEmpty()) item(key = "none") { Text("Nothing in the calendar today.", style = ConclaveType.meta, color = c.fg3) }
                    items(events, key = { "ev:" + it.id }) { e ->
                        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(TodayWords.range(e.start, e.end, e.allDay, zone), style = ConclaveType.metaNum, color = c.fg3, modifier = Modifier.width(112.dp))
                            Box(Modifier.size(8.dp).background(eventColor(e.color, c.fg3), CircleShape))
                            Spacer(Modifier.width(8.dp))
                            Column {
                                Text(e.title, style = ConclaveType.body, color = c.fg)
                                Text(e.calendar, style = ConclaveType.meta, color = c.fg3)
                            }
                        }
                    }
                }
                t.calendarError?.let { err -> item(key = "calerr") { Text("Could not read a calendar: $err", style = ConclaveType.meta, color = c.fg3) } }
                item(key = "end") { Spacer(Modifier.height(32.dp)) }
            }
        }
    }
}

private fun eventColor(hex: String?, fallback: Color): Color = try {
    if (hex != null && hex.length == 7 && hex.startsWith("#")) Color(0xFF000000 or hex.substring(1).toLong(16)) else fallback
} catch (_: NumberFormatException) {
    fallback
}

/** A proposal card: the question, what will be written, Approve and Decline at full width (MOBILE-V2 5). */
@Composable
private fun ProposalCard(p: Proposal, zone: java.time.ZoneId, busy: Boolean, onApprove: () -> Unit, onDecline: () -> Unit) {
    val c = Conclave.colors
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp).background(c.surface2, RoundedCornerShape(18.dp)).padding(16.dp)) {
        Text(TodayWords.question(p), style = ConclaveType.meta, color = c.fg3)
        val lines = TodayWords.cardLines(p, zone)
        lines.forEachIndexed { i, line ->
            Text(line, style = if (i == 0) ConclaveType.title else ConclaveType.body, color = if (i == 0) c.fg else c.fg2, modifier = Modifier.padding(top = if (i == 0) 6.dp else 2.dp))
        }
        Spacer(Modifier.height(12.dp))
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = onApprove, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(TodayWords.approve(p), style = ConclaveType.button) }
            OutlinedButton(onClick = onDecline, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Decline", style = ConclaveType.button) }
        }
    }
}
