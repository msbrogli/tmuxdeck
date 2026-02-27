import Foundation

@Observable
final class APIClient {
    var baseURL: URL?
    var isConnected = false
    var lastError: APIError?

    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init() {
        let config = URLSessionConfiguration.default
        config.httpCookieAcceptPolicy = .always
        config.httpShouldSetCookies = true
        config.httpCookieStorage = .shared
        self.session = URLSession(configuration: config)

        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    func configure(with server: ServerConfig) {
        self.baseURL = server.baseURL
    }

    // MARK: - Auth

    func authStatus() async throws -> AuthStatus {
        try await get("/api/v1/auth/status")
    }

    func login(pin: String) async throws {
        let _: OkResponse = try await post("/api/v1/auth/login", body: PINRequest(pin: pin))
    }

    func logout() async throws {
        let _: OkResponse = try await post("/api/v1/auth/logout", body: Empty?.none)
    }

    func setupPIN(pin: String) async throws {
        let _: OkResponse = try await post("/api/v1/auth/setup", body: PINRequest(pin: pin))
    }

    func changePIN(currentPin: String, newPin: String) async throws {
        let _: OkResponse = try await post(
            "/api/v1/auth/change-pin",
            body: ChangePINRequest(currentPin: currentPin, newPin: newPin)
        )
    }

    // MARK: - Containers

    func getContainers() async throws -> ContainerListResponse {
        try await get("/api/v1/containers")
    }

    func getContainer(id: String) async throws -> ContainerResponse {
        try await get("/api/v1/containers/\(id)")
    }

    func startContainer(id: String) async throws {
        try await postNoContent("/api/v1/containers/\(id)/start")
    }

    func stopContainer(id: String) async throws {
        try await postNoContent("/api/v1/containers/\(id)/stop")
    }

    func deleteContainer(id: String) async throws {
        try await delete("/api/v1/containers/\(id)")
    }

    func renameContainer(id: String, displayName: String) async throws -> ContainerResponse {
        try await patch("/api/v1/containers/\(id)", body: RenameContainerRequest(displayName: displayName))
    }

    func createContainer(_ request: CreateContainerRequest) async throws -> ContainerResponse {
        try await post("/api/v1/containers", body: request)
    }

    // MARK: - Sessions

    func getSessions(containerId: String) async throws -> [TmuxSessionResponse] {
        try await get("/api/v1/containers/\(containerId)/sessions")
    }

    func createSession(containerId: String, name: String) async throws -> TmuxSessionResponse {
        try await post(
            "/api/v1/containers/\(containerId)/sessions",
            body: CreateSessionRequest(name: name)
        )
    }

    func renameSession(containerId: String, sessionId: String, name: String) async throws {
        try await patchNoContent(
            "/api/v1/containers/\(containerId)/sessions/\(sessionId)",
            body: RenameSessionRequest(name: name)
        )
    }

    func deleteSession(containerId: String, sessionId: String) async throws {
        try await delete("/api/v1/containers/\(containerId)/sessions/\(sessionId)")
    }

    // MARK: - Windows

    func createWindow(containerId: String, sessionId: String, name: String? = nil) async throws -> [TmuxWindowResponse] {
        try await post(
            "/api/v1/containers/\(containerId)/sessions/\(sessionId)/windows",
            body: CreateWindowRequest(name: name)
        )
    }

    func swapWindows(containerId: String, sessionId: String, index1: Int, index2: Int) async throws {
        try await postNoContent(
            "/api/v1/containers/\(containerId)/sessions/\(sessionId)/swap-windows",
            body: SwapWindowsRequest(index1: index1, index2: index2)
        )
    }

    func moveWindow(containerId: String, sessionId: String, windowIndex: Int, targetSessionId: String) async throws {
        try await postNoContent(
            "/api/v1/containers/\(containerId)/sessions/\(sessionId)/move-window",
            body: MoveWindowRequest(windowIndex: windowIndex, targetSessionId: targetSessionId)
        )
    }

    // MARK: - Templates

    func getTemplates() async throws -> [TemplateResponse] {
        try await get("/api/v1/templates")
    }

    // MARK: - Settings

    func getSettings() async throws -> SettingsResponse {
        try await get("/api/v1/settings")
    }

    func updateSettings(_ request: UpdateSettingsRequest) async throws -> SettingsResponse {
        try await post("/api/v1/settings", body: request)
    }

    // MARK: - Notifications

    func getNotifications() async throws -> [NotificationResponse] {
        try await get("/api/v1/notifications")
    }

    func dismissNotifications(_ request: DismissRequest) async throws {
        let _: [String: Int] = try await post("/api/v1/notifications/dismiss", body: request)
    }

    // MARK: - Health

    func healthCheck() async throws -> Bool {
        do {
            let _: [String: String] = try await get("/health")
            isConnected = true
            return true
        } catch {
            isConnected = false
            throw error
        }
    }

    // MARK: - Generic Request Methods

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let request = try makeRequest(path: path, method: "GET")
        return try await perform(request)
    }

    private func post<T: Decodable, B: Encodable>(_ path: String, body: B?) async throws -> T {
        var request = try makeRequest(path: path, method: "POST")
        if let body = body {
            request.httpBody = try encoder.encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return try await perform(request)
    }

    private func postNoContent<B: Encodable>(_ path: String, body: B? = Empty?.none) async throws {
        var request = try makeRequest(path: path, method: "POST")
        if let body = body {
            request.httpBody = try encoder.encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (_, response) = try await session.data(for: request)
        try validateResponse(response)
    }

    private func patch<T: Decodable, B: Encodable>(_ path: String, body: B) async throws -> T {
        var request = try makeRequest(path: path, method: "PATCH")
        request.httpBody = try encoder.encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await perform(request)
    }

    private func patchNoContent<B: Encodable>(_ path: String, body: B) async throws {
        var request = try makeRequest(path: path, method: "PATCH")
        request.httpBody = try encoder.encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (_, response) = try await session.data(for: request)
        try validateResponse(response)
    }

    private func delete(_ path: String) async throws {
        let request = try makeRequest(path: path, method: "DELETE")
        let (_, response) = try await session.data(for: request)
        try validateResponse(response)
    }

    private func makeRequest(path: String, method: String) throws -> URLRequest {
        guard let baseURL = baseURL else {
            throw APIError.noServer
        }
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw APIError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        return request
    }

    private func perform<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: request)
        try validateResponse(response)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decodingFailed(error)
        }
    }

    private func validateResponse(_ response: URLResponse) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        switch httpResponse.statusCode {
        case 200...299:
            return
        case 401:
            throw APIError.unauthorized
        case 404:
            throw APIError.notFound
        default:
            throw APIError.serverError(httpResponse.statusCode)
        }
    }
}

private struct Empty: Encodable {}

enum APIError: LocalizedError {
    case noServer
    case invalidURL
    case invalidResponse
    case unauthorized
    case notFound
    case serverError(Int)
    case decodingFailed(Error)
    case networkError(Error)

    var errorDescription: String? {
        switch self {
        case .noServer: return "No server configured"
        case .invalidURL: return "Invalid URL"
        case .invalidResponse: return "Invalid response"
        case .unauthorized: return "Not authenticated"
        case .notFound: return "Resource not found"
        case .serverError(let code): return "Server error (\(code))"
        case .decodingFailed(let error): return "Failed to decode response: \(error.localizedDescription)"
        case .networkError(let error): return error.localizedDescription
        }
    }
}
