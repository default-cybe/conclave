import ConclaveKit
import SwiftUI

/// The Assistant's home (web features/home AssistantHome, Android home/TodayScreen.kt): the day plan
/// the assistant saved, the tasks due, active goals with their next step, and today's calendar.
struct TodayView: View {
    let hub: HubModel
    let page: (SidePage) -> Void
    let open: (String) -> Void
    @State private var today: Today?
    @State private var goals: [Goal] = []
    @State private var error: String?

    var body: some View {
        Page(title: "Today", sub: today.map { dateWords($0.date) }) {
            Button("Message assistant") { Task { if let id = await hub.newSession(.assistant) { open(id) } } }
                .buttonStyle(CVButton(look: .solid))
        } content: {
            if let error { ErrorBox(message: error) { Task { await load() } } }
            if let t = today {
                plan(t)
                if t.dueToday + t.overdue > 0 {
                    CardSection(title: "Tasks") {
                        Button { page(.tasks) } label: {
                            CardRow(label: [t.dueToday > 0 ? "\(t.dueToday) due today" : nil, t.overdue > 0 ? "\(t.overdue) overdue" : nil].compactMap { $0 }.joined(separator: ", ")) {
                                Image(systemName: "chevron.right").font(.system(size: 12)).foregroundStyle(Tone.fg4)
                            }.contentShape(Rectangle())
                        }
                        .buttonStyle(QuietPress(radius: 0))
                    }
                }
                let top = goals.filter { $0.parentId == nil }
                if !top.isEmpty {
                    CardSection(title: "Goals") {
                        ForEach(top) { g in
                            CardRow(label: g.title, detail: g.nextStep) {
                                if let d = g.targetDate { RowValue(text: d) }
                            }
                        }
                    }
                }
                if let events = t.events {
                    CardSection(title: "Calendar", note: events.isEmpty ? "Nothing in the calendar today." : nil) {
                        ForEach(events) { e in
                            CardRow(label: e.title, detail: e.calendar) { RowValue(text: e.allDay ? "All day" : range(e, t.timezone)) }
                        }
                    }
                }
                if let err = t.calendarError { Text("Could not read a calendar: \(err)").font(.sans(12.5)).foregroundStyle(Tone.fg3) }
            } else if error == nil {
                LoadingLine(text: "Reading your day")
            }
        }
        .refreshable { await load() }
        .task { await load() }
    }

    @ViewBuilder private func plan(_ t: Today) -> some View {
        if let p = t.plan, !(p.summary.isEmpty && p.items.isEmpty) {
            VStack(alignment: .leading, spacing: 10) {
                if !p.summary.isEmpty { Text(p.summary).font(.sans(15)).foregroundStyle(Tone.fg).fixedSize(horizontal: false, vertical: true) }
                if let f = p.focus, !f.text.isEmpty {
                    HStack(spacing: 8) {
                        Image(systemName: "scope").foregroundStyle(Tone.signal)
                        Text("\(f.start)–\(f.end)  \(f.text)").font(.sans(13.5, .medium)).foregroundStyle(Tone.fg)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .panel(Tone.signal.opacity(0.08), radius: Radius.r2, border: Tone.signal.opacity(0.3))
                }
                if !p.items.isEmpty {
                    CardSection(title: "Plan") {
                        ForEach(Array(p.items.enumerated()), id: \.offset) { _, i in
                            HStack(alignment: .firstTextBaseline, spacing: 12) {
                                Text(i.time ?? "").font(.sans(12.5)).monospacedDigit().foregroundStyle(Tone.fg3).frame(width: 48, alignment: .leading)
                                Text(i.text).font(.sans(14)).foregroundStyle(Tone.fg).fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 14).padding(.vertical, 10)
                        }
                    }
                }
            }
        } else {
            EmptyLine(text: "No plan for today yet. Ask the assistant to plan your day.")
        }
    }

    private func load() async {
        do {
            async let t = hub.client.today()
            async let g = try? hub.client.goals()
            let (day, list) = try await (t, g)
            today = day
            goals = list ?? []
            error = nil
        } catch {
            if (error as? URLError)?.code == .cancelled { return }
            self.error = error.localizedDescription
        }
    }

    private func dateWords(_ ymd: String) -> String {
        guard let d = try? Date(ymd + "T12:00:00Z", strategy: .iso8601) else { return ymd }
        return d.formatted(.dateTime.weekday(.wide).month(.wide).day())
    }

    private func range(_ e: TodayEvent, _ zone: String) -> String {
        var f = Date.FormatStyle(date: .omitted, time: .shortened)
        f.timeZone = TimeZone(identifier: zone) ?? .current
        let a = Date(timeIntervalSince1970: Double(e.start) / 1000), b = Date(timeIntervalSince1970: Double(e.end) / 1000)
        return "\(a.formatted(f))–\(b.formatted(f))"
    }
}
