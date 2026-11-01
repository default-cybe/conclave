package dev.conclave.app.ui.workflows

import androidx.compose.runtime.staticCompositionLocalOf
import androidx.lifecycle.viewModelScope
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.errorText
import dev.conclave.client.logic.RunLive
import dev.conclave.client.logic.RunReducer
import dev.conclave.client.logic.WorkflowWords
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.Message
import dev.conclave.client.model.WorkflowCall
import dev.conclave.client.model.WorkflowRun
import dev.conclave.client.pauseWorkflow
import dev.conclave.client.rerunWorkflow
import dev.conclave.client.resumeWorkflow
import dev.conclave.client.skipWorkflowCall
import dev.conclave.client.stopWorkflow
import dev.conclave.client.workflowRun
import dev.conclave.client.workflowRuns
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Opens one workflow run from anywhere in the app (a Workflow tool card, a notice). Null where nothing provides it. */
val LocalOpenWorkflowRun = staticCompositionLocalOf<((String) -> Unit)?> { null }

/** Workflow runs, newest first, kept live from workflow.run events. [sessionId] narrows them to one session's runs. */
class RunsViewModel(hub: HubRepository, val sessionId: String?) : HubViewModel(hub) {
    val runs = MutableStateFlow<List<WorkflowRun>?>(null)
    val error = MutableStateFlow<String?>(null)
    val refreshing = MutableStateFlow(false)

    init {
        viewModelScope.launch {
            hub.events.collect { e ->
                when (e) {
                    is EngineEvent.WorkflowRunUpdated -> runs.update { list -> list?.let { RunReducer.upsertRun(it, e.run, sessionId) } }
                    is EngineEvent.ConfigUpdated -> load()
                    else -> Unit
                }
            }
        }
        load()
    }

    fun load() {
        viewModelScope.launch {
            refreshing.value = true
            try {
                runs.value = hub.api { it.workflowRuns(sessionId = sessionId, limit = 100) }
                error.value = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error.value = errorText(e)
            } finally {
                refreshing.value = false
            }
        }
    }
}

/**
 * One run, live: the detail from the hub, then every workflow.* event for
 * it. The run is loaded again when it ends (the result and findings come
 * with the end) and when it starts again after a resume.
 */
class RunViewModel(hub: HubRepository, val runId: String) : HubViewModel(hub) {
    val state = MutableStateFlow<RunLive?>(null)
    val error = MutableStateFlow<String?>(null)
    private var loading: Job? = null

    init {
        // subscribe first, so nothing that happens during the first load is lost
        viewModelScope.launch {
            hub.events.collect { e ->
                if (e is EngineEvent.ConfigUpdated) {
                    load()
                    return@collect
                }
                val s = state.value ?: return@collect
                val (next, reload) = RunReducer.apply(s, e)
                if (next !== s) state.value = next
                if (reload) load()
            }
        }
        load()
    }

    fun load() {
        loading?.cancel()
        loading = viewModelScope.launch {
            try {
                val d = hub.api { it.workflowRun(runId) }
                // keep the last tools the events brought; the detail starts its own activity
                state.value = state.value?.copy(detail = d) ?: RunLive(d)
                error.value = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (state.value == null) error.value = errorText(e) else say(errorText(e))
            }
        }
    }

    private fun control(done: String? = null, block: suspend () -> WorkflowRun) = action(done) {
        val run = block()
        state.update { s -> s?.copy(detail = s.detail.copy(run = run)) }
    }

    fun pause() = control("Paused. Running agents finish; no new ones start.") { hub.api { it.pauseWorkflow(runId) } }

    fun resume() = action {
        val run = hub.api { it.resumeWorkflow(runId) }
        state.update { s -> s?.copy(detail = s.detail.copy(run = run)) }
        // a resumed run starts its calls over from the journal
        load()
    }

    fun stop() = control("Stopped") { hub.api { it.stopWorkflow(runId) } }

    fun skip(call: WorkflowCall) = control("Skipped ${WorkflowWords.callLabel(call)}") { hub.api { it.skipWorkflowCall(runId, call.seq) } }

    fun rerun(call: WorkflowCall) = action("Running again from ${WorkflowWords.callLabel(call)}") {
        hub.api { it.rerunWorkflow(runId, call.seq) }
        load()
    }

    /** The agent's own session, for the read-only transcript. */
    suspend fun transcript(childSessionId: String): List<Message> = hub.api { it.messages(childSessionId) }
}
