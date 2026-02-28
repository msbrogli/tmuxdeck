import SwiftUI

struct QuickActionsSheet: View {
    let onAction: (Data) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    actionSection("Signals") {
                        actionRow("Ctrl+C", subtitle: "Interrupt", icon: "xmark.octagon", color: .red,
                                  data: [0x03])
                        actionRow("Ctrl+D", subtitle: "EOF / Logout", icon: "rectangle.portrait.and.arrow.right", color: .orange,
                                  data: [0x04])
                        actionRow("Ctrl+Z", subtitle: "Suspend", icon: "pause.circle", color: .yellow,
                                  data: [0x1A])
                        actionRow("Ctrl+\\", subtitle: "Quit", icon: "power", color: .red,
                                  data: [0x1C])
                    }

                    actionSection("Navigation") {
                        actionRow("Tab", subtitle: "Autocomplete", icon: "arrow.right.to.line", color: .blue,
                                  data: [0x09])
                        actionRow("Escape", subtitle: "Cancel / Vi normal", icon: "escape", color: .gray,
                                  data: [0x1B])
                        actionRow("↑ Up", subtitle: "Previous command", icon: "arrow.up", color: .primary,
                                  data: [0x1B, 0x5B, 0x41])
                        actionRow("↓ Down", subtitle: "Next command", icon: "arrow.down", color: .primary,
                                  data: [0x1B, 0x5B, 0x42])
                    }

                    actionSection("Editing") {
                        actionRow("Ctrl+A", subtitle: "Beginning of line", icon: "arrow.left.to.line", color: .purple,
                                  data: [0x01])
                        actionRow("Ctrl+E", subtitle: "End of line", icon: "arrow.right.to.line", color: .purple,
                                  data: [0x05])
                        actionRow("Ctrl+U", subtitle: "Clear line before cursor", icon: "delete.backward", color: .orange,
                                  data: [0x15])
                        actionRow("Ctrl+K", subtitle: "Clear line after cursor", icon: "delete.forward", color: .orange,
                                  data: [0x0B])
                        actionRow("Ctrl+W", subtitle: "Delete word before cursor", icon: "strikethrough", color: .orange,
                                  data: [0x17])
                        actionRow("Ctrl+L", subtitle: "Clear screen", icon: "sparkles.rectangle.stack", color: .teal,
                                  data: [0x0C])
                    }

                    actionSection("Tmux") {
                        actionRow("Prefix (Ctrl+B)", subtitle: "Tmux command prefix", icon: "command", color: .indigo,
                                  data: [0x02])
                        actionRow("Next Window", subtitle: "Prefix + n", icon: "arrow.right.square", color: .indigo,
                                  data: [0x02, 0x6E])
                        actionRow("Prev Window", subtitle: "Prefix + p", icon: "arrow.left.square", color: .indigo,
                                  data: [0x02, 0x70])
                        actionRow("Next Pane", subtitle: "Prefix + o", icon: "rectangle.grid.2x2", color: .indigo,
                                  data: [0x02, 0x6F])
                        actionRow("Split Horizontal", subtitle: "Prefix + \"", icon: "rectangle.split.1x2", color: .indigo,
                                  data: [0x02, 0x22])
                        actionRow("Split Vertical", subtitle: "Prefix + %", icon: "rectangle.split.2x1", color: .indigo,
                                  data: [0x02, 0x25])
                    }
                }
                .padding()
            }
            .navigationTitle("Quick Actions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func actionSection(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(.subheadline, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.leading, 4)

            VStack(spacing: 2) {
                content()
            }
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private func actionRow(_ title: String, subtitle: String, icon: String, color: Color, data: [UInt8]) -> some View {
        Button {
            onAction(Data(data))
            dismiss()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(color)
                    .frame(width: 28, height: 28)
                    .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 6, style: .continuous))

                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.system(.subheadline, weight: .medium))
                        .foregroundStyle(.primary)
                    Text(subtitle)
                        .font(.system(.caption2))
                        .foregroundStyle(.tertiary)
                }

                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
