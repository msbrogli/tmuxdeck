import SwiftUI

struct TerminalScreen: View {
    let apiClient: APIClient
    let preferences: UserPreferences
    let container: ContainerResponse
    let session: TmuxSessionResponse
    @Binding var isFullscreen: Bool

    @State private var viewModel: TerminalViewModel?
    @State private var hideTabBar = false
    @State private var inputMode: InputMode = UIDevice.current.userInterfaceIdiom == .pad ? .keyboard : .voice
    @State private var showQuickActions = false

    var body: some View {
        VStack(spacing: 0) {
            if let vm = viewModel {
                if !hideTabBar {
                    WindowTabBar(
                        windows: vm.windows,
                        activeIndex: vm.activeWindowIndex,
                        onSelect: { index in
                            vm.switchWindow(to: index)
                        },
                        onNewWindow: {
                            Task { await vm.createWindow() }
                        }
                    )
                }

                ZStack {
                    SwiftTerminalView(viewModel: vm, keyboardActive: inputMode == .keyboard, showQuickActions: $showQuickActions)
                        .padding(.bottom, 60)
                        .onDisappear {
                            vm.disconnect()
                        }

                    // Scrollback overlay
                    if vm.showingScrollback {
                        ScrollbackOverlayView(
                            historyText: vm.scrollbackText,
                            theme: vm.theme,
                            fontSize: vm.fontSize,
                            onDismiss: {
                                withAnimation { vm.dismissScrollback() }
                            }
                        )
                        .transition(AnyTransition.opacity)
                        .zIndex(10)
                    }

                    // Floating restore button when fullscreen
                    if isFullscreen {
                        VStack {
                            HStack {
                                Spacer()
                                Button {
                                    withAnimation(.easeInOut(duration: 0.25)) {
                                        isFullscreen = false
                                        hideTabBar = false
                                    }
                                } label: {
                                    Image(systemName: "arrow.down.right.and.arrow.up.left")
                                        .font(.system(size: 13, weight: .semibold))
                                        .foregroundStyle(.white)
                                        .padding(8)
                                        .background(.ultraThinMaterial.opacity(0.6))
                                        .clipShape(RoundedRectangle(cornerRadius: 6))
                                }
                                .padding(8)
                            }
                            Spacer()
                        }
                        .transition(.opacity)
                    }

                    // Floating input control (voice/keyboard toggle)
                    TerminalInputControl(
                        onText: { text in
                            vm.sendInput(Data((text + "\n").utf8))
                        },
                        onRawInput: { data in
                            vm.sendInput(data)
                        },
                        onSelectPane: { direction in
                            vm.connection.selectPane(direction: direction)
                        },
                        onToggleZoom: {
                            vm.connection.toggleZoom()
                        },
                        onSplitPane: { direction in
                            vm.connection.splitPane(direction: direction)
                        },
                        onKillPane: {
                            vm.connection.killPane()
                        },
                        onNewWindow: {
                            Task { await vm.createWindow() }
                        },
                        inputMode: $inputMode
                    )

                }

                if let error = vm.error {
                    HStack {
                        Image(systemName: "exclamationmark.triangle")
                        Text(error)
                            .font(.caption)
                        Spacer()
                        Button("Retry") {
                            vm.disconnect()
                            vm.connectIfNeeded()
                        }
                        .font(.caption)
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 4)
                    .background(.red.opacity(0.1))
                }

                if !vm.connection.isConnected && vm.error == nil {
                    HStack {
                        ProgressView()
                            .scaleEffect(0.7)
                        Text("Connecting...")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }
            } else {
                ProgressView("Loading terminal...")
            }
        }
        .navigationTitle(isFullscreen ? "" : session.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(isFullscreen ? .hidden : .visible, for: .navigationBar)
        .toolbar {
            if !isFullscreen {
                ToolbarItem(placement: .primaryAction) {
                    HStack(spacing: 4) {
                        Button {
                            withAnimation(.easeInOut(duration: 0.25)) {
                                isFullscreen = true
                                hideTabBar = false
                            }
                        } label: {
                            Image(systemName: "arrow.up.left.and.arrow.down.right")
                        }

                        Menu {
                            Button {
                                viewModel?.toggleMode()
                            } label: {
                                Label(
                                    viewModel?.mode == .app ? "Tmux Mode" : "App Mode",
                                    systemImage: viewModel?.mode == .app ? "rectangle.split.3x1" : "rectangle.fill"
                                )
                            }

                            Button {
                                hideTabBar.toggle()
                            } label: {
                                Label(
                                    hideTabBar ? "Show Tab Bar" : "Hide Tab Bar",
                                    systemImage: hideTabBar ? "rectangle.topthird.inset.filled" : "rectangle.slash"
                                )
                            }

                            Divider()

                            Button {
                                Task { await viewModel?.refreshWindows() }
                            } label: {
                                Label("Refresh Windows", systemImage: "arrow.clockwise")
                            }

                            Button {
                                viewModel?.connection.disableMouse()
                            } label: {
                                Label("Disable Mouse", systemImage: "cursorarrow.slash")
                            }

                            Divider()

                            Button {
                                viewModel?.adjustFontSize(delta: 2)
                            } label: {
                                Label("Increase Font", systemImage: "textformat.size.larger")
                            }

                            Button {
                                viewModel?.adjustFontSize(delta: -2)
                            } label: {
                                Label("Decrease Font", systemImage: "textformat.size.smaller")
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
                    }
                }
            }
        }
        .statusBarHidden(isFullscreen)
        .sheet(isPresented: $showQuickActions) {
            if let vm = viewModel {
                QuickActionsSheet { data in
                    vm.sendInput(data)
                }
                .presentationDetents([.medium, .large])
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .switchWindow)) { notif in
            guard let index = notif.userInfo?["index"] as? Int,
                  let vm = viewModel else { return }
            // Find the window with this tmux index
            if vm.windows.contains(where: { $0.index == index }) {
                vm.switchWindow(to: index)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .newSession)) { _ in
            guard let vm = viewModel else { return }
            Task { await vm.createWindow() }
        }
        .onAppear {
            if viewModel == nil {
                viewModel = TerminalViewModel(
                    apiClient: apiClient,
                    preferences: preferences,
                    containerId: container.id,
                    sessionName: session.name,
                    windows: session.windows
                )
            }
        }
    }
}
