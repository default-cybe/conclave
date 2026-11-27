import SwiftUI
import UIKit

/// The composer's text, a UITextView: SwiftUI's TextField cannot tell Return from Shift+Return, nor take a
/// pasted picture. Return and Cmd+Return send on a hardware keyboard, Shift+Return makes a new line; the
/// on-screen keyboard's Return is a new line (Send is the button). Scribble works as in any text view.
struct ComposerField: UIViewRepresentable {
    @Binding var text: String
    let placeholder: String
    let onSend: () -> Void
    let onPasteImages: ([UIImage]) -> Void
    private static let maxHeight: CGFloat = 200

    func makeUIView(context: Context) -> Field {
        let v = Field()
        v.delegate = context.coordinator
        v.adjustsFontForContentSizeCategory = true
        v.backgroundColor = .clear
        v.textColor = UIColor(Tone.fg)
        v.tintColor = UIColor(Tone.signal)
        v.textContainerInset = UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 0)
        v.textContainer.lineFragmentPadding = 0
        v.isScrollEnabled = false
        v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        v.accessibilityIdentifier = "composer"
        v.placeholder.text = placeholder
        return v
    }

    func updateUIView(_ v: Field, context: Context) {
        // the reading size, Mona Sans: 16 on a phone, 15 wider (the web's --read-base)
        let size: CGFloat = Metrics(context.environment.horizontalSizeClass).compact ? 16 : 15
        if v.font?.pointSize != UIFontMetrics(forTextStyle: .body).scaledValue(for: size) {
            let f = UIFontMetrics(forTextStyle: .body).scaledFont(for: UIFont(name: "MonaSans-Regular", size: size) ?? .systemFont(ofSize: size))
            v.font = f
            v.placeholder.font = f
        }
        if v.text != text { v.text = text }
        v.placeholder.text = placeholder
        v.placeholder.isHidden = !text.isEmpty
        v.onSend = onSend
        v.onPasteImages = onPasteImages
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView v: Field, context: Context) -> CGSize? {
        let width = proposal.width ?? 300
        let fit = v.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        v.isScrollEnabled = fit > Self.maxHeight
        return CGSize(width: width, height: min(fit, Self.maxHeight))
    }

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    final class Coordinator: NSObject, UITextViewDelegate {
        let text: Binding<String>
        init(text: Binding<String>) { self.text = text }
        func textViewDidChange(_ v: UITextView) {
            text.wrappedValue = v.text
            (v as? Field)?.placeholder.isHidden = !v.text.isEmpty
            v.invalidateIntrinsicContentSize()
        }
    }

    final class Field: UITextView {
        var onSend: () -> Void = {}
        var onPasteImages: ([UIImage]) -> Void = { _ in }
        let placeholder = UILabel()

        override init(frame: CGRect, textContainer: NSTextContainer?) {
            super.init(frame: frame, textContainer: textContainer)
            placeholder.textColor = UIColor(Tone.fg3)
            placeholder.adjustsFontForContentSizeCategory = true
            placeholder.translatesAutoresizingMaskIntoConstraints = false
            addSubview(placeholder)
            NSLayoutConstraint.activate([
                placeholder.leadingAnchor.constraint(equalTo: leadingAnchor),
                placeholder.topAnchor.constraint(equalTo: topAnchor, constant: 8),
            ])
        }

        required init?(coder: NSCoder) { fatalError("not from a storyboard") }

        override var keyCommands: [UIKeyCommand]? {
            let plain = UIKeyCommand(input: "\r", modifierFlags: [], action: #selector(send))
            let cmd = UIKeyCommand(title: "Send", action: #selector(send), input: "\r", modifierFlags: .command)
            // else the text view's own Return (a newline) wins
            plain.wantsPriorityOverSystemBehavior = true
            cmd.wantsPriorityOverSystemBehavior = true
            // while composing CJK text Return confirms the word, not a send
            return markedTextRange == nil ? [plain, cmd] : []
        }

        @objc private func send() { onSend() }

        override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
            if action == #selector(paste(_:)), UIPasteboard.general.hasImages { return true }
            return super.canPerformAction(action, withSender: sender)
        }

        override func paste(_ sender: Any?) {
            let board = UIPasteboard.general
            if board.hasImages, let images = board.images, !images.isEmpty {
                onPasteImages(images)
                // a picture copied with its caption keeps the words too
                if board.hasStrings, let s = board.string { insertText(s) }
            } else {
                super.paste(sender)
            }
        }
    }
}
