import SwiftUI

struct NotificationBannerView: View {
    let notification: NotificationResponse
    var onTap: ((NotificationResponse) -> Void)?
    var onDismiss: (() -> Void)?

    @State private var offset: CGFloat = -120
    @State private var dismissTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: iconName)
                    .foregroundStyle(iconColor)
                    .font(.body)

                Text(notification.title)
                    .font(.subheadline)
                    .fontWeight(.semibold)
                    .lineLimit(1)

                Spacer()

                Button {
                    dismissBanner()
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Text(notification.message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(12)
        .background(.ultraThickMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.15), radius: 8, y: 4)
        .padding(.horizontal, 16)
        .offset(y: offset)
        .gesture(
            DragGesture(minimumDistance: 10)
                .onEnded { value in
                    if value.translation.height < -20 {
                        dismissBanner()
                    }
                }
        )
        .onTapGesture {
            onTap?(notification)
            dismissBanner()
        }
        .onAppear {
            withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) {
                offset = 0
            }
            dismissTask = Task {
                try? await Task.sleep(for: .seconds(4))
                guard !Task.isCancelled else { return }
                await MainActor.run { dismissBanner() }
            }
        }
        .onDisappear {
            dismissTask?.cancel()
        }
    }

    private func dismissBanner() {
        dismissTask?.cancel()
        withAnimation(.easeIn(duration: 0.2)) {
            offset = -120
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            onDismiss?()
        }
    }

    private var iconName: String {
        switch notification.notificationType {
        case "bell": return "bell.fill"
        case "activity": return "bolt.fill"
        case "alert": return "exclamationmark.triangle.fill"
        default: return "bell.fill"
        }
    }

    private var iconColor: Color {
        switch notification.notificationType {
        case "bell": return .orange
        case "activity": return .blue
        case "alert": return .red
        default: return .orange
        }
    }
}
