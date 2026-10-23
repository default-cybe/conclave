@file:OptIn(ExperimentalSharedTransitionApi::class)

package dev.conclave.app.ui.motion

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.BoundsTransform
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.focusable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.client.motion.CardPanel as PanelTiming

/** Which card is open, and what each card opens to. */
class CardPanelState {
    var open by mutableStateOf<String?>(null)
    internal var last: String? = null
    internal val panels = HashMap<String, @Composable (close: () -> Unit) -> Unit>()
    internal val labels = HashMap<String, String>()
    internal val cards = HashMap<String, FocusRequester>()
    internal var returnTo: String? = null

    fun close() {
        returnTo = open
        open = null
    }
}

/** Inside a [CardPanelHost]: cards that open into their panel. */
class CardPanelScope internal constructor(internal val shared: SharedTransitionScope, val state: CardPanelState)

private val PanelShape = RoundedCornerShape(10.dp)

private fun key(k: String) = "cv-panel:$k"

/**
 * Card to panel (ui.html card-panel): a card grows into its full panel (a
 * container transform, with SharedTransitionLayout) while the page dims.
 * The card's face fades out first; the panel's content fades in from 110ms;
 * the box grows in 420ms on --ease-emph. Closing shrinks it back in 320ms on
 * --ease-std, and the card's face returns before the box is empty. Back or a
 * tap outside closes it; focus moves into the panel and back to the card.
 * With "Remove animations" the panel opens and closes in place.
 *
 * Put the cards inside [content] with [PanelCard].
 */
@Composable
fun CardPanelHost(modifier: Modifier = Modifier, state: CardPanelState = remember { CardPanelState() }, content: @Composable CardPanelScope.() -> Unit) {
    val c = Conclave.colors
    val reduced = reducedMotion()
    SharedTransitionLayout(modifier) {
        val scope = remember(this, state) { CardPanelScope(this, state) }
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val maxH = maxHeight
            scope.content()
            val open = state.open
            if (open != null) state.last = open
            val shown = open ?: state.last
            val opening = open != null
            AnimatedVisibility(
                visible = opening,
                enter = if (reduced) EnterTransition.None else fadeIn(tween(PanelTiming.OPEN_MS, easing = Motion.EaseEmph)),
                exit = if (reduced) ExitTransition.None else fadeOut(tween(PanelTiming.CLOSE_MS, easing = Motion.EaseStd)),
            ) {
                Box(
                    Modifier
                        .fillMaxSize()
                        .background(c.scrim)
                        .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClickLabel = "Close") { state.close() },
                )
            }
            AnimatedVisibility(
                visible = opening,
                enter = EnterTransition.None,
                exit = ExitTransition.None,
                modifier = Modifier.align(Alignment.Center),
            ) {
                val k = shown ?: return@AnimatedVisibility
                if (opening) BackHandler { state.close() }
                val focus = remember { FocusRequester() }
                LaunchedEffect(k) { runCatching { focus.requestFocus() } }
                val bounds = with(scope.shared) {
                    if (reduced) {
                        Modifier
                    } else {
                        Modifier.sharedBounds(
                            rememberSharedContentState(key(k)),
                            animatedVisibilityScope = this@AnimatedVisibility,
                            enter = fadeIn(tween(PanelTiming.CONTENT_MS, delayMillis = PanelTiming.CONTENT_AT, easing = Motion.Ease)),
                            exit = fadeOut(tween(PanelTiming.FACE_OUT_MS, easing = Motion.EaseIn)),
                            boundsTransform = panelBounds(opening),
                            clipInOverlayDuringTransition = OverlayClip(PanelShape),
                        )
                    }
                }
                Box(
                    Modifier
                        .padding(16.dp)
                        .widthIn(max = 640.dp)
                        .fillMaxWidth()
                        .heightIn(max = maxH * 0.8f)
                        .then(bounds)
                        .clip(PanelShape)
                        .background(c.bgRaise)
                        .border(1.dp, c.rule2, PanelShape)
                        .semantics { paneTitle = state.labels[k].orEmpty(); isTraversalGroup = true }
                        .focusRequester(focus)
                        .focusable(),
                ) {
                    state.panels[k]?.invoke { state.close() }
                }
            }
        }
    }
}

/** Grows on --ease-emph in 420ms; shrinks back on --ease-std in 320ms. */
private fun panelBounds(opening: Boolean) = BoundsTransform { _, _ ->
    if (opening) tween(PanelTiming.OPEN_MS, easing = Motion.EaseEmph) else tween(PanelTiming.CLOSE_MS, easing = Motion.EaseStd)
}

/**
 * A card that opens into its panel. [card] is its face (it is drawn in a
 * button); [panel] is what it opens to, given a way to close. [label] names
 * the panel for screen readers.
 */
@Composable
fun CardPanelScope.PanelCard(
    key: String,
    label: String,
    modifier: Modifier = Modifier,
    shape: androidx.compose.ui.graphics.Shape = PanelShape,
    panel: @Composable (close: () -> Unit) -> Unit,
    card: @Composable () -> Unit,
) {
    val reduced = reducedMotion()
    state.panels[key] = panel
    state.labels[key] = label
    val focus = remember { FocusRequester() }
    state.cards[key] = focus
    val open = state.open == key
    // focus comes back to the card that opened
    LaunchedEffect(open) {
        if (!open && state.returnTo == key) {
            state.returnTo = null
            runCatching { focus.requestFocus() }
        }
    }
    Box(modifier) {
        // holds the card's place in the list while it is out as the panel
        Box(Modifier.alpha(0f).clearAndSetSemantics { }) { card() }
        AnimatedVisibility(
            visible = !open,
            modifier = Modifier.matchParentSize(),
            enter = if (reduced) EnterTransition.None else fadeIn(tween(PanelTiming.FACE_OUT_MS, easing = Motion.Ease)),
            exit = if (reduced) ExitTransition.None else fadeOut(tween(PanelTiming.FACE_OUT_MS, easing = Motion.EaseIn)),
        ) {
            val bounds = with(shared) {
                if (reduced) {
                    Modifier
                } else {
                    Modifier.sharedBounds(
                        rememberSharedContentState(key(key)),
                        animatedVisibilityScope = this@AnimatedVisibility,
                        enter = fadeIn(tween(PanelTiming.FACE_OUT_MS, delayMillis = PanelTiming.CLOSE_MS - PanelTiming.FACE_OUT_MS * 2, easing = Motion.Ease)),
                        exit = fadeOut(tween(PanelTiming.FACE_OUT_MS, easing = Motion.EaseIn)),
                        boundsTransform = panelBounds(state.open != null),
                        clipInOverlayDuringTransition = OverlayClip(shape),
                    )
                }
            }
            Box(
                Modifier
                    .fillMaxSize()
                    .then(bounds)
                    .clip(shape)
                    .focusRequester(focus)
                    .clickable(onClickLabel = "Open $label") { state.open = key },
            ) { card() }
        }
    }
}
