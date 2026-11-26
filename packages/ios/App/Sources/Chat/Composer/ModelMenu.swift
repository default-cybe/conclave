import ConclaveKit
import SwiftUI

/// The composer's model chip: makers as submenus (ModelPicks), then the model's effort levels.
/// A pick is the chat's default from now on.
struct ModelMenu: View {
    let hub: HubModel
    let session: Session

    var body: some View {
        let groups = ModelPicks.groups(hub.models)
        let current = ModelPicks.shownRow(groups, hub.models, session.model.isEmpty ? nil : session.model)
        let effort = groups.lazy.flatMap(\.rows).first { $0.ref == current }?.model.effort
        let level = session.chat?.thinking
        Menu {
            if hub.models.isEmpty { Text("Loading models") }
            ForEach(groups, id: \.key) { g in
                Menu(g.name) {
                    ForEach(g.rows, id: \.ref) { r in
                        Button {
                            Task { await hub.update(session.id, SessionPatch(model: r.ref)) }
                        } label: {
                            if r.ref == current { Label(r.label, systemImage: "checkmark") } else { Text(r.label) }
                            if let via = r.via { Text(via) }
                        }
                        .disabled(r.model.unavailable != nil)
                    }
                }
            }
            let choices = Effort.choices(effort)
            if let effort, !choices.isEmpty {
                Section("Effort") {
                    ForEach(choices, id: \.self) { l in
                        Button {
                            Task { await hub.update(session.id, SessionPatch(chat: ChatSettingsPatch(thinking: l))) }
                        } label: {
                            if l == Effort.shown(level, effort) { Label(Effort.label(l, effort), systemImage: "checkmark") } else { Text(Effort.label(l, effort)) }
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(Effort.words(session.model.isEmpty ? nil : session.model, level, effort)).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.caption2)
            }
            .font(.callout)
            .foregroundStyle(Tone.fg2)
        }
        .menuOrder(.fixed)
        .accessibilityLabel("Model")
        .task { await hub.loadModels() }
    }
}
