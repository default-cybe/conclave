package dev.conclave.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import dev.conclave.app.R
import dev.conclave.client.logic.TextSize

/**
 * Conclave color tokens (docs/design/SPEC.md section 3). The values are the
 * sRGB equivalents of the OKLCH tokens in packages/web/src/styles/index.css,
 * so the app and the web app share one palette.
 *
 * Color means one thing each: [signal] is live work, focus and the brand;
 * [warn] is something waiting on the owner or a limit at 70%; [ok] is healthy;
 * [fault] is failed or a limit at 90%. Neutrals carry the rest.
 */
@Immutable
data class ConclaveColors(
    val dark: Boolean,
    /** Page surface. */
    val bg: Color,
    /** Inputs, code, composer. */
    val bgSunk: Color,
    /** Approval card, menus, dialogs, sheets, selected row. */
    val bgRaise: Color,
    /** Row and quiet button hover or press. */
    val bgHover: Color,
    /** Row and column rules. */
    val rule: Color,
    /** Section heading rule, box borders, outline buttons. */
    val rule2: Color,
    /** Input and checkbox borders. */
    val edge: Color,
    /** Primary text. */
    val fg: Color,
    /** Secondary text. */
    val fg2: Color,
    /** Metadata, labels, hints. */
    val fg3: Color,
    /**
     * Icons, rules and separators. Never words: at 3.2:1 it is under the
     * 4.5:1 text needs, so placeholders and disabled labels are [fg3].
     */
    val fg4: Color,
    val signal: Color,
    val signalDim: Color,
    val ok: Color,
    val warn: Color,
    val fault: Color,
    val addBg: Color,
    val delBg: Color,
    val meterOff: Color,
    val meterOn: Color,
    val waveInk: Color,
    val waveHot: Color,
    val scrim: Color,
    val synKw: Color,
    val synStr: Color,
    val synNum: Color,
    val synType: Color,
) {
    /** The phone's second surface (MOBILE-V2): your bubbles, the composer, a filled chip. */
    val surface2: Color get() = bgHover

    /** Primary button fill: neutral ink, never violet. */
    val solid: Color get() = fg

    /** Primary button text. */
    val solidFg: Color get() = bg
}

val DarkTokens = ConclaveColors(
    dark = true,
    bg = Color(0xFF0E0E10),
    bgSunk = Color(0xFF08080B),
    bgRaise = Color(0xFF151518),
    bgHover = Color(0xFF19191D),
    rule = Color(0xFF242428),
    rule2 = Color(0xFF36363B),
    edge = Color(0xFF5D5D63),
    fg = Color(0xFFECECEF),
    fg2 = Color(0xFFB2B2B8),
    fg3 = Color(0xFF828289),
    fg4 = Color(0xFF626269),
    signal = Color(0xFFC6A2F7),
    signalDim = Color(0x24C6A2F7),
    ok = Color(0xFF71D29D),
    warn = Color(0xFFF2BE62),
    fault = Color(0xFFF1756C),
    addBg = Color(0x1771D29D),
    delBg = Color(0x1AF1756C),
    meterOff = Color(0xFF2D2D32),
    meterOn = Color(0xFFBDBDC4),
    waveInk = Color(0xFFA09CA9),
    waveHot = Color(0xFFDFC0FF),
    scrim = Color(0x99030304),
    synKw = Color(0xFFC4A8EC),
    synStr = Color(0xFF94CF9F),
    synNum = Color(0xFFE9B082),
    synType = Color(0xFF8AC9DD),
)

val LightTokens = ConclaveColors(
    dark = false,
    bg = Color(0xFFF9F9FA),
    bgSunk = Color(0xFFF1F1F4),
    bgRaise = Color(0xFFFFFFFF),
    bgHover = Color(0xFFEEEEF1),
    rule = Color(0xFFDFDFE3),
    rule2 = Color(0xFFC3C3C9),
    edge = Color(0xFF8B8B91),
    fg = Color(0xFF17171C),
    fg2 = Color(0xFF48484F),
    fg3 = Color(0xFF686870),
    fg4 = Color(0xFF85858C),
    signal = Color(0xFF7A4ABA),
    signalDim = Color(0x177A4ABA),
    ok = Color(0xFF007E46),
    warn = Color(0xFFA66000),
    fault = Color(0xFFCC3430),
    addBg = Color(0x1F51B67A),
    delBg = Color(0x1AE45D53),
    meterOff = Color(0xFFDDDDE1),
    meterOn = Color(0xFF35353A),
    waveInk = Color(0xFF5E5B6D),
    waveHot = Color(0xFF7444B4),
    scrim = Color(0x4715151A),
    synKw = Color(0xFF6D41A9),
    synStr = Color(0xFF246E3A),
    synNum = Color(0xFF9C5313),
    synType = Color(0xFF006488),
)

