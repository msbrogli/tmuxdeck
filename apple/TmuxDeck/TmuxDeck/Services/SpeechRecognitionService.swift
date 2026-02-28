import Foundation
import Speech
import AVFoundation

@Observable
final class SpeechRecognitionService {
    var isListening = false
    var transcript = ""
    var error: String?
    var audioLevel: Float = 0
    var locale: Locale {
        didSet {
            speechRecognizer = SFSpeechRecognizer(locale: locale)
            Self.saveLocale(locale)
        }
    }

    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var audioEngine = AVAudioEngine()
    private var levelTimer: Timer?

    static let supportedLocales: [Locale] = {
        SFSpeechRecognizer.supportedLocales()
            .sorted { $0.identifier < $1.identifier }
    }()

    init() {
        let saved = Self.loadLocale()
        self.locale = saved
        self.speechRecognizer = SFSpeechRecognizer(locale: saved)
    }

    var languageCode: String {
        locale.language.languageCode?.identifier.uppercased() ?? "??"
    }

    var isAvailable: Bool {
        speechRecognizer?.isAvailable == true
    }

    func requestPermissions() async -> Bool {
        let speechStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }

        guard speechStatus == .authorized else {
            error = "Speech recognition not authorized"
            return false
        }

        let audioStatus: Bool
        if #available(iOS 17.0, *) {
            audioStatus = await AVAudioApplication.requestRecordPermission()
        } else {
            audioStatus = await withCheckedContinuation { continuation in
                AVAudioSession.sharedInstance().requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        }

        guard audioStatus else {
            error = "Microphone access not authorized"
            return false
        }

        return true
    }

    func startListening() {
        guard !isListening else { return }
        guard let speechRecognizer, speechRecognizer.isAvailable else {
            error = "Speech recognition unavailable"
            return
        }

        do {
            try startAudioSession()
            try startRecognition(with: speechRecognizer)
            isListening = true
            error = nil
            transcript = ""
        } catch {
            self.error = error.localizedDescription
            stopListening()
        }
    }

    @discardableResult
    func stopListening() -> String {
        let finalText = transcript
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        levelTimer?.invalidate()
        levelTimer = nil

        recognitionRequest = nil
        recognitionTask = nil
        isListening = false
        audioLevel = 0

        deactivateAudioSession()

        return finalText
    }

    private func startAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
    }

    private func deactivateAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func startRecognition(with recognizer: SFSpeechRecognizer) throws {
        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        guard let recognitionRequest else { return }

        recognitionRequest.shouldReportPartialResults = true
        recognitionRequest.addsPunctuation = true

        recognitionTask = recognizer.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            guard let self else { return }
            if let result {
                DispatchQueue.main.async {
                    self.transcript = result.bestTranscription.formattedString
                }
            }
            if error != nil {
                DispatchQueue.main.async {
                    self.stopListening()
                }
            }
        }

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
            self?.updateAudioLevel(buffer: buffer)
        }

        audioEngine.prepare()
        try audioEngine.start()
    }

    private func updateAudioLevel(buffer: AVAudioPCMBuffer) {
        guard let channelData = buffer.floatChannelData?[0] else { return }
        let frames = Int(buffer.frameLength)
        var sum: Float = 0
        for i in 0..<frames {
            sum += channelData[i] * channelData[i]
        }
        let rms = sqrtf(sum / Float(frames))
        let level = max(0, min(1, rms * 8))
        DispatchQueue.main.async { [weak self] in
            self?.audioLevel = level
        }
    }

    // MARK: - Persistence

    private static let localeKey = "speechLocale"

    private static func saveLocale(_ locale: Locale) {
        UserDefaults.standard.set(locale.identifier, forKey: localeKey)
    }

    private static func loadLocale() -> Locale {
        if let id = UserDefaults.standard.string(forKey: localeKey) {
            return Locale(identifier: id)
        }
        return Locale.current
    }
}
