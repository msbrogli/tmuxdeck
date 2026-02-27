import Foundation

@Observable
final class NotificationService {
    var notifications: [NotificationResponse] = []
    var unreadCount: Int { notifications.count }

    private var sseTask: Task<Void, Never>?
    private var apiClient: APIClient?

    func configure(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    func startListening() {
        stopListening()

        guard let baseURL = apiClient?.baseURL else { return }
        guard let url = URL(string: "/api/v1/notifications/stream", relativeTo: baseURL) else { return }

        sseTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    var request = URLRequest(url: url)
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    request.timeoutInterval = .infinity

                    let config = URLSessionConfiguration.default
                    config.httpCookieAcceptPolicy = .always
                    config.httpShouldSetCookies = true
                    config.httpCookieStorage = .shared
                    config.timeoutIntervalForRequest = .infinity
                    config.timeoutIntervalForResource = .infinity
                    let session = URLSession(configuration: config)

                    let (bytes, response) = try await session.bytes(for: request)

                    guard let httpResponse = response as? HTTPURLResponse,
                          httpResponse.statusCode == 200 else {
                        try await Task.sleep(for: .seconds(5))
                        continue
                    }

                    for try await line in bytes.lines {
                        guard !Task.isCancelled else { break }
                        if line.hasPrefix("data: ") {
                            let jsonString = String(line.dropFirst(6))
                            if let data = jsonString.data(using: .utf8),
                               let notification = try? JSONDecoder().decode(NotificationResponse.self, from: data) {
                                await MainActor.run {
                                    self?.notifications.insert(notification, at: 0)
                                }
                            }
                        }
                    }
                } catch {
                    if !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(5))
                    }
                }
            }
        }
    }

    func stopListening() {
        sseTask?.cancel()
        sseTask = nil
    }

    func fetchNotifications() async {
        guard let apiClient = apiClient else { return }
        do {
            let fetched = try await apiClient.getNotifications()
            await MainActor.run {
                notifications = fetched
            }
        } catch {
            // Silently fail — notifications are non-critical
        }
    }

    func dismiss(containerId: String, sessionName: String) async {
        guard let apiClient = apiClient else { return }
        let request = DismissRequest(containerId: containerId, tmuxSession: sessionName)
        try? await apiClient.dismissNotifications(request)
        notifications.removeAll { $0.containerId == containerId && $0.tmuxSession == sessionName }
    }

    func clearAll() {
        notifications.removeAll()
    }
}
