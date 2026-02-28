import SwiftUI
import SwiftTerm

struct SwiftTerminalView: UIViewRepresentable {
    let viewModel: TerminalViewModel
    var keyboardActive: Bool
    @Binding var showQuickActions: Bool

    func makeUIView(context: Context) -> TerminalView {
        let terminalView = TerminalView()
        terminalView.terminalDelegate = context.coordinator

        let theme = viewModel.theme
        terminalView.nativeForegroundColor = theme.foreground
        terminalView.nativeBackgroundColor = theme.background

        let fontSize = viewModel.fontSize
        terminalView.font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)

        context.coordinator.terminalView = terminalView

        viewModel.feedHandler = { [weak terminalView] bytes in
            terminalView?.feed(byteArray: ArraySlice(bytes))
        }

        viewModel.terminalViewRef = terminalView

        // Remove SwiftTerm's built-in keyboard accessory bar (F1-F10, arrows, etc.)
        terminalView.inputAccessoryView = nil

        // Disable pinch-to-zoom (UIScrollView built-in)
        terminalView.minimumZoomScale = 1.0
        terminalView.maximumZoomScale = 1.0
        terminalView.pinchGestureRecognizer?.isEnabled = false

        // Two-finger swipe down to open scrollback history
        let swipeDown = UISwipeGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handleScrollbackSwipe))
        swipeDown.direction = .down
        swipeDown.numberOfTouchesRequired = 2
        terminalView.addGestureRecognizer(swipeDown)

        viewModel.connectIfNeeded()

        return terminalView
    }

    func updateUIView(_ uiView: TerminalView, context: Context) {
        let size = viewModel.fontSize
        if uiView.font.pointSize != size {
            uiView.font = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
        }

        let theme = viewModel.theme
        if uiView.nativeForegroundColor != theme.foreground {
            uiView.nativeForegroundColor = theme.foreground
        }
        if uiView.nativeBackgroundColor != theme.background {
            uiView.nativeBackgroundColor = theme.background
        }

        context.coordinator.keyboardAllowed = keyboardActive
        if keyboardActive {
            if !uiView.isFirstResponder {
                uiView.becomeFirstResponder()
            }
        } else {
            if uiView.isFirstResponder {
                uiView.resignFirstResponder()
            }
        }

    }

    func makeCoordinator() -> Coordinator {
        Coordinator(viewModel: viewModel, showQuickActions: $showQuickActions)
    }

    class Coordinator: NSObject, TerminalViewDelegate {
        let viewModel: TerminalViewModel
        weak var terminalView: TerminalView?
        @Binding var showQuickActions: Bool
        var keyboardAllowed = false
        private var keyboardObserver: NSObjectProtocol?

        init(viewModel: TerminalViewModel, showQuickActions: Binding<Bool>) {
            self.viewModel = viewModel
            self._showQuickActions = showQuickActions
            super.init()

            keyboardObserver = NotificationCenter.default.addObserver(
                forName: UIResponder.keyboardWillShowNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                guard let self, !self.keyboardAllowed else { return }
                self.terminalView?.resignFirstResponder()
            }
        }

        deinit {
            if let observer = keyboardObserver {
                NotificationCenter.default.removeObserver(observer)
            }
        }

        // MARK: - Scrollback gesture

        @objc func handleScrollbackSwipe() {
            viewModel.requestScrollbackHistory()
        }

        // MARK: - TerminalViewDelegate

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            if viewModel.showingScrollback {
                viewModel.dismissScrollback()
            }
            viewModel.sendInput(Data(data))
        }

        func scrolled(source: TerminalView, position: Double) {}
        func setTerminalTitle(source: TerminalView, title: String) {}

        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            viewModel.sendResize(cols: newCols, rows: newRows)
        }

        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
            if let url = URL(string: link) {
                UIApplication.shared.open(url)
            }
        }

        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}

        func clipboardCopy(source: TerminalView, content: Data) {
            if let text = String(data: content, encoding: .utf8) {
                UIPasteboard.general.string = text
            }
        }

        func iTermContent(source: TerminalView, content: Data) {}
    }
}
