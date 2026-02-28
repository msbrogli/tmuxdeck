import SwiftUI

enum InputMode {
    case voice, keyboard
}

struct TerminalInputControl: View {
    let onText: (String) -> Void
    var onRawInput: ((Data) -> Void)?
    @Binding var inputMode: InputMode

    @State private var speech = SpeechRecognitionService()
    @State private var isRecording = false
    @State private var hasPermission: Bool?
    @State private var showSentConfirmation = false
    @State private var sentText = ""
    @State private var showLanguagePicker = false
    @State private var waveformSamples: [CGFloat] = Array(repeating: 0, count: 28)
    @State private var waveformTimer: Timer?

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            // Transcript bubble above bar (only while recording)
            if isRecording && !speech.transcript.isEmpty {
                Text(speech.transcript)
                    .font(.system(.subheadline, design: .monospaced, weight: .medium))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 10)
                    .background {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(.red.opacity(0.75))
                    }
                    .padding(.horizontal, 10)
                    .padding(.bottom, 6)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if showSentConfirmation {
                sentBar
                    .transition(.opacity)
            } else {
                // Single persistent bar — appearance changes, view stays
                mainBar
            }
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: isRecording)
        .animation(.easeOut(duration: 0.2), value: showSentConfirmation)
        .sheet(isPresented: $showLanguagePicker) {
            LanguagePickerSheet(
                currentLocale: speech.locale,
                onSelect: { locale in
                    speech.locale = locale
                    showLanguagePicker = false
                }
            )
            .presentationDetents([.medium, .large])
        }
        .task {
            hasPermission = await speech.requestPermissions()
        }
    }

    // MARK: - Main Bar (single persistent view — morphs between idle and recording)

    private var mainBar: some View {
        HStack(spacing: 0) {
            if isRecording {
                // Waveform
                HStack(spacing: 1.5) {
                    ForEach(0..<waveformSamples.count, id: \.self) { i in
                        RoundedRectangle(cornerRadius: 1)
                            .fill(.white.opacity(0.85))
                            .frame(width: 2.5, height: max(3, waveformSamples[i] * 28))
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: 32)

                Text("Release to send")
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.7))
                    .padding(.trailing, 14)
            } else {
                // Ctrl+C button
                Button {
                    onRawInput?(Data([0x03]))
                } label: {
                    Image(systemName: "stop.circle.fill")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(.red.opacity(0.6))
                        .frame(width: 36, height: 48)
                }

                // PTT label area
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color.primary.opacity(0.06))

                    HStack(spacing: 8) {
                        Image(systemName: "mic.fill")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.primary.opacity(0.55))
                        Text("Hold to speak")
                            .font(.system(size: 14, weight: .medium, design: .rounded))
                            .foregroundStyle(.primary.opacity(0.45))
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 4)
                .padding(.vertical, 6)

                // Enter button
                Button {
                    onRawInput?(Data([0x0d])) // carriage return
                } label: {
                    Image(systemName: "return")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.primary.opacity(0.5))
                        .frame(width: 36, height: 48)
                }

                // Keyboard toggle
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        inputMode = inputMode == .keyboard ? .voice : .keyboard
                    }
                } label: {
                    Image(systemName: inputMode == .keyboard ? "mic.fill" : "keyboard")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(.primary.opacity(0.5))
                        .frame(width: 36, height: 48)
                        .contentTransition(.symbolEffect(.replace))
                }
            }
        }
        .frame(height: 48)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(isRecording ? AnyShapeStyle(Color.red.gradient) : AnyShapeStyle(.ultraThinMaterial))
                .shadow(
                    color: isRecording ? .red.opacity(0.25) : .black.opacity(0.08),
                    radius: isRecording ? 8 : 4,
                    y: isRecording ? 2 : -1
                )
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
        // Gesture lives on the persistent container — survives visual changes
        .gesture(pttGesture)
        .sensoryFeedback(.impact(weight: .medium), trigger: isRecording)
        .opacity(hasPermission == false && !isRecording ? 0.3 : 1)
    }

    // MARK: - Sent Confirmation Bar

    private var sentBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 16))
                .foregroundStyle(.green)
            Text(sentText)
                .font(.system(.subheadline, design: .monospaced, weight: .medium))
                .foregroundStyle(.primary.opacity(0.7))
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 48)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.ultraThinMaterial)
                .shadow(color: .black.opacity(0.06), radius: 3, y: -1)
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
    }

    // MARK: - PTT Gesture

    private var pttGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { _ in
                if !isRecording {
                    startRecording()
                }
            }
            .onEnded { _ in
                if isRecording {
                    finishRecording()
                }
            }
    }

    // MARK: - Actions

    private func startRecording() {
        // Dismiss keyboard if it's up
        if inputMode == .keyboard {
            withAnimation(.easeInOut(duration: 0.1)) {
                inputMode = .voice
            }
        }
        isRecording = true
        speech.startListening()
        startWaveformSampling()
    }

    private func finishRecording() {
        let text = speech.stopListening()
        isRecording = false
        stopWaveformSampling()

        guard !text.isEmpty else { return }

        sentText = text
        onText(text)

        showSentConfirmation = true
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            showSentConfirmation = false
        }
    }

    private func startWaveformSampling() {
        waveformTimer = Timer.scheduledTimer(withTimeInterval: 0.06, repeats: true) { _ in
            Task { @MainActor in
                var newSamples = Array(waveformSamples.dropFirst())
                let level = CGFloat(speech.audioLevel)
                let sample = min(1.0, level * 1.8 + CGFloat.random(in: 0...0.08))
                newSamples.append(sample)
                waveformSamples = newSamples
            }
        }
    }

    private func stopWaveformSampling() {
        waveformTimer?.invalidate()
        waveformTimer = nil
        waveformSamples = Array(repeating: 0, count: 28)
    }
}

// MARK: - Language Picker

struct LanguagePickerSheet: View {
    let currentLocale: Locale
    let onSelect: (Locale) -> Void
    @State private var search = ""

    private var locales: [Locale] {
        let all = SpeechRecognitionService.supportedLocales
        if search.isEmpty { return all }
        return all.filter { locale in
            displayName(for: locale).localizedCaseInsensitiveContains(search)
        }
    }

    var body: some View {
        NavigationStack {
            List(locales, id: \.identifier) { locale in
                languageRow(locale)
            }
            .searchable(text: $search, prompt: "Search languages")
            .navigationTitle("Language")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func languageRow(_ locale: Locale) -> some View {
        Button {
            onSelect(locale)
        } label: {
            HStack {
                Text(displayName(for: locale))
                    .foregroundStyle(.primary)
                Spacer()
                if locale.identifier == currentLocale.identifier {
                    Image(systemName: "checkmark")
                        .foregroundStyle(.tint)
                        .fontWeight(.semibold)
                }
            }
        }
    }

    private func displayName(for locale: Locale) -> String {
        Locale.current.localizedString(forIdentifier: locale.identifier) ?? locale.identifier
    }
}
