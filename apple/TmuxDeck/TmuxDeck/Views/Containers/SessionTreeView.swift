import SwiftUI

struct SessionTreeView: View {
    let apiClient: APIClient
    let container: ContainerResponse
    @Binding var selectedDestination: SessionDestination?

    @State private var sessions: [TmuxSessionResponse] = []
    @State private var expandedSessions: Set<String> = []
    @State private var isLoading = false
    @State private var error: String?
    @State private var showNewSession = false
    @State private var newSessionName = ""
    @State private var inlineEditingSessionId: String?
    @State private var inlineEditName = ""

    var body: some View {
        List {
            ForEach(sessions) { session in
                Section {
                    DisclosureGroup(
                        isExpanded: Binding(
                            get: { expandedSessions.contains(session.id) },
                            set: { expanded in
                                if expanded {
                                    expandedSessions.insert(session.id)
                                } else {
                                    expandedSessions.remove(session.id)
                                }
                            }
                        )
                    ) {
                        ForEach(session.windows) { window in
                            Button {
                                selectedDestination = SessionDestination(container: container, session: session)
                            } label: {
                                WindowRow(window: window)
                            }
                            .listRowBackground(
                                selectedDestination?.session.id == session.id
                                    ? Color.accentColor.opacity(0.15)
                                    : nil
                            )
                        }
                    } label: {
                        if inlineEditingSessionId == session.id {
                            InlineSessionRenameField(
                                name: $inlineEditName,
                                onCommit: {
                                    Task { await commitInlineRename(session: session) }
                                }
                            )
                        } else {
                            SessionHeader(session: session)
                                .onLongPressGesture {
                                    inlineEditingSessionId = session.id
                                    inlineEditName = session.name
                                }
                        }
                    }
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        Task { await deleteSession(session) }
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }
        }
        .navigationTitle(container.displayName)
        .refreshable {
            await loadSessions()
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showNewSession = true
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .overlay {
            if sessions.isEmpty && !isLoading {
                ContentUnavailableView(
                    "No Sessions",
                    systemImage: "terminal",
                    description: Text(
                        container.status.lowercased() == "running"
                            ? "Tap + to create a session."
                            : "Container is not running."
                    )
                )
            }
        }
        .alert("New Session", isPresented: $showNewSession) {
            TextField("Session name", text: $newSessionName)
            Button("Create") {
                Task { await createSession() }
            }
            Button("Cancel", role: .cancel) {
                newSessionName = ""
            }
        }
        .task {
            sessions = container.sessions
            expandedSessions = Set(sessions.map(\.id))
            if container.status.lowercased() == "running" {
                await loadSessions()
            }
        }
    }

    private func loadSessions() async {
        isLoading = true
        do {
            sessions = try await apiClient.getSessions(containerId: container.id)
            expandedSessions = Set(sessions.map(\.id))
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    private func createSession() async {
        guard !newSessionName.isEmpty else { return }
        do {
            _ = try await apiClient.createSession(containerId: container.id, name: newSessionName)
            newSessionName = ""
            await loadSessions()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func commitInlineRename(session: TmuxSessionResponse) async {
        let newName = inlineEditName.trimmingCharacters(in: .whitespaces)
        inlineEditingSessionId = nil
        guard !newName.isEmpty else { return }
        try? await apiClient.renameSession(containerId: container.id, sessionId: session.id, name: newName)
        inlineEditName = ""
        await loadSessions()
    }

    private func deleteSession(_ session: TmuxSessionResponse) async {
        do {
            try await apiClient.deleteSession(containerId: container.id, sessionId: session.id)
            await loadSessions()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct SessionHeader: View {
    let session: TmuxSessionResponse

    var body: some View {
        HStack {
            Image(systemName: "terminal")
                .foregroundStyle(.tint)

            VStack(alignment: .leading) {
                Text(session.name)
                    .font(.headline)
                Text("\(session.windows.count) window\(session.windows.count == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if session.attached {
                Image(systemName: "link.circle.fill")
                    .foregroundStyle(.green)
                    .font(.caption)
            }
        }
    }
}

struct WindowRow: View {
    let window: TmuxWindowResponse

    var body: some View {
        HStack {
            Image(systemName: "rectangle.split.3x1")
                .font(.caption)
                .foregroundStyle(.secondary)

            PaneStatusDot(window: window)

            Text("\(window.index): \(window.name)")
                .font(.subheadline)

            if window.command.lowercased().contains("claude") && window.paneStatus.isEmpty {
                ClaudeHooksHintIcon()
            }

            Spacer()

            if window.bell {
                Image(systemName: "bell.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            if window.activity {
                Image(systemName: "circle.fill")
                    .font(.system(size: 6))
                    .foregroundStyle(.blue)
            }

            if window.active {
                Image(systemName: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
            }
        }
    }
}

struct InlineSessionRenameField: View {
    @Binding var name: String
    let onCommit: () -> Void

    var body: some View {
        HStack {
            Image(systemName: "terminal")
                .foregroundStyle(.tint)
            TextField("Session name", text: $name)
                .font(.headline)
                .textFieldStyle(.roundedBorder)
                .onSubmit { onCommit() }
        }
    }
}
