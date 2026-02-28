import SwiftUI

struct QuickSwitcherView: View {
    @Binding var isPresented: Bool
    var onSelect: ((TerminalTarget) -> Void)?
    @Environment(AppState.self) private var appState
    @State private var searchText = ""
    @State private var results: [ScoredSwitcherItem] = []
    @State private var allItems: [SwitcherItem] = []
    @FocusState private var isSearchFocused: Bool

    struct SwitcherItem: Identifiable {
        let id = UUID()
        let containerName: String
        let containerId: String
        let sessionName: String
        let session: TmuxSessionResponse
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

    struct ScoredSwitcherItem: Identifiable {
        let item: SwitcherItem
        let matchIndices: [Int]
        let score: Double

        var id: UUID { item.id }
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
                        if results.isEmpty && !searchText.isEmpty {
                            Text("No results")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .padding(.vertical, 24)
                        } else {
                            ForEach(results) { scored in
                                Button {
                                    selectItem(scored.item)
                                } label: {
                                    HStack {
                                        Image(systemName: scored.item.icon)
                                            .frame(width: 24)
                                            .foregroundStyle(.secondary)

                                        highlightedText(
                                            scored.item.displayTitle,
                                            indices: scored.matchIndices
                                        )
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

    private func highlightedText(_ text: String, indices: [Int]) -> Text {
        guard !indices.isEmpty else { return Text(text) }
        let indexSet = Set(indices)
        let chars = Array(text)
        var result = Text("")
        for (i, char) in chars.enumerated() {
            if indexSet.contains(i) {
                result = result + Text(String(char))
                    .bold()
                    .foregroundStyle(.tint)
            } else {
                result = result + Text(String(char))
            }
        }
        return result
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
                        session: session,
                        windowName: nil,
                        windowIndex: nil
                    ))

                    for window in session.windows {
                        items.append(SwitcherItem(
                            containerName: container.displayName,
                            containerId: container.id,
                            sessionName: session.name,
                            session: session,
                            windowName: window.name,
                            windowIndex: window.index
                        ))
                    }
                }
            }

            allItems = items
            results = items.map { ScoredSwitcherItem(item: $0, matchIndices: [], score: 0) }
        } catch {
            // Failed to load
        }
    }

    private func filterResults(query: String) {
        if query.isEmpty {
            results = allItems.map { ScoredSwitcherItem(item: $0, matchIndices: [], score: 0) }
            return
        }

        results = allItems.compactMap { item in
            let result = fuzzyMatch(query: query, target: item.displayTitle)
            guard result.match else { return nil }
            return ScoredSwitcherItem(item: item, matchIndices: result.indices, score: result.score)
        }
        .sorted { $0.score > $1.score }
    }

    private func selectItem(_ item: SwitcherItem) {
        let target = TerminalTarget(
            containerId: item.containerId,
            containerName: item.containerName,
            session: item.session,
            windowIndex: item.windowIndex ?? 0
        )
        onSelect?(target)
        isPresented = false
    }
}
