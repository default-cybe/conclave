import ConclaveKit
import SwiftUI

/// Meetings (Android MeetingsScreen, web features/meeting): Now, Upcoming and Past with the
/// countdown, status and prep words. A meeting opens its notes once it ended, with Save to memory
/// and Open as chat; New schedules one (or prepares it now). Listening stays on a computer.
struct MeetingsView: View {
    let hub: HubModel
    let open: (String) -> Void
    @State private var list: [Meeting]?
    @State private var error: String?
    @State private var shown: Meeting?
    @State private var adding = false

    var body: some View {
        Page(title: "Meetings", sub: "The hub prepares each one from your chats and code, and writes the notes after") {
            Button("New") { adding = true }.buttonStyle(CVButton(look: .solid, height: 32)).accessibilityIdentifier("new-meeting")
        } content: {
            if let error { ErrorBox(message: error) { Task { await load() } } }
            if let list {
                TimelineView(.periodic(from: .now, by: 60)) { ctx in
                    let now = Int64(ctx.date.timeIntervalSince1970 * 1000)
                    let s = MeetingWords.sections(list, now: now)
                    if s.isEmpty { EmptyLine(text: "No meetings yet. New schedules one; the hub prepares it before it starts.") }
                    section("Now", s.now, now)
                    section("Upcoming", s.upcoming, now)
                    section("Past", s.past, now)
                }
            } else if error == nil {
                LoadingLine()
            }
        }
        .refreshable { await load() }
        .task { await load() }
        .sheet(item: $shown) { m in MeetingSheet(hub: hub, meeting: m, open: open) { Task { await load() } } }
        .sheet(isPresented: $adding) { NewMeetingSheet(hub: hub) { Task { await load() } } }
    }

    @ViewBuilder private func section(_ title: String, _ items: [Meeting], _ now: Int64) -> some View {
        if !items.isEmpty {
            CardSection(title: title) {
                ForEach(items) { m in
                    Button { shown = m } label: { row(m, now).contentShape(Rectangle()) }.buttonStyle(QuietPress(radius: 0))
                }
            }
        }
    }

