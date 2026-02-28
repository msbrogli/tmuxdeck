import SwiftUI

/// Unified sidebar: Containers -> Sessions -> Windows in a single tree.
/// Tapping a window selects it and opens the terminal in the detail pane.
struct SidebarView: View {
    let apiClient: APIClient
    @Binding var selection: TerminalTarget?
    @Environment(AppState.self) private var appState

    @State private var containers: [ContainerResponse] = []
    @State private var isLoading = false
    @State private var searchText = ""
    private let sessionOrderStore = SessionOrderStore()
    @State private var showNewSession = false
    @State private var showSettings = false
    @State private var showCreateContainer = false
    @State private var newSessionContainerId = ""
    @State private var newSessionName = ""
    // Rename session
    @State private var showRenameSession = false
    @State private var renameSessionContainerId = ""
    @State private var renameSessionId = ""
    @State private var renameSessionName = ""
    // Move window to session
    @State private var showMoveWindow = false
    @State private var moveWindowContainerId = ""
    @State private var moveWindowSessionId = ""
    @State private var moveWindowIndex = 0
    @State private var moveWindowSessions: [TmuxSessionResponse] = []

    var body: some View {
        List(selection: $selection) {
            ForEach(filteredContainers) { container in
                Section {
                    containerTree(container)
                } header: {
                    ContainerHeader(container: container)
                }
            }
        }
        .listStyle(.sidebar)
        .searchable(text: $searchText, prompt: "Search")
        .refreshable { await loadContainers() }
        .navigationTitle("TmuxDeck")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                HStack(spacing: 4) {
                    Button {
                        showCreateContainer = true
                    } label: {
                        Image(systemName: "plus")
                    }

                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            NavigationStack {
                SettingsView()
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showSettings = false }
                        }
                    }
            }
        }
        .sheet(isPresented: $showCreateContainer) {
            CreateContainerView(apiClient: apiClient) {
                Task { await loadContainers() }
            }
        }
        .sheet(isPresented: $showMoveWindow) {
            NavigationStack {
                List(moveWindowSessions) { session in
                    Button(session.name) {
                        Task {
                            await moveWindow(to: session.id)
                        }
                    }
                }
                .navigationTitle("Move to Session")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { showMoveWindow = false }
                    }
                }
            }
            .presentationDetents([.medium])
        }
        .overlay {
            if containers.isEmpty && !isLoading {
                ContentUnavailableView(
                    "No Containers",
                    systemImage: "shippingbox",
                    description: Text("Pull to refresh or tap + to create.")
                )
            }
        }
        .task { await loadContainers() }
        .alert("New Session", isPresented: $showNewSession) {
            TextField("Session name", text: $newSessionName)
            Button("Create") {
                Task { await createSession() }
            }
            Button("Cancel", role: .cancel) { newSessionName = "" }
        }
        .alert("Rename Session", isPresented: $showRenameSession) {
            TextField("New name", text: $renameSessionName)
            Button("Rename") {
                Task { await renameSession() }
            }
            Button("Cancel", role: .cancel) { renameSessionName = "" }
        }
    }

    private var filteredContainers: [ContainerResponse] {
        if searchText.isEmpty { return containers }
        let q = searchText.lowercased()
        return containers.filter { c in
            c.displayName.lowercased().contains(q) ||
            c.sessions.contains { s in
                s.name.lowercased().contains(q) ||
                s.windows.contains { $0.name.lowercased().contains(q) }
            }
        }
    }

    @ViewBuilder
    private func containerTree(_ container: ContainerResponse) -> some View {
        if container.status.lowercased() != "running" {
            HStack {
                Text("Not running")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if !container.isSpecial {
                    Button("Start") {
                        Task { await startContainer(container) }
                    }
                    .font(.caption)
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                }
            }
        } else if container.sessions.isEmpty {
            HStack {
                Text("No sessions")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    newSessionContainerId = container.id
                    showNewSession = true
                } label: {
                    Image(systemName: "plus.circle")
                        .font(.caption)
                }
            }
        } else {
            let orderedSessions = sessionOrderStore.sorted(sessions: container.sessions, for: container.id)
            ForEach(orderedSessions) { session in
                DisclosureGroup {
                    ForEach(session.windows) { window in
                        let target = TerminalTarget(
                            containerId: container.id,
                            containerName: container.displayName,
                            session: session,
                            windowIndex: window.index
                        )
                        Label {
                            HStack(spacing: 6) {
                                PaneStatusDot(window: window)
                                Text("\(window.index): \(window.name)")
                                    .font(.subheadline)
                                    .lineLimit(1)
                                if window.command.lowercased().contains("claude") && window.paneStatus.isEmpty {
                                    ClaudeHooksHintIcon()
                                }
                                Spacer()
                                if window.bell {
                                    Image(systemName: "bell.fill")
                                        .font(.system(size: 8))
                                        .foregroundStyle(.orange)
                                }
                                if window.activity {
                                    Circle().fill(.blue).frame(width: 5, height: 5)
                                }
                                if window.active {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 9, weight: .bold))
                                        .foregroundStyle(.green)
                                }
                            }
                        } icon: {
                            Image(systemName: "rectangle.split.3x1")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .tag(target)
                        .contextMenu {
                            if window.index > 0 {
                                Button {
                                    Task {
                                        await swapWindows(
                                            containerId: container.id,
                                            sessionId: session.id,
                                            index1: window.index,
                                            index2: window.index - 1
                                        )
                                    }
                                } label: {
                                    Label("Move Up", systemImage: "arrow.up")
                                }
                            }

                            if window.index < session.windows.count - 1 {
                                Button {
                                    Task {
                                        await swapWindows(
                                            containerId: container.id,
                                            sessionId: session.id,
                                            index1: window.index,
                                            index2: window.index + 1
                                        )
                                    }
                                } label: {
                                    Label("Move Down", systemImage: "arrow.down")
                                }
                            }

                            if container.sessions.count > 1 {
                                Button {
                                    moveWindowContainerId = container.id
                                    moveWindowSessionId = session.id
                                    moveWindowIndex = window.index
                                    moveWindowSessions = container.sessions.filter { $0.id != session.id }
                                    showMoveWindow = true
                                } label: {
                                    Label("Move to Session...", systemImage: "arrow.right.square")
                                }
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "terminal")
                            .font(.caption)
                            .foregroundStyle(.tint)
                        Text(session.name)
                            .font(.subheadline)
                            .fontWeight(.medium)
                        Spacer()
                        Text("\(session.windows.count)w")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        if session.attached {
                            Image(systemName: "link.circle.fill")
                                .font(.system(size: 10))
                                .foregroundStyle(.green)
                        }
                    }
                }
                .contextMenu {
                    Button {
                        renameSessionContainerId = container.id
                        renameSessionId = session.id
                        renameSessionName = session.name
                        showRenameSession = true
                    } label: {
                        Label("Rename", systemImage: "pencil")
                    }

                    Button {
                        newSessionContainerId = container.id
                        showNewSession = true
                    } label: {
                        Label("New Session", systemImage: "plus")
                    }

                    Button(role: .destructive) {
                        Task { await deleteSession(container.id, session.id) }
                    } label: {
                        Label("Delete Session", systemImage: "trash")
                    }
                }
            }
            .onMove { source, destination in
                var ids = orderedSessions.map(\.id)
                ids.move(fromOffsets: source, toOffset: destination)
                sessionOrderStore.setOrder(sessionIds: ids, for: container.id)
            }
        }
    }

    // MARK: - Actions

    private func loadContainers() async {
        isLoading = true
        do {
            let response = try await apiClient.getContainers()
            containers = response.containers
        } catch {}
        isLoading = false
    }

    private func startContainer(_ container: ContainerResponse) async {
        try? await apiClient.startContainer(id: container.id)
        await loadContainers()
    }

    private func createSession() async {
        guard !newSessionName.isEmpty else { return }
        _ = try? await apiClient.createSession(containerId: newSessionContainerId, name: newSessionName)
        newSessionName = ""
        await loadContainers()
    }

    private func deleteSession(_ containerId: String, _ sessionId: String) async {
        try? await apiClient.deleteSession(containerId: containerId, sessionId: sessionId)
        await loadContainers()
    }

    private func renameSession() async {
        guard !renameSessionName.isEmpty else { return }
        try? await apiClient.renameSession(
            containerId: renameSessionContainerId,
            sessionId: renameSessionId,
            name: renameSessionName
        )
        renameSessionName = ""
        await loadContainers()
    }

    private func swapWindows(containerId: String, sessionId: String, index1: Int, index2: Int) async {
        try? await apiClient.swapWindows(
            containerId: containerId,
            sessionId: sessionId,
            index1: index1,
            index2: index2
        )
        await loadContainers()
    }

    private func moveWindow(to targetSessionId: String) async {
        try? await apiClient.moveWindow(
            containerId: moveWindowContainerId,
            sessionId: moveWindowSessionId,
            windowIndex: moveWindowIndex,
            targetSessionId: targetSessionId
        )
        showMoveWindow = false
        await loadContainers()
    }
}

// MARK: - Supporting Types

struct TerminalTarget: Hashable, Identifiable {
    let containerId: String
    let containerName: String
    let session: TmuxSessionResponse
    let windowIndex: Int

    var id: String { "\(containerId)-\(session.id)-\(windowIndex)" }
}

struct ContainerHeader: View {
    let container: ContainerResponse

    var body: some View {
        HStack(spacing: 6) {
            statusDot
            VStack(alignment: .leading, spacing: 1) {
                Text(container.displayName)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .textCase(nil)
                    .foregroundStyle(.primary)

                if !container.isSpecial && !container.image.isEmpty {
                    Text(container.image)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .textCase(nil)
                        .lineLimit(1)
                }
            }

            if container.isLocal == true {
                Image(systemName: "laptopcomputer")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            } else if container.isHost == true {
                Image(systemName: "desktopcomputer")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var statusDot: some View {
        Circle()
            .fill(statusColor)
            .frame(width: 7, height: 7)
    }

    private var statusColor: Color {
        switch container.status.lowercased() {
        case "running": return .green
        case "exited", "stopped": return .red
        case "creating": return .yellow
        default: return .gray
        }
    }
}
