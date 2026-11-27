import ConclaveKit
import SwiftUI

/// The composer's model chip, as the web's ModelPick: the maker's logo, the model's name and its effort
/// in 13 pt fg-2, a small chevron. It opens the picker: a popover on iPad, a sheet on a phone. A pick
/// is the chat's default from now on.
struct ModelMenu: View {
    let hub: HubModel
    let session: Session
    @State private var open = false
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        let groups = ModelPicks.groups(hub.models)
        let current = ModelPicks.shownRow(groups, hub.models, session.model.isEmpty ? nil : session.model)
        let row = groups.lazy.flatMap(\.rows).first { $0.ref == current }
        let phone = Metrics(sizeClass).compact
        Button { open = true } label: {
            HStack(spacing: 6) {
                if let row { MakerLogo(key: row.harness ? ModelPicks.agents : (ModelPicks.makerOf(row.model) ?? "")).frame(width: 14, height: 14) }
                Text(Effort.words(session.model.isEmpty ? nil : session.model, session.chat?.thinking, row?.model.effort)).lineLimit(1)
                Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Tone.fg4)
            }
            .font(.sans(phone ? 14 : 13))
            .foregroundStyle(Tone.fg2)
            .padding(.horizontal, 8)
            .frame(height: phone ? 44 : 30)
            .contentShape(Rectangle())
        }
        .buttonStyle(QuietPress(radius: Radius.r1))
        .accessibilityLabel("Model")
        .popover(isPresented: $open, arrowEdge: .bottom) {
            ModelPicker(hub: hub, session: session, groups: groups, current: current) { open = false }
                .frame(idealWidth: 340, idealHeight: 520)
                .presentationCompactAdaptation(.sheet)
                .presentationDetents([.medium, .large])
        }
        .task { await hub.loadModels() }
    }
}

/// The web's ModelPicker: effort on top as a row of choices, then each maker under its logo and
/// name, its models by family (Mythos, Fable, Opus, Sonnet, Haiku; GPT, mini and nano...), the
/// chosen one with a check. Rows 32 pt (44 on a phone), 13.5 pt, family headings 12 pt fg-3.
private struct ModelPicker: View {
    let hub: HubModel
    let session: Session
    let groups: [ModelPicks.Group]
    let current: String?
    let done: () -> Void
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduce

    var body: some View {
        let m = Metrics(sizeClass)
        let effort = groups.lazy.flatMap(\.rows).first { $0.ref == current }?.model.effort
        let choices = Effort.choices(effort)
        let level = effort.flatMap { Effort.shown(session.chat?.thinking, $0) }
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let effort, !choices.isEmpty {
                    Text("Effort").font(.sans(12, .medium)).foregroundStyle(Tone.fg3).padding(.horizontal, 12).padding(.bottom, 6)
                    HStack(spacing: 2) {
                        ForEach(choices, id: \.self) { l in
                            let on = l == level
                            Button {
                                Task { await hub.update(session.id, SessionPatch(chat: ChatSettingsPatch(thinking: l))) }
                            } label: {
                                Text(Effort.label(l, effort)).font(.sans(12.5, on ? .medium : .regular)).lineLimit(1).minimumScaleFactor(0.8)
                                    .foregroundStyle(on ? Tone.fg : Tone.fg3)
                                    .frame(maxWidth: .infinity).frame(height: m.compact ? 36 : 28)
                                    .background(on ? Tone.raise : .clear, in: RoundedRectangle(cornerRadius: Radius.r1, style: .continuous))
                                    .overlay(RoundedRectangle(cornerRadius: Radius.r1, style: .continuous).strokeBorder(on ? Tone.rule : .clear))
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(on ? .isSelected : [])
                        }
                    }
                    .padding(2)
                    .background(Tone.sunk, in: RoundedRectangle(cornerRadius: Radius.r2, style: .continuous))
                    .padding(.horizontal, 8)
                    .animation(Motion.of(Motion.ease(Motion.dur1), reduce: reduce), value: level)
                    Rectangle().fill(Tone.rule).frame(height: 1).padding(.vertical, 10)
                }
                if hub.models.isEmpty {
                    Text("Loading models").font(.sans(13)).foregroundStyle(Tone.fg3).padding(12)
                }
                ForEach(groups, id: \.key) { g in
                    HStack(spacing: 8) {
                        MakerLogo(key: g.key).frame(width: 14, height: 14).foregroundStyle(Tone.fg)
                        Text(g.name).font(.sans(13, .semibold)).foregroundStyle(Tone.fg)
                    }
                    .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 4)
                    .accessibilityAddTraits(.isHeader)
                    ForEach(ModelFamilies.split(g.rows), id: \.name) { f in
                        if !f.name.isEmpty, f.name != g.name {
                            Text(f.name).font(.sans(12)).foregroundStyle(Tone.fg3).padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 2)
                        }
                        ForEach(f.rows, id: \.ref) { r in row(r, m) }
                    }
                }
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 4)
        }
        .background(Tone.raise)
    }

    private func row(_ r: ModelPicks.Row, _ m: Metrics) -> some View {
        let on = r.ref == current
        return Button {
            Task { await hub.update(session.id, SessionPatch(model: r.ref)) }
            done()
        } label: {
            HStack(spacing: 8) {
                Text(r.label).font(.sans(m.compact ? 15 : 13.5)).foregroundStyle(r.model.unavailable == nil ? Tone.fg : Tone.fg4).lineLimit(1)
                if let via = r.via { Text(via).font(.sans(12)).foregroundStyle(Tone.fg3).lineLimit(1) }
                Spacer(minLength: 0)
                if on { Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Tone.fg) }
            }
            .padding(.horizontal, 12)
            .frame(height: m.compact ? 44 : 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(QuietPress(radius: Radius.r1, selected: on, selectedFill: Tone.hover))
        .disabled(r.model.unavailable != nil)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// A maker's mark from @lobehub/icons (MIT, the web's components/logo), in the text's color; a
/// neutral glyph when there is none.
struct MakerLogo: View {
    let key: String

    private static let assets: [String: String] = [
        "anthropic": "logo-claude", "openai": "logo-openai", "google": "logo-gemini", "gemini": "logo-gemini", "zai": "logo-zai",
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