    private func row(_ m: Meeting, _ now: Int64) -> some View {
        let zone = MeetingWords.zone(m)
        let st = MeetingWords.status(m, now: now)
        let meta = [m.scheduledAt.map { MeetingWords.when($0, durationMin: m.durationMin, zone: zone) }, m.cwd.isEmpty ? nil : MeetingWords.folderName(m.cwd)]
            .compactMap { $0 }.joined(separator: " · ")
        return HStack(alignment: .firstTextBaseline, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(m.title.isEmpty ? "Meeting" : m.title).font(.sans(14, .medium)).foregroundStyle(Tone.fg).lineLimit(2)
                // wraps: on a phone one line cut the folder ("fse-pa...")
                if !meta.isEmpty { Text(meta).font(.sans(12)).foregroundStyle(Tone.fg3).lineLimit(2).fixedSize(horizontal: false, vertical: true) }
                if m.status == "scheduled" || m.status == "ready" {
                    let p = MeetingWords.prep(m)
                    Text(p.0).font(.sans(12)).foregroundStyle(meetingTone(p.1))
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 3) {
                Text(st.0).font(.sans(12.5, .medium)).foregroundStyle(meetingTone(st.1))
                if let at = m.scheduledAt, m.status == "scheduled" || m.status == "ready" {
                    Text(MeetingWords.countdown(at - now, start: at, zone: MeetingWords.zone(m))).font(.sans(12)).foregroundStyle(Tone.fg3)
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    private func load() async {
        do {
            list = try await hub.client.meetings()
            error = nil
        } catch {
            if error is CancellationError { return }
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }
}

func meetingTone(_ t: String) -> Color {
    switch t {
    case "ok": Tone.ok
    case "warn": Tone.warn
    case "fault": Tone.fault
    case "live": Tone.signal
    case "dim": Tone.fg3
    default: Tone.fg2
    }
}

/// One meeting: what it is for, and its notes once it ended.
private struct MeetingSheet: View {
    let hub: HubModel
    @State var meeting: Meeting
    let open: (String) -> Void
    let changed: () -> Void
    @State private var notes: String?
    @State private var line: String?
    @State private var deleting = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    let now = Int64(Date().timeIntervalSince1970 * 1000)
                    let st = MeetingWords.status(meeting, now: now)
                    Text(st.0).font(.sans(13, .medium)).foregroundStyle(meetingTone(st.1))
                    if let at = meeting.scheduledAt {
                        Text(MeetingWords.when(at, durationMin: meeting.durationMin, zone: MeetingWords.zone(meeting))).font(.sans(14)).foregroundStyle(Tone.fg2)
                    }
                    if let a = meeting.agenda, !a.isEmpty { Text(a).font(.sans(14)).foregroundStyle(Tone.fg) }
                    if let e = meeting.error { Text(e).font(.sans(13)).foregroundStyle(Tone.fault) }
                    if let line { Text(line).font(.sans(12.5)).foregroundStyle(Tone.fg2) }
                    if meeting.status == "ended" {
                        HStack(spacing: 8) {
                            Button(meeting.memoryId == nil ? "Save to memory" : "Saved to memory") { Task { await save() } }
                                .buttonStyle(CVButton(look: .outline, height: 34)).disabled(meeting.memoryId != nil)
                            Button("Open as chat") { Task { await asChat() } }.buttonStyle(CVButton(look: .outline, height: 34))
                        }
                        if let notes { MarkdownView(blocks: MarkdownBlocks.parse(notes)) } else { LoadingLine() }
                    } else if meeting.status == "scheduled" || meeting.status == "ready" {
                        Text("Start it on a computer: the hub listens there and answers while it runs.").font(.sans(13)).foregroundStyle(Tone.fg3)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
            }
            .background(Tone.bg)
            .navigationTitle(meeting.title.isEmpty ? "Meeting" : meeting.title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .destructiveAction) { Button("Delete", role: .destructive) { deleting = true } }
            }
            .alert("Delete \(meeting.title)?", isPresented: $deleting) {
                Button("Delete", role: .destructive) { Task { await delete() } }
                Button("Cancel", role: .cancel) {}
            } message: { Text("Its prep, transcript and notes go too.") }
        }
        .task { if meeting.status == "ended" { notes = (try? await hub.client.meetingNotes(meeting.id)) ?? "No notes were written." } }
    }

    private func save() async {
        do { meeting = try await hub.client.saveMeetingToMemory(meeting.id); line = "Saved to memory."; changed() } catch { line = "Could not save. " + error.localizedDescription }
    }

    private func asChat() async {
        do { let s = try await hub.client.meetingToChat(meeting.id); dismiss(); open(s.id) } catch { line = "Could not open it. " + error.localizedDescription }
    }

    private func delete() async {
        do { try await hub.client.deleteMeeting(meeting.id); changed(); dismiss() } catch { line = "Could not delete. " + error.localizedDescription }
    }
}

/// New meeting: a title, what it is for, and when; without a time the hub prepares it now.
private struct NewMeetingSheet: View {
    let hub: HubModel
    let created: () -> Void
    @State private var title = ""
    @State private var agenda = ""
    @State private var scheduled = true
    @State private var at = Date().addingTimeInterval(3600)
    @State private var minutes = 30
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                TextField("Title", text: $title)
                TextField("What it's for", text: $agenda, axis: .vertical).lineLimit(2...5)
                Toggle("At a set time", isOn: $scheduled).tint(Tone.signal)
                if scheduled {
                    DatePicker("Starts", selection: $at, in: Date()...)
                    Stepper("\(minutes) minutes", value: $minutes, in: 15...240, step: 15)
                }
                if let error { Text(error).foregroundStyle(Tone.fault) }
            }
            .navigationTitle("New meeting").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(scheduled ? "Schedule" : "Prepare now") { Task { await create() } }
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    private func create() async {
        do {
            _ = try await hub.client.createMeeting(title: title.trimmingCharacters(in: .whitespaces), agenda: agenda, device: nil, cwd: nil,
                                                   scheduledAt: scheduled ? Int64(at.timeIntervalSince1970 * 1000) : nil, durationMin: scheduled ? minutes : nil)
            created()
            dismiss()
        } catch {
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }
}
