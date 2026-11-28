import ConclaveKit
import SwiftUI

/// The workflow library (web WorkflowsPage Library, Android WorkflowLibraryScreen): workflows grouped
/// by where they come from, each with its description, source and last run. A tap opens the launch
/// sheet; a started run opens in the Runs tab.
struct WorkflowLibraryList: View {
    let hub: HubModel
    let started: (WorkflowRun) -> Void
    @Binding var count: Int?
    /// Bumped by the page's pull to refresh.
    var refreshes = 0
    @State private var list: [WorkflowSummary]?
    @State private var error: String?
    @State private var picked: WorkflowSummary?

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            if let error { ErrorBox(message: error) { Task { await load() } } }
            if let list {
                if list.isEmpty {
                    EmptyLine(text: "Workflows saved in ~/.conclave/workflows or a project's .conclave/workflows show up here.")
                }
                let now = Int64(Date().timeIntervalSince1970 * 1000)
                ForEach(WorkflowSummary.sourceOrder, id: \.self) { source in
                    let items = list.filter { $0.source == source }
                    if !items.isEmpty {
                        CardSection(title: "\(WorkflowSummary.sourceHeading(source))  \(items.count)") {
                            ForEach(items) { w in
                                Button { picked = w } label: { LibraryRow(workflow: w, now: now) }
                                    .buttonStyle(QuietPress(radius: 0))
                                    .accessibilityIdentifier("workflow-\(w.id)")
                            }
                        }
                    }
                }
            } else if error == nil {
                LoadingLine(text: "Reading the library")
            }
        }
        .task(id: refreshes) { await load() }
        .sheet(item: $picked) { w in
            LaunchSheet(hub: hub, workflow: w) { run in
                picked = nil
                started(run)
            }
        }
        .onAppear {
            #if DEBUG
            // screenshots: -openWorkflow <id> opens its launch sheet once the library is in
            if let id = UserDefaults.standard.string(forKey: "openWorkflow"), !id.isEmpty, picked == nil, let w = list?.first(where: { $0.id == id }) { picked = w }
            #endif
        }
        .onChange(of: list) {
            #if DEBUG
            if let id = UserDefaults.standard.string(forKey: "openWorkflow"), !id.isEmpty, picked == nil, let w = list?.first(where: { $0.id == id }) { picked = w }
            #endif
        }
    }

    func load() async {
        do {
            let l = try await hub.client.workflows()
            list = l
            count = l.count
            error = nil
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            self.error = error.localizedDescription
        }
    }
}

private struct LibraryRow: View {
    let workflow: WorkflowSummary
    let now: Int64

    var body: some View {
        let w = workflow
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(w.name).font(.sans(14, .medium)).foregroundStyle(Tone.fg).lineLimit(1)
                if !w.description.isEmpty { Text(w.description).font(.sans(12.5)).foregroundStyle(Tone.fg3).lineLimit(2) }
                if !w.runnable {
                    Text(w.error.map { "Cannot load: \($0)" } ?? "Cannot load").font(.sans(12)).foregroundStyle(Tone.fault).lineLimit(2)
                } else if !w.portable && w.source != "builtin" {
                    Text("Conclave only").font(.sans(12)).foregroundStyle(Tone.fg4)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                if let s = w.lastRunStatus {
                    Text(WorkflowWords.runWord(s)).font(.sans(12.5, .medium)).foregroundStyle(WorkflowWords.runTone(s).color)
                } else {
                    Text("never run").font(.sans(12.5)).foregroundStyle(Tone.fg3)
                }
                if let at = w.lastRunAt { Text(Ago.short(at, now: now)).font(.sans(12)).monospacedDigit().foregroundStyle(Tone.fg4) }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
        .contentShape(Rectangle())
        .opacity(w.runnable ? 1 : 0.7)
    }
}

/// Run a workflow (web RunSheet): what it does, its presets, the declared args as fields (or a JSON
/// box), Save as preset, the computer and folder it runs in, and a token budget.
struct LaunchSheet: View {
    let hub: HubModel
    let workflow: WorkflowSummary
    let started: (WorkflowRun) -> Void
    @State private var form = LaunchForm()
    @State private var presets: [WorkflowPreset] = []
    @State private var presetName = ""
    @State private var device = "local"
    @State private var cwd = ""
    @State private var budget = ""
    @State private var argsError: String?
    @State private var budgetError: String?
    @State private var failed: String?
    @State private var busy = false
    @Environment(\.dismiss) private var dismiss

