@file:OptIn(ExperimentalFoundationApi::class)

package dev.conclave.app.ui.common

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.outlined.Category
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.ModelPicks
import dev.conclave.client.logic.PickerTabs
import dev.conclave.client.model.ModelGroup
import dev.conclave.client.model.ModelInfo
import java.util.Locale

/**
 * Bottom sheet for picking a model, as the web's ModelPicker.tsx
 * (logic/PickerTabs.kt): the search, then provider tabs (All, Anthropic,
 * OpenAI, Google, Z.ai, Local, Coding agents, Other; only the ones with
 * models; the makers as their logos, named for TalkBack), then Pinned,
 * Recent and the tab's models under a heading per maker and a small one per
 * family, strongest family first.
 * Each model row has a pin; pins live on the hub (preferences.pinnedModels)
 * and so follow the account to every device. A search lists the matches of
 * every tab. The sheet opens on the current model's tab. [extra] free-form
 * refs (e.g. "@reviewer" agents) stay on top. A model the owner's order
 * reaches through several providers shows once, with its route under the
 * name (core providers/merge.ts); a [current] ref of another route checks
 * that row. [header] goes between the title and the search: the composer's
 * Effort row (docs/DESIGN.md 37). A row shows its name only; a long press
 * shows its context, price and pin. A model the plan refused waits in the
 * "Not available" fold at the end with its reason (design review #7).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModelPickerSheet(
    title: String,
    groups: List<ModelGroup>,
    current: String?,
    onPick: (String) -> Unit,
    onDismiss: () -> Unit,
    extra: List<Pair<String, String>> = emptyList(),
    header: (@Composable () -> Unit)? = null,
) {
    val hub = LocalAppContainer.current.hub
    val pinned by hub.pinnedModels.collectAsStateWithLifecycle()
    val sessions by hub.sessions.collectAsStateWithLifecycle()
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var query by remember { mutableStateOf("") }
    val makers = remember(groups) { ModelPicks.groups(groups) }
    val entries = remember(makers) { PickerTabs.entries(makers) }
    val tabs = remember(entries) { PickerTabs.shownTabs(entries) }
    // a saved ref on a plan's prefix or an effort variant checks the row it folds into
    val shown = remember(groups, current) { ModelPicks.shownRow(makers, groups, current) }
    // recent: the last models the sessions used, each as the row it folds into
    val recent = remember(sessions, makers, groups) { PickerTabs.recent(sessions).mapNotNull { ModelPicks.shownRow(makers, groups, it) } }
    // opens on the current model's tab; with none, on All
    var tab by remember { mutableStateOf(PickerTabs.tabFor(entries, shown)) }
    // the "Not available" fold, shut on each open; the row a long press opened (its specs and pin)
    var unavailable by remember { mutableStateOf(false) }
    var peek by remember { mutableStateOf<String?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            Text(title, style = ConclaveType.title, modifier = Modifier.padding(horizontal = 20.dp))
            if (header != null) header()
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                placeholder = { Text("Search models") },
                leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            )
            val q = query.trim().lowercase()
            // a search spans every tab, so the tabs step aside while it runs
            if (q.isEmpty() && tabs.size > 2) {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    tabs.forEach { t -> TabChip(t, selected = t == tab, onClick = { tab = t }) }
                }
            }
            val list = remember(entries, q, tab, pinned, recent, unavailable) { PickerTabs.items(entries, q, if (tab in tabs) tab else PickerTabs.Tab.ALL, pinned, recent, unavailable) }
            val extras = extra.filter { (ref, label) -> q.isEmpty() || ref.lowercase().contains(q) || label.lowercase().contains(q) }.distinctBy { it.first }
            LazyColumn(Modifier.fillMaxWidth().heightIn(max = 560.dp).nestedScroll(KeepEnd)) {
                if (extras.isNotEmpty()) {
                    item { SectionHeader("Agents") }
                    items(extras, key = { "x:" + it.first }) { (ref, label) ->
                        PickerRow(ref = null, label = label, sub = ref, detail = null, selected = ref == current) { onPick(ref) }
                    }
                    item { HorizontalDivider(thickness = 1.dp, color = Conclave.colors.rule, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp)) }
                }
                // a family heading such as "Other" can repeat under two makers: headings key by place
                itemsIndexed(list, key = { n, i ->
                    when (i) {
                        is PickerTabs.Item.Head -> "h:$n:" + i.label
                        is PickerTabs.Item.Fold -> "fold"
                        is PickerTabs.Item.Model -> i.section.name + ":" + i.entry.makerKey + ":" + i.entry.row.ref
                    }
                }) { _, i ->
                    when (i) {
                        is PickerTabs.Item.Head -> if (i.family) FamilyHeader(i.label) else MakerHeader(i.label, i.maker)
                        is PickerTabs.Item.Fold -> FoldHeader(i) { unavailable = !unavailable }
                        is PickerTabs.Item.Model -> {
                            val r = i.entry.row
                            val key = i.section.name + ":" + r.ref
                            ModelRow(
                                r,
                                selected = r.ref == shown,
                                // the maker's logo where the list mixes makers (All, a search), never on Recent or a coding agent
                                maker = if ((tab == PickerTabs.Tab.ALL || q.isNotEmpty()) && i.section != PickerTabs.Section.RECENT) i.entry.makerKey to i.entry.makerName else null,
                                current = current,
                                onRoute = onPick,
                                pinned = r.ref in pinned,
                                onPin = { hub.togglePin(r.ref) },
                                peeked = peek == key,
                                onPeek = { peek = if (peek == key) null else key },
                            ) { onPick(r.ref) }
                        }
                    }
                }
                if (list.isEmpty() && extras.isEmpty()) {
                    item {
                        Text(
                            if (q.isNotEmpty()) "No models match." else "No models yet. Add a key in Settings, Providers.",
                            modifier = Modifier.padding(24.dp),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}

/** One provider tab: an outline, the chosen one raised (the composer's Effort chips). All is a word, a maker its logo, the rest a neutral icon; each named for TalkBack. */
@Composable
private fun TabChip(tab: PickerTabs.Tab, selected: Boolean, onClick: () -> Unit) {
    val c = Conclave.colors
    val shape = RoundedCornerShape(20.dp)
    val tint = if (selected) c.fg else c.fg3
    Box(
        Modifier
            .heightIn(min = 40.dp)
            .clip(shape)
            .then(if (selected) Modifier.background(c.bgRaise).border(1.dp, c.edge, shape) else Modifier.border(1.dp, c.rule2, shape))
            .selectable(selected = selected, role = Role.Tab, onClick = onClick)
            .padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        val icon = when (tab) {
            PickerTabs.Tab.LOCAL -> Icons.Outlined.Computer
            PickerTabs.Tab.AGENTS -> Icons.Outlined.Terminal
            PickerTabs.Tab.OTHER -> Icons.Outlined.Category
            else -> null
        }
        when {
            tab.maker != null -> CompanyMark(tab.maker, size = 16.dp, tint = tint, label = tab.label)
            icon != null -> Icon(icon, contentDescription = tab.label, modifier = Modifier.size(16.dp), tint = tint)
            else -> Text(tab.label, style = ConclaveType.meta, color = tint, maxLines = 1)
        }
    }
}

