@file:OptIn(ExperimentalMaterial3Api::class)

package dev.conclave.app.ui.memory

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.EmptyState
import dev.conclave.app.ui.common.ErrorBanner
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.LoadingBox
import dev.conclave.app.ui.common.LocalAppContainer
import dev.conclave.app.ui.common.Segmented
import dev.conclave.app.ui.common.TopBar
import dev.conclave.app.ui.common.errorText
import dev.conclave.app.ui.common.outlineButtonBorder
import dev.conclave.app.ui.common.outlineButtonColors
import dev.conclave.app.ui.common.solidButtonColors
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.ConclaveApiException
import dev.conclave.client.logic.BRAIN
import dev.conclave.client.logic.HoloMode
import dev.conclave.client.logic.MemoryIndex
import dev.conclave.client.logic.MemoryMaps
import dev.conclave.client.model.MemoryGraph
import dev.conclave.client.model.MemoryGraphNode
import java.text.DateFormat
import java.util.Date
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/*
 * Memory > Map, the web's /memory/map: all of the owner's memory as one
 * picture (GET /api/memory/graph, owner only). Tree is the mind map around
 * the brain or an item; Rings puts every item on one circle with its real
 * links bundled through the middle; 3D projects Clusters or Timeline on a
 * Canvas, drag to orbit and pinch to zoom. A tap opens the item sheet: what
 * it is, its links by relation, Center here and Open in Notes. The models
 * live in the client (logic/MemoryGraphModel.kt, logic/MemoryLinks.kt).
 */

sealed interface GraphLoad {
    data object Loading : GraphLoad
    data object NotOwner : GraphLoad
    data class Failed(val text: String) : GraphLoad
    class Ready(val g: MemoryGraph, val ix: MemoryIndex) : GraphLoad
}

class MemoryMapViewModel(hub: HubRepository) : HubViewModel(hub) {
    val load = MutableStateFlow<GraphLoad>(GraphLoad.Loading)

    init {
        reload()
    }

    fun reload() {
        load.value = GraphLoad.Loading
        viewModelScope.launch {
            load.value = try {
                val g = hub.api { it.memoryGraph() }
                // the index walks every item and link: off the main thread
                GraphLoad.Ready(g, withContext(Dispatchers.Default) { MemoryMaps.index(g) })
            } catch (e: CancellationException) {
                throw e
            } catch (e: ConclaveApiException) {
                if (e.status == 403) GraphLoad.NotOwner else GraphLoad.Failed(errorText(e))
            } catch (e: Exception) {
                GraphLoad.Failed(errorText(e))
            }
        }
    }
}

enum class MemView { TREE, RINGS, HOLO }

