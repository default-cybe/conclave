import ConclaveKit
import SwiftUI

/// Plans and spend (Android UsageScreen, web Usage): the range, what plans saved this month, each
/// plan's limit windows with a bar and the reset, then totals, cost per day, by model and by account.
struct UsageView: View {
    let hub: HubModel
    @State private var range = UsageRange.month
    @State private var summary: UsageSummary?
    /// This calendar month, for the savings line whatever the range.
    @State private var month: UsageSummary?
    @State private var limits: [LimitState]?
    @State private var error: String?
    @State private var reading = false
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        Page(title: "Usage") {
            Button(reading ? "Reading" : "Refresh limits") { Task { await readLimits() } }
                .buttonStyle(CVButton(look: .outline))
                .disabled(reading)
                .accessibilityIdentifier("usage-refresh")
        } content: {
            Segmented(options: UsageRange.allCases.map { ($0, $0.label) }, selection: $range)
            if let error { ErrorBox(message: error) { Task { await load() } } }
            if summary == nil && limits == nil {
                if error == nil { LoadingLine() }
            } else {
                if let totals = month?.totals, let line = ApiValue.savedSentence(totals) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(line).font(.sans(14, .medium)).foregroundStyle(Tone.fg)
                        Text(ApiValue.savedDetail(totals)).font(.sans(12.5)).foregroundStyle(Tone.fg3)
                    }
                }
                if let limits, !limits.isEmpty {
                    TimelineView(.periodic(from: .now, by: 30)) { ctx in
                        let now = Int64(ctx.date.timeIntervalSince1970 * 1000)
                        CardSection(title: "Limits") {
                            ForEach(UsageWords.sorted(limits)) { PlanBlock(limit: $0, now: now) }
                        }
                    }
                }
                if let s = summary { totals(s) }
            }
        }
        .refreshable { await load() }
        .task(id: range) { await load() }
    }

    @ViewBuilder private func totals(_ s: UsageSummary) -> some View {
        let columns = Array(repeating: GridItem(.flexible(), spacing: 8), count: Metrics(sizeClass).compact ? 2 : 4)
        VStack(alignment: .leading, spacing: 8) {
            Heading(text: "Totals")
            LazyVGrid(columns: columns, spacing: 8) {
                ForEach(UsageWords.tiles(s), id: \.label) { t in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(t.label).font(.sans(12)).foregroundStyle(Tone.fg3).lineLimit(1)
                        Text(t.value).font(.sans(18, .semibold)).monospacedDigit().foregroundStyle(Tone.fg).lineLimit(1).minimumScaleFactor(0.7)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .panel(Tone.raise, radius: Radius.r3, border: Tone.rule)
                    .accessibilityElement(children: .combine)
                }
            }
        }
        VStack(alignment: .leading, spacing: 8) {
            Heading(text: "Cost per day")
            CostChart(days: s.byDay)
        }
        if !s.byModel.isEmpty {
            let models = Array(s.byModel.sorted { $0.costUsd > $1.costUsd }.prefix(12))
            let top = max(models.first?.costUsd ?? 0, 0.000_001)
            CardSection(title: "By model") {
                ForEach(models, id: \.key) { m in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(m.key).font(.sans(14)).foregroundStyle(Tone.fg).lineLimit(1)
                            Spacer(minLength: 8)
                            Text(UsageWords.usd(m.costUsd)).font(.sans(14)).monospacedDigit().foregroundStyle(Tone.fg)
                        }
                        Bar(fraction: m.costUsd / top, fill: Tone.fg3, height: 3)
                        Text(UsageWords.modelLine(m)).font(.sans(12)).monospacedDigit().foregroundStyle(Tone.fg3)
                    }
                    .padding(.horizontal, 14).padding(.vertical, 10)
                }
            }
        }
        // plan accounts bill $0: each one's bill beside what its calls are worth at API prices
        let accounts = s.byAccount.filter { !$0.key.isEmpty && ($0.calls > 0 || $0.costUsd > 0) }
            .sorted { ApiValue.worth($0.costUsd, $0.apiValueUsd) > ApiValue.worth($1.costUsd, $1.apiValueUsd) }
        if !accounts.isEmpty {
            CardSection(title: "By account") {
                ForEach(accounts, id: \.key) { a in
                    CardRow(label: a.key, detail: "\(ApiValue.billedLine(a.costUsd, a.apiValueUsd)), \(a.calls) calls") { EmptyView() }
                }
            }
        }
    }

    private func load() async {
        let client = hub.client
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let from = now - Int64(range.days) * 86_400_000
        let monthStart = Int64((Calendar.current.dateInterval(of: .month, for: Date())?.start ?? Date()).timeIntervalSince1970 * 1000)
        // the sign of JavaScript's getTimezoneOffset
        let tz = -TimeZone.current.secondsFromGMT() / 60
        async let s = attempt { try await client.usage(from: from, to: now, tzOffset: tz) }
        async let m = attempt { try await client.usage(from: monthStart, to: now, tzOffset: tz) }
        async let l = attempt { try await client.limits() }
        let (rs, rm, rl) = await (s, m, l)
        // a failed read keeps the last value and says why; the others still show
        var failed: String?
        switch rs { case .success(let v): summary = v; case .failure(let e): failed = failed ?? e.localizedDescription }
        switch rm { case .success(let v): month = v; case .failure(let e): failed = failed ?? e.localizedDescription }
        switch rl { case .success(let v): limits = v; case .failure(let e): failed = failed ?? e.localizedDescription }
        if Task.isCancelled { return }
        error = failed
    }

    /// The hub reads every plan again (up to 8 s). A member gets 403 and keeps the stored values quietly.
    private func readLimits() async {
        reading = true
        defer { reading = false }
        do {
            limits = try await hub.client.refreshLimits()
        } catch let e as ConclaveAPIError where e.status == 403 {
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private func attempt<T: Sendable>(_ f: @Sendable () async throws -> T) async -> Result<T, any Error> {
    do { return .success(try await f()) } catch { return .failure(error) }
}

private struct Heading: View {
    let text: String
    var body: some View {
        Text(text).font(.sans(12.5, .semibold)).foregroundStyle(Tone.fg3).padding(.leading, 2).accessibilityAddTraits(.isHeader)
    }
}

/// A plan: its name and where the numbers come from, then each window.
private struct PlanBlock: View {
    let limit: LimitState
    let now: Int64

    var body: some View {
        let source = UsageWords.source(limit, now: now)
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(UsageWords.planName(limit)).font(.sans(14, .medium)).foregroundStyle(Tone.fg).lineLimit(1)
                Spacer(minLength: 8)
                Text(source.text).font(.sans(12)).foregroundStyle(source.fault ? Tone.fault : Tone.fg3).lineLimit(1)
            }
            if limit.windows.isEmpty {
                Text(limit.note ?? "No limit windows reported").font(.sans(12.5)).foregroundStyle(Tone.fg3)
            } else {
                ForEach(Array(limit.windows.enumerated()), id: \.offset) { _, w in
                    WindowRow(window: w, blocked: limit.blocked == true && (w.usedPercent ?? 0) >= 99, now: now)
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
    }
}

/// One window: label and percent, the bar (neutral, warn from 70%, fault from 90%), the reset.
private struct WindowRow: View {
    let window: LimitWindow
    let blocked: Bool
    let now: Int64

    var body: some View {
        let pct = UsageWords.used(window, blocked: blocked)
        let tone: Color = switch UsageWords.level(pct) {
        case .normal: Tone.fg2
        case .warn: Tone.warn
        case .fault: Tone.fault
        }
        let label = UsageWords.windowLabel(window.name)
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(label).font(.sans(13)).foregroundStyle(Tone.fg2)
                Spacer(minLength: 8)
                Text(UsageWords.balance(window) ?? pct.map { "\($0)%" } ?? "n/a").font(.sans(13, .medium)).monospacedDigit().foregroundStyle(pct == nil ? Tone.fg3 : tone)
            }
            if UsageWords.balance(window) == nil { Bar(fraction: Double(pct ?? 0) / 100, fill: tone, height: 6) }
            if let reset = UsageWords.reset(window, now: now) {
                Text(reset).font(.sans(12)).monospacedDigit().foregroundStyle(Tone.fg3)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([label, pct.map { "\($0)% used" } ?? UsageWords.balance(window) ?? "", UsageWords.reset(window, now: now) ?? ""].filter { !$0.isEmpty }.joined(separator: ", "))
    }
}

private struct Bar: View {
    let fraction: Double
    let fill: Color
    let height: CGFloat

    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(Tone.rule)
                if fraction > 0 { Capsule().fill(fill).frame(width: max(height, g.size.width * min(fraction, 1))) }
            }
        }
        .frame(height: height)
    }
}

