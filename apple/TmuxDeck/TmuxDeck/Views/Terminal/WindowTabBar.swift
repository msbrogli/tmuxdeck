import SwiftUI

struct WindowTabBar: View {
    let windows: [TmuxWindowResponse]
    let activeIndex: Int
    let onSelect: (Int) -> Void
    let onNewWindow: () -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(windows) { window in
                        WindowTab(
                            window: window,
                            isActive: window.index == activeIndex,
                            onSelect: { onSelect(window.index) }
                        )
                        .id(window.index)
                    }

                    Button(action: onNewWindow) {
                        Image(systemName: "plus")
                            .font(.caption)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 6)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 8)
            }
            .frame(height: 36)
            .background(.ultraThinMaterial)
            .onChange(of: activeIndex) { _, newIndex in
                withAnimation {
                    proxy.scrollTo(newIndex, anchor: .center)
                }
            }
        }
    }
}

struct WindowTab: View {
    let window: TmuxWindowResponse
    let isActive: Bool
    let onSelect: () -> Void

    @State private var showHooksHint = false

    private var isClaudeWithoutHooks: Bool {
        window.command.lowercased().contains("claude") && window.paneStatus.isEmpty
    }

    var body: some View {
        HStack(spacing: 4) {
            PaneStatusDot(window: window)

            Text("\(window.index):\(window.name)")
                .font(.caption)
                .lineLimit(1)

            if isClaudeWithoutHooks {
                Image(systemName: "info.circle")
                    .font(.system(size: 8))
                    .foregroundStyle(.orange)
                    .onTapGesture {
                        showHooksHint = true
                    }
                    .popover(isPresented: $showHooksHint) {
                        ClaudeHooksHintView()
                            .presentationCompactAdaptation(.popover)
                    }
            }

            if window.bell {
                Image(systemName: "bell.fill")
                    .font(.system(size: 8))
                    .foregroundStyle(.orange)
            }

            if window.activity && !isActive {
                Circle()
                    .fill(.blue)
                    .frame(width: 5, height: 5)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(isActive ? Color.accentColor.opacity(0.2) : Color.clear)
        .foregroundStyle(isActive ? .primary : .secondary)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onTapGesture {
            onSelect()
        }
    }
}

struct ClaudeHooksHintIcon: View {
    var body: some View {
        Image(systemName: "info.circle")
            .font(.system(size: 9))
            .foregroundStyle(.orange)
    }
}

struct ClaudeHooksHintView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Claude Hooks", systemImage: "info.circle")
                .font(.headline)

            Text("Add a hook to report pane status:")
                .font(.caption)
                .foregroundStyle(.secondary)

            Text("""
            # .claude/hooks/pane-status.sh
            #!/bin/bash
            tmux set -p @pane_status "$1"
            """)
            .font(.system(.caption2, design: .monospaced))
            .padding(8)
            .background(Color(.systemGray6))
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .padding()
        .frame(width: 280)
    }
}

struct PaneStatusDot: View {
    let window: TmuxWindowResponse
    @State private var isPulsing = false

    private static let idleCommands: Set<String> = [
        "bash", "zsh", "sh", "fish", "dash", "ksh", "tcsh", "csh",
        "vim", "nvim", "vi", "nano", "emacs", "less", "more", "man"
    ]

    private var effectiveStatus: String {
        if !window.paneStatus.isEmpty {
            return window.paneStatus
        }
        let cmd = window.command.lowercased()
            .components(separatedBy: "/").last ?? window.command.lowercased()
        return Self.idleCommands.contains(cmd) ? "idle" : "busy"
    }

    private var dotColor: Color {
        switch effectiveStatus {
        case "idle": return .gray
        case "busy": return .orange
        case "waiting": return .green
        case "attention": return .blue
        default: return .gray
        }
    }

    private var shouldPulse: Bool {
        effectiveStatus == "busy" || effectiveStatus == "attention"
    }

    var body: some View {
        Circle()
            .fill(dotColor)
            .frame(width: 6, height: 6)
            .opacity(shouldPulse && isPulsing ? 0.3 : 1.0)
            .animation(
                shouldPulse
                    ? .easeInOut(duration: 0.8).repeatForever(autoreverses: true)
                    : .default,
                value: isPulsing
            )
            .onAppear {
                if shouldPulse { isPulsing = true }
            }
            .onChange(of: shouldPulse) { _, newValue in
                isPulsing = newValue
            }
    }
}
