import ConclaveKit
import SwiftUI

/// What waits on you across sessions (Android Inbox, the web's ApprovalsPage below 1280 pt): one
/// column of full cards, questions first, then approvals newest first. Each card is the chat's own
/// (answerable here), under its chat's title and an "Open chat" link.
struct InboxView: View {
    let hub: HubModel
    let open: (String) -> Void

    var body: some View {
        let questions = hub.questions.sorted { $0.createdAt > $1.createdAt }
        let approvals = hub.approvals.sorted { $0.createdAt > $1.createdAt }
        let count = questions.count + approvals.count
        Page(title: "Inbox", sub: count == 0 ? nil : "\(count) waiting on you") {
            if count == 0 {
                EmptyLine(text: InboxWords.empty)
            }
            ForEach(questions) { q in
                item(Asks.home(q), line: InboxWords.questionLine(q), at: q.createdAt) {
                    QuestionCard(request: q, viewing: Asks.home(q)) { await hub.answer(q, $0) }
                }
            }
            ForEach(approvals) { a in
                let lines = InboxWords.approvalLines(a.tool, a.summary, input: a.input)
                item(Asks.home(a), line: Asks.askerLine(a, lines.label), at: a.createdAt) {
                    ApprovalCard(request: a, viewing: Asks.home(a)) { await hub.answer(a, $0) }
                }
            }
        }
    }

    /// The chat's title and what it wants, the time, "Open chat", then the card.
    private func item<Card: View>(_ home: String, line: String, at: Int64, @ViewBuilder card: () -> Card) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(hub.session(home).map(Panel.title) ?? "Chat").font(.sans(14, .semibold)).foregroundStyle(Tone.fg).lineLimit(1)
                    Text(line).font(.sans(12.5)).foregroundStyle(Tone.fg3).lineLimit(1)
                }
                Spacer(minLength: 0)
                if at > 0 { Text(Ago.short(at, now: Int64(Date().timeIntervalSince1970 * 1000))).font(.sans(12)).foregroundStyle(Tone.fg4) }
                Button("Open chat") { open(home) }.buttonStyle(CVButton(look: .quiet, height: 28, size: 12.5))
            }
            card()
        }
        .padding(.top, 4)
        .rise()
    }
}
