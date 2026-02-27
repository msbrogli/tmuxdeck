import Foundation

@Observable
final class TerminalViewModel {
    var windows: [TmuxWindowResponse] = []
    var activeWindowIndex: Int = 0
    var isConnected = false
    var error: String?
    var fontSize: CGFloat = 14

    /// Set by SwiftTerminalView to feed incoming bytes into the TerminalView
    var feedHandler: (([UInt8]) -> Void)?

    let connection = TerminalConnection()
    private let apiClient: APIClient
    private var hasConnected = false

    let containerId: String
    let sessionName: String

    init(apiClient: APIClient, containerId: String, sessionName: String, windows: [TmuxWindowResponse]) {
        self.apiClient = apiClient
        self.containerId = containerId
        self.sessionName = sessionName
        self.windows = windows
        if let active = windows.first(where: { $0.active }) {
            self.activeWindowIndex = active.index
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
        }
    }

    private func handleControlMessage(_ message: String) {
        if message.hasPrefix("MOUSE_WARNING:on") {
            connection.disableMouse()
        } else if message.hasPrefix("BELL_WARNING:") && !message.hasSuffix(":ok") {
            connection.fixBell()
        }
    }
}