@Composable
fun MemoryMapScreen(
    onBack: () -> Unit,
    onOpenNote: (memoryId: String, title: String) -> Unit,
    /** From a link: tree, rings, clusters or timeline, and an item to open. */
    startView: String? = null,
    startItem: String? = null,
) {
    val hub = LocalAppContainer.current.hub
    val vm: MemoryMapViewModel = viewModel { MemoryMapViewModel(hub) }
    val load by vm.load.collectAsStateWithLifecycle()
    var view by rememberSaveable { mutableStateOf(when (startView) { "rings" -> MemView.RINGS; "clusters", "timeline", "3d" -> MemView.HOLO; else -> MemView.TREE }) }
    var holo by rememberSaveable { mutableStateOf(if (startView == "timeline") HoloMode.TIMELINE else HoloMode.CLUSTERS) }
    var center by rememberSaveable { mutableStateOf(BRAIN) }
    var picked by rememberSaveable { mutableStateOf(startItem) }
    val c = Conclave.colors

    Scaffold(
        topBar = {
            TopBar(
                "Memory map",
                onBack = onBack,
                actions = {
                    if (view == MemView.TREE && center != BRAIN) TextButton(onClick = { center = BRAIN }) { Text("Brain", color = c.fg2) }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            when (val l = load) {
                GraphLoad.Loading -> LoadingBox(Modifier.fillMaxSize())
                GraphLoad.NotOwner -> EmptyState(Icons.Outlined.Lock, "Only the owner sees the memory map", "It shows all of the hub's memory, so a member account does not get it.")
                is GraphLoad.Failed -> ErrorBanner("The memory map did not load: ${l.text}", Modifier.padding(16.dp), onRetry = vm::reload)
                is GraphLoad.Ready -> if (l.g.nodes.isEmpty()) {
                    EmptyState(Icons.Outlined.Memory, "No memory yet", "Notes you add, and a linked Basic Memory, show here.")
                } else {
                    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Segmented(view, listOf(MemView.TREE to "Tree", MemView.RINGS to "Rings", MemView.HOLO to "3D"), { view = it }, Modifier.fillMaxWidth())
                        if (view == MemView.HOLO) {
                            Segmented(holo, listOf(HoloMode.CLUSTERS to "Clusters", HoloMode.TIMELINE to "Timeline"), { holo = it }, Modifier.fillMaxWidth())
                        }
                        StoreLine(l.g)
                    }
                    Box(Modifier.weight(1f).fillMaxWidth()) {
                        when (view) {
                            MemView.TREE -> MemoryTreeCanvas(l.ix, center, picked, onPick = { picked = it }, modifier = Modifier.fillMaxSize())
                            MemView.RINGS -> MemoryRingsCanvas(l.g, l.ix, picked, onPick = { picked = it }, modifier = Modifier.fillMaxSize())
                            MemView.HOLO -> MemoryHoloCanvas(l.g, l.ix, holo, picked, onPick = { picked = it }, modifier = Modifier.fillMaxSize())
                        }
                    }
                    val n = picked?.let { l.ix.byId[it] }
                    if (n != null) {
                        ItemSheet(
                            n = n,
                            ix = l.ix,
                            isCenter = view == MemView.TREE && n.id == center,
                            onDismiss = { picked = null },
                            onPick = { picked = it },
                            onCenter = {
                                center = n.id
                                view = MemView.TREE
                                picked = null
                            },
                            onOpenNote = n.memoryId?.let { id -> { onOpenNote(id, n.title) } },
                        )
                    }
                }
            }
        }
    }
}

/** How much there is, and Basic Memory's state when one is linked. */
@Composable
private fun StoreLine(g: MemoryGraph) {
    val c = Conclave.colors
    val bm = g.basicMemory
    val name = bm.name ?: "Basic Memory"
    val text = "${MemoryMaps.num(g.nodes.size)} items, ${MemoryMaps.num(g.edges.size)} links" + when (bm.state) {
        "ok" -> ", with $name"
        "offline" -> ", $name is offline"
        else -> ""
    }
    Text(text, style = ConclaveType.metaNum, color = if (bm.state == "offline") c.warn else c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

private fun changed(t: Long?): String? = t?.takeIf { it > 0 }?.let { DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(it)) }

/** The web's item panel as a sheet: what it is, its links by relation, Center here, Open in Notes. */
@Composable
private fun ItemSheet(
    n: MemoryGraphNode,
    ix: MemoryIndex,
    isCenter: Boolean,
    onDismiss: () -> Unit,
    onPick: (String) -> Unit,
    onCenter: () -> Unit,
    onOpenNote: (() -> Unit)?,
) {
    val c = Conclave.colors
    val groups = remember(n.id, ix) { (ix.nbrs[n.id] ?: emptyList()).groupBy({ it.label }, { it.id }).entries.sortedByDescending { it.value.size } }
    var all by remember(n.id) { mutableStateOf(emptySet<String>()) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = c.bgRaise) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().heightIn(max = 560.dp).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            val where = MemoryMaps.nodeWords(n) + (if (n.area.isNotEmpty()) ", ${n.area}" else "") + (if (isCenter) ", the center" else "")
            Text(where, style = ConclaveType.meta, color = c.fg3)
            Text(n.title, style = ConclaveType.title, color = c.fg, maxLines = 4, overflow = TextOverflow.Ellipsis)
            Text("${MemoryMaps.num(n.degree)} links" + (changed(n.at)?.let { ", changed $it" } ?: ""), style = ConclaveType.metaNum, color = c.fg3)
            Row(Modifier.padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (!isCenter) Button(onClick = onCenter, colors = solidButtonColors()) { Text("Center here", style = ConclaveType.button) }
                if (onOpenNote != null) {
                    OutlinedButton(onClick = onOpenNote, colors = outlineButtonColors(), border = outlineButtonBorder()) { Text("Open in Notes", style = ConclaveType.button) }
                }
            }
            for ((label, ids) in groups) {
                Spacer(Modifier.height(8.dp))
                HorizontalDivider(thickness = 1.dp, color = c.rule)
                Text("$label  ${MemoryMaps.num(ids.size)}", style = ConclaveType.meta, color = c.fg3, modifier = Modifier.padding(top = 6.dp))
                val cut = if (label in all) ids else ids.take(6)
                for (id in cut) {
                    val m = ix.byId[id] ?: continue
                    Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable { onPick(id) }, verticalAlignment = Alignment.CenterVertically) {
                        Text(MemoryMaps.nodeLabel(m), style = ConclaveType.body, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        Text(m.area, style = ConclaveType.meta, color = c.fg3, maxLines = 1)
                    }
                }
                if (ids.size > cut.size) {
                    TextButton(onClick = { all = all + label }) { Text("${MemoryMaps.num(ids.size - cut.size)} more", color = c.fg2) }
                }
            }
        }
    }
}
