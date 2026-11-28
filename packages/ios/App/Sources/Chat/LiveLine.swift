import ConclaveKit
import SwiftUI

/// The live line under a session's last turn (Android SessionLiveLine): the knot, then the state in
/// words. Thinking (after 400 ms, with seconds), the running step ("Running bun test", "Reading
/// src/auth.ts"), Writing, Waiting on you, Resumes at a limit's reset, and "Done in 3m" once a turn
/// ran here. One height in every state.
struct LiveLine: View {
    let session: Session?
    let transcript: Transcript
    @State private var turnStart: Date?
    @State private var done: (Date, Date)?
    @State private var wasLive = false
    @Environment(\.accessibilityReduceMotion) private var reduce

    private var status: SessionStatus? { session?.status }
    private var live: Bool { status == .running }
    private var waiting: Bool { status == .waitingApproval || status == .waitingInput }

    var body: some View {
        TimelineView(.periodic(from: .now, by: live ? 0.25 : 1)) { ctx in
            HStack(spacing: 8) {
                KnotMark(size: 14)
                    // a soft breath while it works; still with Reduce Motion
                    .opacity(live && !reduce ? 0.55 + 0.45 * abs(sin(ctx.date.timeIntervalSince1970 * 1.6)) : live || waiting ? 1 : 0.55)
                words(now: ctx.date)
                    .font(.sans(13)).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .frame(minHeight: 28)
        }
        .onChange(of: live, initial: true) { _, now in
            if now && !wasLive { turnStart = Date(); done = nil }
            if !now && wasLive, let s = turnStart { done = (s, Date()); turnStart = nil }
            wasLive = now
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func words(now: Date) -> some View {
        if waiting {
            Text(status == .waitingInput ? "Waiting on your answer" : "Waiting on you").foregroundStyle(Tone.warn)
        } else if !live, let at = session?.resumeAt, at > Int64(now.timeIntervalSince1970 * 1000) {
            Text("Resumes at \(Date(timeIntervalSince1970: TimeInterval(at) / 1000).formatted(date: .omitted, time: .shortened))").foregroundStyle(Tone.fg3)
        } else if live {
            switch SessionLive.activity(transcript.messages, running: transcript.runningTools) {
            case .tool(let verb, let target, _):
                (Text(verb + " ").foregroundStyle(Tone.fg2) + Text(target ?? "").font(.mono(12.5)).foregroundStyle(Tone.fg))
            case .writing:
                Text("Writing").foregroundStyle(Tone.fg2)
            case .thinking:
                let secs = turnStart.map { now.timeIntervalSince($0) } ?? 0
                Text(secs < 1 ? "Thinking" : "Thinking \(SessionLive.duration(Int64(secs * 1000)))").foregroundStyle(Tone.fg2)
                    .opacity(secs < 0.4 ? 0 : 1)
            }
        } else if let (s, e) = done {
            Text("Done in \(SessionLive.duration(Int64(e.timeIntervalSince(s) * 1000)))").foregroundStyle(Tone.fg3)
        } else {
            Text(" ")
        }
    }
}
