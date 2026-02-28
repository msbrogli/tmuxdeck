import SwiftUI

struct PaneIndicator: View {
    let paneCount: Int
    let activeIndex: Int
    var onSelect: ((Int) -> Void)?

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<paneCount, id: \.self) { index in
                Circle()
                    .fill(index == activeIndex ? Color.white : Color.white.opacity(0.4))
                    .frame(width: 7, height: 7)
                    .onTapGesture {
                        onSelect?(index)
                    }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.ultraThinMaterial, in: Capsule())
    }
}
