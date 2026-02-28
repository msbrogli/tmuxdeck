import SwiftUI

struct HotkeyEditorView: View {
    let hotkeys: [String: String]
    let apiClient: APIClient
    @State private var currentHotkeys: [String: String] = [:]
    @State private var isResetting = false

    var body: some View {
        List {
            Section {
                ForEach(sortedKeys, id: \.self) { key in
                    HStack {
                        Text(formatActionName(key))
                            .font(.subheadline)
                        Spacer()
                        Text(currentHotkeys[key] ?? "")
                            .font(.system(.caption, design: .monospaced))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color(.systemGray5))
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                }
            } footer: {
                Text("Keyboard shortcuts are configured on the server and apply to the web interface.")
                    .font(.caption)
            }

            Section {
                Button("Reset to Defaults") {
                    Task { await resetDefaults() }
                }
                .disabled(isResetting)
            }
        }
        .navigationTitle("Keyboard Shortcuts")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            currentHotkeys = hotkeys
        }
    }

    private var sortedKeys: [String] {
        currentHotkeys.keys.sorted()
    }

    private func formatActionName(_ key: String) -> String {
        // Convert camelCase to Title Case
        var result = ""
        for char in key {
            if char.isUppercase && !result.isEmpty {
                result.append(" ")
            }
            result.append(char)
        }
        return result.prefix(1).uppercased() + result.dropFirst()
    }

    private func resetDefaults() async {
        isResetting = true
        do {
            let request = UpdateSettingsRequest(hotkeys: [:])
            let updated = try await apiClient.updateSettings(request)
            currentHotkeys = updated.hotkeys
        } catch {}
        isResetting = false
    }
}
