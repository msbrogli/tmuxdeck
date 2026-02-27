import SwiftUI

struct ContainerListView: View {
    @Bindable var viewModel: ContainerListViewModel
    @Binding var selectedContainer: ContainerResponse?
    @Environment(AppState.self) private var appState

    var body: some View {
        List(viewModel.filteredContainers, selection: $selectedContainer) { container in
            NavigationLink(value: container) {
                ContainerCardView(container: container)
            }
            .swipeActions(edge: .trailing) {
                if !container.isSpecial {
                    Button(role: .destructive) {
                        Task { await viewModel.deleteContainer(container) }
                    } label: {
                        Label("Remove", systemImage: "trash")
                    }
                }
            }
            .swipeActions(edge: .leading) {
                if !container.isSpecial {
                    if container.status.lowercased() == "running" {
                        Button {
                            Task { await viewModel.stopContainer(container) }
                        } label: {
                            Label("Stop", systemImage: "stop.circle")
                        }
                        .tint(.orange)
                    } else {
                        Button {
                            Task { await viewModel.startContainer(container) }
                        } label: {
                            Label("Start", systemImage: "play.circle")
                        }
                        .tint(.green)
                    }
                }
            }
            .contextMenu {
                if !container.isSpecial {
                    if container.status.lowercased() == "running" {
                        Button {
                            Task { await viewModel.stopContainer(container) }
                        } label: {
                            Label("Stop", systemImage: "stop.circle")
                        }
                    } else {
                        Button {
                            Task { await viewModel.startContainer(container) }
                        } label: {
                            Label("Start", systemImage: "play.circle")
                        }
                    }
                    Divider()
                    Button(role: .destructive) {
                        Task { await viewModel.deleteContainer(container) }
                    } label: {
                        Label("Remove", systemImage: "trash")
                    }
                }
            }
        }
        .searchable(text: $viewModel.searchText, prompt: "Search containers")
        .refreshable {
            await viewModel.loadContainers()
        }
        .navigationTitle("Containers")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button {
                        Task { await appState.logout() }
                    } label: {
                        Label("Logout", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                    Button {
                        appState.currentScreen = .serverSetup
                    } label: {
                        Label("Switch Server", systemImage: "server.rack")
                    }
                } label: {
                    Image(systemName: "gearshape")
                }
            }

            ToolbarItem(placement: .status) {
                if viewModel.isLoading {
                    ProgressView()
                }
            }
        }
        .overlay {
            if viewModel.containers.isEmpty && !viewModel.isLoading {
                ContentUnavailableView(
                    "No Containers",
                    systemImage: "shippingbox",
                    description: Text("Pull to refresh or check your server connection.")
                )
            }
        }
        .task {
            await viewModel.loadContainers()
        }
    }
}

struct ContainerCardView: View {
    let container: ContainerResponse

    var body: some View {
        HStack(spacing: 12) {
            statusIcon
                .frame(width: 36, height: 36)

            VStack(alignment: .leading, spacing: 4) {
                Text(container.displayName)
                    .font(.headline)
                    .lineLimit(1)

                HStack(spacing: 8) {
                    StatusBadge(status: container.status)

                    if !container.sessions.isEmpty {
                        Label("\(container.sessions.count)", systemImage: "terminal")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Spacer()

            if container.isLocal == true {
                Image(systemName: "laptopcomputer")
                    .foregroundStyle(.secondary)
            } else if container.isHost == true {
                Image(systemName: "desktopcomputer")
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var statusIcon: some View {
        let color: Color = {
            switch container.status.lowercased() {
            case "running": return .green
            case "exited", "stopped": return .red
            case "creating": return .yellow
            default: return .gray
            }
        }()

        Circle()
            .fill(color.opacity(0.2))
            .overlay {
                Image(systemName: container.isSpecial ? "server.rack" : "shippingbox")
                    .font(.system(size: 16))
                    .foregroundStyle(color)
            }
    }
}

struct StatusBadge: View {
    let status: String

    var body: some View {
        Text(status.capitalized)
            .font(.caption2)
            .fontWeight(.medium)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(backgroundColor.opacity(0.15))
            .foregroundStyle(backgroundColor)
            .clipShape(Capsule())
    }

    private var backgroundColor: Color {
        switch status.lowercased() {
        case "running": return .green
        case "exited", "stopped": return .red
        case "creating": return .yellow
        default: return .gray
        }
    }
}
