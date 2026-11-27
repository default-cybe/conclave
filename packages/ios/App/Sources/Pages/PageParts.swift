import SwiftUI

/// A page past the chat (Inbox, Devices, Settings) as the web lays them out: a centred column
/// 760 pt wide with the web's gutters, the title in 20 pt semibold and a quiet line under it,
/// then the content. No system List or Form: those draw iOS grouped tables, not Conclave.
struct Page<Trailing: View, Content: View>: View {
    let title: String
    var sub: String? = nil
    @ViewBuilder var trailing: () -> Trailing
    @ViewBuilder var content: () -> Content
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        let m = Metrics(sizeClass)
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(title).font(.sans(m.compact ? 24 : 20, .semibold)).foregroundStyle(Tone.fg)
                            .accessibilityAddTraits(.isHeader)
                        if let sub { Text(sub).font(.sans(m.compact ? 14 : 13)).foregroundStyle(Tone.fg3) }
                    }
                    Spacer(minLength: 0)
                    trailing()
                }
                content()
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(.horizontal, m.gutter)
            .padding(.top, m.compact ? 12 : 28).padding(.bottom, 40)
            .frame(maxWidth: .infinity)
        }
        .background(Tone.bg.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Tone.bg, for: .navigationBar)
    }
}

extension Page where Trailing == EmptyView {
    init(title: String, sub: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.init(title: title, sub: sub, trailing: { EmptyView() }, content: content)
    }
}

/// A titled group of rows on a raised card with a hairline, rows split by rules (web Settings).
struct CardSection<Content: View>: View {
    let title: String
    var note: String? = nil
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.sans(12.5, .semibold)).foregroundStyle(Tone.fg3).padding(.leading, 2)
                .accessibilityAddTraits(.isHeader)
            VStack(spacing: 0) {
                Group(subviews: content()) { rows in
                    ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
                        if i > 0 { Rectangle().fill(Tone.rule).frame(height: 1).padding(.leading, 14) }
                        row
                    }
                }
            }
            .panel(Tone.raise, radius: Radius.r3, border: Tone.rule)
            if let note { Text(note).font(.sans(12)).foregroundStyle(Tone.fg3).padding(.leading, 2) }
        }
    }
}

/// One row of a card: a label at the left, a value or control at the right, 44 pt high.
struct CardRow<Value: View>: View {
    let label: String
    var detail: String? = nil
    @ViewBuilder var value: () -> Value

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.sans(14)).foregroundStyle(Tone.fg)
                if let detail { Text(detail).font(.sans(12)).foregroundStyle(Tone.fg3).lineLimit(2) }
            }
            Spacer(minLength: 8)
            value()
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .frame(minHeight: 44)
    }
}

/// A row's value as words: 14 pt fg-2, or mono for an address, on one line.
struct RowValue: View {
    let text: String
    var mono = false
    var body: some View { Text(text).font(mono ? .mono(12.5) : .sans(14)).foregroundStyle(Tone.fg2).lineLimit(1) }
}

extension CardRow where Value == RowValue {
    init(_ label: String, _ text: String, mono: Bool = false) {
        self.init(label: label) { RowValue(text: text, mono: mono) }
    }
}

/// The web's Segmented control: options on a hover tint, the picked one raised with a hairline.
struct Segmented<T: Hashable>: View {
    let options: [(T, String)]
    @Binding var selection: T
    @Namespace private var ns
    @Environment(\.accessibilityReduceMotion) private var reduce

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.0) { value, label in
                let on = value == selection
                Button {
                    withAnimation(Motion.of(.spring(response: 0.3, dampingFraction: 0.85), reduce: reduce)) { selection = value }
                } label: {
                    Text(label).font(.sans(12.5, .medium)).foregroundStyle(on ? Tone.fg : Tone.fg3)
                        .padding(.horizontal, 10).frame(height: 26)
                        .background {
                            if on {
                                RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Tone.raise)
                                    .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Tone.rule))
                                    .matchedGeometryEffect(id: "on", in: ns)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(2)
        .background(Tone.hover.opacity(0.6), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
}

/// A quiet centred line where a list is empty.
struct EmptyLine: View {
    let text: String
    var body: some View {
        Text(text).font(.sans(13.5)).foregroundStyle(Tone.fg3).multilineTextAlignment(.center)
            .frame(maxWidth: .infinity).padding(.vertical, 40)
    }
}