/** A maker's heading in the list, with its logo (none for Coding agents). */
@Composable
private fun MakerHeader(label: String, maker: String?) {
    val c = Conclave.colors
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 14.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        if (maker != null) {
            CompanyMark(maker, size = 14.dp, tint = c.fg3)
            Spacer(Modifier.width(6.dp))
        }
        Text(label, style = ConclaveType.meta, color = c.fg3, maxLines = 1)
    }
}

/** The "Not available" fold at the end of the list: its name, how many, a chevron that turns when open. */
@Composable
private fun FoldHeader(fold: PickerTabs.Item.Fold, onToggle: () -> Unit) {
    val c = Conclave.colors
    HorizontalDivider(thickness = 1.dp, color = c.rule, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(onClickLabel = if (fold.open) "Hide models not available" else "Show models not available", role = Role.Button, onClick = onToggle).padding(horizontal = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.KeyboardArrowDown, contentDescription = null, modifier = Modifier.size(16.dp).rotate(if (fold.open) 0f else -90f), tint = c.fg3)
        Spacer(Modifier.width(6.dp))
        Text(fold.label, style = ConclaveType.meta, color = c.fg3, modifier = Modifier.weight(1f))
        Text(fold.count.toString(), style = ConclaveType.metaNum, color = c.fg4)
    }
}

