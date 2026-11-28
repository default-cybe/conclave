import ConclaveKit
import SwiftUI

/// The board (web TasksPage, Android TasksScreen): Inbox, To do, Doing, Review and Done. On iPad
/// the columns sit side by side as on the web; on a phone the non-empty ones stack as cards. A
/// task's status menu moves it; tapping it opens a sheet to move, start or delete it. Start opens
/// the session the hub makes for it.
struct TasksView: View {
    let hub: HubModel
    let open: (String) -> Void
    @State private var tasks: [BoardTask]?
    @State private var error: String?
    /// An action the hub refused.
    @State private var failed: String?
    @State private var adding = false
    @State private var newTitle = ""
    @State private var picked: BoardTask?
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        let m = Metrics(sizeClass)
        Page(title: "Tasks", sub: tasks.map(BoardWords.summary)) {
            Button("New task") {
                newTitle = ""
                adding = true
            }
            .buttonStyle(CVButton(look: .solid))
            .accessibilityIdentifier("new-task")
        } content: {
            if let failed { Text(failed).font(.sans(13)).foregroundStyle(Tone.fault) }
            if let tasks {
                if tasks.isEmpty {
                    EmptyLine(text: "No tasks. Add one, then start it with an agent.")
                } else if m.compact {
                    phoneList(tasks)
                } else {
                    board(tasks)
                }
            } else if let error {
                ErrorBox(message: error) { Task { await load() } }
            } else {
                LoadingLine()
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .alert("New task", isPresented: $adding) {
            TextField("Title", text: $newTitle)
            Button("Cancel", role: .cancel) {}
            Button("Add") { Task { await create() } }
        }
        .sheet(item: $picked) { t in
            // follow the task's latest state while its sheet is open
            TaskSheet(task: tasks?.first(where: { $0.id == t.id }) ?? t,
                      move: { s in Task { await setStatus(t, s) } },
                      start: { Task { await start(t) } },
                      delete: { Task { await delete(t) } })
        }
    }

    /// iPad: the web's columns side by side, scrolling sideways past the page's width.
    private func board(_ tasks: [BoardTask]) -> some View {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: 14) {
                ForEach(BoardWords.columns(tasks), id: \.status) { col in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 6) {
                            Text(col.status.label).font(.sans(12.5, .semibold)).foregroundStyle(Tone.fg3)
                                .accessibilityAddTraits(.isHeader)
                            Text("\(col.tasks.count)").font(.sans(12)).monospacedDigit().foregroundStyle(Tone.fg4)
                        }
                        .padding(.leading, 2)
                        if col.tasks.isEmpty {
                            Text(BoardWords.empty(col.status)).font(.sans(12.5)).foregroundStyle(Tone.fg4)
                                .padding(.vertical, 8).padding(.leading, 2)
                        }
                        ForEach(col.tasks) { t in
                            card(t, now: now)
                                .padding(.horizontal, 12).padding(.vertical, 10)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .panel(Tone.raise, radius: Radius.r3, border: Tone.rule)
                        }
                    }
                    .frame(width: 210, alignment: .topLeading)
                    .accessibilityIdentifier("column-\(col.status.rawValue)")
                }
            }
        }
        // the board runs past the page's 760 pt column to the window's edge, as the web's board does
        .scrollClipDisabled()
    }

    /// Phone: the non-empty columns in order, each a card of rows.
    private func phoneList(_ tasks: [BoardTask]) -> some View {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        return VStack(alignment: .leading, spacing: 20) {
            ForEach(BoardWords.columns(tasks).filter { !$0.tasks.isEmpty }, id: \.status) { col in
                CardSection(title: "\(col.status.label), \(col.tasks.count)") {
                    ForEach(col.tasks) { t in
                        card(t, now: now).padding(.horizontal, 14).padding(.vertical, 10)
                    }
                }
            }
        }
    }

    /// A task: the title, its line, and the status menu. Tap opens the sheet; a long press starts or deletes.
    private func card(_ t: BoardTask, now: Int64) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Button { picked = t } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(t.title.isEmpty ? "Untitled" : t.title).font(.sans(14, .medium))
                        .foregroundStyle(t.status == .done ? Tone.fg2 : Tone.fg)
                        .lineLimit(2).multilineTextAlignment(.leading)
                    let meta = BoardWords.meta(t, now: now)
                    if !meta.isEmpty { Text(meta).font(.sans(12)).foregroundStyle(Tone.fg3).lineLimit(2) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("task-\(t.id)")
            Menu {
                ForEach(TaskStatus.allCases) { s in
                    Button(s.label) { Task { await setStatus(t, s) } }.disabled(s == t.status)
                }
            } label: {
                Text(t.status.label).font(.sans(12, .medium)).foregroundStyle(t.status == .doing ? Tone.signal : Tone.fg3)
                    .padding(.horizontal, 7).frame(height: 22)
                    .background(Tone.hover, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
            .accessibilityLabel("Status of \(t.title), \(t.status.label)")
        }
        .contextMenu {
            Button("Start", systemImage: "play") { Task { await start(t) } }
            Button("Delete", systemImage: "trash", role: .destructive) { Task { await delete(t) } }
        }
    }

    private func load() async {
        do {
            tasks = try await hub.client.tasks()
            error = nil
        } catch {
            if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
            self.error = error.localizedDescription
        }
    }

    private func upsert(_ t: BoardTask) {
        if let i = tasks?.firstIndex(where: { $0.id == t.id }) { tasks?[i] = t } else { tasks = (tasks ?? []) + [t] }
    }

    private func create() async {
        let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        await act { upsert(try await hub.client.createTask(TaskInput(title: title, status: .inbox))) }
    }

    private func setStatus(_ t: BoardTask, _ s: TaskStatus) async {
        guard s != (tasks?.first(where: { $0.id == t.id })?.status ?? t.status) else { return }
        await act { upsert(try await hub.client.updateTask(t.id, TaskInput(status: s))) }
    }

    private func start(_ t: BoardTask) async {
        await act {
            let s = try await hub.client.startTask(t.id)
            picked = nil
            open(s.id)
            // the hub moves a started task along; read the board again
            await load()
        }
    }

    private func delete(_ t: BoardTask) async {
        await act {
            try await hub.client.deleteTask(t.id)
            tasks?.removeAll { $0.id == t.id }
            if picked?.id == t.id { picked = nil }
        }
    }

    /// Runs an action and shows the hub's words when it refuses.
    private func act(_ f: () async throws -> Void) async {
        do {
            try await f()
            failed = nil
        } catch {
            failed = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }
}

/// One task: its words, the five statuses to move it, Start and Delete.
private struct TaskSheet: View {
    let task: BoardTask
    let move: (TaskStatus) -> Void
    let start: () -> Void
    let delete: () -> Void
    @State private var confirming = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .firstTextBaseline) {
                    Text(task.title.isEmpty ? "Untitled" : task.title).font(.sans(18, .semibold)).foregroundStyle(Tone.fg)
                    Spacer()
                    Button("Done") { dismiss() }.buttonStyle(CVButton(look: .quiet))
                }
                let meta = BoardWords.meta(task, now: Int64(Date().timeIntervalSince1970 * 1000))
                if !meta.isEmpty { Text(meta).font(.sans(13)).foregroundStyle(Tone.fg3) }
                if !task.description.isEmpty {
                    Text(task.description).font(.sans(14)).foregroundStyle(Tone.fg2).lineSpacing(3).textSelection(.enabled)
                }
                Segmented(options: TaskStatus.allCases.map { ($0, $0.label) }, selection: Binding(get: { task.status }, set: { move($0) }))
                Button(action: start) { Label("Start", systemImage: "play.fill").frame(maxWidth: .infinity) }
                    .buttonStyle(CVButton(look: .solid))
                    .accessibilityIdentifier("task-start")
                Button("Delete task") { confirming = true }
                    .buttonStyle(CVButton(look: .quietFault))
            }
            .padding(24)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
        }
        .background(Tone.bg.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .confirmationDialog("Delete \(task.title)?", isPresented: $confirming, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { delete() }
        }
    }
}
