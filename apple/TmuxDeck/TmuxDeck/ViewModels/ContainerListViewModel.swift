import Foundation

@Observable
final class ContainerListViewModel {
    var containers: [ContainerResponse] = []
    var isLoading = false
    var error: String?
    var dockerError: String?
    var searchText = ""

    private let apiClient: APIClient
    let orderingService: OrderingService

    init(apiClient: APIClient) {
        self.apiClient = apiClient
        self.orderingService = OrderingService(apiClient: apiClient)
    }

    var filteredContainers: [ContainerResponse] {
        let ordered = orderingService.sortedContainers(containers)
        if searchText.isEmpty {
            return ordered
        }
        return ordered.filter {
            $0.displayName.localizedCaseInsensitiveContains(searchText) ||
            $0.name.localizedCaseInsensitiveContains(searchText)
        }
    }

    var runningCount: Int {
        containers.filter { $0.status.lowercased() == "running" }.count
    }

    func loadContainers() async {
        isLoading = true
        error = nil

        do {
            async let containersFetch = apiClient.getContainers()
            async let orderFetch: () = orderingService.fetchContainerOrder()
            let response = try await containersFetch
            _ = await orderFetch
            containers = response.containers
            dockerError = response.dockerError
        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }

    func startContainer(_ container: ContainerResponse) async {
        do {
            try await apiClient.startContainer(id: container.id)
            await loadContainers()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func stopContainer(_ container: ContainerResponse) async {
        do {
            try await apiClient.stopContainer(id: container.id)
            await loadContainers()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func deleteContainer(_ container: ContainerResponse) async {
        do {
            try await apiClient.deleteContainer(id: container.id)
            await loadContainers()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func renameContainer(_ container: ContainerResponse, newName: String) async {
        do {
            _ = try await apiClient.renameContainer(id: container.id, displayName: newName)
            await loadContainers()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
