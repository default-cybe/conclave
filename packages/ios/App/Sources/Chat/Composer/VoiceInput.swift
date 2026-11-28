import AVFoundation
import Speech
import SwiftUI

/// The composer's mic (Android VoiceInput): speech recognition streams words into the box while you
/// talk; a second tap, or a pause the recognizer calls final, stops it. On device when the language
/// has an on-device model, so nothing leaves the iPad or iPhone then.
@MainActor @Observable
final class VoiceInput {
    private(set) var listening = false
    private(set) var error: String?
    @ObservationIgnored private let engine = AVAudioEngine()
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?
    @ObservationIgnored private let recognizer = SFSpeechRecognizer()

    var available: Bool { recognizer?.isAvailable ?? false }

    /// `prefix` is what the box held before; the words heard follow it.
    func toggle(prefix: String, onText: @escaping (String) -> Void) async {
        if listening { stop(); return }
        error = nil
        guard await Self.authorize() else {
            error = "Turn on Microphone and Speech Recognition for Conclave in the Settings app."
            return
        }
        do { try start(prefix: prefix, onText: onText) } catch {
            stop()
            self.error = "The microphone did not start."
        }
    }

    func stop() {
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        listening = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func start(prefix: String, onText: @escaping (String) -> Void) throws {
        guard let recognizer, recognizer.isAvailable else { error = "Speech recognition is not available now."; return }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        request = req
        let input = engine.inputNode
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { buf, _ in req.append(buf) }
        engine.prepare()
        try engine.start()
        listening = true
        let lead = prefix.isEmpty || prefix.hasSuffix(" ") || prefix.hasSuffix("\n") ? prefix : prefix + " "
        task = recognizer.recognitionTask(with: req) { [weak self] result, err in
            let text = result?.bestTranscription.formattedString
            let done = (result?.isFinal ?? false) || err != nil
            Task { @MainActor in
                if let text { onText(lead + text) }
                if done { self?.stop() }
            }
        }
    }

    private static func authorize() async -> Bool {
        let speech = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) } }
        guard speech else { return false }
        return await AVAudioApplication.requestRecordPermission()
    }
}
