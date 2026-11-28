import ConclaveKit
import SwiftUI

/// Settings > Plan order and limits (web settings/accounts.tsx): each vendor's accounts in the order
/// calls take them, the first first; the next takes over when one is at a limit, resting or paused.
/// Move up or down, Pause or Resume, Try now, "Use when a model refuses", Remove a gone sign-in.
/// Owner only. Budgets, window starters and per-model orders stay on the web for now.
struct AccountsView: View {
    let hub: HubModel
    let back: () -> Void
    @State private var status: AccountsStatus?
    @State private var busy: String?
    @State private var line: String?
    @State private var error: String?

    var body: some View {
        Page(title: "Plan order and limits", sub: "Which plan or key takes a call") {
            HStack(spacing: 8) {
                Button(busy == "refresh" ? "Reading" : "Refresh") { Task { await run("refresh", nil) { try await hub.client.refreshAccounts() } } }
                    .buttonStyle(CVButton(look: .outline, height: 32)).disabled(busy != nil)
                SettingsBack(back: back)
            }
        } content: {
            if let error { ErrorBox(message: error) { Task { await load() } } }
            if let line { Text(line).font(.sans(12.5)).foregroundStyle(Tone.fg2) }
            if let s = status {
                if !s.management { Text("CLIProxyAPI's management does not answer, so pausing, Try now and the order wait until it does.").font(.sans(13)).foregroundStyle(Tone.warn) }
                let groups = AccountWords.vendorOrders(s)
                if groups.isEmpty { EmptyLine(text: "No plans or keys yet. Sign in on Subscriptions or add a key on Providers.") }
                ForEach(Array(groups.enumerated()), id: \.element.0.vendor) { i, g in
                    CardSection(title: g.0.vendorName, note: i == 0 ? "First in the list takes the call. The next one takes over when it is at a limit, resting or paused. Signed in plans go before API keys unless you move them." : nil) {
                        ForEach(Array(g.1.enumerated()), id: \.element.id) { n, a in row(a, rank: n + 1, order: g.1.map(\.id), vendor: g.0.vendor) }
                    }
                }
            } else if error == nil {
                LoadingLine()
            }
        }
        .task { await load() }
    }

    private func row(_ a: PlanAccount, rank: Int, order: [String], vendor: String) -> some View {
        let w = AccountWords.state(a.enabled ? a.state : "paused")
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let window = a.windows.compactMap { win in UsageWords.used(win).map { (win, $0) } }.max { $0.1 < $1.1 }
        let sub = [a.plan ?? (a.kind == "api" ? "API key" : nil), a.email, a.detail, window.map { "\($0.0.name) \($0.1)% used" + (UsageWords.reset($0.0, now: now).map { ", " + $0 } ?? "") }]
            .compactMap { $0 }.joined(separator: ". ")
        return HStack(alignment: .top, spacing: 10) {
            Text("\(rank)").font(.mono(12.5)).foregroundStyle(Tone.fg3).frame(width: 16, alignment: .trailing).padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(a.label).font(.sans(14, .medium)).foregroundStyle(Tone.fg).lineLimit(1)
                    Text(w.0).font(.sans(12.5)).foregroundStyle(stateColor(w.1))
                }
                if !sub.isEmpty { Text(sub).font(.sans(12)).foregroundStyle(Tone.fg3).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer(minLength: 8)
            if busy == a.id { ProgressView().controlSize(.small) }
            Button { Task { await move(a, -1, order, vendor) } } label: { Image(systemName: "chevron.up").frame(width: 32, height: 32) }
                .buttonStyle(QuietPress()).disabled(rank == 1 || busy != nil).accessibilityLabel("Move \(a.label) up")
            Button { Task { await move(a, 1, order, vendor) } } label: { Image(systemName: "chevron.down").frame(width: 32, height: 32) }
                .buttonStyle(QuietPress()).disabled(rank == order.count || busy != nil).accessibilityLabel("Move \(a.label) down")
            Menu {
                Button(a.enabled ? "Pause" : "Resume", systemImage: a.enabled ? "pause" : "play") {
                    Task { await run(a.id, a.enabled ? "\(a.label) is paused." : "\(a.label) is back in the order.") { try await hub.client.updateAccount(a.id, ["enabled": .bool(!a.enabled)]) } }
                }
                Button("Try now", systemImage: "arrow.clockwise") { Task { await run(a.id, "\(a.label): the next call tries it.") { try await hub.client.tryAccountNow(a.id) } } }
                Button(a.refusal ? "Stop using when a model refuses" : "Use when a model refuses", systemImage: "arrow.uturn.right") {
                    Task { await run(a.id, nil) { try await hub.client.updateAccount(a.id, ["refusal": .bool(!a.refusal)]) } }
                }
                if a.gone { Button("Remove", systemImage: "trash", role: .destructive) { Task { await run(a.id, "\(a.label) removed.") { try await hub.client.removeAccount(a.id) } } } }
            } label: { Image(systemName: "ellipsis").frame(width: 32, height: 32) }
                .accessibilityLabel("\(a.label) actions")
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private func load() async {
        do {
            status = try await hub.client.accounts()
            error = nil
        } catch {
            if error is CancellationError { return }
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }

    private func move(_ a: PlanAccount, _ by: Int, _ order: [String], _ vendor: String) async {
        let o = AccountWords.moved(order, a.id, by: by)
        guard o != order else { return }
        await run(a.id, nil) { try await hub.client.setAccountOrder(vendor: vendor, order: o) }
    }

    private func run(_ id: String, _ done: String?, _ op: () async throws -> AccountsStatus) async {
        busy = id
        defer { busy = nil }
        do {
            status = try await op()
            line = done
        } catch {
            line = "Failed. " + ((error as? ConclaveAPIError)?.message ?? error.localizedDescription)
        }
    }

    private func stateColor(_ t: Providers.Tone) -> Color {
        switch t {
        case .ok: Tone.ok
        case .live: Tone.signal
        case .dim: Tone.fg3
        case .warn: Tone.warn
        case .fault: Tone.fault
        }
    }
}
