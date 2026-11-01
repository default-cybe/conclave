package dev.conclave.app.ui.sessions

import androidx.lifecycle.viewModelScope
import dev.conclave.app.data.HubRepository
import dev.conclave.app.ui.common.HubViewModel
import dev.conclave.app.ui.common.errorText
import dev.conclave.client.logic.ListGroup
import dev.conclave.client.logic.Lists
import dev.conclave.client.model.EngineEvent
import dev.conclave.client.model.SearchHit
import dev.conclave.client.model.Session
import dev.conclave.client.model.SessionKind
import dev.conclave.client.model.SessionPatch
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class SessionsUi(
    val groups: List<ListGroup> = emptyList(),
    val total: Int = 0,
    val messageHits: List<SearchHit> = emptyList(),
)

/**
 * The Chats list ([chats]) or the Code list, or the archive of either
 * ([archived]): a search over titles, and over messages from three letters.
 */
@OptIn(FlowPreview::class)
class SessionsViewModel(hub: HubRepository, private val chats: Boolean, private val archived: Boolean) : HubViewModel(hub) {
    val query = MutableStateFlow("")
    val refreshing = MutableStateFlow(false)
    private val archive = MutableStateFlow<List<Session>>(emptyList())
    private val messageHits = MutableStateFlow<List<SearchHit>>(emptyList())

    val ui: StateFlow<SessionsUi> = combine(hub.sessions, archive, query, messageHits) { live, arch, q, hits ->
        val groups = Lists.groups(if (archived) arch else live, chats, q, archived)
        val mine = live.associateBy { it.id }
        SessionsUi(
            groups = groups,
            total = groups.sumOf { it.sessions.size },
            // a hit belongs to this list when its session does (one the app does not hold yet counts for Code)
            messageHits = if (q.trim().length >= 3 && !archived) hits.filter { h -> mine[h.sessionId]?.let { it.isChat == chats } ?: !chats } else emptyList(),
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), SessionsUi())

    init {
        viewModelScope.launch {
            query.debounce(400).distinctUntilChanged().collect { q ->
                messageHits.value = if (q.trim().length >= 3 && !archived) {
                    try {
                        hub.api { it.search(q.trim()) }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        emptyList()
                    }
                } else {
                    emptyList()
                }
            }
        }
        if (archived) {
            viewModelScope.launch { loadArchive() }
            viewModelScope.launch {
                hub.events.collect { e -> if (e is EngineEvent.SessionUpdated || e is EngineEvent.SessionDeleted) loadArchive() }
            }
        }
    }

    private suspend fun loadArchive() {
        try {
            archive.value = hub.api { it.listSessions(archived = true, limit = 200, kind = if (chats) SessionKind.CHAT else SessionKind.AGENT) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            say(errorText(e))
        }
    }

    fun refresh() {
        viewModelScope.launch {
            refreshing.value = true
            try {
                hub.refreshAll()
                if (archived) loadArchive()
            } finally {
                refreshing.value = false
            }
        }
    }

    fun archive(s: Session, archive: Boolean = true) = action(if (archive) "Archived." else "Restored.") {
        val updated = hub.api { it.updateSession(s.id, SessionPatch(archived = archive)) }
        hub.putSession(updated)
        if (archived) loadArchive()
    }

    fun togglePin(s: Session) = action {
        hub.putSession(hub.api { it.updateSession(s.id, SessionPatch(pinned = !s.pinned)) })
    }

    fun rename(s: Session, title: String) = action {
        if (title.isBlank()) return@action
        val updated = hub.api { it.updateSession(s.id, SessionPatch(title = title.trim())) }
        if (!updated.archived) hub.putSession(updated)
        if (archived) loadArchive()
    }

    fun delete(s: Session) = action("Deleted.") {
        hub.api { it.deleteSession(s.id) }
        hub.sessions.value = hub.sessions.value.filterNot { it.id == s.id }
        archive.value = archive.value.filterNot { it.id == s.id }
    }
}
