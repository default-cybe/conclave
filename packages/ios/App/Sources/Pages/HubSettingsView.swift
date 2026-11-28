import ConclaveKit
import SwiftUI

/// The hub-wide rows the web has under Settings > Defaults, Notifications and Workflows (v0.4.112,
/// PR #395): models, tiers, plan fallback, limits, steps, prompt cache, stuck minutes and file
/// conflicts. Owner only; each change is a PATCH /api/config, then the config is read again so the
/// row shows what the hub kept (it range-checks every value).
struct HubSettingsSections: View {
    let hub: HubModel
    @State private var config: JSONValue?
    @State private var error: String?

    var body: some View {
        Group {
            if let config {
                sections(config)
            } else if let error {
                ErrorBox(message: error) { Task { await load() } }
            } else {
                LoadingLine()
            }
        }
        .task { await load() }
    }

    @ViewBuilder private func sections(_ c: JSONValue) -> some View {
        if let error { Text(error).font(.sans(12.5)).foregroundStyle(Tone.fault) }
        CardSection(title: "New sessions") {
            model(c, "Small model", "smallModel", help: "Titles, summaries and memory notes. Pick something fast and cheap.", empty: "Not set")
            model(c, "Model that reads images", "models.vision", help: "Turns pictures and PDFs into text for a model that cannot see them, such as GLM. Empty: the first of the small and default models that can see.", empty: "Small or default model", clears: true)
            model(c, "Second opinions", "modes.reviewer", help: "The model that reviews an answer when you ask for one.", empty: "Not set")
        }
        CardSection(title: "Model tiers", note: "Workflow steps, subagents and agents ask for a tier instead of a model. Empty: the hub picks as shown.") {
            model(c, "Fast", "models.tiers.fast", help: "Quick lookups and small jobs. Empty: the small model.", empty: "Small model", clears: true)
            model(c, "Smart", "models.tiers.smart", help: "Most subagent work. Empty: the session's own model.", empty: "Session's model", clears: true)
            model(c, "Deep", "models.tiers.deep", help: "Hard reasoning and reviews. Empty: the strongest model you have set up.", empty: "Picked by the hub", clears: true)
        }
        CardSection(title: "Per conversation") {
            toggle(c, "Same model for all work", "models.sameModel", def: false, help: "New chats and sessions start with Delegate, Task and workflow agents on the conversation's model. Each one can still turn it off in the model picker.")
        }
        CardSection(title: "When a plan runs out") {
            toggle(c, "Resume after the reset", "limits.autoResume", def: true, help: "A session that hit a limit continues on its own when the window resets.")
            toggle(c, "Wait if the reset is under 5 minutes", "limits.waitShortResets", def: true, help: "A long chat waits for a reset that close instead of switching, since the new model would read the whole chat again with no cache.")
            NumberRow(label: "Offer a handover over", unit: "tokens", help: "A model switch in a chat this long shows its price first and offers a short handover next to the full history. 0 never offers it.",
                      saved: ConfigPath.value(c, "context.switchBriefAt")?.number ?? 50_000) { await set("context.switchBriefAt", .number($0)) }
        }
        CardSection(title: "Spend and time limits", note: "Each chat, routine run or subagent stops when it, and everything it starts, reaches one of these. Empty or 0: no limit. A routine's own limits in its editor win.") {
            ForEach([("session", "Each chat or session"), ("routine", "Each routine run"), ("subagent", "Each subagent")], id: \.0) { kind, label in
                VStack(alignment: .leading, spacing: 8) {
                    Text(label).font(.sans(14)).foregroundStyle(Tone.fg)
                    HStack(spacing: 8) {
                        ForEach([("tokens", "Output tokens", false), ("costUsd", "Cost, USD", true), ("minutes", "Working time, min", false)], id: \.0) { field, short, fraction in
                            let path = "limits.\(kind).\(field)"
                            NumberBox(label: "\(label), \(short)", short: short, fraction: fraction, saved: ConfigPath.value(c, path)?.number ?? 0) { await set(path, .number($0)) }
                        }
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
            }
        }
        CardSection(title: "Model calls per turn", note: "A turn that reaches its number wraps up with a final reply and no more tools. An agent's own maxSteps wins over both.") {
            NumberRow(label: "In a chat or session", unit: "calls", help: "Model calls in one of your turns. 1 to 2000.", saved: ConfigPath.value(c, "limits.maxSteps")?.number ?? 250) { await set("limits.maxSteps", .number($0)) }
            NumberRow(label: "In a subagent", unit: "calls", help: "Model calls in one subagent's turn. 1 to 2000.", saved: ConfigPath.value(c, "limits.subagentMaxSteps")?.number ?? 100) { await set("limits.subagentMaxSteps", .number($0)) }
        }
        CardSection(title: "Prompt cache") {
            CardRow(label: "Keep the cache for", detail: "Claude models only. A 5 minute write costs 1.25x and a 1 hour write 2x; a read costs a tenth. Auto: 1 hour while you chat, 5 minutes for subagents, routines and loops.") {
                Segmented(options: [("auto", "Auto"), ("5m", "5 min"), ("1h", "1 hour")], selection: Binding(get: { ConfigPath.value(c, "cache.ttl")?.string ?? "auto" }, set: { v in Task { await set("cache.ttl", .string(v)) } }))
            }
        }
        CardSection(title: "Sessions that need you") {
            NumberRow(label: "Stuck after", unit: "minutes", help: "Minutes with no streamed text or tool call before a running turn counts as stuck. Slow or local models may want more. 0 turns the check off.",
                      saved: ConfigPath.value(c, "limits.stuck.minutes")?.number ?? 5) { await set("limits.stuck.minutes", .number($0)) }
            CardRow(label: "A file another chat just edited", detail: "When a chat writes a file another live chat wrote in the last 10 minutes. Warn: the write goes ahead and the Inbox shows both chats. Ask: that write waits for you.") {
                Segmented(options: [("warn", "Warn"), ("ask", "Ask")], selection: Binding(get: { ConfigPath.value(c, "permissions.onFileConflict")?.string ?? "warn" }, set: { v in Task { await set("permissions.onFileConflict", .string(v)) } }))
            }
        }
        CardSection(title: "Memory") {
            toggle(c, "Use memory", "memory.enabled", def: true, help: "Off means sessions neither read nor write notes.")
            toggle(c, "Give relevant notes", "memory.autoInject", def: true, help: "Before each turn, the notes that match the message ride along.")
            toggle(c, "Save what sessions learn", "memory.autoExtract", def: true, help: "When a session ends, the small model writes down facts worth keeping.")
        }
    }

    private func toggle(_ c: JSONValue, _ label: String, _ path: String, def: Bool, help: String) -> some View {
        CardRow(label: label, detail: help) {
            Toggle(label, isOn: Binding(get: { ConfigPath.value(c, path)?.bool ?? def }, set: { v in Task { await set(path, .bool(v)) } }))
                .labelsHidden().tint(Tone.signal)
        }
    }

    private func model(_ c: JSONValue, _ label: String, _ path: String, help: String, empty: String, clears: Bool = false) -> some View {
        let current = ConfigPath.value(c, path)?.string.flatMap { $0.isEmpty ? nil : $0 }
        return CardRow(label: label, detail: help) {
            Menu {
                if clears, current != nil { Button("Clear") { Task { await set(path, .null) } } }
                ForEach(hub.models.filter { $0.enabled && $0.configured }, id: \.provider) { g in
                    Section(g.name.isEmpty ? g.provider : g.name) {
                        ForEach(g.models) { m in
                            Button { Task { await set(path, .string(m.ref)) } } label: {
                                if m.ref == current { Label(m.name, systemImage: "checkmark") } else { Text(m.name) }
                            }
                        }
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Text(current.map { ref in hub.models.flatMap(\.models).first { $0.ref == ref }?.name ?? ModelRefs.displayName(ref) } ?? empty)
                        .font(.sans(13, .medium)).foregroundStyle(current == nil ? Tone.fg3 : Tone.fg).lineLimit(1)
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(Tone.fg3)
                }
                .padding(.horizontal, 10).frame(height: 28)
                .panel(.clear, radius: Radius.r2, border: Tone.rule2)
            }
            .accessibilityLabel("\(label) model")
        }
    }

    private func load() async {
        do {
            config = try await hub.client.hubConfig()
            error = nil
        } catch {
            if error is CancellationError { return }
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }

    private func set(_ path: String, _ value: JSONValue) async {
        do {
            try await hub.client.patchConfig(ConfigPath.patch(path, value))
            error = nil
        } catch {
            self.error = "Could not save. " + ((error as? ConclaveAPIError)?.message ?? error.localizedDescription)
        }
        await load()
    }
}

/// A number setting as a row: label, help, and a box that saves on Return or when it loses focus.
private struct NumberRow: View {
    let label: String
    let unit: String
    let help: String
    let saved: Double
    let save: (Double) async -> Void

    var body: some View {
        CardRow(label: label, detail: help) {
            HStack(spacing: 6) {
                NumberBox(label: label, short: nil, fraction: false, saved: saved, save: save).frame(width: 104)
                Text(unit).font(.sans(12.5)).foregroundStyle(Tone.fg3)
            }
        }
    }
}

/// The web's LimitInput: empty is 0, a bad number turns the line red and is not sent.
private struct NumberBox: View {
    let label: String
    let short: String?
    let fraction: Bool
    let saved: Double
    let save: (Double) async -> Void
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        let bad = ConfigPath.number(text, fraction: fraction) == nil
        VStack(alignment: .leading, spacing: 3) {
            if let short { Text(short).font(.sans(11.5)).foregroundStyle(Tone.fg3).lineLimit(1) }
            TextField(short == nil ? "" : "No limit", text: $text)
                .font(.mono(13)).monospacedDigit()
                .keyboardType(fraction ? .decimalPad : .numberPad)
                .focused($focused)
                .onSubmit(commit)
                .padding(.horizontal, 10).frame(height: 34)
                .panel(Tone.sunk, radius: Radius.r2, border: bad ? Tone.fault : Tone.rule2)
                .accessibilityLabel(label)
        }
        .onAppear { text = Self.words(saved, keepZero: short == nil) }
        .onChange(of: saved) { text = Self.words(saved, keepZero: short == nil) }
        .onChange(of: focused) { if !focused { commit() } }
    }

    private func commit() {
        guard let n = ConfigPath.number(text, fraction: fraction), n != saved else { return }
        Task { await save(n) }
    }

    /// A limit of 0 shows as the empty "No limit" box; a plain number setting shows its 0.
    static func words(_ n: Double, keepZero: Bool) -> String {
        if n == 0 && !keepZero { return "" }
        return n == n.rounded() ? String(Int(n)) : String(n)
    }
}
