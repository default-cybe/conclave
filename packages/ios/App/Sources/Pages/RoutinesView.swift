import ConclaveKit
import SwiftUI

/// Scheduled prompts (Android routines/RoutinesScreen.kt, web features/routines): each routine with its
/// schedule, switch, next and last run; a tap opens it with Run now, Edit, Delete and its history.
/// New makes one in the editor: name, prompt, agent and the schedule, checked by the hub's preview.
struct RoutinesView: View {
    let hub: HubModel
    let open: (String) -> Void
    @State private var routines: [Routine]?
    @State private var error: String?
    @State private var shown: Routine?
    @State private var editing: RoutineEdit?

    var body: some View {
        Page(title: "Routines", sub: routines.map { $0.count == 1 ? "1 routine" : "\($0.count) routines" }) {
            Button("New routine") { editing = RoutineEdit(routine: nil) }
                .buttonStyle(CVButton(look: .solid))
                .accessibilityIdentifier("routine-new")
        } content: {
            if let error { ErrorBox(message: error) { Task { await load() } } }
            if let routines {
                if routines.isEmpty {
                    EmptyLine(text: "No routines. Scheduled prompts (morning brief, nightly checks) appear here.")
                } else {
                    CardSection(title: "Scheduled") {
                        ForEach(routines.sorted { $0.name.lowercased() < $1.name.lowercased() }) { r in
                            Button { shown = r } label: { RoutineRow(routine: r) { on in Task { await set(r, enabled: on) } } }
                                .buttonStyle(QuietPress(radius: 0))
                        }
                    }
                }
            } else if error == nil {
                LoadingLine(text: "Reading your routines")
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .task { await hub.loadAgents() }
        .sheet(item: $shown) { r in
            RoutineSheet(hub: hub, routine: r, open: { id in shown = nil; open(id) }, edit: { shown = nil; editing = RoutineEdit(routine: r) }, deleted: {
                routines?.removeAll { $0.id == r.id }
                shown = nil
            })
        }
        .sheet(item: $editing) { e in
            RoutineEditor(hub: hub, routine: e.routine) { saved in
                routines = [saved] + (routines ?? []).filter { $0.id != saved.id }
            }
        }
    }

    private func load() async {
        do {
            routines = try await hub.client.routines()
            error = nil
        } catch {
            if (error as? URLError)?.code == .cancelled { return }
            self.error = error.localizedDescription
        }
    }

    private func set(_ r: Routine, enabled: Bool) async {
        do {
            let next = try await hub.client.updateRoutine(r.id, RoutineInput(enabled: enabled))
            routines = routines?.map { $0.id == next.id ? next : $0 }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct RoutineEdit: Identifiable {
    let id = UUID()
    let routine: Routine?
}

/// When a time reads as "in 3 hours" or "2 days ago".
enum When {
    static func words(_ ms: Int64) -> String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        return f.localizedString(for: Date(timeIntervalSince1970: Double(ms) / 1000), relativeTo: Date())
    }
}

private struct RoutineRow: View {
    let routine: Routine
    let toggle: (Bool) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(routine.name).font(.sans(14, .medium)).foregroundStyle(Tone.fg).lineLimit(1)
                Text(routine.schedule + (routine.timezone.map { " (\($0))" } ?? "")).font(.mono(12)).foregroundStyle(Tone.fg3).lineLimit(1)
                let meta = [routine.enabled ? routine.nextRunAt.map { "next \(When.words($0))" } : "off",
                            routine.lastRunAt.map { "last \(When.words($0))" },
                            routine.agent.isEmpty ? nil : AgentPicks.label(routine.agent)].compactMap { $0 }
                if !meta.isEmpty { Text(meta.joined(separator: ", ")).font(.sans(12)).foregroundStyle(Tone.fg3).lineLimit(1) }
                if !routine.prompt.isEmpty { Text(routine.prompt).font(.sans(13)).foregroundStyle(Tone.fg2).lineLimit(2).padding(.top, 2) }
            }
            Spacer(minLength: 8)
            Toggle(routine.name, isOn: Binding(get: { routine.enabled }, set: toggle)).labelsHidden().tint(Tone.signal)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// One routine: the whole prompt, Run now, Edit, Delete, and its last runs (each opens its session).
private struct RoutineSheet: View {
    let hub: HubModel
    let routine: Routine
    let open: (String) -> Void
    let edit: () -> Void
    let deleted: () -> Void
    @State private var runs: [RoutineRun]?
    @State private var error: String?
    @State private var confirmDelete = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text(routine.name).font(.sans(18, .semibold)).foregroundStyle(Tone.fg).accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button("Close") { dismiss() }.buttonStyle(CVButton(look: .quiet))
                }
                Text(routine.schedule).font(.mono(12.5)).foregroundStyle(Tone.fg3)
                Text(routine.prompt).font(.sans(14)).foregroundStyle(Tone.fg).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Button("Run now", systemImage: "play.fill") { Task { await run() } }.buttonStyle(CVButton(look: .solid))
                    Button("Edit", action: edit).buttonStyle(CVButton(look: .outline))
                    Spacer()
                    Button("Delete", role: .destructive) { confirmDelete = true }.buttonStyle(CVButton(look: .quiet)).foregroundStyle(Tone.fault)
                }
                if let error { Text(error).font(.sans(13)).foregroundStyle(Tone.fault) }
                if let runs {
                    CardSection(title: "History", note: runs.isEmpty ? "No runs yet." : nil) {
                        ForEach(runs.prefix(20)) { r in
                            Button { if let s = r.sessionId { open(s) } } label: { RunRow(run: r) }
                                .buttonStyle(QuietPress(radius: 0))
                                .disabled(r.sessionId == nil)
                        }
                    }
                } else {
                    LoadingLine(text: "Reading the runs")
                }
            }
            .padding(24).frame(maxWidth: 620).frame(maxWidth: .infinity)
        }
        .background(Tone.bg.ignoresSafeArea())
        .task { runs = (try? await hub.client.routineRuns(routine.id)) ?? [] }
        .alert("Delete this routine?", isPresented: $confirmDelete) {
            Button("Delete", role: .destructive) { Task { await delete() } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("\u{201C}\(routine.name)\u{201D} stops running. Its past sessions stay.") }
    }

