package dev.conclave.app.ui.common

import androidx.annotation.DrawableRes
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.takeOrElse
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.conclave.app.R
import dev.conclave.app.ui.theme.Conclave
import dev.conclave.app.ui.theme.MonaSans
import dev.conclave.client.logic.LogoId
import dev.conclave.client.logic.Logos
import dev.conclave.client.logic.ModelRefs

/*
 * Provider, model and harness marks (spec 8). The drawables are the mono
 * LobeHub icons (MIT), converted to VectorDrawables; they tint with the text
 * next to them. Logos are identity, not icons: a mark always sits next to its
 * name unless it carries a label.
 *
 * Which mark: Logos.harness for a session that runs through a CLI,
 * Logos.model for a model, Logos.company for a plan, key or bill.
 */

/** The drawable for a mark. */
@DrawableRes
fun LogoId.drawable(): Int = when (this) {
    LogoId.CLAUDE_CODE -> R.drawable.logo_claude_code
    LogoId.CODEX -> R.drawable.logo_codex
    LogoId.GEMINI_CLI -> R.drawable.logo_gemini_cli
    LogoId.OPENCODE -> R.drawable.logo_opencode
    LogoId.CURSOR -> R.drawable.logo_cursor
    LogoId.CLINE -> R.drawable.logo_cline
    LogoId.OPENHANDS -> R.drawable.logo_openhands
    LogoId.CLAUDE -> R.drawable.logo_claude
    LogoId.GPT -> R.drawable.logo_openai
    LogoId.GEMINI -> R.drawable.logo_gemini
    LogoId.GLM -> R.drawable.logo_zai
    LogoId.DEEPSEEK -> R.drawable.logo_deepseek
    LogoId.QWEN -> R.drawable.logo_qwen
    LogoId.KIMI -> R.drawable.logo_kimi
    LogoId.MISTRAL -> R.drawable.logo_mistral
    LogoId.GROK -> R.drawable.logo_grok
    LogoId.LLAMA -> R.drawable.logo_meta
    LogoId.MINIMAX -> R.drawable.logo_minimax
    LogoId.ANTHROPIC -> R.drawable.logo_anthropic
    LogoId.OPENAI -> R.drawable.logo_openai
    LogoId.GOOGLE -> R.drawable.logo_google
    LogoId.ZAI -> R.drawable.logo_zai
    LogoId.ZHIPU -> R.drawable.logo_zhipu
    LogoId.MOONSHOT -> R.drawable.logo_moonshot
    LogoId.OPENROUTER -> R.drawable.logo_openrouter
    LogoId.OLLAMA -> R.drawable.logo_ollama
    LogoId.LMSTUDIO -> R.drawable.logo_lmstudio
    LogoId.GROQ -> R.drawable.logo_groq
    LogoId.XAI -> R.drawable.logo_xai
}

/**
 * The drawable for a model or harness ref, or null when a monogram should be
 * drawn instead. A harness ref ("claude-code/opus", "codex") gives the harness
 * mark; a model ref ("anthropic/claude-sonnet-5-5") gives its family mark.
 */
@DrawableRes
fun logoRes(ref: String?): Int? = (Logos.harness(ref) ?: Logos.model(ref))?.drawable()

/** The drawable for a provider, plan or limit id ("claude-max" is Anthropic), or null. */
@DrawableRes
fun companyLogoRes(provider: String?): Int? = Logos.company(provider)?.drawable()

/** Gap from a mark to its text, by mark size (spec 8.4). */
fun logoGap(size: Dp): Dp = when {
    size <= 13.dp -> 5.dp
    size <= 14.dp -> 7.dp
    size <= 16.dp -> 8.dp
    else -> 14.dp
}

/**
 * One mark at [size], tinted [tint] (the text color by default). An unknown
 * id draws a monogram of [fallbackName]. Pass [label] only when the mark
 * stands alone without its name.
 */
@Composable
fun Logo(
    id: LogoId?,
    fallbackName: String,
    modifier: Modifier = Modifier,
    size: Dp = 14.dp,
    tint: Color = LocalContentColor.current,
    label: String? = null,
) {
    if (id == null) {
        Monogram(fallbackName, modifier, size, label)
        return
    }
    Icon(painterResource(id.drawable()), contentDescription = label, modifier = modifier.size(size), tint = tint)
}

