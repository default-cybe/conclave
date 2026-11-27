import ConclaveKit
import SwiftUI

/// An approval inline in the chat, as the web's ApprovalCard (components/inbox/ApprovalCard.tsx) and
/// Android's Cards.kt: a raised card with a rule-2 line, the question in semibold with "waiting" in
/// amber, what it would run in a sunk box, then Allow once (ink), the wider allow (outline), Deny
/// (quiet, fault on press) and Always allow (quiet) at the right. An answer draws an ok rule on the left.
struct ApprovalCard: View {
    let request: ApprovalRequest
    let viewing: String
    let onAnswer: (ApprovalResponse) async -> Void
    @State private var sent: String?
    @State private var denied = false
    @State private var details = false
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduce

    var body: some View {
        let phone = sizeClass == .compact
        let pr = request.tool == AskCards.pullRequest
        CardFrame(from: Asks.fromLine(request, viewing: viewing), landed: sent.map { _ in denied ? Tone.fg3 : Tone.ok }) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(pr ? "Open this pull request?" : "Allow \(request.tool)?")
                    .font(.sans(phone ? 15 : 14, .semibold))
                    .foregroundStyle(Tone.fg)
                Spacer(minLength: 0)
                Text(sent ?? "waiting").font(.sans(phone ? 13 : 12)).foregroundStyle(sent == nil ? Tone.warn : Tone.fg3)
                    .contentTransition(.opacity)
            }
            Text(request.summary.isEmpty ? request.tool : request.summary)
                .font(pr ? .sans(13.5) : .mono(phone ? 13 : 12.5))
                .foregroundStyle(Tone.fg)
                .lineSpacing(3)
                .lineLimit(details ? nil : 8)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .panel(Tone.sunk, radius: Radius.r2, border: Tone.rule)
                .padding(.top, 12)
            if details {
                if let json = request.input.pretty { CodeBlockView(language: request.tool, text: json).padding(.top, 8) }
                if let rule = request.suggestedRule, AskCards.wider(request) {
                    Text("Always allow adds the rule \(rule)").font(.sans(12.5)).foregroundStyle(Tone.fg3).padding(.top, 6)
                }
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { buttons(phone); Spacer(minLength: 0); trailing(phone) }
                VStack(alignment: .leading, spacing: 8) { HStack(spacing: 8) { buttons(phone) }; trailing(phone) }
                VStack(alignment: .leading, spacing: 8) { buttons(phone); trailing(phone) }
            }
            .padding(.top, 14)
            .disabled(sent != nil)
            .animation(Motion.of(Motion.ease(Motion.dur2), reduce: reduce), value: sent)
        }
    }

    @ViewBuilder private func buttons(_ phone: Bool) -> some View {
        let h: CGFloat = phone ? 44 : 30
        answer("Allow once", "Allowed", .allowOnce, look: .solid, height: h)
        if AskCards.wider(request) { answer(Asks.sessionLabel(request), Asks.sessionDone(request), .allowSession, look: .outline, height: h) }
        answer("Deny", "Denied", .deny(), look: .quietFault, height: h)
    }

    @ViewBuilder private func trailing(_ phone: Bool) -> some View {
        HStack(spacing: 4) {
            if AskCards.wider(request), request.suggestedRule != nil {
                answer("Always allow", "Always allowed", .allowAlways(rule: request.suggestedRule), look: .quiet, height: phone ? 44 : 30)
            }
            Button(details ? "Hide details" : "Details") {
                withAnimation(Motion.of(Motion.ease, reduce: reduce)) { details.toggle() }
            }
            .buttonStyle(CVButton(look: .quiet, height: phone ? 44 : 30))
        }
    }

    private func answer(_ title: String, _ done: String, _ r: ApprovalResponse, look: CVButton.Look, height: CGFloat) -> some View {
        Button(title) {
            sent = done
            denied = r.decision == "deny"
            Task {
                await onAnswer(r)
                // still here after a while: the answer did not land, so it can be given again
                try? await Task.sleep(for: .seconds(4))
                sent = nil
            }
        }
        .buttonStyle(CVButton(look: look, height: height, size: height > 40 ? 15 : 13))
    }
}

