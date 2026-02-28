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
    @State private var selectedTarget: TerminalTarget?
    @State private var bannerNotification: NotificationResponse?
    @State private var lastShownNotificationId: String?

    var body: some View {
        AdaptiveContainerView(selectedTarget: $selectedTarget)
            .overlay(alignment: .top) {
                if showQuickSwitcher {
                    QuickSwitcherView(
                        isPresented: $showQuickSwitcher,
                        onSelect: { target in
                            selectedTarget = target
                        }
                    )
                }
            }
            .overlay(alignment: .top) {
                if let notification = bannerNotification {
                    NotificationBannerView(
                        notification: notification,
                        onTap: { notif in
                            navigateToNotification(notif)
                        },
                        onDismiss: {
                            bannerNotification = nil
                        }
                    )
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .onShake {
                showQuickSwitcher = true
            }
            .onChange(of: appState.notificationService.notifications) { _, notifications in
                if let latest = notifications.first, latest.id != lastShownNotificationId {
                    lastShownNotificationId = latest.id
                    bannerNotification = latest
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .toggleQuickSwitcher)) { _ in
                showQuickSwitcher.toggle()
            }
            .onReceive(NotificationCenter.default.publisher(for: .navigateToTarget)) { notif in
                if let target = notif.userInfo?["target"] as? TerminalTarget {
                    selectedTarget = target
                }
            }
    }

    private func navigateToNotification(_ notification: NotificationResponse) {
        Task {
            do {
                let sessions = try await appState.apiClient.getSessions(containerId: notification.containerId)
                if let session = sessions.first(where: { $0.name == notification.tmuxSession }) {
                    let container = try await appState.apiClient.getContainer(id: notification.containerId)
                    selectedTarget = TerminalTarget(
                        containerId: notification.containerId,
                        containerName: container.displayName,
                        session: session,
                        windowIndex: notification.tmuxWindow
                    )
                }
            } catch {}
        }
    }
}

struct AdaptiveContainerView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Binding var selectedTarget: TerminalTarget?
    @State private var isFullscreen = false
    @State private var columnVisibility: NavigationSplitViewVisibility = .automatic
    // iPhone states
    @State private var selectedDestination: SessionDestination?
    @State private var containerListVM: ContainerListViewModel?

    var body: some View {
        Group {
            if sizeClass == .regular {
                iPadLayout
            } else {
                iPhoneLayout
            }
        }
        .onChange(of: isFullscreen) { _, fullscreen in
            withAnimation(.easeInOut(duration: 0.25)) {
                columnVisibility = fullscreen ? .detailOnly : .automatic
            }
        }
    }

    // MARK: - iPad: 2-column (unified sidebar | terminal)

    private var iPadLayout: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SidebarView(
                apiClient: appState.apiClient,
                selection: $selectedTarget
            )
        } detail: {
            if let target = selectedTarget {
                TerminalScreen(
                    apiClient: appState.apiClient,
                    preferences: appState.preferences,
                    container: ContainerResponse(
                        id: target.containerId,
                        name: target.containerName,
                        displayName: target.containerName,
                        status: "running",
                        image: "",
                        isHost: nil,
                        isLocal: nil,
                        templateId: nil,
                        sessions: [],
                        createdAt: ""
                    ),
                    session: target.session,
                    isFullscreen: $isFullscreen
                )
                .id(target.id)
            } else {
                ContentUnavailableView(
                    "Select a Window",
                    systemImage: "terminal",
                    description: Text("Choose a window from the sidebar to open a terminal.")
                )
            }
        }
        .navigationSplitViewStyle(.balanced)
        .modifier(KeyboardShortcutReceiver(
            isFullscreen: $isFullscreen,
            onClose: { selectedTarget = nil }
        ))
    }

    // MARK: - iPhone: NavigationStack

    private var iPhoneLayout: some View {
        Group {
            if let vm = containerListVM {
                NavigationStack {
                    ContainerListView(viewModel: vm)
                        .navigationDestination(for: ContainerResponse.self) { container in
                            SessionTreeView(
                                apiClient: appState.apiClient,
                                container: container,
                                selectedDestination: $selectedDestination
                            )
                        }
                        .navigationDestination(item: $selectedDestination) { dest in
                            TerminalScreen(
                                apiClient: appState.apiClient,
                                preferences: appState.preferences,
                                container: dest.container,
                                session: dest.session,
                                isFullscreen: $isFullscreen
                            )
                        }
                }
            } else {
                ProgressView("Loading...")
            }
        }
        .modifier(KeyboardShortcutReceiver(
            isFullscreen: $isFullscreen,
            onClose: { selectedDestination = nil }
        ))
        .task {
            if containerListVM == nil {
                containerListVM = ContainerListViewModel(apiClient: appState.apiClient)
            }
        }
    }

}

struct KeyboardShortcutReceiver: ViewModifier {
    @Binding var isFullscreen: Bool
    var onClose: () -> Void

    func body(content: Content) -> some View {
        content
            .onReceive(NotificationCenter.default.publisher(for: .toggleFullscreen)) { _ in
                withAnimation(.easeInOut(duration: 0.25)) {
                    isFullscreen.toggle()
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .closeTerminal)) { _ in
                onClose()
            }
    }
}

struct SessionDestination: Hashable {
    let container: ContainerResponse
    let session: TmuxSessionResponse
}