    private var schema: [WorkflowArgField]? { workflow.argsSchema }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text("Run \(workflow.name)").font(.sans(18, .semibold)).foregroundStyle(Tone.fg).accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button("Cancel") { dismiss() }.buttonStyle(CVButton(look: .quiet))
                }
                if !workflow.description.isEmpty { Text(workflow.description).font(.sans(14)).foregroundStyle(Tone.fg2).fixedSize(horizontal: false, vertical: true) }
                if let w = workflow.whenToUse, !w.isEmpty { Text(w).font(.sans(12.5)).foregroundStyle(Tone.fg3).fixedSize(horizontal: false, vertical: true) }
                Text(about).font(.sans(12.5)).foregroundStyle(Tone.fg3).fixedSize(horizontal: false, vertical: true)
                if !presets.isEmpty { presetChips }
                if let schema {
                    field("Args", help: "The workflow's declared args. Empty fields are left out.") {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(schema, id: \.name) { f in argField(f) }
                        }
                    }
                    field("More args", help: "JSON for args the form does not list. The fields above win on the same name.") {
                        box(TextField(#"{"votes": 3}"#, text: $form.raw, axis: .vertical).font(.mono(13)).lineLimit(2...8))
                    }
                } else {
                    field("Args", help: "JSON the script reads as args. Leave it empty when the workflow needs none.") {
                        box(TextField(#"{"question": "..."}"#, text: $form.raw, axis: .vertical).font(.mono(13)).lineLimit(3...10))
                    }
                }
                if let argsError { Text(argsError).font(.sans(12.5)).foregroundStyle(Tone.fault) }
                field("Save as preset", help: "Give these args a name to rerun them.") {
                    HStack(spacing: 8) {
                        box(TextField("weekly triage", text: $presetName).font(.sans(14)))
                        Button("Save") { Task { await savePreset() } }
                            .buttonStyle(CVButton(look: .outline, height: 40))
                            .disabled(presetName.trimmingCharacters(in: .whitespaces).isEmpty)
                            .accessibilityIdentifier("preset-save")
                    }
                }
                field("Computer") {
                    ScrollView(.horizontal) {
                        Segmented(options: computers, selection: $device)
                    }.scrollIndicators(.hidden)
                }
                field("Folder", help: "The repository or folder it works in. Empty: the device's home.") {
                    box(TextField("~/code/conclave", text: $cwd).font(.mono(13)).textInputAutocapitalization(.never).autocorrectionDisabled())
                }
                field("Budget", help: "A hard ceiling on output tokens: agent calls after it stop. Empty: no ceiling.") {
                    box(TextField("2m", text: $budget).font(.sans(14)).textInputAutocapitalization(.never).autocorrectionDisabled())
                }
                if let budgetError { Text(budgetError).font(.sans(12.5)).foregroundStyle(Tone.fault) }
                if let failed { Text(failed).font(.sans(13)).foregroundStyle(Tone.fault) }
                Button(busy ? "Starting…" : "Start") { Task { await start() } }
                    .buttonStyle(CVButton(look: .solid, height: 40, full: true))
                    .disabled(busy || !workflow.runnable)
                    .accessibilityIdentifier("workflow-start")
            }
            .padding(24).frame(maxWidth: 620).frame(maxWidth: .infinity)
        }
        .background(Tone.bg.ignoresSafeArea())
        .scrollDismissesKeyboard(.interactively)
        .task { await loadPresets() }
        .onChange(of: form) { argsError = nil }
        .onChange(of: budget) { budgetError = nil }
    }

    /// "Built in. Phases: Scope, Find, Verify." as the web's sheet says it.
    private var about: String {
        let src = WorkflowSummary.sourceHeading(workflow.source)
        var s = src + (!workflow.portable ? ", uses the Conclave layer, so it does not run in Claude Code" : "")
        if !workflow.phases.isEmpty { s += ". Phases: \(workflow.phases.joined(separator: ", "))" }
        return s + "."
    }

    /// This hub, then the computers online now.
    private var computers: [(String, String)] {
        [("local", (hub.info?.name).flatMap { $0.isEmpty ? nil : $0 } ?? "This hub")] + hub.devices.filter(\.online).map { ($0.id, $0.name.isEmpty ? $0.id : $0.name) }
    }

