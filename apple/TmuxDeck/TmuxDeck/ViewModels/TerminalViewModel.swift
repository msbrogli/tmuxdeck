import Foundation
import SwiftTerm

enum TerminalMode {
    case tmux
    case app
}

@Observable
final class TerminalViewModel {
    var windows: [TmuxWindowResponse] = []
    var activeWindowIndex: Int = 0
    var isConnected = false
    var error: String?
    var fontSize: CGFloat = 14
    var theme: TerminalTheme = .dark

    var mode: TerminalMode = .tmux
    var panes: [TmuxPaneResponse] = []
    var activePaneIndex: Int = 0
    var isZoomed = false

    /// Set by SwiftTerminalView to feed incoming bytes into the TerminalView
    var feedHandler: (([UInt8]) -> Void)?

    /// Reference to the terminal view for keyboard control
    weak var terminalViewRef: TerminalView?

    let connection = TerminalConnection()
    private let apiClient: APIClient
    private let preferences: UserPreferences
    private var hasConnected = false

    let containerId: String
    let sessionName: String

    init(apiClient: APIClient, preferences: UserPreferences, containerId: String, sessionName: String, windows: [TmuxWindowResponse]) {
        self.apiClient = apiClient
        self.preferences = preferences
        self.containerId = containerId
        self.sessionName = sessionName
        self.windows = windows
        self.fontSize = preferences.fontSize
        self.theme = preferences.currentTheme
        if let active = windows.first(where: { $0.active }) {
            self.activeWindowIndex = active.index
        }
        if preferences.preferAppMode {
            self.mode = .app
        }
    }

    /// Called by SwiftTerminalView once the feed handler is set
    func connectIfNeeded() {
        guard !hasConnected, let feedHandler = feedHandler else { return }
        hasConnected = true

        guard let baseURL = apiClient.baseURL else {
            error = "No server configured"
            return
        }

        connection.connect(
            baseURL: baseURL,
            containerId: containerId,
            sessionName: sessionName,
            windowIndex: activeWindowIndex,
            onData: { [weak self] bytes in
                self?.feedHandler?(bytes)
            },
            onTextMessage: { [weak self] msg in
                self?.handleControlMessage(msg)
            }
        )
    }

    func disconnect() {
        connection.disconnect()
        hasConnected = false
    }

    func sendInput(_ data: Data) {
        connection.sendBinary(data)
    }

    func sendResize(cols: Int, rows: Int) {
        connection.sendResize(cols: cols, rows: rows)
    }

    func switchWindow(to index: Int) {
        activeWindowIndex = index
        connection.selectWindow(index: index)
        if mode == .app {
            connection.listPanes(windowIndex: index)
        }
    }

    func toggleMode() {
        if mode == .tmux {
            enterAppMode()
        } else {
            exitAppMode()
        }
    }

    func enterAppMode() {
        mode = .app
        connection.listPanes(windowIndex: activeWindowIndex)
    }

    private func exitAppMode() {
        mode = .tmux
        isZoomed = false
        connection.unzoomPane()
    }

    func switchPane(direction: Int) {
        guard panes.count > 1 else { return }
        guard let currentPos = panes.firstIndex(where: { $0.index == activePaneIndex }) else { return }
        let nextPos = currentPos + direction
        guard nextPos >= 0, nextPos < panes.count else { return }
        let nextPane = panes[nextPos]
        activePaneIndex = nextPane.index
        isZoomed = true
        connection.zoomPane(windowIndex: activeWindowIndex, paneIndex: nextPane.index)
        connection.capturePane(windowIndex: activeWindowIndex, paneIndex: nextPane.index)
    }

    func createWindow(name: String? = nil) async {
        do {
            let updated = try await apiClient.createWindow(
                containerId: containerId,
                sessionId: sessionName,
                name: name
            )
            windows = updated
            if let last = updated.last {
                switchWindow(to: last.index)
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func refreshWindows() async {
        do {
            let sessions = try await apiClient.getSessions(containerId: containerId)
            if let session = sessions.first(where: { $0.name == sessionName }) {
                windows = session.windows
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    func adjustFontSize(delta: CGFloat) {
        let newSize = fontSize + delta
        if newSize >= 8 && newSize <= 32 {
            fontSize = newSize
            preferences.fontSize = newSize
        }
    }

    func applyTheme(_ newTheme: TerminalTheme) {
        theme = newTheme
        preferences.themeName = newTheme.id
    }

    func reloadPreferences() {
        fontSize = preferences.fontSize
        theme = preferences.currentTheme
    }

    private func handleControlMessage(_ message: String) {
        if message.hasPrefix("MOUSE_WARNING:on") {
            connection.disableMouse()
        } else if message.hasPrefix("BELL_WARNING:") && !message.hasSuffix(":ok") {
            connection.fixBell()
        } else if message.hasPrefix("WINDOW_STATE:") {
            handleWindowStateUpdate(message)
        } else if message.hasPrefix("PANE_LIST:") {
            handlePaneList(message)
        } else if message.hasPrefix("PANE_CONTENT:") {
            handlePaneContent(message)
        }
    }

    private func handleWindowStateUpdate(_ message: String) {
        let jsonString = String(message.dropFirst("WINDOW_STATE:".count))
        guard let data = jsonString.data(using: .utf8) else { return }

        struct WindowState: Decodable {
            let active: Int?
            let windows: [TmuxWindowResponse]
            let panes: [TmuxPaneResponse]?
        }

        do {
            let state = try JSONDecoder().decode(WindowState.self, from: data)
            windows = state.windows
            if let active = state.active {
                activeWindowIndex = active
            }
            if let updatedPanes = state.panes, !updatedPanes.isEmpty {
                panes = updatedPanes
                if !updatedPanes.contains(where: { $0.index == activePaneIndex }) {
                    activePaneIndex = updatedPanes.first?.index ?? 0
                }
            }
        } catch {}
    }

    private func handlePaneList(_ message: String) {
        let jsonString = String(message.dropFirst("PANE_LIST:".count))
        guard let data = jsonString.data(using: .utf8) else { return }

        do {
            let decoded = try JSONDecoder().decode([TmuxPaneResponse].self, from: data)
            panes = decoded
            if mode == .app {
                let activePane = decoded.first(where: { $0.active }) ?? decoded.first
                if let pane = activePane {
                    activePaneIndex = pane.index
                    isZoomed = true
                    connection.zoomPane(windowIndex: activeWindowIndex, paneIndex: pane.index)
                    connection.capturePane(windowIndex: activeWindowIndex, paneIndex: pane.index)
                }
            }
        } catch {}
    }

    private func handlePaneContent(_ message: String) {
        let rest = String(message.dropFirst("PANE_CONTENT:".count))
        guard let colonIdx = rest.firstIndex(of: ":") else { return }
        let content = String(rest[rest.index(after: colonIdx)...])

        // Clear terminal and feed scrollback content
        let clearSeq: [UInt8] = [0x1b, 0x5b, 0x32, 0x4a, 0x1b, 0x5b, 0x48] // ESC[2J ESC[H
        feedHandler?(clearSeq)
        if let contentBytes = content.data(using: .utf8) {
            feedHandler?([UInt8](contentBytes))
        }
    }
}
