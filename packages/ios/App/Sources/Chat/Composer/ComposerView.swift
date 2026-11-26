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

    private var session: Session? { hub.session(chat.sessionId) }

    var body: some View {
        let busy = chat.busy(session)
        // Stop while it runs and the box is empty, as Android; with words in it, Send queues them
        let stops = busy && !chat.canSend && chat.outgoing == nil
        VStack(alignment: .leading, spacing: 8) {
            QueueRows(chat: chat)
            if let lost = chat.lostFile {
                HStack {
                    Text(lost).font(.footnote).foregroundStyle(Tone.warn)
                    Button("Send without it") { Task { await chat.send(busy: busy, dropLost: true) } }.font(.footnote)
                }
            } else if let e = chat.sendError {
                Text(e).font(.footnote).foregroundStyle(Tone.fault)
            }
            VStack(alignment: .leading, spacing: 6) {
                if !chat.files.isEmpty { FileChips(files: $chat.files) }
                ComposerField(
                    text: $chat.draft,
                    placeholder: busy ? "Reply, it will be sent when this one finishes" : "Reply",
                    onSend: { Task { await chat.send(busy: busy) } },
                    onPasteImages: { add($0.compactMap { $0.jpegData(compressionQuality: 1).flatMap { Attachments.image($0, name: "pasted.jpg") } }) }
                )
                HStack(spacing: 14) {
                    attachMenu
                    if let session { ModelMenu(hub: hub, session: session) }
                    Spacer()
                    if stops {
                        Button { Task { await chat.stop() } } label: { Image(systemName: "stop.circle.fill").font(.title2) }
                            .keyboardShortcut(".", modifiers: .command)
                            .accessibilityLabel("Stop")
                    } else {
                        Button { Task { await chat.send(busy: busy) } } label: { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                            .disabled(!chat.canSend)
                            .accessibilityLabel("Send")
                    }
                }
                .tint(Tone.signal)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Tone.raise, in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(dropping ? Tone.signal : Tone.rule, lineWidth: dropping ? 2 : 1))
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

    private var attachMenu: some View {
        Menu {
            Button { showPhotos = true } label: { Label("Photos", systemImage: "photo.on.rectangle") }
            if CameraPicker.available {
                Button { showCamera = true } label: { Label("Camera", systemImage: "camera") }
            }
            Button { showFiles = true } label: { Label("Files", systemImage: "folder") }
        } label: {
            Image(systemName: "paperclip").font(.body.weight(.medium)).foregroundStyle(Tone.fg2)
        }
        .accessibilityLabel("Attach")
    }

    /// Files join while the message stays under what the hub reads in one request.
    private func add(_ new: [Attachment]) {
        for a in new {
            if let why = Attach.refusal(chat.files, a) { chat.sendError = why; return }
            chat.files.append(a)
        }
    }
}

/// The files in the composer, each with its x.
private struct FileChips: View {
    @Binding var files: [Attachment]

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(Array(files.enumerated()), id: \.offset) { i, f in
                    HStack(spacing: 6) {
                        if let img = Attachments.thumbnail(f, side: 64) {
                            Image(uiImage: img).resizable().scaledToFill().frame(width: 32, height: 32).clipShape(RoundedRectangle(cornerRadius: 6))
                        } else {
                            Image(systemName: "doc").frame(width: 32, height: 32)
                        }
                        Text(f.name ?? "file").font(.footnote).lineLimit(1).frame(maxWidth: 140)
                        Button { files.remove(at: i) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Tone.fg3) }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove \(f.name ?? "file")")
                    }
                    .padding(6)
                    .background(Tone.sunk, in: RoundedRectangle(cornerRadius: 10))
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
                Image(systemName: "clock").foregroundStyle(Tone.fg3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(q.text.isEmpty ? Attach.filesWord(q.attachments.count) : q.text).lineLimit(2)
                    Text(PendingQueue.pendingWord(q.whenBusy, held: q.held)).font(.caption).foregroundStyle(Tone.fg3)
                }
                Spacer()
                Button("Edit") { Task { await chat.unqueue(q, edit: true) } }.font(.footnote)
                Button { Task { await chat.unqueue(q, edit: false) } } label: { Image(systemName: "xmark") }
                    .accessibilityLabel("Remove from queue")
            }
            .buttonStyle(.borderless)
            .padding(10)
            .background(Tone.sunk, in: RoundedRectangle(cornerRadius: 12))
        }
    }
}
