import ConclaveKit
import CoreImage.CIFilterBuiltins
import SwiftUI

/// The hub's computers (Android DevicesScreen, web DevicesPage): the hub's own row first, then
/// online, then by name. Each row: the name ("hub" after the hub's), "hostname, platform arch",
/// and online in ok or "seen 3h ago" in fg-3. "Pair a device" opens the pairing code.
struct DevicesView: View {
    let hub: HubModel
    @State private var devices: [Device]?
    @State private var error: String?
    @State private var pairing = false

    var body: some View {
        Page(title: "Devices", sub: devices.map(DeviceWords.summary)) {
            Button("Pair a device") { pairing = true }
                .buttonStyle(CVButton(look: .solid))
                .accessibilityIdentifier("pair-device")
        } content: {
            if let devices {
                VStack(spacing: 0) {
                    ForEach(Array(DeviceWords.sorted(devices).enumerated()), id: \.element.id) { i, d in
                        if i > 0 { Rectangle().fill(Tone.rule).frame(height: 1) }
                        DeviceRow(device: d)
                    }
                }
                .panel(Tone.raise, radius: Radius.r3, border: Tone.rule)
            } else if let error {
                Text(error).font(.sans(13)).foregroundStyle(Tone.fault)
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 20)
            }
        }
        .refreshable { await load() }
        .task(id: hub.deviceTick) { await load() }
        .sheet(isPresented: $pairing, onDismiss: { Task { await load() } }) { PairSheet(client: hub.client) }
    }

    private func load() async {
        do {
            devices = try await hub.client.devices()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct DeviceRow: View {
    let device: Device

    var body: some View {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        HStack(spacing: 12) {
            Image(systemName: device.id == "local" ? "server.rack" : device.info?.platform == "darwin" ? "laptopcomputer" : "desktopcomputer")
                .font(.system(size: 16)).foregroundStyle(Tone.fg3).frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(DeviceWords.title(device)).font(.sans(14, .medium)).foregroundStyle(Tone.fg).lineLimit(1)
                    if device.id == "local" { Text("hub").font(.sans(12)).foregroundStyle(Tone.fg4) }
                }
                let meta = DeviceWords.meta(device)
                if !meta.isEmpty { Text(meta).font(.sans(12.5)).foregroundStyle(Tone.fg3).lineLimit(1) }
            }
            Spacer(minLength: 8)
            HStack(spacing: 6) {
                Circle().fill(device.online ? Tone.ok : Tone.fg4).frame(width: 6, height: 6)
                Text(DeviceWords.state(device, now: now)).font(.sans(12.5)).foregroundStyle(device.online ? Tone.ok : Tone.fg3)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(minHeight: 56)
        .accessibilityElement(children: .combine)
    }
}

/// Pair a device (Android PairSheet, the hub's PairingPanel): App or Command line, the QR code of
/// the code's link, the code in 28 pt mono with Copy, the countdown, the hub's fingerprint, and for
/// the command line the three commands.
struct PairSheet: View {
    let client: ConclaveClient
    @State private var kind = PairKind.app
    @State private var info: PairingInfo?
    @State private var error: String?
    @State private var copied = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text("Pair a device").font(.sans(18, .semibold)).foregroundStyle(Tone.fg)
                    Spacer()
                    Button("Done") { dismiss() }.buttonStyle(CVButton(look: .quiet))
                }
                Segmented(options: PairKind.allCases.map { ($0, $0.label) }, selection: $kind)
                Text(PairingWords.help(kind)).font(.sans(13.5)).foregroundStyle(Tone.fg2).lineSpacing(3)
                if let error {
                    Text(error).font(.sans(13)).foregroundStyle(Tone.fault)
                    Button("Try again") { Task { await make() } }.buttonStyle(CVButton(look: .outline))
                } else if let info {
                    code(info)
                } else {
                    HStack(spacing: 8) { ProgressView(); Text("Making a code").font(.sans(13)).foregroundStyle(Tone.fg3) }
                }
            }
            .padding(24)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        .background(Tone.bg.ignoresSafeArea())
        .task(id: kind) { await make() }
        .accessibilityIdentifier("pair-sheet")
    }

    @ViewBuilder private func code(_ info: PairingInfo) -> some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let now = Int64(ctx.date.timeIntervalSince1970 * 1000)
            let expired = PairingWords.expired(info, now: now)
            VStack(alignment: .leading, spacing: 14) {
                if !expired, let qr = Self.qr(info.deepLink) {
                    Image(uiImage: qr).interpolation(.none).resizable().scaledToFit()
                        .frame(width: 200, height: 200)
                        .padding(12)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: Radius.r3, style: .continuous))
                        .hairline(Tone.rule, radius: Radius.r3)
                        .frame(maxWidth: .infinity)
                        .accessibilityLabel("Pairing QR code")
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Pairing code").font(.sans(12.5, .medium)).foregroundStyle(Tone.fg3)
                    HStack(spacing: 12) {
                        Text(info.code).font(.mono(28, .medium)).foregroundStyle(expired ? Tone.fg4 : Tone.fg).textSelection(.enabled)
                            .accessibilityIdentifier("pair-code")
                        Spacer(minLength: 0)
                        Button(copied ? "Copied" : "Copy") {
                            UIPasteboard.general.string = info.code
                            copied = true
                            Task { try? await Task.sleep(for: .seconds(1.6)); copied = false }
                        }
                        .buttonStyle(CVButton(look: .outline))
                    }
                    Text(PairingWords.timer(info, now: now)).font(.sans(12.5)).monospacedDigit().foregroundStyle(expired ? Tone.warn : Tone.fg3)
                    if expired { Button("Make a new code") { Task { await make() } }.buttonStyle(CVButton(look: .solid)) }
                }
                .padding(14)
                .panel(Tone.raise, radius: Radius.r3, border: Tone.rule)
                if let fp = info.fingerprint, !fp.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Hub fingerprint").font(.sans(12.5, .medium)).foregroundStyle(Tone.fg3)
                        Text(PairingWords.grouped(fp)).font(.mono(12.5)).foregroundStyle(Tone.fg2).textSelection(.enabled)
                    }
                }
                if kind == .computer {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("On the computer").font(.sans(12.5, .medium)).foregroundStyle(Tone.fg3)
                        CodeBlockView(language: "bash", text: PairingWords.commands(info, fallbackUrl: client.baseURL).joined(separator: "\n"))
                    }
                }
                if !expired {
                    HStack(spacing: 8) { ProgressView().controlSize(.small); Text(PairingWords.waiting(kind)).font(.sans(12.5)).foregroundStyle(Tone.fg3) }
                }
            }
        }
    }

    private func make() async {
        info = nil
        error = nil
        do { info = try await client.makePairingCode(kind) } catch { self.error = error.localizedDescription }
    }

    /// The QR code of the code's conclave://pair link, drawn here with Core Image.
    static func qr(_ text: String) -> UIImage? {
        guard !text.isEmpty else { return nil }
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(text.utf8)
        f.correctionLevel = "M"
        guard let out = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