/// Cost per day as bars, the max and average above, the first and last day under.
private struct CostChart: View {
    let days: [UsageBucket]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(UsageWords.chartLine(days)).font(.sans(12.5)).monospacedDigit().foregroundStyle(Tone.fg3)
            if let first = days.first, let last = days.last {
                let top = max(days.map(\.costUsd).max() ?? 0, 0.000_001)
                HStack(alignment: .bottom, spacing: 2) {
                    ForEach(Array(days.enumerated()), id: \.offset) { _, d in
                        UnevenRoundedRectangle(topLeadingRadius: 2, topTrailingRadius: 2)
                            .fill(Tone.fg3)
                            .frame(maxWidth: .infinity)
                            .frame(height: max(0, 120 * d.costUsd / top))
                    }
                }
                .frame(height: 120, alignment: .bottom)
                .overlay(alignment: .bottom) { Rectangle().fill(Tone.rule).frame(height: 1) }
                .accessibilityHidden(true)
                HStack {
                    Text(UsageWords.shortDay(first.key))
                    Spacer()
                    Text(UsageWords.shortDay(last.key))
                }
                .font(.sans(11.5)).monospacedDigit().foregroundStyle(Tone.fg4)
            } else {
                Text("No usage in this range").font(.sans(13)).foregroundStyle(Tone.fg3)
            }
        }
        .padding(14)
        .panel(Tone.raise, radius: Radius.r3, border: Tone.rule)
    }
}
