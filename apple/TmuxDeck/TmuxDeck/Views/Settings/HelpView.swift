import SwiftUI

struct HelpView: View {
    var body: some View {
        List {
            Section("Getting Started") {
                helpRow(
                    icon: "server.rack",
                    title: "Connect to Server",
                    detail: "Add your TmuxDeck server URL and authenticate with your PIN."
                )
                helpRow(
                    icon: "shippingbox",
                    title: "Containers",
                    detail: "Containers are isolated environments with tmux sessions. Create one from a template or use the host/local container."
                )
                helpRow(
                    icon: "terminal",
                    title: "Sessions & Windows",
                    detail: "Each container has tmux sessions containing windows. Tap a window to open its terminal."
                )
            }

            Section("Terminal Usage") {
                helpRow(
                    icon: "keyboard",
                    title: "Input",
                    detail: "Tap the terminal to bring up the keyboard. Use the toolbar for special keys."
                )
                helpRow(
                    icon: "mic",
                    title: "Voice Input",
                    detail: "Tap the microphone button to dictate commands using speech recognition."
                )
                helpRow(
                    icon: "arrow.up.and.down.text.horizontal",
                    title: "Scrollback",
                    detail: "Use Quick Actions to view scrollback history with full text selection support."
                )
                helpRow(
                    icon: "rectangle.split.3x1",
                    title: "Panes",
                    detail: "Use Quick Actions to split, navigate, and manage panes within a window."
                )
            }

            Section("Claude Integration") {
                helpRow(
                    icon: "sparkles",
                    title: "Claude Code",
                    detail: "When Claude Code is running in a pane, TmuxDeck shows its status via pane status dots."
                )
                helpRow(
                    icon: "info.circle",
                    title: "Hooks",
                    detail: "Set up Claude hooks to report pane status. An orange info icon appears when hooks are not configured."
                )
            }

            Section("Keyboard Shortcuts") {
                ShortcutRow(key: "Cmd+K", action: "Quick Switcher")
                ShortcutRow(key: "Cmd+F", action: "Toggle Fullscreen")
                ShortcutRow(key: "Cmd+W", action: "Close Terminal")
                ShortcutRow(key: "Cmd+1-9", action: "Switch Window")
                ShortcutRow(key: "Cmd+T", action: "New Window")
                ShortcutRow(key: "Shake", action: "Quick Switcher (iPhone)")
            }

            Section("Tips") {
                helpRow(
                    icon: "arrow.triangle.2.circlepath",
                    title: "Pull to Refresh",
                    detail: "Pull down on container or session lists to refresh data from the server."
                )
                helpRow(
                    icon: "hand.draw",
                    title: "Swipe Actions",
                    detail: "Swipe left on containers to delete, swipe right to start/stop."
                )
                helpRow(
                    icon: "hand.tap",
                    title: "Context Menus",
                    detail: "Long-press on sessions and windows for additional actions like rename, move, or delete."
                )
            }
        }
        .navigationTitle("Help")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func helpRow(icon: String, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.body)
                .foregroundStyle(.tint)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline)
                    .fontWeight(.medium)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

struct ShortcutRow: View {
    let key: String
    let action: String

    var body: some View {
        HStack {
            Text(action)
                .font(.subheadline)
            Spacer()
            Text(key)
                .font(.system(.caption, design: .monospaced))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Color(.systemGray5))
                .clipShape(RoundedRectangle(cornerRadius: 4))
        }
    }
}
