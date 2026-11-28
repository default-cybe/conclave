import ConclaveKit
import SwiftUI

/// New Code or Security session (web FolderPicker, Android FolderPickerSheet): where it runs (the hub
/// first, then online computers), which folder (Recent from your sessions on that computer, a search
/// over them and the hub's projects, or Browse), and the agent. Start makes the session and hands its id back.
struct NewCodeSessionSheet: View {
    let hub: HubModel
    let mode: StartMode
    let created: (String) -> Void
    @State private var devices: [Device]?
    @State private var devicesError: String?
    @State private var device = "local"
    @State private var agent: String?
    /// Nil: no folder, the hub starts in the computer's home.
    @State private var cwd: String?
    @State private var query = ""
    @State private var projects: [Project] = []
    @State private var browsing = false
    @State private var starting = false
    @State private var startError: String?
    @Environment(\.dismiss) private var dismiss

    // shortcut: a fixed agent list, as no client call for GET /api/agents exists yet; custom agents come with it
    private static let agents = [(StartMode.codeAgent, "Coder"), (StartMode.securityAgent, "Security")]

    private var picked: String { agent ?? (mode == .security ? StartMode.securityAgent : StartMode.codeAgent) }

    var body: some View {
        let recent = FolderWords.recent(hub.sessions, projects: projects, device: device)
        let rows = FolderWords.choices(recent: recent, projects: projects, device: device, query: query)
        let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    Text("New session").font(.sans(18, .semibold)).foregroundStyle(Tone.fg)
                        .accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button("Cancel") { dismiss() }.buttonStyle(CVButton(look: .quiet))
                }
                deviceSection
                VStack(alignment: .leading, spacing: 8) {
                    Text("Agent").font(.sans(12.5, .semibold)).foregroundStyle(Tone.fg3).padding(.leading, 2)
                    Segmented(options: Self.agents, selection: Binding(get: { picked }, set: { agent = $0 }))
                }
                VStack(alignment: .leading, spacing: 10) {
                    searchField
                    CardSection(title: searching ? "Folders" : "Recent", note: rows.isEmpty ? (searching ? "No folder matches." : "No recent folders on this computer.") : nil) {
                        if !searching { folderRow(name: "No folder", detail: "Start in the computer's home folder", path: nil) }
                        ForEach(rows) { r in folderRow(name: r.name, detail: r.detail, path: r.path) }
                    }
                    Button("Browse…", systemImage: "folder") { browsing = true }
                        .buttonStyle(CVButton(look: .outline))
                        .accessibilityIdentifier("folder-browse")
                }
                VStack(alignment: .leading, spacing: 8) {
                    if let cwd { Text(cwd).font(.mono(12.5)).foregroundStyle(Tone.fg2).lineLimit(1).truncationMode(.head) }
                    if let startError { Text(startError).font(.sans(13)).foregroundStyle(Tone.fault).fixedSize(horizontal: false, vertical: true) }
                    Button(starting ? "Starting…" : "Start") { Task { await start() } }
                        .buttonStyle(CVButton(look: .solid, height: 40, full: true))
                        .disabled(starting)
                        .accessibilityIdentifier("new-session-start")
                }
            }
            .padding(24)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .background(Tone.bg.ignoresSafeArea())
        .task { await loadDevices() }
        .task { projects = (try? await hub.client.projects()) ?? [] }
        // a folder belongs to its computer
        .onChange(of: device) { cwd = nil }
        .sheet(isPresented: $browsing) {
            FolderBrowser(client: hub.client, device: device, start: cwd) { cwd = $0 }
        }
        .accessibilityIdentifier("new-session-sheet")
    }

    @ViewBuilder private var deviceSection: some View {
        if let devices {
            CardSection(title: "Computer") {
                ForEach(FolderWords.computers(devices)) { d in
                    Button { device = d.id } label: {
                        HStack(spacing: 12) {
                            Image(systemName: d.id == "local" ? "server.rack" : d.info?.platform == "darwin" ? "laptopcomputer" : "desktopcomputer")
                                .font(.system(size: 15)).foregroundStyle(Tone.fg3).frame(width: 22)
                            Text(FolderWords.placeName(d)).font(.sans(14)).foregroundStyle(Tone.fg).lineLimit(1)
                            Spacer(minLength: 8)
                            if d.id == device { Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Tone.signal) }
                        }
                        .padding(.horizontal, 14)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    }
                    .buttonStyle(QuietPress(radius: 0))
                    .accessibilityAddTraits(d.id == device ? .isSelected : [])
                }
            }
        } else if let devicesError {
            ErrorBox(message: devicesError) { Task { await loadDevices() } }
        } else {
            LoadingLine(text: "Reading your computers")
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").font(.system(size: 13)).foregroundStyle(Tone.fg3)
            TextField("Search folders", text: $query)
                .font(.sans(14)).foregroundStyle(Tone.fg)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .accessibilityIdentifier("folder-search")
        }
        .padding(.horizontal, 12)
        .frame(height: 38)
        .panel(Tone.raise, radius: Radius.r3, border: Tone.rule2)
    }

    private func folderRow(name: String, detail: String?, path: String?) -> some View {
        Button { cwd = path } label: {
            HStack(spacing: 12) {
                Image(systemName: path == nil ? "house" : "folder").font(.system(size: 14)).foregroundStyle(Tone.fg3).frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(.sans(14)).foregroundStyle(Tone.fg).lineLimit(1)
                    if let detail { Text(detail).font(path == nil ? .sans(12) : .mono(11.5)).foregroundStyle(Tone.fg3).lineLimit(1).truncationMode(.head) }
                }
                Spacer(minLength: 8)
                if cwd == path { Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Tone.signal) }
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }
        .buttonStyle(QuietPress(radius: 0))
        .accessibilityAddTraits(cwd == path ? .isSelected : [])
    }

    private func loadDevices() async {
        do {
            devices = try await hub.client.devices()
            devicesError = nil
        } catch {
            devicesError = error.localizedDescription
        }
    }

    private func start() async {
        starting = true
        startError = nil
        do {
            let s = try await hub.client.createSession(CreateSessionInput(agent: picked, cwd: cwd, device: device))
            created(s.id)
            dismiss()
        } catch {
            startError = error.localizedDescription
        }
        starting = false
    }
}

