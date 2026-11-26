import SwiftUI

/// The Android app's color tokens (ui/theme/Theme.kt), light and dark. Only the ones phase 2 draws.
enum Tone {
    static let sunk = pair(0xF1F1F4, 0x08080B)
    static let raise = pair(0xFFFFFF, 0x151518)
    static let rule = pair(0xDFDFE3, 0x242428)
    static let fg2 = pair(0x48484F, 0xB2B2B8)
    static let fg3 = pair(0x686870, 0x828289)
    static let signal = pair(0x7A4ABA, 0xC6A2F7)
    static let ok = pair(0x007E46, 0x71D29D)
    static let warn = pair(0xA66000, 0xF2BE62)
    static let fault = pair(0xCC3430, 0xF1756C)

    private static func pair(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? rgb(dark) : rgb(light) })
    }

    private static func rgb(_ v: UInt32) -> UIColor {
        UIColor(red: CGFloat(v >> 16 & 0xFF) / 255, green: CGFloat(v >> 8 & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }
}
