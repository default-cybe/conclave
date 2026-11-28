import ConclaveKit
import SwiftUI

/// A repo session's bar over the composer (Android RepoRow and RepoActions, web RepoBar): where it
/// works, where the pull request stands, and the actions it offers now: Push, Open pull request,
/// View, Merge, Clean up and Discard, each confirming first. Only a repo session shows it.
struct RepoBar: View {
    let hub: HubModel
    let sessionId: String
    let title: String
    @State private var repo: RepoSession?
    @State private var busy: String?
    @State private var line: String?
    @State private var pushing = false
    @State private var message = ""
    @State private var draft: PrDraft?
    @State private var cleaning = false
    @State private var discarding = false
    @State private var merging = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        Group {
            if let r = repo {
                let a = RepoWords.actions(r)
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Image(systemName: "arrow.triangle.branch").font(.system(size: 12)).foregroundStyle(Tone.fg3)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(RepoWords.whereLine(r)).font(.sans(13, .medium)).foregroundStyle(Tone.fg).lineLimit(1)
                        Text(line ?? r.line).font(.sans(12)).foregroundStyle(color(RepoWords.tone(r))).lineLimit(2)
                    }
                    Spacer(minLength: 6)
                    if let b = busy { Text(b).font(.sans(12)).foregroundStyle(Tone.fg3) }
                    if a.cleanUp { Button("Clean up") { cleaning = true }.buttonStyle(CVButton(look: .outline, height: 30)) }
                    else if a.openPr { Button("Open pull request") { Task { await openDraft() } }.buttonStyle(CVButton(look: .solid, height: 30)) }
                    else if a.push { Button("Push") { message = RepoWords.commitMessage(title); pushing = true }.buttonStyle(CVButton(look: .outline, height: 30)) }
                    Menu {
                        if a.viewPr, let u = r.pr.flatMap({ URL(string: $0.url) }) { Button("View pull request", systemImage: "safari") { openURL(u) } }
                        if a.push { Button("Push", systemImage: "arrow.up") { message = RepoWords.commitMessage(title); pushing = true } }
                        if a.openPr { Button("Open pull request", systemImage: "arrow.triangle.pull") { Task { await openDraft() } } }
                        if a.merge { Button("Merge into \(r.base)", systemImage: "arrow.triangle.merge") { merging = true } }
                        Button("Check now", systemImage: "arrow.clockwise") { Task { await load(refresh: true) } }
                        if a.cleanUp { Button("Clean up", systemImage: "trash") { cleaning = true } }
                        if a.discard { Button("Discard", systemImage: "xmark.bin", role: .destructive) { discarding = true } }
                    } label: { Image(systemName: "ellipsis").frame(width: 30, height: 30) }
                        .accessibilityLabel("Repository actions")
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .panel(Tone.raise, radius: Radius.r2, border: Tone.rule)
                .disabled(busy != nil)
            }
        }
        .task(id: sessionId) { await load(refresh: false) }
        .alert("Push \(repo.map { RepoWords.branchShort($0.branch) } ?? "")", isPresented: $pushing) {
            if (repo?.dirty ?? 0) > 0 { TextField("Commit message", text: $message) }
            Button("Push") { Task { await push() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text((repo?.dirty ?? 0) > 0 ? RepoWords.dirtyWords(repo?.dirty ?? 0) + " They go in one commit with this message." : "The branch goes to GitHub.")
        }
        .alert("Clean up?", isPresented: $cleaning) {
            Button("Clean up", role: .destructive) { Task { await run("Cleaning up") { try await hub.client.cleanUpRepo(sessionId, force: (repo?.dirty ?? 0) > 0 || !(repo?.canCleanUp ?? false), discard: false) } } }
            Button("Cancel", role: .cancel) {}
        } message: { Text(repo.map(RepoWords.cleanUpBody) ?? "") }
        .alert("Discard this worktree?", isPresented: $discarding) {
            Button("Discard", role: .destructive) { Task { await run("Discarding") { try await hub.client.cleanUpRepo(sessionId, force: true, discard: true) } } }
            Button("Cancel", role: .cancel) {}
        } message: { Text(repo.map(RepoWords.discardBody) ?? "") }
        .alert("Merge into \(repo?.base ?? "the base")?", isPresented: $merging) {
            Button("Merge") { Task { await run("Merging") { try await hub.client.mergeRepo(sessionId, squash: false) } } }
            Button("Squash and merge") { Task { await run("Merging") { try await hub.client.mergeRepo(sessionId, squash: true) } } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("The branch's commits go onto \(repo?.base ?? "the base") in the folder's repository.") }
        .sheet(item: Binding(get: { draft.map(DraftBox.init) }, set: { draft = $0?.draft })) { box in
            PrSheet(repo: repo?.repo ?? "", draft: box.draft) { t, b, d in Task { await run("Opening") { try await hub.client.openPullRequest(sessionId, title: t, body: b, draft: d) } } }
        }
    }

    private func color(_ tone: String) -> Color {
        switch tone {
        case "ok": Tone.ok
        case "fault": Tone.fault
        case "live": Tone.signal
        default: Tone.fg3
        }
    }

    private func load(refresh: Bool) async {
        repo = (try? await hub.client.repoSession(sessionId, refresh: refresh)) ?? repo
    }

    private func openDraft() async {
        busy = "Drafting"
        defer { busy = nil }
        do { draft = try await hub.client.prDraft(sessionId) } catch { line = "Could not draft. " + ((error as? ConclaveAPIError)?.message ?? error.localizedDescription) }
    }

    private func push() async {
        busy = "Pushing"
        defer { busy = nil }
        do {
            let r = try await hub.client.pushRepo(sessionId, commitMessage: (repo?.dirty ?? 0) > 0 ? message : nil)
            line = r.line.isEmpty ? nil : r.line
            await load(refresh: false)
        } catch { line = "Push failed. " + ((error as? ConclaveAPIError)?.message ?? error.localizedDescription) }
    }

    private func run(_ word: String, _ op: () async throws -> RepoSession) async {
        busy = word
        defer { busy = nil }
        do {
            repo = try await op()
            line = nil
        } catch { line = "Failed. " + ((error as? ConclaveAPIError)?.message ?? error.localizedDescription) }
    }
}

private struct DraftBox: Identifiable {
    let id = UUID()
    let draft: PrDraft
}

/// Open pull request: the drafted title and body to edit, and Draft.
private struct PrSheet: View {
    let repo: String
    @State var draft: PrDraft
    let open: (String, String, Bool) -> Void
    @State private var asDraft = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 10) {
                Text("\(repo), \(RepoWords.branchShort(draft.head)) into \(draft.base).").font(.sans(13)).foregroundStyle(Tone.fg3)
                TextField("Title", text: $draft.title).font(.sans(15, .medium))
                    .padding(.horizontal, 12).frame(height: 40).panel(Tone.sunk, radius: Radius.r2, border: Tone.rule2)
                TextEditor(text: $draft.body).font(.sans(14)).scrollContentBackground(.hidden)
                    .padding(8).panel(Tone.sunk, radius: Radius.r2, border: Tone.rule2)
                Toggle("Open as a draft", isOn: $asDraft).tint(Tone.signal).font(.sans(14))
            }
            .padding(20)
            .background(Tone.bg)
            .navigationTitle("Open pull request").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Open") { open(draft.title, draft.body, asDraft); dismiss() }.disabled(draft.title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}