/// Browse a computer's folders (web FolderBrowser): starts at the chosen folder or the computer's
/// home, a breadcrumb and Up to climb, folders only (dot folders on request), Use this folder.
struct FolderBrowser: View {
    let client: ConclaveClient
    let device: String
    let start: String?
    let choose: (String) -> Void
    /// Nil until the start is known: the device does not expand "~", so the hub resolves it first.
    @State private var path: String?
    @State private var entries: [FileEntry]?
    @State private var error: String?
    @State private var hidden = false
    @State private var tick = 0
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Choose a folder").font(.sans(18, .semibold)).foregroundStyle(Tone.fg)
                        .accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button("Cancel") { dismiss() }.buttonStyle(CVButton(look: .quiet))
                }
                if let path { crumbBar(path) }
                if let error {
                    ErrorBox(message: error) { tick += 1 }
                } else if let entries {
                    let shown = FolderWords.folders(entries, hidden: hidden)
                    if shown.isEmpty {
                        EmptyLine(text: "No folders in here.")
                    } else {
                        CardSection(title: "Folders") {
                            ForEach(shown) { e in
                                Button { path = e.path.isEmpty ? FolderWords.join(path ?? "/", e.name) : e.path } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: "folder").font(.system(size: 14)).foregroundStyle(Tone.fg3).frame(width: 22)
                                        Text(e.name).font(.mono(13)).foregroundStyle(Tone.fg).lineLimit(1)
                                        Spacer(minLength: 8)
                                        Image(systemName: "chevron.right").font(.system(size: 12)).foregroundStyle(Tone.fg4)
                                    }
                                    .padding(.horizontal, 14)
                                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                }
                                .buttonStyle(QuietPress(radius: 0))
                            }
                        }
                    }
                } else {
                    LoadingLine(text: "Reading the folder")
                }
                Button(hidden ? "Hide dot folders" : "Show hidden") { hidden.toggle() }
                    .buttonStyle(CVButton(look: .quiet))
                Button("Use this folder") {
                    if let path { choose(path) }
                    dismiss()
                }
                .buttonStyle(CVButton(look: .solid, height: 40, full: true))
                .disabled(path == nil)
                .accessibilityIdentifier("folder-use")
            }
            .padding(24)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .background(Tone.bg.ignoresSafeArea())
        .task(id: "\(path ?? "")\n\(tick)") { await load() }
    }

    private func crumbBar(_ path: String) -> some View {
        let crumbs = FolderWords.crumbs(path)
        return HStack(spacing: 8) {
            Button { if let up = FolderWords.parent(path) { self.path = up } } label: {
                Image(systemName: "arrow.up").font(.system(size: 13, weight: .medium)).frame(width: 30, height: 30)
            }
            .buttonStyle(CVButton(look: .outline))
            .disabled(FolderWords.parent(path) == nil)
            .accessibilityLabel("Up one folder")
            ScrollView(.horizontal) {
                HStack(spacing: 2) {
                    ForEach(Array(crumbs.enumerated()), id: \.offset) { i, c in
                        if i > 0 && crumbs[i - 1].name != "/" { Image(systemName: "chevron.right").font(.system(size: 10)).foregroundStyle(Tone.fg4) }
                        Button(c.name) { self.path = c.path }
                            .font(.mono(12.5))
                            .foregroundStyle(c.path == path ? Tone.fg : Tone.fg3)
                            .buttonStyle(.plain)
                            .padding(.horizontal, 4).frame(minHeight: 30)
                    }
                }
            }
            .scrollIndicators(.hidden)
            .defaultScrollAnchor(.trailing)
        }
    }

    private func load() async {
        error = nil
        entries = nil
        do {
            guard let path else {
                let s = start ?? "~"
                // an absolute start is used as is; "~" or a home-relative one goes through the hub
                if s.hasPrefix("/") || s.range(of: #"^[A-Za-z]:[\\/]"#, options: .regularExpression) != nil {
                    path = s
                } else {
                    let home = try await client.folderCheck(device: device, path: s).path
                    if !Task.isCancelled { path = home }
                }
                return
            }
            let list = try await client.browse(device: device, path: path)
            if !Task.isCancelled { entries = list }
        } catch is CancellationError {
        } catch {
            if (error as? URLError)?.code == .cancelled || Task.isCancelled { return }
            self.error = error.localizedDescription
        }
    }
}