/** A family's small heading under its maker ("Opus", "Gemini Flash"). */
@Composable
private fun FamilyHeader(label: String) {
    Text(label, style = ConclaveType.meta, color = Conclave.colors.fg4, maxLines = 1, modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 6.dp, bottom = 2.dp))
}

/**
 * Keeps the list's leftover push past its end (scroll or fling up) out of
 * the sheet: the expanded sheet took it, sprang up and back and the picker
 * shook at the bottom. A pull down at the top still reaches the sheet, to close it.
 */
private val KeepEnd = object : NestedScrollConnection {
    override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset =
        if (available.y < 0f) Offset(0f, available.y) else Offset.Zero

    override suspend fun onPostFling(consumed: Velocity, available: Velocity): Velocity =
        if (available.y < 0f) Velocity(0f, available.y) else Velocity.Zero
}

/** A model: its name, its route or ref under it (after its maker where makers mix), context and price, a check on the current one, and its pin. */
@Composable
private fun ModelRow(
    r: ModelPicks.Row,
    selected: Boolean,
    /** The maker's key and name, shown as its logo. */
    maker: Pair<String, String>? = null,
    current: String? = null,
    onRoute: (String) -> Unit = {},
    pinned: Boolean = false,
    onPin: (() -> Unit)? = null,
    /** A long press showed this row's specs and pin. */
    peeked: Boolean = false,
    onPeek: (() -> Unit)? = null,
    onClick: () -> Unit,
) {
    // the row is the model's name; a route picked by hand ("via neu") says so, the ref only for a coding agent
    val picked = r.routes.firstOrNull { !it.first && it.ref == current }
    val why = r.model.unavailable
    val sub = why ?: picked?.let { "via ${it.label}" } ?: r.via ?: if (r.harness) r.ref else null
    PickerRow(
        ref = r.ref,
        label = r.label,
        sub = sub,
        maker = maker.takeIf { !r.harness },
        // the specs after a long press only (design review #7); a pinned row keeps its pin in sight
        detail = if (peeked) modelDetail(r.model) else null,
        selected = selected,
        vision = peeked && r.model.vision,
        pinned = pinned,
        // a pinned model the plan now refuses keeps its pin, so it can be unpinned
        onPin = onPin?.takeIf { pinned || (why == null && peeked) },
        enabled = why == null,
        warn = why != null,
        onLongClick = onPeek?.takeIf { why == null },
        onClick = onClick,
    )
    // the other ways to the same model, behind the current row: a plan's prefix, another provider, an effort variant
    if (selected && r.routes.size > 1) {
        val c = Conclave.colors
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = 20.dp, end = 12.dp, bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            r.routes.forEach { rt ->
                val on = rt.ref == current || (rt.first && picked == null)
                Text(
                    if (rt.first) "Default, ${rt.label}" else "via ${rt.label}",
                    style = ConclaveType.meta,
                    color = if (on) c.fg else c.fg3,
                    modifier = Modifier.clip(RoundedCornerShape(16.dp)).clickable(role = Role.Button) { onRoute(rt.ref) }.padding(horizontal = 10.dp, vertical = 8.dp),
                )
            }
        }
    }
}