    private func run() async {
        do {
            let r = try await hub.client.runRoutine(routine.id)
            runs = [r] + (runs ?? []).filter { $0.id != r.id }
            error = nil
        } catch {
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }

    private func delete() async {
        do {
            try await hub.client.deleteRoutine(routine.id)
            deleted()
        } catch {
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }
}

private struct RunRow: View {
    let run: RoutineRun

    var body: some View {
        let (icon, tint): (String, Color) = switch run.status {
        case "ok": ("checkmark.circle", Tone.ok)
        case "error": ("exclamationmark.circle", Tone.fault)
        case "skipped": ("minus.circle", Tone.fg4)
        default: ("clock", Tone.signal)
        }
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).font(.system(size: 15)).foregroundStyle(tint).frame(width: 20).accessibilityLabel(run.status)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(run.trigger.capitalized), \(When.words(run.startedAt))").font(.sans(13)).foregroundStyle(Tone.fg)
                if let t = run.error ?? run.summary { Text(t).font(.sans(12)).foregroundStyle(Tone.fg3).lineLimit(2) }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 9)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    }
}

/// New or edit (web RoutineEditor): name, what to do, the agent, and the schedule as choices; the
/// hub's preview lists the next runs or says why it cannot read the line.
private struct RoutineEditor: View {
    let hub: HubModel
    let routine: Routine?
    let saved: (Routine) -> Void
    @State private var name = ""
    @State private var prompt = ""
    @State private var agent = StartMode.assistantAgent
    @State private var kind = Schedules.Kind.daily
    @State private var time = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var weekday = 1
    @State private var every = 30
    @State private var day = Date()
    @State private var custom = ""
    @State private var preview: SchedulePreview?
    @State private var saving = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    private var expr: String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: time)
        let y = Calendar.current.dateComponents([.year, .month, .day], from: day)
        let d = String(format: "%04d-%02d-%02d", y.year ?? 2026, y.month ?? 1, y.day ?? 1)
        return Schedules.expr(kind, hour: c.hour ?? 9, minute: c.minute ?? 0, weekday: weekday, every: every, date: d, custom: custom)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text(routine == nil ? "New routine" : "Edit routine").font(.sans(18, .semibold)).foregroundStyle(Tone.fg).accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button("Cancel") { dismiss() }.buttonStyle(CVButton(look: .quiet))
                }
                field("Name") { TextField("Morning brief", text: $name).font(.sans(14)) }
                field("What to do") {
                    TextField("Summarize my calendar and unread mail", text: $prompt, axis: .vertical).font(.sans(14)).lineLimit(3...8)
                }
                VStack(alignment: .leading, spacing: 8) {
                    Text("Agent").font(.sans(12.5, .semibold)).foregroundStyle(Tone.fg3)
                    ScrollView(.horizontal) {
                        Segmented(options: AgentPicks.switchable(hub.agents).map { ($0.name, AgentPicks.label($0.name)) }, selection: $agent)
                    }.scrollIndicators(.hidden)
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("Schedule").font(.sans(12.5, .semibold)).foregroundStyle(Tone.fg3)
                    ScrollView(.horizontal) {
                        Segmented(options: Schedules.Kind.allCases.map { ($0, Schedules.label($0)) }, selection: $kind)
                    }.scrollIndicators(.hidden)
                    scheduleFields
                    Text(expr).font(.mono(12.5)).foregroundStyle(Tone.fg2)
                    if let e = preview?.error {
                        Text(e).font(.sans(12.5)).foregroundStyle(Tone.fault)
                    } else if let next = preview?.next, !next.isEmpty {
                        Text("Next: " + next.prefix(3).map { Date(timeIntervalSince1970: Double($0) / 1000).formatted(date: .abbreviated, time: .shortened) }.joined(separator: ", "))
                            .font(.sans(12.5)).foregroundStyle(Tone.fg3)
                    }
                }
                if let error { Text(error).font(.sans(13)).foregroundStyle(Tone.fault) }
                Button(saving ? "Saving…" : "Save") { Task { await save() } }
                    .buttonStyle(CVButton(look: .solid, height: 40, full: true))
                    .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty || prompt.trimmingCharacters(in: .whitespaces).isEmpty || preview?.error != nil)
                    .accessibilityIdentifier("routine-save")
            }
            .padding(24).frame(maxWidth: 620).frame(maxWidth: .infinity)
        }
        .background(Tone.bg.ignoresSafeArea())
        .onAppear(perform: fill)
        // the hub reads the line (300 ms after the last change)
        .task(id: expr) {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, !expr.isEmpty else { return }
            preview = try? await hub.client.previewSchedule(expr)
        }
    }

    @ViewBuilder private var scheduleFields: some View {
        switch kind {
        case .daily, .weekdays:
            DatePicker("At", selection: $time, displayedComponents: .hourAndMinute).font(.sans(14))
        case .weekly:
            Picker("Day", selection: $weekday) {
                ForEach(0..<7, id: \.self) { Text(Calendar.current.weekdaySymbols[$0]).tag($0) }
            }.font(.sans(14))
            DatePicker("At", selection: $time, displayedComponents: .hourAndMinute).font(.sans(14))
        case .every:
            Picker("Every", selection: $every) {
                ForEach([5, 15, 30, 60, 120, 240, 360, 720], id: \.self) { Text($0 < 60 ? "\($0) minutes" : $0 == 60 ? "hour" : "\($0 / 60) hours").tag($0) }
            }.font(.sans(14))
        case .once:
            DatePicker("On", selection: $day, in: Date()..., displayedComponents: .date).font(.sans(14))
            DatePicker("At", selection: $time, displayedComponents: .hourAndMinute).font(.sans(14))
        case .custom:
            field("Cron or @every") { TextField("*/30 * * * *", text: $custom).font(.mono(13)).textInputAutocapitalization(.never).autocorrectionDisabled() }
        }
    }

    private func field(_ title: String, @ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.sans(12.5, .semibold)).foregroundStyle(Tone.fg3)
            content().foregroundStyle(Tone.fg).padding(.horizontal, 12).padding(.vertical, 10)
                .panel(Tone.raise, radius: Radius.r3, border: Tone.rule2)
        }
    }

    private func fill() {
        guard let r = routine else { return }
        name = r.name
        prompt = r.prompt
        if !r.agent.isEmpty { agent = r.agent }
        let p = Schedules.parse(r.schedule)
        kind = p.kind
        time = Calendar.current.date(bySettingHour: p.hour, minute: p.minute, second: 0, of: Date()) ?? time
        weekday = p.weekday
        every = p.every
        if let d = try? Date(p.date + "T12:00:00Z", strategy: .iso8601) { day = d }
        if p.kind == .custom { custom = r.schedule }
    }

    private func save() async {
        saving = true
        let input = RoutineInput(name: name.trimmingCharacters(in: .whitespaces), schedule: expr, prompt: prompt, agent: agent)
        do {
            let r: Routine
            if let routine { r = try await hub.client.updateRoutine(routine.id, input) } else { r = try await hub.client.createRoutine(input) }
            saved(r)
            dismiss()
        } catch {
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
        saving = false
    }
}
