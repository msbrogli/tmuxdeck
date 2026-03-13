import SwiftUI

struct ModifierToolbar: View {
    let viewModel: TerminalViewModel

    var body: some View {
        HStack(spacing: 6) {
            // Escape
            ToolbarKey("Esc") {
                viewModel.sendModifiedKey([0x1B])
            }

            // Tab
            ToolbarKey("Tab") {
                viewModel.sendModifiedKey([0x09])
            }

            // Ctrl+C
            ToolbarKey("^C") {
                viewModel.sendInput(Data([0x03]))
            }

            Divider().frame(height: 24)

            // Modifier toggles
            ModifierToggle("Ctrl", isActive: Binding(
                get: { viewModel.ctrlActive },
                set: { viewModel.ctrlActive = $0 }
            ))

            ModifierToggle("Alt", isActive: Binding(
                get: { viewModel.altActive },
                set: { viewModel.altActive = $0 }
            ))

            ModifierToggle("Shift", isActive: Binding(
                get: { viewModel.shiftActive },
                set: { viewModel.shiftActive = $0 }
            ))

            Divider().frame(height: 24)

            // Arrow keys
            ToolbarKey(systemImage: "arrow.up") {
                viewModel.sendModifiedKey([0x1B, 0x5B, 0x41])
            }
            ToolbarKey(systemImage: "arrow.down") {
                viewModel.sendModifiedKey([0x1B, 0x5B, 0x42])
            }
            ToolbarKey(systemImage: "arrow.left") {
                viewModel.sendModifiedKey([0x1B, 0x5B, 0x44])
            }
            ToolbarKey(systemImage: "arrow.right") {
                viewModel.sendModifiedKey([0x1B, 0x5B, 0x43])
            }

            Divider().frame(height: 24)

            // Copy / Paste
            ToolbarKey(systemImage: "doc.on.doc") {
                copyTerminalSelection()
            }
            ToolbarKey(systemImage: "doc.on.clipboard") {
                pasteFromClipboard()
            }
        }
        .padding(.horizontal, 8)
        .frame(maxWidth: .infinity, maxHeight: 40)
        .background(.ultraThinMaterial)
    }

    private func copyTerminalSelection() {
        if let termView = viewModel.terminalViewRef,
           let selection = termView.getSelection(),
           !selection.isEmpty {
            UIPasteboard.general.string = selection
        }
    }

    private func pasteFromClipboard() {
        if let text = UIPasteboard.general.string {
            viewModel.sendInput(Data(text.utf8))
        }
    }
}

private struct ToolbarKey: View {
    let label: String?
    let systemImage: String?
    let action: () -> Void

    init(_ label: String, action: @escaping () -> Void) {
        self.label = label
        self.systemImage = nil
        self.action = action
    }

    init(systemImage: String, action: @escaping () -> Void) {
        self.label = nil
        self.systemImage = systemImage
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Group {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 13, weight: .medium))
                } else if let label {
                    Text(label)
                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                }
            }
            .frame(minWidth: 32, minHeight: 28)
            .background(Color(.tertiarySystemFill))
            .clipShape(RoundedRectangle(cornerRadius: 5))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
    }
}

private struct ModifierToggle: View {
    let title: String
    @Binding var isActive: Bool

    init(_ title: String, isActive: Binding<Bool>) {
        self.title = title
        self._isActive = isActive
    }

    var body: some View {
        Button {
            isActive.toggle()
        } label: {
            Text(title)
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .frame(minWidth: 36, minHeight: 28)
                .background(isActive ? Color.accentColor.opacity(0.3) : Color(.tertiarySystemFill))
                .clipShape(RoundedRectangle(cornerRadius: 5))
                .overlay(
                    RoundedRectangle(cornerRadius: 5)
                        .strokeBorder(isActive ? Color.accentColor : .clear, lineWidth: 1.5)
                )
        }
        .buttonStyle(.plain)
        .foregroundStyle(isActive ? .primary : .secondary)
    }
}
