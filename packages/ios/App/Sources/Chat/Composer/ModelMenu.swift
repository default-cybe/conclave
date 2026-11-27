import ConclaveKit
import SwiftUI

/// The composer's model chip, as the web's ModelPick: the maker's logo, the model's name and its effort
/// in 13 pt fg-2, a small chevron. It opens makers as submenus (ModelPicks), each with its logo, then
/// the model's effort levels. A pick is the chat's default from now on.
struct ModelMenu: View {
    let hub: HubModel
    let session: Session
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        let groups = ModelPicks.groups(hub.models)
        let current = ModelPicks.shownRow(groups, hub.models, session.model.isEmpty ? nil : session.model)
        let row = groups.lazy.flatMap(\.rows).first { $0.ref == current }
        let effort = row?.model.effort
        let level = session.chat?.thinking
        let phone = sizeClass == .compact
        Menu {
            if hub.models.isEmpty { Text("Loading models") }
            ForEach(groups, id: \.key) { g in
                Menu {
                    ForEach(g.rows, id: \.ref) { r in
                        Button {
                            Task { await hub.update(session.id, SessionPatch(model: r.ref)) }
                        } label: {
                            if r.ref == current { Label(r.label, systemImage: "checkmark") } else { Text(r.label) }
                            if let via = r.via { Text(via) }
                        }
                        .disabled(r.model.unavailable != nil)
                    }
                } label: {
                    Label { Text(g.name); Text(ModelPicks.note(g, current)) } icon: { MakerLogo(key: g.key) }
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
            HStack(spacing: 6) {
                if let row { MakerLogo(key: row.harness ? ModelPicks.agents : (ModelPicks.makerOf(row.model) ?? "")).frame(width: 14, height: 14) }
                Text(Effort.words(session.model.isEmpty ? nil : session.model, level, effort)).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Tone.fg4)
            }
            .font(.sans(phone ? 14 : 13))
            .foregroundStyle(Tone.fg2)
            .padding(.horizontal, 8)
            .frame(height: phone ? 44 : 28)
            .contentShape(Rectangle())
        }
        .menuOrder(.fixed)
        .accessibilityLabel("Model")
        .task { await hub.loadModels() }
    }
}

/// A maker's mark from @lobehub/icons (MIT, the web's components/logo), in the text's color; a
/// neutral glyph when there is none.
struct MakerLogo: View {
    let key: String

    private static let assets: [String: String] = [
        "anthropic": "logo-claude", "openai": "logo-openai", "google": "logo-gemini", "zai": "logo-zai",
        "deepseek": "logo-deepseek", "qwen": "logo-qwen", "moonshot": "logo-kimi", "mistral": "logo-mistral",
        "xai": "logo-grok", "meta": "logo-meta", "ollama": "logo-ollama", "openrouter": "logo-openrouter",
    ]

    var body: some View {
        if let name = Self.assets[key] {
            Image(name).renderingMode(.template).resizable().scaledToFit()
        } else {
            Image(systemName: key == ModelPicks.agents ? "terminal" : "cube").resizable().scaledToFit()
        }
    }
}