/// A question inline in the chat, as the web's QuestionCard: the question in 14 pt semibold, the
/// options as quiet rows (label 14 medium, description 13 fg-3), a ring or box that fills in signal,
/// an Other field, Send in ink.
struct QuestionCard: View {
    let request: QuestionRequest
    let viewing: String
    let onAnswer: ([String: String]) async -> Void
    @State private var picked: [Int: Set<String>] = [:]
    @State private var other: [Int: String] = [:]
    @State private var sent = false
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        let phone = sizeClass == .compact
        CardFrame(from: Asks.fromLine(request, viewing: viewing), landed: sent ? Tone.ok : nil) {
            ForEach(Array(request.questions.enumerated()), id: \.offset) { i, q in
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(q.header ?? "Question").font(.sans(phone ? 13 : 12)).foregroundStyle(Tone.fg3)
                        Spacer(minLength: 0)
                        if i == 0 { Text(sent ? "answered" : "waiting").font(.sans(phone ? 13 : 12)).foregroundStyle(sent ? Tone.fg3 : Tone.warn) }
                    }
                    Text(q.question).font(.sans(phone ? 16 : 14, .semibold)).foregroundStyle(Tone.fg).padding(.top, 2)
                    if q.multiSelect { Text("Pick any").font(.sans(12)).foregroundStyle(Tone.fg3) }
                    VStack(spacing: phone ? 8 : 0) {
                        ForEach(q.options, id: \.label) { o in option(i, q, o, phone) }
                    }
                    .padding(.top, 8)
                    .padding(.horizontal, phone ? 0 : -12)
                    TextField("Other answer", text: Binding(get: { other[i] ?? "" }, set: { other[i] = $0 }))
                        .font(.sans(phone ? 16 : 14))
                        .foregroundStyle(Tone.fg)
                        .padding(.horizontal, 12)
                        .frame(height: phone ? 48 : 32)
                        .panel(phone ? Tone.surface2 : Tone.sunk, radius: phone ? Radius.tile : Radius.r2, border: Tone.rule)
                        .padding(.top, 8)
                }
                .padding(.bottom, 8)
            }
            Button(sent ? "Sent" : "Send") {
                sent = true
                Task {
                    await onAnswer(AskCards.answers(request, picked: picked, other: other))
                    try? await Task.sleep(for: .seconds(4))
                    sent = false
                }
            }
            .buttonStyle(CVButton(look: .solid, height: phone ? 48 : 30, radius: phone ? Radius.tile : Radius.r2, size: phone ? 16 : 13, full: phone))
            .disabled(sent || !AskCards.ready(request, picked: picked, other: other))
            .padding(.top, 4)
        }
    }

    private func option(_ i: Int, _ q: Question, _ o: QuestionOption, _ phone: Bool) -> some View {
        let on = picked[i]?.contains(o.label) == true
        return Button {
            picked[i] = AskCards.tap(picked[i] ?? [], o.label, multi: q.multiSelect)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Image(systemName: q.multiSelect ? (on ? "checkmark.square.fill" : "square") : (on ? "largecircle.fill.circle" : "circle"))
                    .font(.system(size: 14))
                    .foregroundStyle(on ? Tone.signal : Tone.fg4)
                    .contentTransition(.symbolEffect(.replace))
                VStack(alignment: .leading, spacing: 2) {
                    Text(o.label).font(.sans(phone ? 16 : 14, .medium)).foregroundStyle(Tone.fg)
                    if let d = o.description { Text(d).font(.sans(phone ? 14 : 13)).foregroundStyle(Tone.fg3) }
                }
                Spacer(minLength: 0)
            }
            .multilineTextAlignment(.leading)
            .padding(.horizontal, 12).padding(.vertical, phone ? 12 : 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(QuietPress(radius: phone ? Radius.tile : Radius.r2))
        // phone: each option a bordered tile, the picked one in fg (the web's PhonePrompt)
        .overlay {
            if phone { RoundedRectangle(cornerRadius: Radius.tile, style: .continuous).strokeBorder(on ? Tone.fg : Tone.rule2) }
        }
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// The card: the quiet who-asks line, then a raised card, radius 5 (18 on a phone), rule-2 line.
/// `landed`: the answer went; an ok (or fg-3 for a denial) rule shows at the left edge.
private struct CardFrame<Content: View>: View {
    let from: String?
    var landed: Color?
    @ViewBuilder let content: () -> Content
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduce

    var body: some View {
        let radius = sizeClass == .compact ? Radius.phoneCard : Radius.r2
        VStack(alignment: .leading, spacing: 6) {
            if let from { Text(from).font(.sans(12.5)).foregroundStyle(Tone.fg3).lineLimit(1) }
            VStack(alignment: .leading, spacing: 0, content: content)
                .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Tone.raise)
                .overlay(alignment: .leading) {
                    Rectangle().fill(landed ?? .clear).frame(width: 2).opacity(landed == nil ? 0 : 1)
                }
                .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
                .hairline(Tone.rule2, radius: radius)
                .animation(Motion.of(Motion.ease(Motion.dur2), reduce: reduce), value: landed != nil)
        }
    }
}
