import Foundation

@Observable
final class TerminalPoolService {
    struct PoolEntry {
        let connection: TerminalConnection
        var lastAccessedAt: Date
    }

    private(set) var entries: [String: PoolEntry] = [:]
    private var activeKey: String?
    private var idleTimer: Timer?
    let maxPoolSize: Int

    init(maxPoolSize: Int = 8) {
        self.maxPoolSize = maxPoolSize
        startIdleEviction()
    }

    deinit {
        idleTimer?.invalidate()
        for entry in entries.values {
            entry.connection.disconnect()
        }
    }

    static func key(containerId: String, sessionName: String) -> String {
        "\(containerId)-\(sessionName)"
    }

    func connection(for containerId: String, sessionName: String) -> TerminalConnection {
        let key = Self.key(containerId: containerId, sessionName: sessionName)

        if let existing = entries[key] {
            entries[key]?.lastAccessedAt = Date()
            return existing.connection
        }

        // Evict if at capacity
        while entries.count >= maxPoolSize {
            evictLRU()
        }

        let conn = TerminalConnection()
        entries[key] = PoolEntry(connection: conn, lastAccessedAt: Date())
        return conn
    }

    func setActive(containerId: String, sessionName: String) {
        let key = Self.key(containerId: containerId, sessionName: sessionName)
        activeKey = key
        entries[key]?.lastAccessedAt = Date()
    }

    func touch(containerId: String, sessionName: String) {
        let key = Self.key(containerId: containerId, sessionName: sessionName)
        entries[key]?.lastAccessedAt = Date()
    }

    func remove(containerId: String, sessionName: String) {
        let key = Self.key(containerId: containerId, sessionName: sessionName)
        entries[key]?.connection.disconnect()
        entries.removeValue(forKey: key)
        if activeKey == key {
            activeKey = nil
        }
    }

    private func evictLRU() {
        guard let oldest = entries
            .filter({ $0.key != activeKey })
            .min(by: { $0.value.lastAccessedAt < $1.value.lastAccessedAt })
        else { return }

        oldest.value.connection.disconnect()
        entries.removeValue(forKey: oldest.key)
    }

    private func startIdleEviction() {
        idleTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.evictIdle()
        }
    }

    private func evictIdle() {
        let cutoff = Date().addingTimeInterval(-60)
        let idleKeys = entries.filter { entry in
            entry.key != activeKey && entry.value.lastAccessedAt < cutoff
        }.map(\.key)

        for key in idleKeys {
            entries[key]?.connection.disconnect()
            entries.removeValue(forKey: key)
        }
    }
}