val LocalConclaveColors = staticCompositionLocalOf { DarkTokens }

/** Semantic colors Material does not have, derived from the tokens. */
@Immutable
data class ExtraColors(
    val success: Color,
    val warning: Color,
    val diffAddBg: Color,
    val diffDelBg: Color,
    /** Gutter sign of an added line. */
    val diffAddFg: Color,
    /** Gutter sign of a removed line. */
    val diffDelFg: Color,
    val codeBg: Color,
)

private fun ConclaveColors.extra() = ExtraColors(
    success = ok,
    warning = warn,
    diffAddBg = addBg,
    diffDelBg = delBg,
    diffAddFg = ok,
    diffDelFg = fault,
    codeBg = bgSunk,
)

val LocalExtraColors = staticCompositionLocalOf { DarkTokens.extra() }

/** Shorthand: `Conclave.colors.fg3`. */
object Conclave {
    val colors: ConclaveColors
        @Composable @ReadOnlyComposable get() = LocalConclaveColors.current
}

/**
 * Material roles from the tokens. The primary role is neutral ink (the solid
 * button), so violet never fills a button; screens use [ConclaveColors.signal]
 * by name for live state. Surfaces stay flat: no tonal tint.
 */
private fun ConclaveColors.scheme(): ColorScheme {
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = fg,
        onPrimary = bg,
        primaryContainer = bgRaise,
        onPrimaryContainer = fg,
        inversePrimary = signal,
        secondary = fg2,
        onSecondary = bg,
        secondaryContainer = bgRaise,
        onSecondaryContainer = fg,
        tertiary = fg2,
        onTertiary = bg,
        tertiaryContainer = bgRaise,
        onTertiaryContainer = fg,
        background = bg,
        onBackground = fg,
        surface = bg,
        onSurface = fg,
        surfaceVariant = bgHover,
        onSurfaceVariant = fg3,
        surfaceTint = Color.Transparent,
        inverseSurface = bgRaise,
        inverseOnSurface = fg,
        error = fault,
        onError = bg,
        errorContainer = delBg,
        onErrorContainer = fault,
        outline = edge,
        outlineVariant = rule,
        scrim = scrim,
        surfaceBright = bgRaise,
        surfaceDim = bgSunk,
        surfaceContainerLowest = bgSunk,
        surfaceContainerLow = bgRaise,
        surfaceContainer = bgRaise,
        surfaceContainerHigh = bgRaise,
        surfaceContainerHighest = bgHover,
    )
}

// ---------------------------------------------------------------------------
// Type (spec 4). Mona Sans for everything, JetBrains Mono for code only.
// The bundled fonts are static, so 450 draws at 400 and 540 or 560 at 500.
// ---------------------------------------------------------------------------

val MonaSans = FontFamily(
    Font(R.font.mona_sans_regular, FontWeight.Normal),
    Font(R.font.mona_sans_medium, FontWeight.Medium),
    Font(R.font.mona_sans_semibold, FontWeight.SemiBold),
    // No weights of 700 or more (spec 2): bold text, as in markdown, draws at 600.
    Font(R.font.mona_sans_semibold, FontWeight.Bold),
)

val JetBrainsMono = FontFamily(
    Font(R.font.jetbrains_mono_regular, FontWeight.Normal),
    Font(R.font.jetbrains_mono_medium, FontWeight.Medium),
    Font(R.font.jetbrains_mono_bold, FontWeight.Bold),
)

private fun mona(size: Float, lineHeight: Float, weight: FontWeight, tracking: TextUnit = 0.em, numbers: Boolean = false) =
    TextStyle(
        fontFamily = MonaSans,
        fontWeight = weight,
        fontSize = size.sp,
        lineHeight = (size * lineHeight).sp,
        letterSpacing = tracking,
        fontFeatureSettings = if (numbers) "tnum" else null,
    )

