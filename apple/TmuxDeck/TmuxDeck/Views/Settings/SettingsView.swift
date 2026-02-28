import SwiftUI

struct SettingsView: View {
    @Environment(AppState.self) private var appState
    @State private var settings: SettingsResponse?
    @State private var isLoading = false
    @State private var error: String?

    // Editable copies for server settings
    @State private var editableVolumes: [String] = []
    @State private var editableSshKeyPath = ""
    @State private var newVolume = ""
    @State private var isSaving = false
    @State private var isDirty = false

    var body: some View {
        Form {
            Section("Terminal") {
                HStack {
                    Text("Font Size")
                    Spacer()
                    Stepper(
                        "\(Int(appState.preferences.fontSize))pt",
                        value: Bindable(appState.preferences).fontSize,
                        in: 8...32,
                        step: 1
                    )
                }

                NavigationLink {
                    TerminalThemeView()
                } label: {
                    HStack {
                        Text("Theme")
                        Spacer()
                        Text(appState.preferences.currentTheme.name)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if settings != nil {
                Section("Default Volume Mounts") {
                    ForEach(editableVolumes, id: \.self) { volume in
                        Text(volume)
                            .font(.system(.caption, design: .monospaced))
                    }
                    .onDelete { indices in
                        editableVolumes.remove(atOffsets: indices)
                        isDirty = true
                    }

                    HStack {
                        TextField("/host:/container", text: $newVolume)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.system(.body, design: .monospaced))

                        Button("Add") {
                            guard !newVolume.isEmpty else { return }
                            editableVolumes.append(newVolume)
                            newVolume = ""
                            isDirty = true
                        }
                        .disabled(newVolume.isEmpty)
                    }
                }

                Section("SSH") {
                    TextField("~/.ssh/id_rsa", text: $editableSshKeyPath)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))
                        .onChange(of: editableSshKeyPath) { _, _ in
                            isDirty = true
                        }
                }

                if let hotkeys = settings?.hotkeys, !hotkeys.isEmpty {
                    Section("Keyboard Shortcuts") {
                        NavigationLink {
                            HotkeyEditorView(
                                hotkeys: hotkeys,
                                apiClient: appState.apiClient
                            )
                        } label: {
                            HStack {
                                Text("View Shortcuts")
                                Spacer()
                                Text("\(hotkeys.count) bindings")
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }

            if KeychainService.shared.biometricsAvailable {
                Section("Security") {
                    let biometricName = KeychainService.shared.biometricType == .faceID
                        ? "Face ID" : "Touch ID"

                    Toggle("\(biometricName) Unlock", isOn: Bindable(appState.preferences).biometricsEnabled)

                    NavigationLink("Change PIN") {
                        ChangePINView()
                    }
                }
            } else {
                Section("Security") {
                    NavigationLink("Change PIN") {
                        ChangePINView()
                    }
                }
            }

            Section("Server") {
                if let server = appState.activeServer {
                    LabeledContent("Name", value: server.name)
                    LabeledContent("URL", value: server.url)
                }

                Button("Switch Server") {
                    appState.currentScreen = .serverSetup
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
                NavigationLink("Help") {
                    HelpView()
                }
                LabeledContent("Version", value: "1.0.0")
                LabeledContent("TmuxDeck", value: "iOS Client")
            }
        }
        .navigationTitle("Settings")
        .toolbar {
            if isDirty {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task { await saveSettings() }
                    }
                    .disabled(isSaving)
                }
            }
        }
        .task {
            await loadSettings()
        }
    }

    private func loadSettings() async {
        isLoading = true
        do {
            let loaded = try await appState.apiClient.getSettings()
            settings = loaded
            editableVolumes = loaded.defaultVolumeMounts
            editableSshKeyPath = loaded.sshKeyPath
            isDirty = false
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    private func saveSettings() async {
        isSaving = true
        do {
            let request = UpdateSettingsRequest(
                defaultVolumeMounts: editableVolumes,
                sshKeyPath: editableSshKeyPath.isEmpty ? nil : editableSshKeyPath
            )
            let updated = try await appState.apiClient.updateSettings(request)
            settings = updated
            isDirty = false
        } catch {
            self.error = error.localizedDescription
        }
        isSaving = false
    }
}
