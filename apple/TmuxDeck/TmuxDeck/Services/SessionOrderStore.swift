import Foundation

@Observable
final class OrderingService {
    private let apiClient: APIClient
    private var containerOrder: [String] = []
    private var sessionOrders: [String: [String]] = [:]

    init(apiClient: APIClient) {
        self.apiClient = apiClient
    }

    // MARK: - Container ordering

    func sortedContainers(_ containers: [ContainerResponse]) -> [ContainerResponse] {
        guard !containerOrder.isEmpty else { return containers }
        let orderMap = Dictionary(uniqueKeysWithValues: containerOrder.enumerated().map { ($1, $0) })
        return containers.sorted { a, b in
            let ai = orderMap[a.id] ?? Int.max
            let bi = orderMap[b.id] ?? Int.max
            return ai < bi
        }
    }

    func fetchContainerOrder() async {
        if let response = try? await apiClient.getContainerOrder() {
            containerOrder = response.order
        }
    }

    func saveContainerOrder(_ ids: [String]) async {
        containerOrder = ids
        _ = try? await apiClient.saveContainerOrder(ids)
    }

    // MARK: - Session ordering

    func sortedSessions(_ sessions: [TmuxSessionResponse], for containerId: String) -> [TmuxSessionResponse] {
        let savedOrder = sessionOrders[containerId] ?? []
        guard !savedOrder.isEmpty else { return sessions }
        let orderMap = Dictionary(uniqueKeysWithValues: savedOrder.enumerated().map { ($1, $0) })
        return sessions.sorted { a, b in
            let ai = orderMap[a.id] ?? Int.max
            let bi = orderMap[b.id] ?? Int.max
            return ai < bi
        }
    }

    func fetchSessionOrder(for containerId: String) async {
        if let response = try? await apiClient.getSessionOrder(containerId: containerId) {
            sessionOrders[containerId] = response.order
        }
    }

    func saveSessionOrder(_ ids: [String], for containerId: String) async {
        sessionOrders[containerId] = ids
        _ = try? await apiClient.saveSessionOrder(containerId: containerId, order: ids)
    }
}
