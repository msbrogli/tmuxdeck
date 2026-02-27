import SwiftUI

struct ContentView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        Group {
            switch appState.currentScreen {
            case .serverSetup:
                ServerSetupView()
            case .login:
                PINEntryView(mode: .login)
            case .pinSetup:
                PINEntryView(mode: .setup)
            case .main:
                MainTabView()
            }
        }
        .animation(.default, value: appState.currentScreen)
        .task {
            if appState.activeServer != nil {
                await appState.checkAuthAndNavigate()
            }
        }
    }
}

struct MainTabView: View {
    @Environment(AppState.self) private var appState
    @State private var showQuickSwitcher = false

    var body: some View {
        AdaptiveContainerView()
            .overlay {
                if showQuickSwitcher {
                    QuickSwitcherView(isPresented: $showQuickSwitcher)
                }
            }
            .onShake {
                showQuickSwitcher = true
            }
    }
}

// Adaptive layout: NavigationSplitView on iPad, NavigationStack on iPhone
struct AdaptiveContainerView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var selectedContainer: ContainerResponse?
    @State private var selectedSession: TmuxSessionResponse?
    @State private var containerListVM: ContainerListViewModel?
    @State private var isFullscreen = false
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    var body: some View {
        Group {
            if let vm = containerListVM {
                if sizeClass == .regular {
                    iPadLayout(vm: vm)
                } else {
                    iPhoneLayout(vm: vm)
                }
            } else {
                ProgressView("Loading...")
            }
        }
        .task {
            if containerListVM == nil {
                containerListVM = ContainerListViewModel(apiClient: appState.apiClient)
            }
        }
        .onChange(of: isFullscreen) { _, fullscreen in
            withAnimation(.easeInOut(duration: 0.25)) {
                columnVisibility = fullscreen ? .detailOnly : .all
            }
        }
    }

    @ViewBuilder
    private func iPadLayout(vm: ContainerListViewModel) -> some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            ContainerListView(viewModel: vm, selectedContainer: $selectedContainer)
        } content: {
            if let container = selectedContainer {
                SessionTreeView(
                    apiClient: appState.apiClient,
                    container: container,
                    selectedSession: $selectedSession
                )
            } else {
                ContentUnavailableView("Select a Container", systemImage: "server.rack")
            }
        } detail: {
            if let container = selectedContainer, let session = selectedSession {
                TerminalScreen(
                    apiClient: appState.apiClient,
                    container: container,
                    session: session,
                    isFullscreen: $isFullscreen
                )
                .id("\(container.id)-\(session.id)")
            } else {
                ContentUnavailableView("Select a Session", systemImage: "terminal")
            }
        }
        .navigationSplitViewStyle(.balanced)
    }

    @ViewBuilder
    private func iPhoneLayout(vm: ContainerListViewModel) -> some View {
        NavigationStack {
            ContainerListView(viewModel: vm, selectedContainer: $selectedContainer)
                .navigationDestination(for: ContainerResponse.self) { container in
                    SessionTreeView(
                        apiClient: appState.apiClient,
                        container: container,
                        selectedSession: $selectedSession
                    )
                }
                .navigationDestination(item: $selectedSession) { session in
                    if let container = selectedContainer {
                        TerminalScreen(
                            apiClient: appState.apiClient,
                            container: container,
                            session: session,
                            isFullscreen: $isFullscreen
                        )
                    }
                }
        }
    }
}

struct SessionDestination: Hashable {
    let container: ContainerResponse
    let session: TmuxSessionResponse
}
