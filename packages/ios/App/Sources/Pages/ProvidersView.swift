import ConclaveKit
import SwiftUI

/// Settings > Providers (Android ProvidersScreen, web settings/providers.tsx): the keyed providers,
/// each checked when the page opens (a list of models, never a paid request), add, replace or
/// remove a key. Keys go to the hub and never come back. Owner only; sign-in plans are on Subscriptions.
struct ProvidersView: View {
    let hub: HubModel
    let back: () -> Void
    @State private var withKeys: Set<String>?
    @State private var tests: [String: (String, Bool)] = [:]
    @State private var editing: KeyProvider?
    @State private var adding = false
    @State private var removing: KeyProvider?
    @State private var line: String?
    @State private var error: String?

    var body: some View {
        Page(title: "Providers", sub: "API keys the hub calls models with") {
            SettingsBack(back: back)
        } content: {
            if let error { ErrorBox(message: error) { Task { await load() } } }
            if let line { Text(line).font(.sans(12.5)).foregroundStyle(Tone.fg2) }
            if let withKeys {
                let rows = Providers.keyedRows(withKeys)
                CardSection(title: "Keys", note: "Keys live on the hub only, encrypted with the hub key. Phones and other computers never receive them. Each key is checked when this page opens: a list of models, never a paid request.") {
                    if rows.isEmpty { EmptyLine(text: "No keys yet. Add one below, or sign in to an AI plan on Subscriptions.") }
                    ForEach(rows, id: \.self) { id in
                        let p = Providers.info(id) ?? KeyProvider(id: id, name: id, description: "", keyPrefix: nil)
                        Button { editing = p } label: {
                            CardRow(label: p.name) {
                                let w = tests[id] ?? ("Checking", true)
                                Text(w.0).font(.sans(13)).foregroundStyle(w.1 ? Tone.fg2 : Tone.fault).lineLimit(1)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(QuietPress(radius: 0))
                    }
                    if !Providers.addable(rows).isEmpty {
                        Button { adding = true } label: {
                            CardRow(label: "Add a provider") { Image(systemName: "plus").foregroundStyle(Tone.fg3) }.contentShape(Rectangle())
                        }
                        .buttonStyle(QuietPress(radius: 0)).accessibilityIdentifier("add-provider")
                    }
                }
                Text("Custom providers (any OpenAI or Anthropic compatible endpoint) are added in the web app: Settings, Providers.")
                    .font(.sans(12)).foregroundStyle(Tone.fg3)
            } else if error == nil {
                LoadingLine()
            }
        }
        .task { await load() }
        .confirmationDialog("Add a provider", isPresented: $adding, titleVisibility: .visible) {
            ForEach(Providers.addable(Providers.keyedRows(withKeys ?? []))) { p in Button("\(p.name): \(p.description)") { editing = p } }
        }
        .sheet(item: $editing) { p in
            KeySheet(provider: p, saved: withKeys?.contains(p.id) == true, save: { key in Task { await save(p, key) } }, remove: { removing = p })
        }
        .alert("Remove the \(removing?.name ?? "") key?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { p in
            Button("Remove key", role: .destructive) { Task { await save(p, nil) } }
            Button("Cancel", role: .cancel) {}
        } message: { p in
            Text("Sessions on \(p.name) models stop until you add a key again.")
        }
    }

    private func load() async {
        do {
            let keys = Providers.withKeys(try await hub.client.configSecrets())
            withKeys = keys
            error = nil
            await withTaskGroup(of: (String, (String, Bool)).self) { g in
                for id in Providers.keyedRows(keys) {
                    g.addTask {
                        do { return (id, Providers.testWords(try await hub.client.testProvider(id))) } catch { return (id, ("Could not check", false)) }
                    }
                }
                for await (id, w) in g { tests[id] = w }
            }
        } catch {
            if error is CancellationError { return }
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }

    private func save(_ p: KeyProvider, _ key: String?) async {
        do {
            try await hub.client.setProviderKey(p.id, key)
            line = key == nil ? "Key removed." : "Key saved."
            tests[p.id] = nil
            await load()
            await hub.loadModels()
        } catch {
            line = "Could not save. " + ((error as? ConclaveAPIError)?.message ?? error.localizedDescription)
        }
    }
}

/// Paste a key: a secure field, Save, and Remove key when one is saved.
private struct KeySheet: View {
    let provider: KeyProvider
    let saved: Bool
    let save: (String) -> Void
    let remove: () -> Void
    @State private var key = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text(saved ? "A key is saved. Paste a new one to replace it." : "Paste the key from the provider's console.").font(.sans(13)).foregroundStyle(Tone.fg3)
                SecureField(Providers.placeholder(provider.id), text: $key)
                    .font(.mono(13)).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .padding(.horizontal, 12).frame(height: 40).panel(Tone.sunk, radius: Radius.r2, border: Tone.rule2)
                    .accessibilityLabel("\(provider.name) API key")
                if saved {
                    Button("Remove key") { dismiss(); remove() }.buttonStyle(CVButton(look: .quietFault))
                }
                Spacer()
            }
            .padding(20)
            .background(Tone.bg)
            .navigationTitle("\(provider.name) API key")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save(key.trimmingCharacters(in: .whitespacesAndNewlines)); dismiss() }
                        .disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

/// Settings > Subscriptions (Android SubscriptionsScreen, web components/subscriptions): sign in
/// to a Claude, ChatGPT or Gemini plan through the hub's CLIProxyAPI. The provider's page opens in
/// Safari; it ends on a localhost page this device cannot load, so its address is pasted back.
/// The first sign-in starts the built-in CLIProxyAPI. Tokens stay on the hub.
struct SubscriptionsView: View {
    let hub: HubModel
    let back: () -> Void
    @State private var status: SubscriptionsStatus?
    @State private var more = false
    @State private var flow: SignInStart?
    @State private var flowName = ""
    @State private var pasted = ""
    @State private var busy = false
    @State private var line: String?
    @State private var error: String?
    @State private var signingOut: SubscriptionAccount?
    @Environment(\.openURL) private var openURL

    var body: some View {
        Page(title: "Subscriptions", sub: status.map { s in let l = Providers.statusLine(s); return l.0 + " " + l.1 }) {
            SettingsBack(back: back)
        } content: {
            if let error { ErrorBox(message: error) { Task { await load() } } }
            if let line { Text(line).font(.sans(12.5)).foregroundStyle(Tone.fg2) }
            if let s = status {
                if !Providers.usable(s) {
                    Text(s.managementNote ?? "Sign in needs the hub's CLIProxyAPI with its management key. Set it up in the web app: Settings, Subscriptions.")
                        .font(.sans(13)).foregroundStyle(Tone.warn)
                }
                if let f = flow { signingIn(f) }
                CardSection(title: "Sign in", note: "Tap a plan to sign in, or to add another account. Tokens stay on the hub.") {
                    ForEach(Providers.rows(s, more: more)) { p in
                        CardRow(label: p.name, detail: "\(p.plan.isEmpty ? p.name : p.plan). \(Providers.who(s, p))") {
                            Button(Providers.action(s, p)) { Task { await start(p) } }
                                .buttonStyle(CVButton(look: .outline, height: 32)).disabled(busy || flow != nil || !Providers.usable(s))
                        }
                    }
                    if !more, s.providers.contains(where: \.more), !s.providers.contains(where: { $0.more && $0.accounts > 0 }) {
                        Button { more = true } label: { CardRow(label: "More plans") { Image(systemName: "chevron.down").foregroundStyle(Tone.fg3) }.contentShape(Rectangle()) }
                            .buttonStyle(QuietPress(radius: 0))
                    }
                }
                if !s.accounts.isEmpty {
                    CardSection(title: "Accounts") {
                        ForEach(s.accounts) { a in
                            let w = Providers.accountWord(a.state)
                            CardRow(label: Providers.accountLabel(a), detail: ([a.providerName, a.detail].compactMap { $0 }).joined(separator: ". ")) {
                                HStack(spacing: 10) {
                                    Text(w.0).font(.sans(13)).foregroundStyle(w.1.color)
                                    Menu {
                                        if a.canRefresh { Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh(a) } } }
                                        Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { signingOut = a }
                                    } label: { Image(systemName: "ellipsis").frame(width: 32, height: 32) }
                                        .accessibilityLabel("\(Providers.accountLabel(a)) actions")
                                }
                            }
                        }
                    }
                }
            } else if error == nil {
                LoadingLine()
            }
        }
        .task { await load() }
        // a device or caught redirect sign-in finishes on the hub: ask until it says so
        .task(id: flow?.state) {
            guard let f = flow, !Providers.needsPaste(f) else { return }
            while !Task.isCancelled, flow?.state == f.state {
                try? await Task.sleep(for: .seconds(2))
                if let st = try? await hub.client.signInStatus(f.state), st.status != "wait" { await finished(st) }
            }
        }
        .alert("Sign out \(signingOut.map(Providers.accountLabel) ?? "")?", isPresented: Binding(get: { signingOut != nil }, set: { if !$0 { signingOut = nil } }), presenting: signingOut) { a in
            Button("Sign out", role: .destructive) { Task { await remove(a) } }
            if a.canRefresh { Button("Refresh instead") { Task { await refresh(a) } } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Sessions on this plan stop using it. Sign in again any time.")
        }
    }

    @ViewBuilder private func signingIn(_ f: SignInStart) -> some View {
        CardSection(title: "Signing in to \(flowName)") {
            VStack(alignment: .leading, spacing: 10) {
                Text(Providers.waitingLine(f, name: flowName)).font(.sans(13.5)).foregroundStyle(Tone.fg2).fixedSize(horizontal: false, vertical: true)
                if let code = f.userCode { Text(code).font(.mono(22, .semibold)).foregroundStyle(Tone.fg).textSelection(.enabled) }
                if Providers.needsPaste(f) {
                    TextField("http://localhost:.../callback?code=...", text: $pasted)
                        .font(.mono(12.5)).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .padding(.horizontal, 12).frame(height: 40).panel(Tone.sunk, radius: Radius.r2, border: Tone.rule2)
                        .accessibilityLabel("Address from the browser bar")
                }
                HStack(spacing: 8) {
                    if Providers.needsPaste(f) {
                        Button(busy ? "Finishing" : "Finish") { Task { await paste(f) } }
                            .buttonStyle(CVButton(look: .solid, height: 36)).disabled(busy || pasted.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    Button("Open again") { if let u = URL(string: f.url) { openURL(u) } }.buttonStyle(CVButton(look: .outline, height: 36))
                    Button("Cancel") { Task { try? await hub.client.cancelSignIn(f.state); flow = nil; pasted = "" } }.buttonStyle(CVButton(look: .quiet, height: 36))
                }
            }
            .padding(14)
        }
    }

    private func load() async {
        do {
            status = try await hub.client.subscriptions()
            error = nil
        } catch {
            if error is CancellationError { return }
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }

    private func start(_ p: SubscriptionProvider) async {
        busy = true
        line = nil
        defer { busy = false }
        do {
            if let s = status, Providers.needsStart(s) { status = try await hub.client.startBuiltinSubscriptions() }
            let f = try await hub.client.startSignIn(p.id)
            flowName = p.name
            pasted = ""
            flow = f
            if let u = URL(string: f.url) { openURL(u) }
        } catch {
            line = "Could not start. " + ((error as? ConclaveAPIError)?.message ?? error.localizedDescription)
        }
    }

    private func paste(_ f: SignInStart) async {
        busy = true
        defer { busy = false }
        do {
            await finished(try await hub.client.finishSignIn(f.state, url: pasted.trimmingCharacters(in: .whitespacesAndNewlines)))
        } catch {
            line = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }

    private func finished(_ st: SignInStatus) async {
        guard st.status != "wait" else { return }
        flow = nil
        pasted = ""
        line = st.status == "ok" ? "Signed in." : st.error ?? "Sign in did not finish."
        await load()
        if st.status == "ok" { await hub.loadModels() }
    }

    private func remove(_ a: SubscriptionAccount) async {
        do { status = try await hub.client.removeSubscriptionAccount(a.name) } catch { line = (error as? ConclaveAPIError)?.message ?? error.localizedDescription }
    }

    private func refresh(_ a: SubscriptionAccount) async {
        do { status = try await hub.client.refreshSubscriptionAccount(a.name) } catch { line = (error as? ConclaveAPIError)?.message ?? error.localizedDescription }
    }
}

/// The way back from a page Settings opened (the page sits in the split view's detail column).
struct SettingsBack: View {
    let back: () -> Void
    var body: some View {
        Button(action: back) { Label("Settings", systemImage: "chevron.left") }
            .buttonStyle(CVButton(look: .quiet, height: 32)).accessibilityIdentifier("settings-back")
    }
}

private extension Providers.Tone {
    var color: Color {
        switch self {
        case .ok: Tone.ok
        case .live: Tone.signal
        case .dim: Tone.fg3
        case .warn: Tone.warn
        case .fault: Tone.fault
        }
    }
}
