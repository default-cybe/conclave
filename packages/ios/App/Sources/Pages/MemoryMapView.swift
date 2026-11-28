import ConclaveKit
import SwiftUI

/// Memory > Map (Android MemoryMapScreen's Rings, web /memory/map): every memory item on one circle,
/// grouped by kind, with its links drawn through the middle. A tap on an item opens what it is and
/// what it links to. Owner only: a member gets the hub's 403 as a line. Tree and 3D stay on the web.
struct MemoryMapView: View {
    let hub: HubModel
    let back: () -> Void
    @State private var graph: MemoryGraph?
    @State private var error: String?
    @State private var picked: Int?

    var body: some View {
        Page(title: "Memory map", sub: graph.map { "\($0.nodes.count) items, \($0.links.count) links" }) {
            Button(action: back) { Label("Memory", systemImage: "chevron.left") }.buttonStyle(CVButton(look: .quiet, height: 32))
        } content: {
            if let error { ErrorBox(message: error) { Task { await load() } } }
            if let g = graph {
                if g.nodes.isEmpty { EmptyLine(text: "No memory yet. Items show here once sessions save what they learn.") }
                else { rings(g) }
                if let i = picked, g.nodes.indices.contains(i) { detail(g, i) }
                legend(g)
            } else if error == nil {
                LoadingLine()
            }
        }
        .task { await load() }
    }

    private func rings(_ g: MemoryGraph) -> some View {
        let angles = g.ringAngles()
        return GeometryReader { geo in
            let side = min(geo.size.width, geo.size.height)
            let c = CGPoint(x: geo.size.width / 2, y: geo.size.height / 2)
            let r = side / 2 - 18
            let at = { (i: Int) in CGPoint(x: c.x + r * cos(angles[i]), y: c.y + r * sin(angles[i])) }
            ZStack {
                // links bend through the middle, so a busy map still reads
                Canvas { ctx, _ in
                    for (a, b) in g.links {
                        var p = Path()
                        p.move(to: at(a))
                        p.addQuadCurve(to: at(b), control: c)
                        let lit = picked == a || picked == b
                        ctx.stroke(p, with: .color(lit ? Tone.signal : Tone.fg4.opacity(0.35)), lineWidth: lit ? 1.4 : 0.6)
                    }
                }
                ForEach(g.nodes.indices, id: \.self) { i in
                    let n = g.nodes[i]
                    Circle().fill(kindColor(n.kind)).frame(width: dotSize(n), height: dotSize(n))
                        .overlay { if picked == i { Circle().stroke(Tone.fg, lineWidth: 2).frame(width: dotSize(n) + 6, height: dotSize(n) + 6) } }
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                        .position(at(i))
                        .onTapGesture { picked = picked == i ? nil : i }
                        .accessibilityLabel(n.title.isEmpty ? n.kind : n.title)
                        .accessibilityAddTraits(.isButton)
                }
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .frame(maxWidth: 640)
        .frame(maxWidth: .infinity)
        .panel(Tone.raise, radius: Radius.r3, border: Tone.rule)
    }

    private func detail(_ g: MemoryGraph, _ i: Int) -> some View {
        let n = g.nodes[i]
        let links = g.neighbours(i)
        return CardSection(title: n.kind.capitalized, note: links.isEmpty ? "No links." : nil) {
            CardRow(label: n.title.isEmpty ? "Untitled" : n.title, detail: n.area.isEmpty ? nil : n.area) { EmptyView() }
            ForEach(Array(links.prefix(12).enumerated()), id: \.offset) { _, l in
                Button { picked = g.nodes.firstIndex(of: l.0) } label: {
                    CardRow(label: l.0.title.isEmpty ? l.0.kind : l.0.title, detail: l.1.isEmpty ? l.0.kind : "\(l.1) · \(l.0.kind)") {
                        Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Tone.fg3)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(QuietPress(radius: 0))
            }
        }
    }

    private func legend(_ g: MemoryGraph) -> some View {
        let kinds = Array(Set(g.nodes.map(\.kind))).sorted()
        return HStack(spacing: 14) {
            ForEach(kinds, id: \.self) { k in
                HStack(spacing: 5) {
                    Circle().fill(kindColor(k)).frame(width: 8, height: 8)
                    Text("\(k) \(g.nodes.filter { $0.kind == k }.count)").font(.sans(12)).foregroundStyle(Tone.fg3)
                }
            }
        }
    }

    private func dotSize(_ n: MemoryGraphNode) -> CGFloat { min(6 + CGFloat(n.degree) * 1.5, 16) }

    private func kindColor(_ kind: String) -> Color {
        switch kind {
        case "fact": Tone.signal
        case "profile": Tone.ok
        case "procedure": Tone.warn
        case "episode": Tone.fault
        case "session": Tone.fg2
        default: Tone.fg4
        }
    }

    private func load() async {
        do {
            graph = try await hub.client.memoryGraph()
            error = nil
        } catch let e as ConclaveAPIError where e.status == 403 {
            error = "The memory map is the hub owner's."
        } catch {
            if error is CancellationError { return }
            self.error = (error as? ConclaveAPIError)?.message ?? error.localizedDescription
        }
    }
}