/** Context and price per million tokens: "200K, $3 / $15". */
private fun modelDetail(m: ModelInfo): String? {
    val parts = mutableListOf<String>()
    if (m.contextWindow > 0) parts += contextLabel(m.contextWindow)
    if (m.inputPrice > 0 || m.outputPrice > 0) {
        parts += "${price(m.inputPrice)} / ${price(m.outputPrice)}"
    } else {
        m.tier?.let { parts += it }
    }
    return parts.joinToString(", ").ifBlank { null }
}

private fun contextLabel(n: Long): String = when {
    n >= 1_000_000 -> "${trim(n / 1_000_000.0)}M"
    n >= 1_000 -> "${n / 1_000}K"
    else -> n.toString()
}

private fun price(v: Double): String = "$" + trim(v)

private fun trim(v: Double): String =
    if (v == Math.floor(v)) v.toLong().toString() else String.format(Locale.US, "%.2f", v).trimEnd('0').trimEnd('.')

@Composable
private fun PickerRow(
    ref: String?,
    label: String,
    sub: String?,
    detail: String?,
    selected: Boolean,
    vision: Boolean = false,
    /** The maker's key and name: its logo after the model's name. */
    maker: Pair<String, String>? = null,
    pinned: Boolean = false,
    /** Null: no pin on this row (an agent from [extra]). */
    onPin: (() -> Unit)? = null,
    /** False: a model that cannot be picked, greyed, its [sub] the reason. */
    enabled: Boolean = true,
    /** The [sub] line in amber: why the model cannot be picked. */
    warn: Boolean = false,
    /** A long press: the row's specs and pin. */
    onLongClick: (() -> Unit)? = null,
    onClick: () -> Unit,
) {
    val c = Conclave.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .combinedClickable(enabled = enabled, onClick = onClick, onLongClick = onLongClick, onLongClickLabel = onLongClick?.let { "Show details and pin" })
            .padding(start = 20.dp, end = if (onPin != null) 4.dp else 20.dp, top = 10.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (ref != null) {
            // Model rows show the model family, even for a harness ref.
            ModelMark(ref, size = 16.dp, tint = if (enabled) c.fg else c.fg3)
            Spacer(Modifier.width(logoGap(16.dp)))
        }
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(label, style = ConclaveType.rowTitle, color = if (enabled) c.fg else c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (maker != null) {
                    Spacer(Modifier.width(6.dp))
                    CompanyMark(maker.first, size = 12.dp, tint = c.fg3, label = maker.second)
                }
            }
            if (sub != null) Text(sub, style = ConclaveType.meta, color = if (warn) c.warn else c.fg3, maxLines = if (warn) 2 else 1, overflow = TextOverflow.Ellipsis)
        }
        if (vision) {
            Icon(Icons.Outlined.Visibility, contentDescription = "Reads images", modifier = Modifier.size(16.dp), tint = c.fg3)
            Spacer(Modifier.width(8.dp))
        }
        if (detail != null) {
            Text(detail, style = ConclaveType.metaNum, color = c.fg3, maxLines = 1)
            Spacer(Modifier.width(8.dp))
        }
        if (selected) Icon(Icons.Filled.Check, contentDescription = "Selected", modifier = Modifier.size(16.dp), tint = c.fg)
        if (onPin != null) {
            IconButton(onClick = onPin, modifier = Modifier.size(40.dp)) {
                Icon(
                    if (pinned) Icons.Filled.PushPin else Icons.Outlined.PushPin,
                    contentDescription = if (pinned) "Unpin $label" else "Pin $label",
                    modifier = Modifier.size(16.dp),
                    tint = if (pinned) c.fg2 else c.fg4,
                )
            }
        }
    }
}
