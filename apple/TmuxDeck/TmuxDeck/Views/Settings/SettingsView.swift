import SwiftUI

struct SettingsView: View {
    @Environment(AppState.self) private var appState
    @State private var settings: SettingsResponse?
    @State private var fontSize: Double = 14
    @State private var biometricsEnabled = false
    @State private var isLoading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    if let server = appState.activeServer {
                        LabeledContent("Name", value: server.name)
                        LabeledContent("URL", value: server.url)
                    }

                    Button("Switch Server") {
                        appState.currentScreen = .serverSetup
                    }
                }

                Section("Terminal") {
                    HStack {
                        Text("Font Size")
                        Spacer()
                        Stepper("\(Int(fontSize))pt", value: $fontSize, in: 8...32, step: 1)
                    }
                }

                if KeychainService.shared.biometricsAvailable {
                    Section("Security") {
                        let biometricName = KeychainService.shared.biometricType == .faceID
                            ? "Face ID" : "Touch ID"

                        Toggle("\(biometricName) Unlock", isOn: $biometricsEnabled)
                    }
                }

                if let settings = settings {
                    Section("Notifications") {
                        LabeledContent("Telegram Bot") {
                            Text(settings.telegramBotToken.isEmpty ? "Not configured" : "Configured")
                                .foregroundStyle(settings.telegramBotToken.isEmpty ? Color.secondary : Color.green)
                        }
                    }
                }

                Section("Account") {
                    Button("Logout") {
                        Task { await appState.logout() }
                    }
                    .foregroundStyle(.red)
                }

                Section("About") {
                    LabeledContent("Version", value: "1.0.0")
                    LabeledContent("TmuxDeck", value: "iOS Client")
                }
            }
            .navigationTitle("Settings")
            .task {
                await loadSettings()
            }
        }
    }

    private func loadSettings() async {
        isLoading = true
        do {
            settings = try await appState.apiClient.getSettings()
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}
