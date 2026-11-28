import AVKit
import ConclaveKit
import Photos
import SwiftUI
import UIKit

/// The pictures a viewer swipes through and the one it opens on.
struct MediaSet: Identifiable {
    let id = UUID()
    let items: [MediaBlock]
    let index: Int
}

/// Opens the viewer for a tapped picture with the gallery of the screen around it (the chat's
/// pictures, or the Files pane's). The screen owns one and puts it in the environment.
@MainActor @Observable
final class MediaPresenter {
    var set: MediaSet?
    @ObservationIgnored var gallery: () -> [MediaBlock] = { [] }

    func open(_ m: MediaBlock) {
        let g = gallery()
        set = MediaSet(items: g.contains(m) ? g : [m], index: g.firstIndex(of: m) ?? 0)
    }
}

extension EnvironmentValues {
    @Entry var media: MediaPresenter? = nil
}

extension View {
    /// The viewer over this screen, full screen, for pictures tapped inside it.
    func mediaViewer(_ p: MediaPresenter, client: ConclaveClient) -> some View {
        @Bindable var p = p
        return environment(\.media, p).fullScreenCover(item: $p.set) { MediaViewer(set: $0, client: client) }
    }
}

/// Bytes of a picture or file the transcript or the Files pane names: inline base64, a trimmed
/// block (conclave-block:), or a tool's file (conclave-file:session/toolUseId[/image]).
enum MediaBytes {
    static let fileScheme = "conclave-file:"

    static func fileURL(session: String, toolUseId: String, image: Int?) -> String {
        fileScheme + ([session, toolUseId] + (image.map { [String($0)] } ?? [])).joined(separator: "/")
    }

    static func load(_ media: MediaBlock, _ client: ConclaveClient) async -> Data? {
        if let b64 = media.data { return Data(base64Encoded: b64, options: .ignoreUnknownCharacters) }
        if let ref = BlockRef.of(media.url) {
            guard let b64 = try? await client.blockData(ref) else { return nil }
            return Data(base64Encoded: b64, options: .ignoreUnknownCharacters)
        }
        if let url = media.url, url.hasPrefix(fileScheme) {
            let p = url.dropFirst(fileScheme.count).split(separator: "/").map(String.init)
            guard p.count >= 2 else { return nil }
            return try? await client.fileData(p[0], toolUseId: p[1], image: p.count > 2 ? Int(p[2]) : nil)
        }
        return nil
    }

    /// The bytes as a file Quick Look and the share sheet can read, in the caches folder the system may empty.
    static func file(_ data: Data, name: String, mediaType: String) -> URL? {
        var n = FileWords.safeName(name)
        if !n.contains("."), let ext = mediaType.split(separator: "/").last { n += ".\(ext.split(separator: "+").first ?? ext)" }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("files/\(abs(data.hashValue))", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(n)
        return (try? data.write(to: url)) != nil ? url : nil
    }
}

/// Full screen pictures, as Android's MediaViewer and the web's ImageViewer: black ground, swipe
/// between the chat's pictures, pinch or double tap to zoom; the bar on top has close, "2 of 5",
/// a small download icon (save to Photos) and share. A tap on the picture hides the bar. A video
/// (video/*) plays with the system's controls under the bar, as Android's VideoPage.
struct MediaViewer: View {
    let set: MediaSet
    let client: ConclaveClient
    @State private var index: Int
    @State private var chrome = true
    @State private var images: [Int: UIImage] = [:]
    /// Videos, as files in the caches folder (AVPlayer plays a file, not bytes) and their players.
    @State private var videos: [Int: URL] = [:]
    @State private var players: [Int: AVPlayer] = [:]
    @State private var failed: Set<Int> = []
    @State private var note: String?
    @State private var shareItem: URL?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduce

