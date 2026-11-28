import ConclaveKit
import SwiftUI

/// Settings > Remote access (web settings/remote.tsx), owner only: how devices reach the hub from
/// anywhere (quick tunnel, Tailscale, your own URL, or local only), same network on or off, and every
/// address with Copy. A stable address on your domain needs a Cloudflare token; that setup is on the web.
struct RemoteView: View {
    let hub: HubModel
    let back: () -> Void
    @State private var status: RemoteStatus?
    @State private var url = ""
    @State private var busy = false
    @State private var line: String?
    @State private var error: String?

    var body: some View {
        Page(title: "Remote access", sub: status.map(RemoteWords.state)) {
            SettingsBack(back: back)
        } content: {
            if let error { ErrorBox(message: error) { Task { await load() } } }
            if let line { Text(line).font(.sans(12.5)).foregroundStyle(Tone.fg2) }
            if let s = status {
                CardSection(title: "How devices reach the hub", note: "From anywhere, not only this network. Pairing codes and notification links use the address this gives.") {
                    ForEach(RemoteWords.modes, id: \.self) { m in
                        Button { Task { await pick(m, s) } } label: {
                            HStack(alignment: .top, spacing: 12) {
                                Image(systemName: s.mode == m ? "largecircle.fill.circle" : "circle")
                                    .foregroundStyle(s.mode == m ? Tone.signal : Tone.fg3).padding(.top, 2)
                                VStack(alignment: .leading, spacing: 2) {
                                    (Text(RemoteWords.label(m)).foregroundStyle(Tone.fg) + Text(m == "quick" ? "  suggested" : "").foregroundStyle(Tone.fg3)).font(.sans(14))
                                    Text(m == "stable" && s.stable != nil ? "\(s.stable!.hostname). Change it on the web." : RemoteWords.help(m))
                                        .font(.sans(12)).foregroundStyle(Tone.fg3).fixedSize(horizontal: false, vertical: true)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 14).padding(.vertical, 10).contentShape(Rectangle())
                        }
                        .buttonStyle(QuietPress(radius: 0)).disabled(busy || (m == "stable" && s.stable == nil))
                        .accessibilityAddTraits(s.mode == m ? .isSelected : [])
                    }
                    if s.mode == "tailscale" || s.mode == "custom" {
                        HStack(spacing: 8) {
                            TextField(s.mode == "tailscale" ? "https://madx.tail4e2a.ts.net" : "https://hub.example.com", text: $url)
                                .font(.mono(13)).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                                .padding(.horizontal, 10).frame(height: 34).panel(Tone.sunk, radius: Radius.r2, border: Tone.rule2)
                                .accessibilityLabel(s.mode == "tailscale" ? "Tailscale address" : "Your address")
                            Button("Save") { Task { await run { try await hub.client.setRemote(mode: s.mode, url: url.trimmingCharacters(in: .whitespaces)) } } }
                                .buttonStyle(CVButton(look: .outline, height: 34)).disabled(busy || !RemoteWords.urlOK(url))
                        }
                        .padding(.horizontal, 14).padding(.vertical, 8)
                    }
                }
                CardSection(title: "Same network") {
                    CardRow(label: "Devices on this network", detail: s.lan.fixedHost.map { "The hub listens only on \($0) (server.host), so the network cannot reach it." } ?? (s.lan.on ? "On: phones and computers on this network reach the hub at its local address." : "Off: only this computer and the remote address reach the hub.")) {
                        Toggle("Devices on this network", isOn: Binding(get: { s.lan.on }, set: { v in Task { await run { try await hub.client.setRemote(lan: v) } } }))
                            .labelsHidden().tint(Tone.signal).disabled(busy)
                    }
                }
                if !s.addresses.isEmpty {
                    CardSection(title: "Addresses", note: "Paired apps keep every one and try the next when one stops answering.") {
                        ForEach(s.addresses, id: \.url) { a in
                            CardRow(label: a.url, detail: a.label) {
                                Button { UIPasteboard.general.string = a.url; line = "Copied." } label: { Image(systemName: "doc.on.doc").frame(width: 32, height: 32) }
                                    .buttonStyle(QuietPress()).accessibilityLabel("Copy \(a.url)")
                            }
                        }
                    }
                }
            } else if error == nil {
                LoadingLine()
            }
        }
        .task { await load() }
        // a tunnel that is starting reports on its own; read again until it settles
        .task(id: status?.state) {
            guard let st = status?.state, st == "installing" || st == "starting" else { return }
            try? await Task.sleep(for: .seconds(3))
            await load()
        }
    }

    private func load() async {
        do {
            let s = try await hub.client.remote()
            if status == nil || url.isEmpty, s.mode == "tailscale" || s.mode == "custom" { url = s.url ?? "" }
            status = s
            error = nil
        } catch {
            if error is CancellationError { return }
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }

    /// Quick and off switch at once; Tailscale and your own URL wait for an address.
    private func pick(_ m: String, _ s: RemoteStatus) async {
        guard m != s.mode else { return }
        if m == "tailscale" || m == "custom" {
            if RemoteWords.urlOK(url) { await run { try await hub.client.setRemote(mode: m, url: url) } } else { line = "Type the address, then Save." ; status?.mode = m }
            return
        }
        await run { try await hub.client.setRemote(mode: m) }
    }

    private func run(_ op: () async throws -> RemoteStatus) async {
        busy = true
        defer { busy = false }
        do {
            status = try await op()
            line = nil
        } catch {
            line = "Failed. " + ((error as? ConclaveAPIError)?.message ?? error.localizedDescription)
        }
    }
}
