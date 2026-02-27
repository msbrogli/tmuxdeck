import Foundation

struct ServerConfig: Codable, Identifiable, Hashable {
    let id: UUID
    var name: String
    var url: String
    var isActive: Bool

    init(name: String, url: String, isActive: Bool = false) {
        self.id = UUID()
        self.name = name
        self.url = url
        self.isActive = isActive
    }

    var baseURL: URL? {
        var urlString = url
        if !urlString.hasPrefix("http://") && !urlString.hasPrefix("https://") {
            urlString = "http://\(urlString)"
        }
        return URL(string: urlString)
    }

    var wsBaseURL: URL? {
        guard let base = baseURL else { return nil }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        components?.scheme = base.scheme == "https" ? "wss" : "ws"
        return components?.url
    }
}

extension ServerConfig {
    static let storageKey = "tmuxdeck_servers"

    static func loadAll() -> [ServerConfig] {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let servers = try? JSONDecoder().decode([ServerConfig].self, from: data) else {
            return []
        }
        return servers
    }

    static func saveAll(_ servers: [ServerConfig]) {
        if let data = try? JSONEncoder().encode(servers) {
            UserDefaults.standard.set(data, forKey: storageKey)
        }
    }
}
