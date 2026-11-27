import ConclaveKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Under the transcript: what waits in the queue, the files, the text, the model, and Send or Stop.
struct ComposerView: View {
    @Bindable var chat: ChatModel
    let hub: HubModel
    @State private var photos: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var showCamera = false
    @State private var dropping = false
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduce

    private var session: Session? { hub.session(chat.sessionId) }

    var body: some View {
        let busy = chat.busy(session)
        // Stop while it runs and the box is empty, as Android; with words in it, Send queues them
        let stops = busy && !chat.canSend && chat.outgoing == nil
        VStack(alignment: .leading, spacing: 8) {
            QueueRows(chat: chat)
            if let lost = chat.lostFile {
                HStack {
                    Text(lost).font(.sans(12.5)).foregroundStyle(Tone.warn)
                    Button("Send without it") { Task { await chat.send(busy: busy, dropLost: true) } }.buttonStyle(CVButton(look: .quiet, height: 26, size: 12.5))
                }
            } else if let e = chat.sendError {
                Text(e).font(.sans(12.5)).foregroundStyle(Tone.fault)
            }
            let phone = Metrics(sizeClass).compact
            // web desktop: radius 5, rule-2 line, sunk; phone (PhoneBox, Android): radius 24 on surface-2, a line only in light
            let radius = phone ? Radius.box : Radius.r2
            let line = dropping ? Tone.signal : phone ? (scheme == .light ? Tone.rule : Color.clear) : Tone.rule2
            VStack(alignment: .leading, spacing: 0) {
                if !chat.files.isEmpty { FileChips(files: $chat.files).padding(.horizontal, 12).padding(.top, 12) }
                ComposerField(
                    text: $chat.draft,
                    placeholder: busy ? "Reply, it will be sent when this one finishes" : "Reply",
                    onSend: { Task { await chat.send(busy: busy) } },
                    onPasteImages: { add($0.compactMap { $0.jpegData(compressionQuality: 1).flatMap { Attachments.image($0, name: "pasted.jpg") } }) }
                )
                .padding(.horizontal, phone ? 16 : 14)
                .padding(.top, 12)
                .padding(.bottom, 4)
                HStack(spacing: 4) {
                    attachMenu(phone)
                    if phone, let session { ModelMenu(hub: hub, session: session) }
                    Spacer()
                    SendStop(stops: stops, ready: chat.canSend, phone: phone) {
                        Task { if stops { await chat.stop() } else { await chat.send(busy: busy) } }
                    }
                }
                .padding(.horizontal, phone ? 6 : 8)
                .padding(.bottom, phone ? 6 : 8)
            }
            .background(phone ? Tone.surface2 : Tone.sunk, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(line, lineWidth: dropping ? 2 : 1))
            .animation(Motion.of(Motion.ease(Motion.dur1), reduce: reduce), value: dropping)
            // the web's quiet row under the box: the model and its effort, at the right
            if !phone, let session {
                HStack { Spacer(); ModelMenu(hub: hub, session: session) }.padding(.horizontal, 2)
            }
        }
        .onDrop(of: [.item], isTargeted: $dropping) { providers in
            Task {
                for p in providers { if let a = await Attachments.load(p) { add([a]) } }
            }
            return true
        }
        .photosPicker(isPresented: $showPhotos, selection: $photos, matching: .images)
        .onChange(of: photos) { _, items in
            guard !items.isEmpty else { return }
            photos = []
            Task {
                for i in items {
                    if let d = try? await i.loadTransferable(type: Data.self) { add([Attachments.image(d, name: nil)].compactMap { $0 }) }
                }
            }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { r in
            if case .success(let urls) = r { add(urls.compactMap(Attachments.file(at:))) }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { add([$0.jpegData(compressionQuality: 1).flatMap { Attachments.image($0, name: "photo.jpg") }].compactMap { $0 }) }
                .ignoresSafeArea()
        }
    }

    /// The web's PlusMenu: a round + that opens photos, camera and files.
    private func attachMenu(_ phone: Bool) -> some View {
        Menu {
            Button { showPhotos = true } label: { Label("Photos", systemImage: "photo.on.rectangle") }
            if CameraPicker.available {
                Button { showCamera = true } label: { Label("Camera", systemImage: "camera") }
            }
            Button { showFiles = true } label: { Label("Files", systemImage: "folder") }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: phone ? 20 : 16, weight: .regular))
                .foregroundStyle(Tone.fg2)
                .frame(width: phone ? 44 : 30, height: phone ? 44 : 30)
                .contentShape(Circle())
        }
        .accessibilityLabel("Add photos or files")
    }

    /// Files join while the message stays under what the hub reads in one request.
    private func add(_ new: [Attachment]) {
        for a in new {
            if let why = Attach.refusal(chat.files, a) { chat.sendError = why; return }
            chat.files.append(a)
        }
    }
}