    private var presetChips: some View {
        field("Presets", help: "Fill the form from a saved set of args.") {
            ScrollView(.horizontal) {
                HStack(spacing: 8) {
                    ForEach(presets) { p in
                        HStack(spacing: 0) {
                            Button(p.name) { form = Launch.formOf(schema, p.args) }
                                .font(.sans(12.5)).foregroundStyle(Tone.fg2).padding(.horizontal, 10).frame(height: 30)
                            Rectangle().fill(Tone.rule2).frame(width: 1, height: 30)
                            Button { Task { await deletePreset(p) } } label: { Image(systemName: "xmark").font(.system(size: 10, weight: .semibold)) }
                                .foregroundStyle(Tone.fg3).frame(width: 30, height: 30)
                                .accessibilityLabel("Delete preset \(p.name)")
                        }
                        .buttonStyle(.plain)
                        .panel(Tone.raise, radius: Radius.r2, border: Tone.rule2)
                    }
                }
            }.scrollIndicators(.hidden)
        }
    }

    @ViewBuilder private func argField(_ f: WorkflowArgField) -> some View {
        if f.type == "boolean" {
            Toggle(isOn: Binding(get: { form.bools[f.name] == true }, set: { form.bools[f.name] = $0 })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(f.name).font(.mono(13)).foregroundStyle(Tone.fg)
                    if let d = f.description { Text(d).font(.sans(12)).foregroundStyle(Tone.fg3) }
                }
            }
            .tint(Tone.signal)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Text(f.name + (f.type == "number" ? " (number)" : "")).font(.mono(12.5)).foregroundStyle(Tone.fg2)
                box(TextField(f.description ?? f.name, text: Binding(get: { form.texts[f.name] ?? "" }, set: { form.texts[f.name] = $0 }), axis: .vertical)
                    .font(.sans(14)).lineLimit(1...6)
                    .keyboardType(f.type == "number" ? .numbersAndPunctuation : .default))
            }
        }
    }

    private func field(_ title: String, help: String? = nil, @ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.sans(12.5, .semibold)).foregroundStyle(Tone.fg3)
            content()
            if let help { Text(help).font(.sans(12)).foregroundStyle(Tone.fg4).fixedSize(horizontal: false, vertical: true) }
        }
    }

    private func box(_ v: some View) -> some View {
        v.foregroundStyle(Tone.fg).padding(.horizontal, 12).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .panel(Tone.raise, radius: Radius.r3, border: Tone.rule2)
    }

    private func args() -> JSONValue?? {
        switch Launch.argsOf(schema, form) {
        case .success(let a): return .some(a)
        case .failure(let e): argsError = e.message; return nil
        }
    }

    private func loadPresets() async { presets = (try? await hub.client.workflowPresets(workflow.id)) ?? [] }

    private func savePreset() async {
        guard let a = args() else { return }
        do {
            _ = try await hub.client.saveWorkflowPreset(workflow.id, name: presetName.trimmingCharacters(in: .whitespaces), args: a)
            presetName = ""
            await loadPresets()
        } catch {
            failed = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }

    private func deletePreset(_ p: WorkflowPreset) async {
        do {
            try await hub.client.deleteWorkflowPreset(workflow.id, presetId: p.id)
            presets.removeAll { $0.id == p.id }
        } catch {
            failed = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }

    private func start() async {
        guard let a = args() else { return }
        let tokens: Int?
        switch Launch.budgetTokens(budget) {
        case .success(let t): tokens = t
        case .failure(let e): budgetError = e.message; return
        }
        busy = true
        defer { busy = false }
        do {
            let run = try await hub.client.startWorkflow(workflow.id, args: a, device: device, cwd: cwd.trimmingCharacters(in: .whitespaces), budgetTokens: tokens)
            started(run)
        } catch {
            failed = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }
}

/// A run's findings (web Findings.tsx): open ones with Fixed, Dismiss (asks why) and Ignore, then
/// the decided ones dimmed with their verdict. Dismissals teach later runs to drop similar findings.
struct FindingsSection: View {
    let hub: HubModel
    let runId: String
    let findings: [WorkflowFinding]
    let refutedRate: Double?
    let changed: (WorkflowFinding) -> Void
    @State private var dismissing: WorkflowFinding?
    @State private var reason = ""
    @State private var failed: String?

    var body: some View {
        let open = findings.filter { $0.verdict == nil }
        let decided = findings.filter { $0.verdict != nil }
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("Findings  \(open.count)").font(.sans(12.5, .semibold)).foregroundStyle(Tone.fg3).accessibilityAddTraits(.isHeader)
                Spacer()
                if let r = refutedRate {
                    Text("Refuters dropped \(Int((r * 100).rounded()))% of the findings they checked").font(.sans(12)).monospacedDigit().foregroundStyle(Tone.fg4)
                        .multilineTextAlignment(.trailing)
                }
            }
            .padding(.horizontal, 2)
            if let failed { Text(failed).font(.sans(12.5)).foregroundStyle(Tone.fault) }
            if open.isEmpty {
                Text("Every finding has a verdict.").font(.sans(13)).foregroundStyle(Tone.fg3).padding(.vertical, 6)
            } else {
                rows(open, dim: false)
            }
            if !decided.isEmpty {
                Text("Decided  \(decided.count)").font(.sans(12.5, .semibold)).foregroundStyle(Tone.fg3).padding(.horizontal, 2).padding(.top, 10)
                rows(decided, dim: true)
            }
        }
        .alert("Dismiss this finding?", isPresented: Binding(get: { dismissing != nil }, set: { if !$0 { dismissing = nil } })) {
            TextField("Why it is not a problem", text: $reason)
            Button("Dismiss") {
                if let f = dismissing { Task { await judge(f, .dismissed, reason: reason.trimmingCharacters(in: .whitespacesAndNewlines)) } }
            }
            .disabled(reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("\(dismissing?.title ?? "")\n\nAfter three similar dismissals, later runs of this workflow drop such findings and say how many.")
        }
    }

    private func rows(_ list: [WorkflowFinding], dim: Bool) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(list.enumerated()), id: \.element.id) { i, f in
                if i > 0 { Rectangle().fill(Tone.rule).frame(height: 1).padding(.leading, 14) }
                FindingRow(finding: f, dim: dim) { verdict in
                    if verdict == .dismissed { reason = ""; dismissing = f } else { Task { await judge(f, verdict) } }
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: Radius.r3, style: .continuous))
        .panel(Tone.raise, radius: Radius.r3, border: Tone.rule)
    }

    private func judge(_ f: WorkflowFinding, _ verdict: FindingVerdict, reason: String? = nil) async {
        do {
            changed(try await hub.client.judgeFinding(runId, findingId: f.id, verdict: verdict, reason: reason))
            failed = nil
        } catch {
            failed = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
        dismissing = nil
    }
}