/** One or two letters in a hairline square, for providers without a mark (spec 8.5). */
@Composable
fun Monogram(name: String, modifier: Modifier = Modifier, size: Dp = 14.dp, label: String? = null) {
    val c = Conclave.colors
    val letters = Logos.monogram(name, if (size >= 18.dp) 2 else 1)
    val fontSize = with(LocalDensity.current) { (size * 0.62f * (if (letters.length > 1) 0.8f else 1f)).toSp() }
    Box(
        modifier
            .size(size)
            .border(1.dp, c.rule2, RoundedCornerShape(3.dp))
            .clearAndSetSemantics { if (label != null) contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            letters,
            color = c.fg2,
            style = TextStyle(fontFamily = MonaSans, fontWeight = FontWeight.SemiBold, fontSize = fontSize, lineHeight = fontSize),
            textAlign = TextAlign.Center,
            maxLines = 1,
        )
    }
}

/** Model family mark for a model ref: anthropic/claude-sonnet-5-5 shows Claude. */
@Composable
fun ModelMark(model: String?, modifier: Modifier = Modifier, size: Dp = 14.dp, tint: Color = LocalContentColor.current, label: String? = null) {
    Logo(Logos.model(model), ModelRefs.displayName(model).ifEmpty { model.orEmpty() }, modifier, size, tint, label)
}

/** Harness mark (Claude Code, Codex, Gemini CLI, OpenCode). Always one color. */
@Composable
fun HarnessMark(harness: String?, modifier: Modifier = Modifier, size: Dp = 14.dp, tint: Color = LocalContentColor.current, label: String? = null) {
    Logo(Logos.harness(harness), ModelRefs.harnessLabel(harness) ?: harness.orEmpty(), modifier, size, tint, label)
}

/** Company mark for a provider, plan or limit id: claude-max shows Anthropic. */
@Composable
fun CompanyMark(provider: String?, modifier: Modifier = Modifier, size: Dp = 16.dp, tint: Color = LocalContentColor.current, label: String? = null) {
    Logo(Logos.company(provider), ModelRefs.providerName(provider), modifier, size, tint, label)
}

@Composable
private fun MarkAndName(
    mark: @Composable () -> Unit,
    name: String,
    modifier: Modifier,
    size: Dp,
    style: TextStyle,
    color: Color,
    showMark: Boolean,
) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        if (showMark) {
            mark()
            Spacer(Modifier.width(logoGap(size)))
        }
        Text(name, style = style, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * Mark plus display name, the common case: "[claude] Sonnet 5.5".
 * A harness ref shows the harness ("[cc] Claude Code") unless [asModel],
 * which shows the model family, as model pickers do.
 */
@Composable
fun ModelName(
    model: String?,
    modifier: Modifier = Modifier,
    size: Dp = 14.dp,
    style: TextStyle = LocalTextStyle.current,
    color: Color = Color.Unspecified,
    asModel: Boolean = false,
    name: String? = null,
    logo: Boolean = true,
) {
    if (model.isNullOrBlank()) return
    val tint = color.takeOrElse { style.color.takeOrElse { LocalContentColor.current } }
    val harness = if (asModel) null else Logos.harness(model)
    val text = name ?: if (harness != null) ModelRefs.harnessLabel(model) ?: model else ModelRefs.displayName(model)
    MarkAndName(
        mark = {
            if (harness != null) Logo(harness, text, size = size, tint = tint) else ModelMark(model, size = size, tint = tint)
        },
        name = text,
        modifier = modifier,
        size = size,
        style = style,
        color = tint,
        showMark = logo,
    )
}

/** Harness mark plus its name: "[cc] Claude Code". */
@Composable
fun HarnessName(
    harness: String?,
    modifier: Modifier = Modifier,
    size: Dp = 14.dp,
    style: TextStyle = LocalTextStyle.current,
    color: Color = Color.Unspecified,
    suffix: String = "",
) {
    if (harness.isNullOrBlank()) return
    val tint = color.takeOrElse { style.color.takeOrElse { LocalContentColor.current } }
    val name = (ModelRefs.harnessLabel(harness) ?: harness) + suffix
    MarkAndName({ HarnessMark(harness, size = size, tint = tint) }, name, modifier, size, style, tint, showMark = true)
}

/** Company mark plus a provider or plan name: "[anthropic] Claude Max". */
@Composable
fun CompanyName(
    provider: String?,
    modifier: Modifier = Modifier,
    name: String? = null,
    size: Dp = 16.dp,
    style: TextStyle = LocalTextStyle.current,
    color: Color = Color.Unspecified,
) {
    if (provider.isNullOrBlank()) return
    val tint = color.takeOrElse { style.color.takeOrElse { LocalContentColor.current } }
    val text = name?.ifBlank { null } ?: ModelRefs.providerName(provider)
    MarkAndName({ CompanyMark(provider, size = size, tint = tint) }, text, modifier, size, style, tint, showMark = true)
}