/// Send, and Stop while a reply runs with the box empty: the web's SendStopButton. iPad: a 30 pt
/// square, radius 3, ink when there is something to send, a hover fill when not. Phone: Android's
/// 36 pt circle, signal when ready, an fg-4 ring when empty. The arrow turns into the square in place.
private struct SendStop: View {
    let stops: Bool
    let ready: Bool
    let phone: Bool
    let action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduce

    var body: some View {
        let solid = stops || ready
        let face: CGFloat = phone ? 36 : 30
        let shape = RoundedRectangle(cornerRadius: phone ? face / 2 : Radius.r1, style: .continuous)
        let fill = phone ? Tone.signal : Tone.solid
        Button(action: action) {
            Image(systemName: stops ? "stop.fill" : "arrow.up")
                .font(.system(size: stops ? (phone ? 13 : 11) : (phone ? 17 : 15), weight: .semibold))
                .contentTransition(.symbolEffect(.replace))
                .foregroundStyle(solid ? Tone.bg : Tone.fg4)
                .frame(width: face, height: face)
                .background(solid ? fill : (phone ? .clear : Tone.hover), in: shape)
                .overlay(shape.strokeBorder(solid ? .clear : (phone ? Tone.fg4 : Tone.rule), lineWidth: phone ? 1.5 : 1))
                .frame(width: phone ? 48 : 30, height: phone ? 48 : 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!solid)
        .keyboardShortcut(stops ? "." : .return, modifiers: .command)
        .accessibilityLabel(stops ? "Stop" : "Send")
        .animation(Motion.of(Motion.ease(Motion.dur1), reduce: reduce), value: solid)
        .animation(Motion.of(.spring(response: 0.28, dampingFraction: 0.8), reduce: reduce), value: stops)
    }
}

/// The files in the composer (the web's AttachmentStrip): pictures as 44 pt thumbnails, other files
/// as 40 pt chips with a hairline; each has a small round x at its corner.
private struct FileChips: View {
    @Binding var files: [Attachment]
    @Environment(\.accessibilityReduceMotion) private var reduce

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(Array(files.enumerated()), id: \.offset) { i, f in
                    Group {
                        if let img = Attachments.thumbnail(f, side: 88) {
                            Image(uiImage: img).resizable().scaledToFill()
                                .frame(width: 44, height: 44)
                                .clipShape(RoundedRectangle(cornerRadius: Radius.r2, style: .continuous))
                                .hairline(radius: Radius.r2)
                        } else {
                            HStack(spacing: 8) {
                                Image(systemName: "doc").font(.system(size: 13)).foregroundStyle(Tone.fg3)
                                Text(f.name ?? "file").font(.sans(13)).foregroundStyle(Tone.fg2).lineLimit(1).frame(maxWidth: 180)
                            }
                            .padding(.horizontal, 12)
                            .frame(height: 40)
                            .hairline(radius: Radius.r2)
                        }
                    }
                    .overlay(alignment: .topTrailing) {
                        Button { withAnimation(Motion.of(Motion.ease(Motion.dur2), reduce: reduce)) { _ = files.remove(at: i) } } label: {
                            Image(systemName: "xmark").font(.system(size: 8, weight: .bold)).foregroundStyle(Tone.bg)
                                .frame(width: 18, height: 18).background(Tone.fg2, in: Circle())
                                .frame(width: 30, height: 30).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .offset(x: 10, y: -10)
                        .accessibilityLabel("Remove \(f.name ?? "file")")
                    }
                    .padding(.top, 6).padding(.trailing, 6)
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }
            }
        }
        .scrollIndicators(.hidden)
    }
}

/// Messages waiting while the session works: each says how it waits, and can be edited or taken off.
private struct QueueRows: View {
    let chat: ChatModel

    var body: some View {
        ForEach(chat.transcript.pending) { q in
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(q.text.isEmpty ? Attach.filesWord(q.attachments.count) : q.text).font(.sans(13.5)).foregroundStyle(Tone.fg).lineLimit(2)
                    Text(PendingQueue.pendingWord(q.whenBusy, held: q.held)).font(.sans(12)).foregroundStyle(Tone.fg3)
                }
                Spacer()
                Button("Edit") { Task { await chat.unqueue(q, edit: true) } }.buttonStyle(CVButton(look: .quiet, height: 26, size: 12.5))
                Button { Task { await chat.unqueue(q, edit: false) } } label: { Image(systemName: "xmark").font(.system(size: 11, weight: .medium)) }
                    .buttonStyle(CVButton(look: .quiet, height: 26, size: 12.5))
                    .accessibilityLabel("Remove from queue")
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .panel(Tone.raise, radius: Radius.r2, border: Tone.rule)
            .rise()
        }
    }
}
