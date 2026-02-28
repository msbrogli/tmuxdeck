import Foundation
import Network

@Observable
final class TerminalConnection {
    var isConnected = false
    var error: String?

    private var webSocketTask: URLSessionWebSocketTask?
    private var session: URLSession
    private var onData: (([UInt8]) -> Void)?
    private var onTextMessage: ((String) -> Void)?
    private let monitor = NWPathMonitor()
    private var wasConnected = false
    private var reconnectInfo: (url: URL, containerId: String, sessionName: String, windowIndex: Int)?

    init() {
        let config = URLSessionConfiguration.default
        config.httpCookieAcceptPolicy = .always
        config.httpShouldSetCookies = true
        config.httpCookieStorage = .shared
        self.session = URLSession(configuration: config)

        monitor.pathUpdateHandler = { [weak self] path in
            guard let self = self else { return }
            if path.status == .satisfied && !self.isConnected && self.wasConnected {
                Task { await self.reconnect() }
            }
        }
        monitor.start(queue: .global(qos: .utility))
    }

    deinit {
        monitor.cancel()
        disconnect()
    }

    func connect(
        baseURL: URL,
        containerId: String,
        sessionName: String,
        windowIndex: Int,
        onData: @escaping ([UInt8]) -> Void,
        onTextMessage: ((String) -> Void)? = nil
    ) {
        disconnect()

        self.onData = onData
        self.onTextMessage = onTextMessage

        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: true) else {
            error = "Invalid WebSocket URL"
            return
        }
        components.scheme = (components.scheme == "https") ? "wss" : "ws"
        components.path = "/ws/terminal/\(containerId)/\(sessionName)/\(windowIndex)"

        guard let url = components.url else {
            error = "Invalid WebSocket URL"
            return
        }

        reconnectInfo = (baseURL, containerId, sessionName, windowIndex)

        webSocketTask = session.webSocketTask(with: url)
        webSocketTask?.resume()

        isConnected = true
        wasConnected = true
        error = nil

        receiveMessage()
    }

    func disconnect() {
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        isConnected = false
    }

    func sendText(_ text: String) {
        guard let task = webSocketTask else { return }
        task.send(.string(text)) { [weak self] error in
            if let error = error {
                self?.handleError(error)
            }
        }
    }

    func sendBinary(_ data: Data) {
        guard let task = webSocketTask else { return }
        task.send(.data(data)) { [weak self] error in
            if let error = error {
                self?.handleError(error)
            }
        }
    }

    func sendResize(cols: Int, rows: Int) {
        sendText("RESIZE:\(cols):\(rows)")
    }

    func selectWindow(index: Int) {
        sendText("SELECT_WINDOW:\(index)")
    }

    func scroll(direction: String, count: Int = 3) {
        sendText("SCROLL:\(direction):\(count)")
    }

    func disableMouse() {
        sendText("DISABLE_MOUSE:")
    }

    func fixBell() {
        sendText("FIX_BELL:")
    }

    func listPanes(windowIndex: Int) {
        sendText("LIST_PANES:\(windowIndex)")
    }

    func zoomPane(windowIndex: Int, paneIndex: Int) {
        sendText("ZOOM_PANE:\(windowIndex).\(paneIndex)")
    }

    func unzoomPane() {
        sendText("UNZOOM_PANE:")
    }

    func capturePane(windowIndex: Int, paneIndex: Int) {
        sendText("CAPTURE_PANE:\(windowIndex).\(paneIndex)")
    }

    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            guard let self = self else { return }

            switch result {
            case .success(let message):
                switch message {
                case .data(let data):
                    let bytes = [UInt8](data)
                    Task { @MainActor in
                        self.onData?(bytes)
                    }
                case .string(let text):
                    if text.hasPrefix("MOUSE_WARNING:") || text.hasPrefix("BELL_WARNING:")
                        || text.hasPrefix("WINDOW_STATE:")
                        || text.hasPrefix("PANE_LIST:") || text.hasPrefix("PANE_CONTENT:") {
                        Task { @MainActor in
                            self.onTextMessage?(text)
                        }
                    }
                @unknown default:
                    break
                }
                self.receiveMessage()

            case .failure(let error):
                self.handleError(error)
            }
        }
    }

    private func handleError(_ err: Error) {
        Task { @MainActor in
            self.isConnected = false
            self.error = err.localizedDescription
        }
    }

    private func reconnect() async {
        guard let info = reconnectInfo, let onData = onData else { return }
        try? await Task.sleep(for: .seconds(1))
        await MainActor.run {
            connect(
                baseURL: info.url,
                containerId: info.containerId,
                sessionName: info.sessionName,
                windowIndex: info.windowIndex,
                onData: onData,
                onTextMessage: onTextMessage
            )
        }
    }
}
