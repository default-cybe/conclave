import ConclaveKit
import SwiftUI

/// Workflow runs, newest first (Android WorkflowRunsScreen): the workflow, its agents, tokens and
/// cost, and its state word in a fixed place. A run opens in place with a way back, since this
/// page sits in the split view's detail column.
struct WorkflowsView: View {
    let hub: HubModel
    let open: (String) -> Void
    @State private var runs: [WorkflowRun]?
    @State private var error: String?
    @State private var openRun: String?
    @State private var hooked = false

    var body: some View {
        Group {
            if let openRun {
                WorkflowRunView(hub: hub, runId: openRun, open: open, back: { self.openRun = nil })
            } else {
                list
            }
        }
        .onAppear {
            #if DEBUG
            // screenshots: -openRun <id> opens that run first
            if !hooked, let id = UserDefaults.standard.string(forKey: "openRun"), !id.isEmpty { openRun = id }
            #endif
            hooked = true
        }
    }

    private var list: some View {
        Page(title: "Workflow runs", sub: runs.map(Self.summary)) {
            if let error { ErrorBox(message: error) { Task { await load() } } }
            if let runs {
                if runs.isEmpty {
                    EmptyLine(text: "No workflow runs yet. A workflow runs many agents in phases and checks their work. Ask an agent to run one, or turn on Ultra in a session.")
                } else {
                    let now = Int64(Date().timeIntervalSince1970 * 1000)
                    VStack(spacing: 0) {
                        ForEach(Array(runs.enumerated()), id: \.element.id) { i, r in
                            if i > 0 { Rectangle().fill(Tone.rule).frame(height: 1) }
                            Button { openRun = r.id } label: { RunRow(run: r, now: now) }
                                .buttonStyle(QuietPress(radius: 0))
                                .accessibilityIdentifier("run-\(r.id)")
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: Radius.r3, style: .continuous))
                    .panel(Tone.raise, radius: Radius.r3, border: Tone.rule)
                }
            } else if error == nil {
                LoadingLine()
            }
        }
        .refreshable { await load() }
        .task { await load() }
    }

    /// "3 runs, 1 running".
    private static func summary(_ runs: [WorkflowRun]) -> String {
        let live = runs.filter { WorkflowWords.isLive($0.status) }.count
        let head = "\(runs.count) \(runs.count == 1 ? "run" : "runs")"
        return live > 0 ? "\(head), \(live) running" : head
    }

    private func load() async {
        do {
            runs = try await hub.client.workflowRuns(limit: 100)
            error = nil
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            self.error = error.localizedDescription
        }
    }
}

private struct RunRow: View {
    let run: WorkflowRun
    let now: Int64

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(run.name.isEmpty ? "Workflow" : run.name).font(.sans(14, .medium)).foregroundStyle(Tone.fg).lineLimit(1)
                Text(WorkflowWords.runMeta(run)).font(.sans(12.5)).monospacedDigit().foregroundStyle(Tone.fg3).lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(WorkflowWords.runWord(run.status)).font(.sans(12.5, .medium)).foregroundStyle(WorkflowWords.runTone(run.status).color)
                Text(Ago.short(run.finishedAt ?? run.startedAt ?? run.createdAt, now: now)).font(.sans(12)).monospacedDigit().foregroundStyle(Tone.fg4)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(minHeight: 56)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// One run (Android WorkflowRunScreen): the status sentence and what runs now, the phases in order
/// with a row per agent (label, model and last tool, state word), the result and the narrator log.
/// Pause, Resume and Stop as the run allows. A live run reads again every few seconds; an agent
/// row with a session opens it.
struct WorkflowRunView: View {
    let hub: HubModel
    let runId: String
    let open: (String) -> Void
    var back: (() -> Void)? = nil
    @State private var detail: WorkflowRunDetail?
    @State private var error: String?
    @State private var failed: String?
    @State private var stopping = false

