import Foundation

@Observable
final class AppState {
    enum Screen {
        case serverSetup
        case login
        case pinSetup
        case main
    }

    var currentScreen: Screen = .serverSetup
    var activeServer: ServerConfig?
    var isLoading = false
    var errorMessage: String?

    let apiClient = APIClient()
    let notificationService = NotificationService()

    var servers: [ServerConfig] = ServerConfig.loadAll() {
        didSet {
            ServerConfig.saveAll(servers)
        }
    }

    init() {
        notificationService.configure(apiClient: apiClient)

        if let active = servers.first(where: { $0.isActive }) {
            activeServer = active
            apiClient.configure(with: active)
        }
    }

    func selectServer(_ server: ServerConfig) {
        for i in servers.indices {
            servers[i].isActive = (servers[i].id == server.id)
        }
        activeServer = server
        apiClient.configure(with: server)
    }

    func addServer(name: String, url: String) {
        let server = ServerConfig(name: name, url: url, isActive: servers.isEmpty)
        servers.append(server)
        if server.isActive {
            activeServer = server
            apiClient.configure(with: server)
        }
    }

    func removeServer(_ server: ServerConfig) {
        servers.removeAll { $0.id == server.id }
        if server.id == activeServer?.id {
            activeServer = servers.first
            if let active = activeServer {
                apiClient.configure(with: active)
            }
        }
    }

    func checkAuthAndNavigate() async {
        guard activeServer != nil else {
            currentScreen = .serverSetup
            return
        }

        isLoading = true
        defer { isLoading = false }

        do {
            let status = try await apiClient.authStatus()
            if !status.pinSet {
                currentScreen = .pinSetup
            } else if !status.authenticated {
                currentScreen = .login
            } else {
                currentScreen = .main
                notificationService.startListening()
            }
        } catch {
            errorMessage = error.localizedDescription
            currentScreen = .login
        }
    }

    func loginWithPIN(_ pin: String) async throws {
        try await apiClient.login(pin: pin)
        currentScreen = .main
        notificationService.startListening()
    }

    func setupPIN(_ pin: String) async throws {
        try await apiClient.setupPIN(pin: pin)
        currentScreen = .main
        notificationService.startListening()
    }

    func logout() async {
        try? await apiClient.logout()
        notificationService.stopListening()
        currentScreen = .login
    }
}
