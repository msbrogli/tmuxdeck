import SwiftUI

struct QuickSwitcherView: View {
    @Binding var isPresented: Bool
    @Environment(AppState.self) private var appState
    @State private var searchText = ""
    @State private var results: [SwitcherItem] = []
    @State private var allItems: [SwitcherItem] = []
    @FocusState private var isSearchFocused: Bool

    struct SwitcherItem: Identifiable {
        let id = UUID()
        let containerName: String
        let containerId: String
        let sessionName: String
        let windowName: String?
        let windowIndex: Int?

        var displayTitle: String {
            if let windowName = windowName, let windowIndex = windowIndex {
                return "\(containerName) / \(sessionName) / \(windowIndex):\(windowName)"
            }
            return "\(containerName) / \(sessionName)"
        }

        var icon: String {
            windowName != nil ? "rectangle.split.3x1" : "terminal"
        }
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.4)
                .ignoresSafeArea()
                .onTapGesture {
                    isPresented = false
                }

            VStack(spacing: 0) {
                HStack {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(.secondary)

                    TextField("Search sessions and windows...", text: $searchText)
                        .textFieldStyle(.plain)
                        .focused($isSearchFocused)
                        .onChange(of: searchText) { _, newValue in
                            filterResults(query: newValue)
                        }

                    Button {
                        isPresented = false
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
                .padding()
                .background(.ultraThickMaterial)

                Divider()

                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(results) { item in
                            Button {
                                selectItem(item)
                            } label: {
                                HStack {
                                    Image(systemName: item.icon)
                                        .frame(width: 24)
                                        .foregroundStyle(.secondary)

                                    Text(item.displayTitle)
                                        .font(.subheadline)
                                        .lineLimit(1)

                                    Spacer()

                                    Image(systemName: "arrow.right")
                                        .font(.caption)
                                        .foregroundStyle(.tertiary)
                                }
                                .padding(.horizontal)
                                .padding(.vertical, 10)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)

                            Divider()
                                .padding(.leading, 48)
                        }
                    }
                }
                .frame(maxHeight: 400)
                .background(.ultraThickMaterial)
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .shadow(radius: 20)
            .padding(.horizontal, 20)
            .padding(.top, 80)
            .frame(maxHeight: .infinity, alignment: .top)
        }
        .onAppear {
            isSearchFocused = true
            Task { await loadAllItems() }
        }
    }

    private func loadAllItems() async {
        do {
            let response = try await appState.apiClient.getContainers()
            var items: [SwitcherItem] = []

            for container in response.containers {
                for session in container.sessions {
                    items.append(SwitcherItem(
                        containerName: container.displayName,
                        containerId: container.id,
                        sessionName: session.name,
                        windowName: nil,
                        windowIndex: nil
                    ))

                    for window in session.windows {
                        items.append(SwitcherItem(
                            containerName: container.displayName,
                            containerId: container.id,
                            sessionName: session.name,
                            windowName: window.name,
                            windowIndex: window.index
                        ))
                    }
                }
            }

            allItems = items
            results = items
        } catch {
            // Failed to load — dismiss
        }
    }

    private func filterResults(query: String) {
        if query.isEmpty {
            results = allItems
            return
        }

        let lowered = query.lowercased()
        results = allItems.filter { item in
            item.displayTitle.lowercased().contains(lowered)
        }
    }

    private func selectItem(_ item: SwitcherItem) {
        // Navigate to terminal — the parent view handles the actual navigation
        isPresented = false
    }
}
