import SwiftUI

@main
struct TmuxDeckApp: App {
    @State private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(appState)
                .onOpenURL { url in
                    handleDeepLink(url)
                }
        }
        .commands {
            CommandMenu("Navigation") {
                Button("Quick Switcher") {
                    NotificationCenter.default.post(name: .toggleQuickSwitcher, object: nil)
                }
                .keyboardShortcut("k", modifiers: .command)

                Button("Toggle Fullscreen") {
                    NotificationCenter.default.post(name: .toggleFullscreen, object: nil)
                }
                .keyboardShortcut("f", modifiers: [.command, .shift])

                Button("New Session") {
                    NotificationCenter.default.post(name: .newSession, object: nil)
                }
                .keyboardShortcut("t", modifiers: .command)

                Button("Close Terminal") {
                    NotificationCenter.default.post(name: .closeTerminal, object: nil)
                }
                .keyboardShortcut("w", modifiers: .command)

                Divider()

                ForEach(1...9, id: \.self) { index in
                    Button("Window \(index)") {
                        NotificationCenter.default.post(
                            name: .switchWindow,
                            object: nil,
                            userInfo: ["index": index - 1]
                        )
                    }
                    .keyboardShortcut(KeyEquivalent(Character("\(index)")), modifiers: .command)
                }
            }
        }
    }

    private func handleDeepLink(_ url: URL) {
        // tmuxdeck://container/{id}/session/{name}/window/{index}
        guard url.scheme == "tmuxdeck" else { return }

        let components = url.pathComponents.filter { $0 != "/" }
        guard components.count >= 4,
              components[0] == "container",
              components[2] == "session" else { return }

        let containerId = components[1]
        let sessionName = components[3]
        let windowIndex = components.count >= 6 && components[4] == "window"
            ? Int(components[5]) ?? 0
            : 0

        Task {
            do {
                let sessions = try await appState.apiClient.getSessions(containerId: containerId)
                guard let session = sessions.first(where: { $0.name == sessionName }) else { return }
                let container = try await appState.apiClient.getContainer(id: containerId)
                let target = TerminalTarget(
                    containerId: containerId,
                    containerName: container.displayName,
                    session: session,
                    windowIndex: windowIndex
                )
                NotificationCenter.default.post(
                    name: .navigateToTarget,
                    object: nil,
                    userInfo: ["target": target]
                )
            } catch {}
        }
    }
}

// MARK: - App-wide notification names for keyboard shortcuts

extension Notification.Name {
    static let toggleQuickSwitcher = Notification.Name("toggleQuickSwitcher")
    static let toggleFullscreen = Notification.Name("toggleFullscreen")
    static let newSession = Notification.Name("newSession")
    static let closeTerminal = Notification.Name("closeTerminal")
    static let switchWindow = Notification.Name("switchWindow")
    static let navigateToTarget = Notification.Name("navigateToTarget")
}
