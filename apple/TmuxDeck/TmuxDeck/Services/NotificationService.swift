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

        guard let apiClient = apiClient,
              let baseURL = apiClient.baseURL,
              let url = URL(string: "/api/v1/notifications/stream", relativeTo: baseURL) else { return }

        // Reuse the APIClient's URLSession so auth cookies are shared
        let session = apiClient.urlSession

        sseTask = Task { [weak self] in
            var retryCount = 0

            while !Task.isCancelled {
                do {
                    var request = URLRequest(url: url)
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    request.timeoutInterval = .infinity

                    let (bytes, response) = try await session.bytes(for: request)

                    guard let httpResponse = response as? HTTPURLResponse,
                          httpResponse.statusCode == 200 else {
                        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
                        if statusCode == 401 {
                            // Not authenticated — stop retrying, let AppState handle re-auth
                            break
                        }
                        // Other errors: exponential backoff (5s, 10s, 20s, ... max 60s)
                        let delay = min(5.0 * pow(2.0, Double(retryCount)), 60.0)
                        retryCount += 1
                        try await Task.sleep(for: .seconds(delay))
                        continue
                    }

                    // Connected successfully — reset backoff
                    retryCount = 0

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
                        let delay = min(5.0 * pow(2.0, Double(retryCount)), 60.0)
                        retryCount += 1
                        try? await Task.sleep(for: .seconds(delay))
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
