import SwiftUI

/// Conclave's color tokens: packages/web/src/styles/index.css (oklch, here as the sRGB it resolves to),
/// the same values as the Android app's ui/theme/Theme.kt. Light and dark. Color means one thing each:
/// signal is live work, focus and the brand; warn waits on you; ok is healthy; fault failed.
enum Tone {
    static let bg = pair(0xF9F9FA, 0x0E0E10)
    static let sunk = pair(0xF1F1F4, 0x08080B)
    static let raise = pair(0xFFFFFF, 0x151518)
    static let hover = pair(0xEEEEF1, 0x19191D)
    /// Phones: the composer and your message bubble (docs/design/MOBILE-V2.md).
    static let surface2 = pair(0xEDEDF0, 0x1D1D21)
    /// The sidebar and the phone's drawer, a step under the page, and its rows.
    static let side = pair(0xF1F1F3, 0x09090C)
    static let sideHover = pair(0xE7E7EA, 0x131316)
    static let sideActive = pair(0xE1E1E5, 0x18181C)
    static let card = pair(0xFFFFFF, 0x141417)
    static let rule = pair(0xDFDFE3, 0x242428)
    static let rule2 = pair(0xC3C3C9, 0x36363B)
    static let edge = pair(0x8B8B91, 0x5D5D63)
    static let fg = pair(0x17171C, 0xECECEF)
    static let fg2 = pair(0x48484F, 0xB2B2B8)
    static let fg3 = pair(0x686870, 0x828289)
    static let fg4 = pair(0x85858C, 0x626269)
    static let signal = pair(0x7A4ABA, 0xC6A2F7)
    static let ok = pair(0x007E46, 0x71D29D)
    static let warn = pair(0xA66000, 0xF2BE62)
    static let fault = pair(0xCC3430, 0xF1756C)
    /// --solid and --solid-fg: the ink button (fg on bg).
    static let solid = fg
    static let solidInk = bg
    static let scrim = Color(UIColor { $0.userInterfaceStyle == .dark ? rgb(0x050507, 0.6) : rgb(0x1E1E24, 0.28) })

    // code (--syn-*)
    static let synKeyword = pair(0x6D41A9, 0xC4A8EC)
    static let synString = pair(0x246E3A, 0x94CF9F)
    static let synNumber = pair(0x9C5313, 0xE9B082)
    static let synType = pair(0x006488, 0x8AC9DD)

    private static func pair(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? rgb(dark) : rgb(light) })
    }

    static func rgb(_ v: UInt32, _ alpha: CGFloat = 1) -> UIColor {
        UIColor(red: CGFloat(v >> 16 & 0xFF) / 255, green: CGFloat(v >> 8 & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: alpha)
    }
}

/// The web's radii (--r-1..3) and the phone shapes of MOBILE-V2 (bubble 20, composer 24, cards 18, tiles 12).
enum Radius {
    static let r1: CGFloat = 3
    static let r2: CGFloat = 5
    static let r3: CGFloat = 10
    /// A sidebar row.
    static let row: CGFloat = 8
    static let tile: CGFloat = 12
    static let phoneCard: CGFloat = 18
    static let bubble: CGFloat = 20
    static let box: CGFloat = 24
}

/// Mona Sans and JetBrains Mono, the web's --sans and --mono, bundled from the Android app (SIL OFL 1.1,
/// licenses in App/Resources/Fonts). Each size scales with Dynamic Type from the text style it reads as.
extension Font {
    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .body) -> Font {
        let name = switch weight {
        case .semibold, .bold, .heavy, .black: "MonaSans-SemiBold"
        case .medium: "MonaSans-Medium"
        default: "MonaSans-Regular"
        }
        return .custom(name, size: size, relativeTo: style)
    }

    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular, relativeTo style: Font.TextStyle = .callout) -> Font {
        let name = switch weight {
        case .semibold, .bold, .heavy, .black: "JetBrainsMono-Bold"
        case .medium: "JetBrainsMono-Medium"
        default: "JetBrainsMono-Regular"
        }
        return .custom(name, size: size, relativeTo: style)
    }
}

/// Sizes that differ between a computer-wide window (the web's desktop) and a phone (the web's
/// phone sizes and Android): reading 15/1.6 against 16/1.55, rows 13.5 against 15.
struct Metrics {
    let compact: Bool

    /// Phone sizes only on a phone: NavigationSplitView gives the iPad sidebar column a compact
    /// size class too, which drew it at phone sizes. A narrow iPad window keeps the web's desktop sizes.
    init(_ sizeClass: UserInterfaceSizeClass?) {
        compact = sizeClass == .compact && UIDevice.current.userInterfaceIdiom == .phone
    }

