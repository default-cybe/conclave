import ConclaveKit
import SwiftUI

/// An approval inline in the chat (Android ui/chat/Cards.kt): who asks, what, and the answers it offers.
struct ApprovalCard: View {
    let request: ApprovalRequest
    let viewing: String
    let onAnswer: (ApprovalResponse) async -> Void
    @State private var sent: String?
    @State private var details = false

    var body: some View {
        CardFrame(from: Asks.fromLine(request, viewing: viewing)) {
            HStack(alignment: .firstTextBaseline) {
                Text(request.summary.isEmpty ? request.tool : request.summary)
                    .font(.system(.callout, design: request.tool == AskCards.pullRequest ? .default : .monospaced))
                    .textSelection(.enabled)
                Spacer()
                Button(details ? "Hide details" : "Details") { details.toggle() }.font(.footnote).buttonStyle(.borderless)
            }
            if details {
                if let json = request.input.pretty { CodeBlockView(language: request.tool, text: json) }
                if let rule = request.suggestedRule, AskCards.wider(request) {
                    Text("Always allow adds the rule \(rule)").font(.footnote).foregroundStyle(Tone.fg3)
                }
            }
            if let sent {
                Label(sent, systemImage: "checkmark").font(.callout).foregroundStyle(Tone.fg2)
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack { buttons }
                    VStack(alignment: .leading) { buttons }
                }
            }
        }
    }

    @ViewBuilder private var buttons: some View {
        answer("Allow once", "Allowed", .allowOnce, prominent: true)
        if AskCards.wider(request) {
            answer(Asks.sessionLabel(request), Asks.sessionDone(request), .allowSession)
            if request.suggestedRule != nil { answer("Always allow", "Always allowed", .allowAlways(rule: request.suggestedRule)) }
        }
        answer("Deny", "Denied", .deny(), role: .destructive)
    }

    private func answer(_ title: String, _ done: String, _ r: ApprovalResponse, prominent: Bool = false, role: ButtonRole? = nil) -> some View {
        Button(title, role: role) {
            sent = done
            Task {
                await onAnswer(r)
                // still here after a while: the answer did not land, so it can be given again
                try? await Task.sleep(for: .seconds(4))
                sent = nil
            }
        }
        .buttonStyle(AskButtonStyle(prominent: prominent))
    }
}

/// A question inline in the chat: options with their descriptions, single or multiple choice, and Other.
struct QuestionCard: View {
    let request: QuestionRequest
    let viewing: String
    let onAnswer: ([String: String]) async -> Void
    @State private var picked: [Int: Set<String>] = [:]
    @State private var other: [Int: String] = [:]
    @State private var sent = false

    var body: some View {
        CardFrame(from: Asks.fromLine(request, viewing: viewing)) {
            ForEach(Array(request.questions.enumerated()), id: \.offset) { i, q in
                VStack(alignment: .leading, spacing: 6) {
                    if let h = q.header { Text(h.uppercased()).font(.caption).foregroundStyle(Tone.fg3) }
                    Text(q.question).font(.headline)
                    if q.multiSelect { Text("Pick any").font(.caption).foregroundStyle(Tone.fg3) }
                    ForEach(q.options, id: \.label) { o in
                        let on = picked[i]?.contains(o.label) == true
                        Button {
                            picked[i] = AskCards.tap(picked[i] ?? [], o.label, multi: q.multiSelect)
                        } label: {
                            HStack(alignment: .firstTextBaseline) {
                                Image(systemName: q.multiSelect ? (on ? "checkmark.square.fill" : "square") : (on ? "largecircle.fill.circle" : "circle"))
                                    .foregroundStyle(on ? Tone.signal : Tone.fg3)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(o.label)
                                    if let d = o.description { Text(d).font(.footnote).foregroundStyle(Tone.fg3) }
                                }
                                Spacer(minLength: 0)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(on ? .isSelected : [])
                    }
                    TextField("Other answer", text: Binding(get: { other[i] ?? "" }, set: { other[i] = $0 }))
                        .textFieldStyle(.roundedBorder)
                }
            }
            Button(sent ? "Sent" : "Send") {
                sent = true
                Task {
                    await onAnswer(AskCards.answers(request, picked: picked, other: other))
                    try? await Task.sleep(for: .seconds(4))
                    sent = false
                }
            }
            .buttonStyle(AskButtonStyle(prominent: true))
            .disabled(sent || !AskCards.ready(request, picked: picked, other: other))
        }
    }
}

/// The card: the quiet who-asks line, then the content on a raised rounded panel.
private struct CardFrame<Content: View>: View {
    let from: String?
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let from { Text(from).font(.footnote).foregroundStyle(Tone.fg3) }
            VStack(alignment: .leading, spacing: 12, content: content)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Tone.raise, in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(Tone.signal.opacity(0.5)))
        }
    }
}

private struct AskButtonStyle: ButtonStyle {
    let prominent: Bool
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(.medium))
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .foregroundStyle(prominent ? Color.white : configuration.role == .destructive ? Tone.fault : Tone.fg2)
            .background(prominent ? Tone.signal : Tone.sunk, in: Capsule())
            .opacity(configuration.isPressed ? 0.7 : enabled ? 1 : 0.45)
    }
}
