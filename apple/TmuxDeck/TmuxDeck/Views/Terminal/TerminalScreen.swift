import SwiftUI

struct TerminalScreen: View {
    let apiClient: APIClient
    let container: ContainerResponse
    let session: TmuxSessionResponse
    @Binding var isFullscreen: Bool

    @State private var viewModel: TerminalViewModel?
    @State private var hideTabBar = false

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

                ZStack(alignment: .topTrailing) {
                    SwiftTerminalView(viewModel: vm)
                        .onDisappear {
                            vm.disconnect()
                        }
                        .gesture(
                            MagnificationGesture()
                                .onChanged { scale in
                                    if scale > 1.05 {
                                        vm.adjustFontSize(delta: 0.5)
                                    } else if scale < 0.95 {
                                        vm.adjustFontSize(delta: -0.5)
                                    }
                                }
                        )

                    // Floating restore button when fullscreen
                    if isFullscreen {
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
                        .transition(.opacity)
                    }
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
        .onAppear {
            if viewModel == nil {
                viewModel = TerminalViewModel(
                    apiClient: apiClient,
                    containerId: container.id,
                    sessionName: session.name,
                    windows: session.windows
                )
            }
        }
    }
}