    init(set: MediaSet, client: ConclaveClient) {
        self.set = set
        self.client = client
        _index = State(initialValue: set.index)
    }

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.ignoresSafeArea()
            TabView(selection: $index) {
                ForEach(Array(set.items.enumerated()), id: \.offset) { i, m in
                    Group {
                        if let player = players[i] {
                            VideoPlayer(player: player).padding(.top, 56)
                        } else if let img = images[i] {
                            ZoomableImage(image: img) { withAnimation(Motion.of(Motion.ease(Motion.dur2), reduce: reduce)) { chrome.toggle() } }
                        } else if failed.contains(i) {
                            Text("This video cannot be played here. Use Share to open it in another app.")
                                .font(.sans(14)).foregroundStyle(.white.opacity(0.7)).multilineTextAlignment(.center).padding(32)
                        } else {
                            ProgressView().tint(.white)
                        }
                    }
                    .tag(i)
                    .task { await load(i, m) }
                    .ignoresSafeArea()
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea()
            if chrome { bar.transition(.opacity) }
            if let note {
                Text(note).font(.sans(13, .medium)).foregroundStyle(.white)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(.black.opacity(0.7), in: Capsule())
                    .frame(maxHeight: .infinity, alignment: .bottom).padding(.bottom, 40)
                    .transition(.opacity)
            }
        }
        .statusBarHidden(!chrome)
        // a video stops when swiped away from or closed
        .onChange(of: index) { _, now in for (i, p) in players where i != now { p.pause() } }
        .onDisappear { for p in players.values { p.pause() } }
        .sheet(item: $shareItem) { ShareSheet(items: [$0]) }
        .accessibilityIdentifier("media-viewer")
    }

    private var bar: some View {
        HStack(spacing: 4) {
            icon("xmark", "Close") { dismiss() }
            Spacer(minLength: 0)
            VStack(spacing: 1) {
                Text(Self.isVideo(set.items[index]) ? "Video" : "Picture").font(.sans(14, .medium)).foregroundStyle(.white.opacity(0.9))
                if set.items.count > 1 {
                    Text("\(index + 1) of \(set.items.count)").font(.sans(12)).monospacedDigit().foregroundStyle(.white.opacity(0.45))
                }
            }
            Spacer(minLength: 0)
            icon("arrow.down.to.line", "Save to Photos") { save() }
            icon("square.and.arrow.up", "Share") { share() }
        }
        .padding(.horizontal, 8)
        .frame(height: 56)
        .background(LinearGradient(colors: [.black.opacity(0.6), .clear], startPoint: .top, endPoint: .bottom).ignoresSafeArea())
    }

    /// The web's bar buttons: 36 pt (44 on a phone), 18 pt icons in white at 70%.
    private func icon(_ name: String, _ label: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: name).font(.system(size: 17, weight: .medium)).foregroundStyle(.white.opacity(0.7))
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    static func isVideo(_ m: MediaBlock) -> Bool { m.mediaType.lowercased().hasPrefix("video/") }

    private func load(_ i: Int, _ m: MediaBlock) async {
        if Self.isVideo(m) {
            guard players[i] == nil else { return }
            guard let data = await MediaBytes.load(m, client),
                  let url = MediaBytes.file(data, name: m.title ?? "conclave-video", mediaType: m.mediaType) else {
                failed.insert(i)
                return
            }
            videos[i] = url
            players[i] = AVPlayer(url: url)
            return
        }
        guard images[i] == nil, let data = await MediaBytes.load(m, client) else { return }
        // decoded at a size that still zooms sharp, never whole: a phone screenshot is far over this
        let px = max(UIScreen.main.bounds.width, UIScreen.main.bounds.height) * UIScreen.main.scale * 2
        if let cg = await Task.detached(operation: { PictureView.thumbnail(data, maxPixels: min(px, 4096)) }).value {
            images[i] = UIImage(cgImage: cg)
        }
    }