    var read: CGFloat { compact ? 16 : 15 }
    /// Extra space between lines for the reading leading (Mona Sans sets about 1.25 by itself).
    var readSpacing: CGFloat { compact ? 4.8 : 5.25 }
    var meta: CGFloat { compact ? 13.5 : 12.5 }
    var row: CGFloat { compact ? 15 : 13.5 }
    var code: CGFloat { compact ? 13 : 12.5 }
    var gutter: CGFloat { compact ? 16 : 32 }
}

/// The web's motion tokens (--ease, --dur-1..3, motion.css). Every animation goes through `Motion.of`, so
/// Reduce Motion turns movement off; fades that carry meaning stay, short.
enum Motion {
    static let ease = Animation.timingCurve(0.2, 0.7, 0.2, 1, duration: 0.24)
    static let dur1 = 0.12
    static let dur2 = 0.18
    static let dur3 = 0.24

    static func ease(_ d: Double) -> Animation { .timingCurve(0.2, 0.7, 0.2, 1, duration: d) }

    /// The animation, or a quick fade under Reduce Motion.
    static func of(_ a: Animation, reduce: Bool) -> Animation { reduce ? .linear(duration: dur1) : a }
}

/// Cards and new messages come in as on the web (anim-rise: 6 pt up and a fade, 240 ms); with Reduce
/// Motion they only fade.
struct Rise: ViewModifier {
    var delay: Double = 0
    @Environment(\.accessibilityReduceMotion) private var reduce
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown || reduce ? 0 : 6)
            .onAppear {
                guard !shown else { return }
                withAnimation(Motion.of(Motion.ease.delay(delay), reduce: reduce)) { shown = true }
            }
    }
}

extension View {
    func rise(delay: Double = 0) -> some View { modifier(Rise(delay: delay)) }

    /// A 1 pt line around a rounded shape, the web's `border border-rule`.
    func hairline(_ color: Color = Tone.rule, radius: CGFloat, width: CGFloat = 1) -> some View {
        overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(color, lineWidth: width))
    }

    func panel(_ fill: Color, radius: CGFloat, border: Color? = nil) -> some View {
        background(fill, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay { if let border { RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(border, lineWidth: 1) } }
    }
}

/// Press feedback of a quiet row or icon: the hover fill while held, no system highlight.
struct QuietPress: ButtonStyle {
    var fill: Color = Tone.hover
    var radius: CGFloat = Radius.row
    var selected = false
    var selectedFill: Color = Tone.sideActive

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(RoundedRectangle(cornerRadius: radius))
            .background(selected ? selectedFill : configuration.isPressed ? fill : .clear, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
    }
}

/// The web's Button (components/ui/Button.tsx): solid ink, outline, quiet and quiet-fault; md is 30 pt, touch 44.
struct CVButton: ButtonStyle {
    enum Look { case solid, accent, outline, quiet, quietFault }
    var look: Look = .outline
    var height: CGFloat = 30
    var radius: CGFloat = Radius.r2
    var size: CGFloat = 13
    var full = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        let (fill, ink, line): (Color, Color, Color?) = switch look {
        case .solid: enabled ? (Tone.solid, Tone.solidInk, nil) : (Tone.hover, Tone.fg3, Tone.rule)
        case .accent: enabled ? (Tone.signal, Tone.bg, nil) : (Tone.hover, Tone.fg3, Tone.rule)
        case .outline: (pressed ? Tone.hover : .clear, enabled ? Tone.fg : Tone.fg3, Tone.rule2)
        case .quiet: (pressed ? Tone.hover : .clear, enabled ? Tone.fg2 : Tone.fg3, nil)
        case .quietFault: (pressed ? Tone.fault.opacity(0.1) : .clear, enabled ? (pressed ? Tone.fault : Tone.fg2) : Tone.fg3, nil)
        }
        configuration.label
            .font(.sans(size, .medium))
            .lineLimit(1)
            .padding(.horizontal, look == .quiet || look == .quietFault ? 8 : 12)
            .frame(maxWidth: full ? .infinity : nil, minHeight: height)
            .foregroundStyle(ink)
            .background(fill, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay { if let line { RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(line, lineWidth: 1) } }
            .brightness(pressed && (look == .solid || look == .accent) ? -0.06 : 0)
            .contentShape(RoundedRectangle(cornerRadius: radius))
            .animation(.linear(duration: Motion.dur1), value: pressed)
    }
}
