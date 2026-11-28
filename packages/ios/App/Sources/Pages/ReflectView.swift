import ConclaveKit
import SwiftUI

/// Reflect (web ReflectPage, reflect.tsx and reflectLearnings.tsx): the Nightly reflection switch,
/// and the learnings caught from what you typed, each with the quote, Save (to memory, or another
/// place the hub offers) and Skip. The weekly report and skill ideas stay on the web for now.
struct ReflectView: View {
    let hub: HubModel
    let back: () -> Void
    @State private var settings: ReflectSettings?
    @State private var list: LearningsList?
    @State private var busy: String?
    @State private var line: String?
    @State private var error: String?

    var body: some View {
        Page(title: "Reflect", sub: "What the assistant learns each night about how you like to work") {
            SettingsBack(back: back)
        } content: {
            if let error { ErrorBox(message: error) { Task { await load() } } }
            if let line { Text(line).font(.sans(12.5)).foregroundStyle(Tone.fg2) }
            if let s = settings {
                CardSection(title: "Nightly reflection") {
                    CardRow(label: "Reflect each night", detail: "Never takes a note from an email, a web page or a tool result. Chats with agents that read those are left out." + (s.time.map { " Runs at \($0)." } ?? "")) {
                        Toggle("Reflect each night", isOn: Binding(get: { s.enabled }, set: { v in Task { await setOn(v) } })).labelsHidden().tint(Tone.signal)
                    }
                }
            }
            if let list {
                CardSection(title: "Learnings", note: list.pending == 0 ? "Nothing waits. Corrections, preferences and \"remember: ...\" show here after you type them." : "Nothing is written until you press Save.") {
                    ForEach(list.items.filter { $0.status == "pending" }) { l in learning(l) }
                }
            } else if error == nil {
                LoadingLine()
            }
        }
        .task { await load() }
    }

    private func learning(_ l: Learning) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(l.kindWord).font(.sans(12, .semibold)).foregroundStyle(Tone.fg3)
                if l.count > 1 { Text("\(l.count) times").font(.sans(12)).foregroundStyle(Tone.fg3) }
                if let t = l.sessionTitle { Text(t).font(.sans(12)).foregroundStyle(Tone.fg3).lineLimit(1) }
            }
            Text(l.fact).font(.sans(14)).foregroundStyle(Tone.fg).fixedSize(horizontal: false, vertical: true)
            if !l.quote.isEmpty { Text("\u{201C}\(l.quote)\u{201D}").font(.sans(12.5)).italic().foregroundStyle(Tone.fg3).lineLimit(3) }
            HStack(spacing: 8) {
                let usable = l.targets.filter { $0.refused == nil }
                if usable.count > 1 {
                    Menu("Save") {
                        ForEach(usable, id: \.target) { t in Button(t.label) { Task { await save(l, t.target) } } }
                    }
                    .buttonStyle(CVButton(look: .solid, height: 32))
                } else {
                    Button("Save") { Task { await save(l, usable.first?.target ?? "memory") } }.buttonStyle(CVButton(look: .solid, height: 32))
                }
                Button("Skip") { Task { await skip(l) } }.buttonStyle(CVButton(look: .quiet, height: 32))
                if busy == l.id { ProgressView().controlSize(.small) }
            }
            .disabled(busy != nil)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private func load() async {
        do {
            async let s = hub.client.reflect()
            async let l = hub.client.learnings()
            settings = try? await s
            list = try await l
            error = nil
        } catch {
            if error is CancellationError { return }
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }

    private func setOn(_ v: Bool) async {
        do { settings = try await hub.client.setReflect(["enabled": .bool(v)]) } catch { line = "Failed. " + ((error as? ConclaveAPIError)?.message ?? error.localizedDescription) }
    }

    private func save(_ l: Learning, _ target: String) async {
        busy = l.id
        defer { busy = nil }
        do {
            list = try await hub.client.saveLearning(l.id, target: target, text: l.text(for: target))
            line = "Saved."
        } catch { line = "Failed. " + ((error as? ConclaveAPIError)?.message ?? error.localizedDescription) }
    }

    private func skip(_ l: Learning) async {
        busy = l.id
        defer { busy = nil }
        do { list = try await hub.client.skipLearning(l.id) } catch { line = "Failed. " + ((error as? ConclaveAPIError)?.message ?? error.localizedDescription) }
    }
}
