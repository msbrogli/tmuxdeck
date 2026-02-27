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

    var body: some View {
        HStack(spacing: 4) {
            Text("\(window.index):\(window.name)")
                .font(.caption)
                .lineLimit(1)

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
