package dev.conclave.app.ui.common

import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.conclave.app.ui.motion.Motion
import dev.conclave.app.ui.motion.reducedMotion
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.ConclaveType
import dev.conclave.client.logic.ModelPicks
import dev.conclave.client.model.ModelGroup
import dev.conclave.client.model.ModelInfo
import java.util.Locale

/**
 * Bottom sheet for picking a model, in two levels like the Claude app's
 * picker (the web's ModelPicker.tsx, logic/ModelPicks.kt). First a row per
 * maker (Anthropic, OpenAI, Google, Z.ai, then the others, Coding agents
 * last) with its mark and the current model's name, else how many models it
 * has; [extra] free-form refs (e.g. "@reviewer" agents) stay on top. A row
 * opens its models in place under a back row ("< Anthropic"); the system
 * back goes back too. The sheet opens on the current model's maker. Typing
 * searches every model as one flat list; clearing it goes back to the
 * makers. A model the owner's order reaches through several providers shows
 * once, with its route under the name (core providers/merge.ts); a
 * [current] ref of another route checks that row. [header] goes between the
 * title and the search: the composer's Effort row (docs/DESIGN.md 37).
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
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var query by remember { mutableStateOf("") }
    val makers = remember(groups) { ModelPicks.groups(groups) }
    // a saved ref on a plan's prefix or an effort variant checks the row it folds into
    val shown = remember(groups, current) { ModelPicks.shownRow(makers, groups, current) }
    // opens on the current model's maker; with none, on the makers
    var open by remember { mutableStateOf(ModelPicks.groupOf(makers, shown)) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
            Text(title, style = ConclaveType.title, modifier = Modifier.padding(horizontal = 20.dp))
            if (header != null) header()
            OutlinedTextField(
                value = query,
                onValueChange = {
                    // clearing the search goes back to the makers
                    if (query.isNotBlank() && it.isBlank()) open = null
                    query = it
                },
                placeholder = { Text("Search models") },
                leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            )
            val q = query.trim().lowercase()
            val inside = makers.firstOrNull { it.key == open }
            BackHandler(enabled = q.isEmpty() && inside != null) { open = null }
            val level = when {
                q.isNotEmpty() -> SEARCH
                inside != null -> inside.key
                else -> TOP
            }
            val reduced = reducedMotion()
            val rise = with(LocalDensity.current) { Motion.RISE.roundToPx() }
            AnimatedContent(
                targetState = level,
                transitionSpec = {
                    // into a maker the list comes from the right, back out from the left; a search just swaps
                    val d = if (reduced || targetState == SEARCH || initialState == SEARCH) 0 else Motion.DUR_2
                    val from = if (targetState == TOP) -rise else rise
                    (fadeIn(tween(d, easing = Motion.Ease)) + slideInHorizontally(tween(d, easing = Motion.Ease)) { from }) togetherWith
                        fadeOut(tween(if (d == 0) 0 else Motion.DUR_1, easing = Motion.EaseIn))
                },
                label = "model levels",
            ) { shownLevel ->
                LazyColumn(Modifier.fillMaxWidth().heightIn(max = 560.dp)) {
                    when (shownLevel) {
                        SEARCH -> {
                            val extras = extra.filter { (ref, label) -> ref.lowercase().contains(q) || label.lowercase().contains(q) }.distinctBy { it.first }
                            val found = ModelPicks.search(makers, q)
                            items(extras, key = { "x:" + it.first }) { (ref, label) ->
                                PickerRow(ref = null, label = label, sub = ref, detail = null, selected = ref == current) { onPick(ref) }
                            }
                            items(found, key = { "m:" + it.ref }) { r ->
                                ModelRow(r, selected = r.ref == shown, maker = makers.firstOrNull { g -> r in g.rows }?.name) { onPick(r.ref) }
                            }
                            if (extras.isEmpty() && found.isEmpty()) {
                                item { Text("No models match.", modifier = Modifier.padding(24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            }
                        }
                        TOP -> {
                            val extras = extra.distinctBy { it.first }
                            if (extras.isNotEmpty()) {
                                item { SectionHeader("Agents") }
                                items(extras, key = { "x:" + it.first }) { (ref, label) ->
                                    PickerRow(ref = null, label = label, sub = ref, detail = null, selected = ref == current) { onPick(ref) }
                                }
                                item { HorizontalDivider(thickness = 1.dp, color = Conclave.colors.rule, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp)) }
                            }
                            items(makers, key = { "g:" + it.key }) { g ->
                                MakerRow(g, ModelPicks.note(g, shown), named = g.rows.any { it.ref == shown }) { open = g.key }
                            }
                            if (makers.isEmpty() && extras.isEmpty()) {
                                item { Text("No models yet. Add a key in Settings, Providers.", modifier = Modifier.padding(24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            }
                        }
                        else -> {
                            val g = makers.firstOrNull { it.key == shownLevel }
                            if (g != null) {
                                item(key = "back") { BackRow(g) { open = null } }
                                items(g.rows, key = { "m:" + it.ref }) { r -> ModelRow(r, selected = r.ref == shown, current = current, onRoute = onPick) { onPick(r.ref) } }
                            }
                        }
                    }
                }
            }
        }
    }
}

private const val TOP = ""
private const val SEARCH = "?"

/** A maker's row: its mark and name, the current model's name or how many models it has, and a chevron. */
@Composable
private fun MakerRow(g: ModelPicks.Group, note: String, named: Boolean, onClick: () -> Unit) {
    val c = Conclave.colors
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 52.dp).padding(start = 20.dp, end = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MakerMark(g)
        Spacer(Modifier.width(logoGap(16.dp)))
        Text(g.name, style = ConclaveType.rowTitle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Spacer(Modifier.width(8.dp))
        Text(
            note,
            style = if (named) ConclaveType.meta else ConclaveType.metaNum,
            color = if (named) c.fg2 else c.fg3,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        Spacer(Modifier.width(4.dp))
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, contentDescription = null, tint = c.fg3, modifier = Modifier.size(20.dp))
    }
}

