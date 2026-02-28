import Foundation

struct SessionOrderStore {
    private static func key(for containerId: String) -> String {
        "tmuxdeck_sessionOrder_\(containerId)"
    }

    func sorted(sessions: [TmuxSessionResponse], for containerId: String) -> [TmuxSessionResponse] {
        let savedOrder = UserDefaults.standard.stringArray(forKey: Self.key(for: containerId)) ?? []
        guard !savedOrder.isEmpty else { return sessions }

        let orderMap = Dictionary(uniqueKeysWithValues: savedOrder.enumerated().map { ($1, $0) })
        return sessions.sorted { a, b in
            let ai = orderMap[a.id] ?? Int.max
            let bi = orderMap[b.id] ?? Int.max
            return ai < bi
        }
    }

    func setOrder(sessionIds: [String], for containerId: String) {
        UserDefaults.standard.set(sessionIds, forKey: Self.key(for: containerId))
    }
}
