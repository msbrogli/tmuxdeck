import SwiftUI

struct TerminalThemeView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        List(TerminalTheme.allThemes) { theme in
            Button {
                appState.preferences.themeName = theme.id
            } label: {
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(Color(uiColor: theme.background))
                        .overlay(
                            RoundedRectangle(cornerRadius: 6)
                                .strokeBorder(Color(uiColor: theme.foreground).opacity(0.4), lineWidth: 1)
                        )
                        .overlay(
                            Text("Aa")
                                .font(.system(.body, design: .monospaced))
                                .foregroundStyle(Color(uiColor: theme.foreground))
                        )
                        .frame(width: 56, height: 40)

                    Text(theme.name)
                        .foregroundStyle(.primary)

                    Spacer()

                    if appState.preferences.themeName == theme.id {
                        Image(systemName: "checkmark")
                            .foregroundStyle(.tint)
                            .fontWeight(.semibold)
                    }
                }
            }
        }
        .navigationTitle("Theme")
        .navigationBarTitleDisplayMode(.inline)
    }
}