/** The spec's type roles at phone sizes (spec 4.2). */
object ConclaveType {
    val wordmarkXl = mona(64f, 0.95f, FontWeight.SemiBold, (-0.035).em)
    val status = mona(23f, 1.15f, FontWeight.Medium, (-0.02).em)
    val verdict = mona(34f, 1.1f, FontWeight.SemiBold, (-0.025).em)
    val stepTitle = mona(24f, 1.15f, FontWeight.SemiBold, (-0.02).em)
    val pageTitle = mona(20f, 1.25f, FontWeight.SemiBold, (-0.012).em)
    val title = mona(17f, 1.3f, FontWeight.SemiBold, (-0.01).em)
    /** Tabular readouts. */
    val stat = mona(20f, 1.1f, FontWeight.Medium, (-0.01).em, numbers = true)
    val section = mona(14f, 1.3f, FontWeight.SemiBold)
    val rowTitle = mona(15f, 1.35f, FontWeight.Medium)
    val body = mona(15f, 1.45f, FontWeight.Normal)
    val prose = mona(15.5f, 1.6f, FontWeight.Normal)
    /** Chat messages on the phone (MOBILE-V2 5, 16/1.55, as in Claude's Android app), times the Text size in a transcript ([chatDensity]). */
    val chat = mona(TextSize.CHAT_BODY, 1.55f, FontWeight.Normal)
    /** The empty chat page greeting (t-page at 26). */
    val greeting = mona(26f, 1.2f, FontWeight.Medium, (-0.015).em)
    val meta = mona(13f, 1.4f, FontWeight.Normal)
    /** Meta with tabular figures, for times, counts and percents in columns. */
    val metaNum = mona(13f, 1.4f, FontWeight.Normal, numbers = true)
    val micro = mona(11f, 1.3f, FontWeight.Normal)
    val button = mona(15f, 1.3f, FontWeight.Medium)
    val code = TextStyle(
        fontFamily = JetBrainsMono,
        fontWeight = FontWeight.Normal,
        fontSize = 12.5.sp,
        lineHeight = 20.sp,
        letterSpacing = (-0.01).em,
        fontFeatureSettings = "zero",
    )
}

val ConclaveTypography = Typography(
    displayLarge = ConclaveType.wordmarkXl,
    displayMedium = ConclaveType.verdict,
    displaySmall = ConclaveType.stepTitle,
    headlineLarge = ConclaveType.status,
    headlineMedium = ConclaveType.pageTitle,
    // Dialog titles use headlineSmall: the spec's `title` role.
    headlineSmall = ConclaveType.title,
    // Top app bar titles use titleLarge: the spec's `page-title` role.
    titleLarge = ConclaveType.pageTitle,
    titleMedium = ConclaveType.title,
    titleSmall = ConclaveType.rowTitle,
    bodyLarge = ConclaveType.prose,
    bodyMedium = ConclaveType.body,
    bodySmall = ConclaveType.meta,
    labelLarge = ConclaveType.button,
    labelMedium = mona(13f, 1.35f, FontWeight.Medium),
    labelSmall = ConclaveType.micro,
)

/** Monospace style for code, diffs, paths and ids. */
val CodeStyle = ConclaveType.code

enum class ThemeMode(val wire: String, val label: String) {
    SYSTEM("system", "System"),
    DARK("dark", "Dark"),
    LIGHT("light", "Light");

    companion object {
        /** The saved choice; none yet follows the phone, as the web app does. */
        fun from(wire: String?): ThemeMode = entries.firstOrNull { it.wire == wire } ?: SYSTEM
    }
}

/** The Text size picked in Settings, Appearance. Only a transcript reads it ([chatDensity]). */
val LocalTextSize = staticCompositionLocalOf { TextSize.DEFAULT }

/**
 * The density for a transcript (a session's turns, a chat's replies): its
 * sp, so replies, your messages, tool rows and code, at the Text size on
 * top of the phone's own font size. Its dp, and the screen around it, stay
 * as they are. Provide it as LocalDensity around the transcript's list.
 */
@Composable
fun chatDensity(): Density {
    val d = LocalDensity.current
    val size = LocalTextSize.current
    return remember(d, size) { Density(d.density, size.fontScale(d.fontScale)) }
}

/**
 * The Conclave look: the web tokens in dark or light, following the phone
 * unless the owner picked one. Dynamic color stays off so the app always
 * looks like Conclave. [textSize] is for the transcripts ([chatDensity]).
 */
@Composable
fun ConclaveTheme(
    mode: ThemeMode = ThemeMode.SYSTEM,
    textSize: TextSize = TextSize.DEFAULT,
    content: @Composable () -> Unit,
) {
    val dark = when (mode) {
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
        ThemeMode.DARK -> true
        ThemeMode.LIGHT -> false
    }
    val tokens = if (dark) DarkTokens else LightTokens
    val extra = remember(tokens) { tokens.extra() }
    val scheme = remember(tokens) { tokens.scheme() }
    CompositionLocalProvider(
        LocalConclaveColors provides tokens,
        LocalExtraColors provides extra,
        LocalTextSize provides textSize,
    ) {
        MaterialTheme(colorScheme = scheme, typography = ConclaveTypography, content = content)
    }
}

/** True when the Conclave dark tokens are in use. */
@Composable
@ReadOnlyComposable
fun isDarkScheme(): Boolean = LocalConclaveColors.current.dark