/** The row back to the makers: "< [mark] Anthropic". */
@Composable
private fun BackRow(g: ModelPicks.Group, onClick: () -> Unit) {
    val c = Conclave.colors
    Row(
        Modifier.fillMaxWidth().clickable(onClickLabel = "Back to all models", onClick = onClick).heightIn(min = 52.dp).padding(start = 12.dp, end = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowLeft, contentDescription = "Back", tint = c.fg3, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(4.dp))
        MakerMark(g)
        Spacer(Modifier.width(logoGap(16.dp)))
        Text(g.name, style = ConclaveType.section, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A maker's company mark; the coding agents a terminal. */
@Composable
private fun MakerMark(g: ModelPicks.Group) {
    val c = Conclave.colors
    if (g.key == ModelPicks.AGENTS) {
        Icon(Icons.Outlined.Terminal, contentDescription = null, tint = c.fg2, modifier = Modifier.size(16.dp))
    } else {
        CompanyMark(g.key, size = 16.dp, tint = c.fg)
    }
}

/** A model: its name, its route or ref under it (after its maker while searching), context and price, a check on the current one. */
@Composable
private fun ModelRow(r: ModelPicks.Row, selected: Boolean, maker: String? = null, current: String? = null, onRoute: (String) -> Unit = {}, onClick: () -> Unit) {
    // the row is the model's name; a route picked by hand ("via neu") says so, the ref only for a coding agent
    val picked = r.routes.firstOrNull { !it.first && it.ref == current }
    val sub = picked?.let { "via ${it.label}" } ?: r.via ?: if (r.harness) r.ref else null
    PickerRow(
        ref = r.ref,
        label = r.label,
        sub = if (maker != null && !r.harness) listOfNotNull(maker, sub).joinToString(", ") else sub,
        detail = modelDetail(r.model),
        selected = selected,
        vision = r.model.vision,
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
    onClick: () -> Unit,
) {
    val c = Conclave.colors
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (ref != null) {
            // Model rows show the model family, even for a harness ref.
            ModelMark(ref, size = 16.dp, tint = c.fg)
            Spacer(Modifier.width(logoGap(16.dp)))
        }
        Column(Modifier.weight(1f)) {
            Text(label, style = ConclaveType.rowTitle, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (sub != null) Text(sub, style = ConclaveType.meta, color = c.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
    }
}