    private func save() {
        let img = images[index]
        let video = videos[index]
        guard img != nil || video != nil else { return }
        Task {
            let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
            guard status == .authorized || status == .limited else { return flash("Allow Conclave to add photos in Settings") }
            if let video {
                guard UIVideoAtPathIsCompatibleWithSavedPhotosAlbum(video.path) else { return flash("Photos cannot keep this video. Use Share.") }
                UISaveVideoAtPathToSavedPhotosAlbum(video.path, nil, nil, nil)
            } else if let img {
                UIImageWriteToSavedPhotosAlbum(img, nil, nil, nil)
            }
            flash("Saved to Photos")
        }
    }

    private func share() {
        Task {
            let m = set.items[index]
            guard let data = await MediaBytes.load(m, client) else { return }
            shareItem = MediaBytes.file(data, name: m.title ?? (Self.isVideo(m) ? "conclave-video" : "conclave-image"), mediaType: m.mediaType)
        }
    }

    private func flash(_ s: String) {
        withAnimation(Motion.of(Motion.ease(Motion.dur2), reduce: reduce)) { note = s }
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            withAnimation(Motion.of(Motion.ease(Motion.dur2), reduce: reduce)) { note = nil }
        }
    }
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

/// The system share sheet (Save to Files, AirDrop, other apps) for a file.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}

/// Pinch 1x to 5x, double tap to 2.5x at the tapped point and back, pan clamped to the picture:
/// a UIScrollView, which zooms as Photos does.
struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    var onTap: () -> Void = {}

    func makeCoordinator() -> Coordinator { Coordinator(onTap: onTap) }

    func makeUIView(context: Context) -> UIScrollView {
        let s = UIScrollView()
        s.minimumZoomScale = 1
        s.maximumZoomScale = 5
        s.showsVerticalScrollIndicator = false
        s.showsHorizontalScrollIndicator = false
        s.contentInsetAdjustmentBehavior = .never
        s.delegate = context.coordinator
        s.backgroundColor = .clear
        let v = UIImageView(image: image)
        v.contentMode = .scaleAspectFit
        v.translatesAutoresizingMaskIntoConstraints = false
        s.addSubview(v)
        NSLayoutConstraint.activate([
            v.widthAnchor.constraint(equalTo: s.frameLayoutGuide.widthAnchor),
            v.heightAnchor.constraint(equalTo: s.frameLayoutGuide.heightAnchor),
            v.leadingAnchor.constraint(equalTo: s.contentLayoutGuide.leadingAnchor),
            v.trailingAnchor.constraint(equalTo: s.contentLayoutGuide.trailingAnchor),
            v.topAnchor.constraint(equalTo: s.contentLayoutGuide.topAnchor),
            v.bottomAnchor.constraint(equalTo: s.contentLayoutGuide.bottomAnchor),
        ])
        context.coordinator.view = v
        let double = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        double.numberOfTapsRequired = 2
        s.addGestureRecognizer(double)
        let single = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tap))
        single.require(toFail: double)
        s.addGestureRecognizer(single)
        v.isAccessibilityElement = true
        v.accessibilityLabel = "Picture"
        return s
    }

    func updateUIView(_ s: UIScrollView, context: Context) {
        context.coordinator.view?.image = image
        context.coordinator.onTap = onTap
    }

    @MainActor final class Coordinator: NSObject, UIScrollViewDelegate {
        weak var view: UIImageView?
        var onTap: () -> Void
        init(onTap: @escaping () -> Void) { self.onTap = onTap }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { view }

        @objc func tap() { onTap() }

        @objc func doubleTap(_ g: UITapGestureRecognizer) {
            guard let s = g.view as? UIScrollView, let v = view else { return }
            if s.zoomScale > 1 {
                s.setZoomScale(1, animated: !UIAccessibility.isReduceMotionEnabled)
            } else {
                let p = g.location(in: v)
                let size = CGSize(width: s.bounds.width / 2.5, height: s.bounds.height / 2.5)
                s.zoom(to: CGRect(x: p.x - size.width / 2, y: p.y - size.height / 2, width: size.width, height: size.height), animated: !UIAccessibility.isReduceMotionEnabled)
            }
        }
    }
}
