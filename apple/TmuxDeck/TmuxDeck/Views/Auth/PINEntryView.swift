import SwiftUI

struct PINEntryView: View {
    enum Mode {
        case login
        case setup
    }

    let mode: Mode

    @Environment(AppState.self) private var appState
    @State private var pin = ""
    @State private var confirmPin = ""
    @State private var isConfirming = false
    @State private var error: String?
    @State private var isLoading = false
    @State private var showBiometricPrompt = false

    private let pinLength = 4

    var body: some View {
        VStack(spacing: 32) {
            Spacer()

            Image(systemName: "lock.shield")
                .font(.system(size: 60))
                .foregroundStyle(.tint)

            Text(titleText)
                .font(.title2)
                .fontWeight(.semibold)

            Text(subtitleText)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            // PIN dots
            HStack(spacing: 16) {
                ForEach(0..<pinLength, id: \.self) { index in
                    Circle()
                        .fill(index < currentPin.count ? Color.accentColor : Color.secondary.opacity(0.3))
                        .frame(width: 16, height: 16)
                        .scaleEffect(index < currentPin.count ? 1.2 : 1.0)
                        .animation(.spring(response: 0.2), value: currentPin.count)
                }
            }
            .padding(.vertical)

            if let error = error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            // Number pad
            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 3), spacing: 16) {
                ForEach(1...9, id: \.self) { number in
                    PINButton(label: "\(number)") {
                        appendDigit("\(number)")
                    }
                }

                if mode == .login {
                    PINButton(label: "face.smiling", isSystemImage: true) {
                        Task { await attemptBiometrics() }
                    }
                    .disabled(!KeychainService.shared.biometricsAvailable)
                } else {
                    Color.clear.frame(height: 60)
                }

                PINButton(label: "0") {
                    appendDigit("0")
                }

                PINButton(label: "delete.left", isSystemImage: true) {
                    deleteDigit()
                }
            }
            .padding(.horizontal, 40)

            if isLoading {
                ProgressView()
                    .padding()
            }

            Spacer()

            if mode == .login {
                Button("Switch Server") {
                    appState.currentScreen = .serverSetup
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.bottom)
            }
        }
        .padding()
        .onAppear {
            if mode == .login && KeychainService.shared.biometricsAvailable {
                Task { await attemptBiometrics() }
            }
        }
        .alert("Enable Biometric Unlock?", isPresented: $showBiometricPrompt) {
            Button("Enable") {
                Task { await saveBiometricPIN() }
            }
            Button("Not Now", role: .cancel) { }
        } message: {
            let type = KeychainService.shared.biometricType == .faceID ? "Face ID" : "Touch ID"
            Text("Use \(type) to unlock TmuxDeck next time?")
        }
    }

    private var currentPin: String {
        isConfirming ? confirmPin : pin
    }

    private var titleText: String {
        switch mode {
        case .login: return "Welcome Back"
        case .setup: return isConfirming ? "Confirm PIN" : "Create PIN"
        }
    }

    private var subtitleText: String {
        switch mode {
        case .login: return "Enter your PIN to unlock"
        case .setup:
            return isConfirming
                ? "Enter the same PIN again"
                : "Set a 4-digit PIN to secure TmuxDeck"
        }
    }

    private func appendDigit(_ digit: String) {
        guard currentPin.count < pinLength else { return }

        if isConfirming {
            confirmPin += digit
            if confirmPin.count == pinLength {
                Task { await handleConfirmComplete() }
            }
        } else {
            pin += digit
            if pin.count == pinLength {
                Task { await handlePINComplete() }
            }
        }
    }

    private func deleteDigit() {
        if isConfirming {
            if !confirmPin.isEmpty { confirmPin.removeLast() }
        } else {
            if !pin.isEmpty { pin.removeLast() }
        }
        error = nil
    }

    private func handlePINComplete() async {
        switch mode {
        case .login:
            isLoading = true
            do {
                try await appState.loginWithPIN(pin)
                if KeychainService.shared.biometricsAvailable {
                    showBiometricPrompt = true
                }
            } catch {
                self.error = "Invalid PIN"
                pin = ""
            }
            isLoading = false

        case .setup:
            isConfirming = true
        }
    }

    private func handleConfirmComplete() async {
        if confirmPin == pin {
            isLoading = true
            do {
                try await appState.setupPIN(pin)
            } catch {
                self.error = error.localizedDescription
                pin = ""
                confirmPin = ""
                isConfirming = false
            }
            isLoading = false
        } else {
            error = "PINs don't match"
            confirmPin = ""
        }
    }

    private func attemptBiometrics() async {
        do {
            let storedPIN = try await KeychainService.shared.loadPINWithBiometrics()
            try await appState.loginWithPIN(storedPIN)
        } catch {
            // Biometric failed — user can enter PIN manually
        }
    }

    private func saveBiometricPIN() async {
        try? KeychainService.shared.savePINWithBiometrics(pin: pin)
    }
}

struct PINButton: View {
    let label: String
    var isSystemImage: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            if isSystemImage {
                Image(systemName: label)
                    .font(.title2)
                    .frame(width: 60, height: 60)
            } else {
                Text(label)
                    .font(.title)
                    .fontWeight(.medium)
                    .frame(width: 60, height: 60)
            }
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.circle)
    }
}