    var body: some View {
        Page(title: detail.map { $0.run.name.isEmpty ? "Run" : $0.run.name } ?? "Run", sub: detail.flatMap { WorkflowWords.duration($0.run, now: Self.now) }) {
            if let run = detail?.run { controls(run) }
        } content: {
            if let back {
                Button(action: back) { Label("All runs", systemImage: "chevron.left").font(.sans(13, .medium)) }
                    .buttonStyle(CVButton(look: .quiet))
                    .accessibilityIdentifier("runs-back")
            }
            if let failed { Text(failed).font(.sans(13)).foregroundStyle(Tone.fault) }
            if let detail {
                status(detail)
                let groups = WorkflowWords.byPhase(detail.run, detail.calls)
                ForEach(Array(groups.enumerated()), id: \.offset) { i, g in phase(g, index: i, run: detail.run) }
                if let report = WorkflowWords.report(detail.result) {
                    section("Result") {
                        Text(report).font(.sans(14)).foregroundStyle(Tone.fg).lineSpacing(3).textSelection(.enabled)
                            .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if !detail.logs.isEmpty {
                    section("Log", trailing: "\(detail.logs.count)") {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(detail.logs) { l in
                                HStack(alignment: .firstTextBaseline, spacing: 10) {
                                    Text(Self.clock(l.ts)).font(.mono(11.5)).foregroundStyle(Tone.fg4)
                                    Text(l.text).font(.mono(12)).foregroundStyle(Tone.fg2).textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                        .padding(14)
                    }
                }
            } else if let error {
                ErrorBox(message: error) { Task { await load() } }
            } else {
                LoadingLine()
            }
        }
        .refreshable { await load() }
        // restarts when the run goes live again (a resume), so polling picks up again
        .task(id: "\(runId)|\(detail.map { WorkflowWords.isLive($0.run.status) } ?? true)") {
            // shortcut: polls every 3 s while live instead of following workflow.* events; follow events when the socket carries them here
            await load()
            while !Task.isCancelled, let d = detail, WorkflowWords.isLive(d.run.status) {
                try? await Task.sleep(for: .seconds(3))
                if Task.isCancelled { break }
                await load()
            }
        }
        .confirmationDialog("Stop \(detail?.run.name ?? "this run")?", isPresented: $stopping, titleVisibility: .visible) {
            Button("Stop", role: .destructive) { Task { await control { try await hub.client.stopWorkflow(runId) } } }
        } message: {
            Text("Running agents are stopped and the script ends. Finished calls stay in the journal, so Resume replays them.")
        }
    }

    private static var now: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    @ViewBuilder private func controls(_ run: WorkflowRun) -> some View {
        HStack(spacing: 8) {
            switch run.status {
            case .running:
                Button("Pause") { Task { await control { try await hub.client.pauseWorkflow(runId) } } }
                    .buttonStyle(CVButton(look: .outline)).accessibilityIdentifier("run-pause")
            case .paused, .interrupted, .waitingReset:
                Button("Resume") { Task { await control { try await hub.client.resumeWorkflow(runId) } } }
                    .buttonStyle(CVButton(look: .outline)).accessibilityIdentifier("run-resume")
            default:
                EmptyView()
            }
            if WorkflowWords.isLive(run.status) {
                Button("Stop") { stopping = true }
                    .buttonStyle(CVButton(look: .quietFault)).accessibilityIdentifier("run-stop")
            }
        }
    }

    /// The sentence, what runs now, where it runs, and the error.
    private func status(_ d: WorkflowRunDetail) -> some View {
        let p = WorkflowWords.statusParts(d.run, d.calls)
        return VStack(alignment: .leading, spacing: 6) {
            Text("\(p.head). \(p.agents).").font(.sans(15, .medium)).foregroundStyle(Tone.fg).fixedSize(horizontal: false, vertical: true)
            Text(p.spend).font(.sans(13)).monospacedDigit().foregroundStyle(Tone.fg2)
            if let now = WorkflowWords.activity(d) {
                Text(now).font(.sans(13)).foregroundStyle(Tone.signal).lineLimit(1)
            }
            if let desc = d.run.description, !desc.isEmpty { Text(desc).font(.sans(13)).foregroundStyle(Tone.fg3) }
            if let err = d.run.error, !err.isEmpty, d.run.status != .stopped { Text(err).font(.sans(13)).foregroundStyle(Tone.fault) }
            if let sid = d.run.sessionId {
                Button("Open the session") { open(sid) }.buttonStyle(CVButton(look: .outline)).padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("run-status")
    }

    /// A phase: its title and progress, then a row per call. The current phase's progress is in signal.
    private func phase(_ g: PhaseGroup, index: Int, run: WorkflowRun) -> some View {
        let current = index == run.phaseIndex && WorkflowWords.isLive(run.status)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(g.title).font(.sans(12.5, .semibold)).foregroundStyle(Tone.fg3).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                Text(WorkflowWords.phaseProgress(g, index: index, run: run)).font(.sans(12)).monospacedDigit()
                    .foregroundStyle(current ? Tone.signal : Tone.fg4)
            }
            .padding(.horizontal, 2)
            if let detail = g.detail, !detail.isEmpty { Text(detail).font(.sans(12)).foregroundStyle(Tone.fg3).padding(.leading, 2) }
            if !g.calls.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(WorkflowWords.rows(g.calls).enumerated()), id: \.element.call.seq) { i, row in
                        if i > 0 { Rectangle().fill(Tone.rule).frame(height: 1).padding(.leading, 14) }
                        callRow(row)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: Radius.r3, style: .continuous))
                .panel(Tone.raise, radius: Radius.r3, border: Tone.rule)
            }
        }
    }

    @ViewBuilder private func callRow(_ row: CallRow) -> some View {
        let c = row.call
        let line = HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(WorkflowWords.callLabel(c)).font(.sans(14, .medium)).foregroundStyle(Tone.fg).lineLimit(1)
                let meta = WorkflowWords.callMeta(c, lastTool: c.lastTool)
                if !meta.isEmpty {
                    Text(meta).font(.sans(12)).foregroundStyle(c.state == .failed && !WorkflowWords.stoppedByRun(c) ? Tone.fault : Tone.fg3).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Text(WorkflowWords.callWord(c)).font(.sans(12.5, .medium)).foregroundStyle(WorkflowWords.callTone(c).color)
        }
        .padding(.leading, 14 + CGFloat(row.depth) * 16).padding(.trailing, 14).padding(.vertical, 9)
        .frame(minHeight: 48)
        .contentShape(Rectangle())
        if let sid = c.childSessionId {
            Button { open(sid) } label: { line }
                .buttonStyle(QuietPress(radius: 0))
                .accessibilityIdentifier("call-\(c.seq)")
        } else {
            line.accessibilityElement(children: .combine)
        }
    }

    private func section<C: View>(_ title: String, trailing: String? = nil, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title).font(.sans(12.5, .semibold)).foregroundStyle(Tone.fg3).accessibilityAddTraits(.isHeader)
                Spacer()
                if let trailing { Text(trailing).font(.sans(12)).monospacedDigit().foregroundStyle(Tone.fg4) }
            }
            .padding(.horizontal, 2)
            content().panel(Tone.raise, radius: Radius.r3, border: Tone.rule)
        }
    }

    private static func clock(_ ts: Int64) -> String {
        Date(timeIntervalSince1970: Double(ts) / 1000).formatted(date: .omitted, time: .standard)
    }

    private func load() async {
        do {
            detail = try await hub.client.workflowRun(runId)
            error = nil
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            if detail == nil { self.error = error.localizedDescription } else { failed = error.localizedDescription }
        }
    }

    /// Pause, resume or stop, then read the run again (a resumed run starts its calls over).
    private func control(_ f: () async throws -> WorkflowRun) async {
        do {
            let run = try await f()
            detail?.run = run
            failed = nil
            await load()
        } catch {
            failed = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }
}

private extension RunTone {
    var color: Color {
        switch self {
        case .signal: Tone.signal
        case .warn: Tone.warn
        case .fault: Tone.fault
        case .dim: Tone.fg3
        }
    }
}