private struct FindingRow: View {
    let finding: WorkflowFinding
    let dim: Bool
    let judge: (FindingVerdict) -> Void
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        let f = finding
        let compact = sizeClass == .compact
        let stack = compact ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(f.priority ?? "").font(.mono(12, .medium)).foregroundStyle(f.priority == "P0" || f.priority == "P1" ? Tone.fg : Tone.fg3).frame(width: 24, alignment: .leading)
            stack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(f.title).font(.sans(14, .medium)).foregroundStyle(dim ? Tone.fg2 : Tone.fg).fixedSize(horizontal: false, vertical: true)
                    let place = f.place.map { Text($0).font(.mono(12)).foregroundStyle(Tone.fg3) }
                    let proof: Text? = f.proven ? Text(", proven by a failing test").font(.sans(12)).foregroundStyle(Tone.ok)
                        : f.votesWord.map { Text(", \($0)").font(.sans(12)).foregroundStyle(Tone.fg3) }
                    if place != nil || proof != nil { (place ?? Text("")) + (proof ?? Text("")) }
                    if !dim, let q = f.quote { Text(q).font(.mono(12)).foregroundStyle(Tone.fg2).lineLimit(1) }
                    if !dim, let s = f.scenario { Text("Trigger: \(s)").font(.sans(12)).foregroundStyle(Tone.fg3).fixedSize(horizontal: false, vertical: true) }
                    if let r = f.reason { Text("Reason: \(r)").font(.sans(12)).foregroundStyle(Tone.fg3).fixedSize(horizontal: false, vertical: true) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if let v = f.verdict {
                    Text(v.rawValue).font(.sans(12.5, .medium)).foregroundStyle(Tone.fg3)
                } else {
                    HStack(spacing: 2) {
                        Button("Fixed") { judge(.fixed) }.buttonStyle(CVButton(look: .quiet, height: compact ? 36 : 28, size: 12.5))
                        Button("Dismiss") { judge(.dismissed) }.buttonStyle(CVButton(look: .quiet, height: compact ? 36 : 28, size: 12.5))
                        Button("Ignore") { judge(.ignored) }.buttonStyle(CVButton(look: .quiet, height: compact ? 36 : 28, size: 12.5))
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("Verdict for \(f.title)")
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

extension RunTone {
    var color: Color {
        switch self {
        case .signal: Tone.signal
        case .warn: Tone.warn
        case .fault: Tone.fault
        case .dim: Tone.fg3
        }
    }
}
