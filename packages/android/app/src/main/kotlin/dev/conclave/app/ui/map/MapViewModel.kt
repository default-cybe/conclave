package dev.conclave.app.ui.map

import androidx.lifecycle.viewModelScope
import dev.conclave.app.data.HubRepository
import dev.conclave.app.data.SettingsStore
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.errorText
import dev.conclave.client.ConnectionState
import dev.conclave.client.map
import dev.conclave.client.map.MapDeltas
import dev.conclave.client.map.MapWords
import dev.conclave.client.map.StreamMode
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.MapNode
import dev.conclave.client.model.MapNodeKind
import dev.conclave.client.model.MapSnapshot
import dev.conclave.client.stopWorkflow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The Map's data (docs/DESIGN.md 29): the snapshot, moved on by map.delta
 * events while it is live, or a replay at an earlier time. While this lives
 * the socket asks for the deltas. Loads again when the connection comes
 * back or an alert comes or goes, since neither travels in a delta.
 */
class MapViewModel(hub: HubRepository, private val settings: SettingsStore) : HubViewModel(hub) {
    /** The live snapshot, moved on by deltas. */
    val live = MutableStateFlow<MapSnapshot?>(null)

    /** The replay's snapshot, while one is shown. */
    val past = MutableStateFlow<MapSnapshot?>(null)

    /** The time a replay shows; null while live. */
    val replay = MutableStateFlow<Long?>(null)
    val loading = MutableStateFlow(true)
    val error = MutableStateFlow<String?>(null)

    private val release: () -> Unit = hub.watchMap()
    private var asked = 0
    private var pastAsked = 0

    init {
        load()
        viewModelScope.launch {
            hub.events.collect { e ->
                when (e) {
                    is EngineEvent.MapDeltaEvent -> {
                        val d = MapDeltas.parse(e.delta) ?: return@collect
                        live.update { s -> s?.let { MapDeltas.apply(it, d) } }
                    }
                    // a stuck turn or a file conflict came or went: the snapshot carries them, deltas do not
                    is EngineEvent.AlertRaised, is EngineEvent.AlertCleared -> if (replay.value == null) load()
                    // the hub could not replay what this app missed
                    is EngineEvent.ConfigUpdated -> if (replay.value == null) load()
                    else -> Unit
                }
            }
        }
        // back online: what moved while the socket was down is not replayed, so load again
        viewModelScope.launch {
            var wasOpen = hub.connection.value == ConnectionState.OPEN
            hub.connection.collect { st ->
                val open = st == ConnectionState.OPEN
                if (open && !wasOpen && replay.value == null) load()
                wasOpen = open
            }
        }
    }

    fun load() {
        val ask = ++asked
        viewModelScope.launch {
            try {
                val s = hub.api { it.map(tz = MapWords.tzOffset()) }
                if (ask == asked) {
                    live.value = s
                    error.value = null
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (ask == asked) error.value = errorText(e)
            } finally {
                if (ask == asked) loading.value = false
            }
        }
    }

    /** Show the hub at [at], or live again with null. */
    fun setReplay(at: Long?) {
        replay.value = at
        if (at == null) {
            past.value = null
            load()
            return
        }
        val ask = ++pastAsked
        viewModelScope.launch {
            try {
                val s = hub.api { it.map(at = at, tz = MapWords.tzOffset()) }
                if (ask == pastAsked && replay.value != null) past.value = s
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                say(errorText(e))
            }
        }
    }

    /** Stop a node's work: the run for a workflow, the turn for the rest. */
    fun stop(n: MapNode) = action {
        val run = n.runId
        if (n.kind == MapNodeKind.WORKFLOW && run != null) hub.api { it.stopWorkflow(run) } else hub.api { it.abort(n.id) }
    }

    fun setStreams(m: StreamMode) {
        viewModelScope.launch { settings.setMapStreams(m.wire) }
    }

    override fun onCleared() {
        release()
        super.onCleared()
    }
}
