import Foundation
import AVFoundation

@Observable
final class ServerDiscovery: NSObject {
    var discoveredServers: [DiscoveredServer] = []
    var isScanning = false
    var scannedURL: String?

    private var browser: NetServiceBrowser?
    private var services: [NetService] = []

    struct DiscoveredServer: Identifiable {
        let id = UUID()
        let name: String
        let host: String
        let port: Int

        var url: String { "http://\(host):\(port)" }
    }

    func startBonjourDiscovery() {
        isScanning = true
        discoveredServers = []
        browser = NetServiceBrowser()
        browser?.delegate = self
        browser?.searchForServices(ofType: "_http._tcp.", inDomain: "local.")
    }

    func stopDiscovery() {
        browser?.stop()
        browser = nil
        isScanning = false
    }

    func parseQRCode(_ value: String) -> String? {
        var url = value
        if url.hasPrefix("tmuxdeck://") {
            url = "http://" + url.dropFirst("tmuxdeck://".count)
        }
        guard URL(string: url) != nil else { return nil }
        scannedURL = url
        return url
    }

    func validateServer(url: String) async -> Bool {
        guard let serverURL = URL(string: url),
              let healthURL = URL(string: "/health", relativeTo: serverURL) else {
            return false
        }

        do {
            let (data, response) = try await URLSession.shared.data(from: healthURL)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                return false
            }
            let result = try JSONDecoder().decode([String: String].self, from: data)
            return result["status"] == "ok"
        } catch {
            return false
        }
    }
}

extension ServerDiscovery: NetServiceBrowserDelegate {
    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        if service.name.lowercased().contains("tmuxdeck") {
            services.append(service)
            service.delegate = self
            service.resolve(withTimeout: 5.0)
        }
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
        isScanning = false
    }

    func netServiceBrowserDidStopSearch(_ browser: NetServiceBrowser) {
        isScanning = false
    }
}

extension ServerDiscovery: NetServiceDelegate {
    func netServiceDidResolveAddress(_ sender: NetService) {
        guard let hostname = sender.hostName else { return }
        let server = DiscoveredServer(
            name: sender.name,
            host: hostname,
            port: sender.port
        )
        Task { @MainActor in
            discoveredServers.append(server)
        }
    }
}
