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

        // Set up gestures for the initial mode
        context.coordinator.currentMode = viewModel.mode
        if viewModel.mode == .app {
            context.coordinator.setupAppModeGestures(on: terminalView)
        } else {
            context.coordinator.setupTmuxModeGestures(on: terminalView)
        }

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

        // Swap gestures when mode changes
        let coordinator = context.coordinator
        if coordinator.currentMode != viewModel.mode {
            coordinator.currentMode = viewModel.mode
            coordinator.removeAllCustomGestures(from: uiView)
            if viewModel.mode == .app {
                coordinator.setupAppModeGestures(on: uiView)
            } else {
                coordinator.setupTmuxModeGestures(on: uiView)
            }
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(viewModel: viewModel, showQuickActions: $showQuickActions)
    }

    class Coordinator: NSObject, TerminalViewDelegate, UIGestureRecognizerDelegate {
        let viewModel: TerminalViewModel
        weak var terminalView: TerminalView?
        @Binding var showQuickActions: Bool
        var currentMode: TerminalMode = .tmux
        var keyboardAllowed = false
        private static let customGestureTag = 8888
        private var keyboardObserver: NSObjectProtocol?

        init(viewModel: TerminalViewModel, showQuickActions: Binding<Bool>) {
            self.viewModel = viewModel
            self._showQuickActions = showQuickActions
            super.init()

            // Block keyboard from appearing when not in keyboard mode.
            // SwiftTerm's TerminalView calls becomeFirstResponder() on tap,
            // which we can't prevent. Instead, immediately resign when it happens.
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

        // MARK: - Gesture Setup

        func removeAllCustomGestures(from view: UIView) {
            view.gestureRecognizers?.filter { $0.view?.tag == Self.customGestureTag || $0.name?.hasPrefix("tmuxdeck.") == true }
                .forEach { view.removeGestureRecognizer($0) }
        }

        func setupTmuxModeGestures(on view: TerminalView) {
            let swipeLeft2 = UISwipeGestureRecognizer(target: self, action: #selector(handleTwoFingerSwipeLeft))
            swipeLeft2.direction = .left
            swipeLeft2.numberOfTouchesRequired = 2
            swipeLeft2.name = "tmuxdeck.swipeLeft2"
            swipeLeft2.delegate = self
            view.addGestureRecognizer(swipeLeft2)

            let swipeRight2 = UISwipeGestureRecognizer(target: self, action: #selector(handleTwoFingerSwipeRight))
            swipeRight2.direction = .right
            swipeRight2.numberOfTouchesRequired = 2
            swipeRight2.name = "tmuxdeck.swipeRight2"
            swipeRight2.delegate = self
            view.addGestureRecognizer(swipeRight2)

            let swipeUp2 = UISwipeGestureRecognizer(target: self, action: #selector(handleTwoFingerSwipeUp))
            swipeUp2.direction = .up
            swipeUp2.numberOfTouchesRequired = 2
            swipeUp2.name = "tmuxdeck.swipeUp2"
            swipeUp2.delegate = self
            view.addGestureRecognizer(swipeUp2)

            let swipeDown2 = UISwipeGestureRecognizer(target: self, action: #selector(handleTwoFingerSwipeDown))
            swipeDown2.direction = .down
            swipeDown2.numberOfTouchesRequired = 2
            swipeDown2.name = "tmuxdeck.swipeDown2"
            swipeDown2.delegate = self
            view.addGestureRecognizer(swipeDown2)

            let swipeLeft3 = UISwipeGestureRecognizer(target: self, action: #selector(handleThreeFingerSwipeLeft))
            swipeLeft3.direction = .left
            swipeLeft3.numberOfTouchesRequired = 3
            swipeLeft3.name = "tmuxdeck.swipeLeft3"
            swipeLeft3.delegate = self
            view.addGestureRecognizer(swipeLeft3)

            let swipeRight3 = UISwipeGestureRecognizer(target: self, action: #selector(handleThreeFingerSwipeRight))
            swipeRight3.direction = .right
            swipeRight3.numberOfTouchesRequired = 3
            swipeRight3.name = "tmuxdeck.swipeRight3"
            swipeRight3.delegate = self
            view.addGestureRecognizer(swipeRight3)

            let doubleTap2 = UITapGestureRecognizer(target: self, action: #selector(handleTwoFingerDoubleTap))
            doubleTap2.numberOfTouchesRequired = 2
            doubleTap2.numberOfTapsRequired = 2
            doubleTap2.name = "tmuxdeck.doubleTap2"
            doubleTap2.delegate = self
            view.addGestureRecognizer(doubleTap2)

            let tripleTap2 = UITapGestureRecognizer(target: self, action: #selector(handleTwoFingerTripleTap))
            tripleTap2.numberOfTouchesRequired = 2
            tripleTap2.numberOfTapsRequired = 3
            tripleTap2.name = "tmuxdeck.tripleTap2"
            tripleTap2.delegate = self
            tripleTap2.require(toFail: doubleTap2)
            view.addGestureRecognizer(tripleTap2)
        }

        func setupAppModeGestures(on view: TerminalView) {
            // 1-finger horizontal pan for switching panes
            let panGesture = UIPanGestureRecognizer(target: self, action: #selector(handleAppModePan(_:)))
            panGesture.name = "tmuxdeck.appPan"
            panGesture.delegate = self
            view.addGestureRecognizer(panGesture)

            // Also need to tell the scroll view's pan gesture to allow ours simultaneously
            view.panGestureRecognizer.require(toFail: panGesture)

            // Keep 2-finger double tap (Ctrl+C) and triple tap (quick actions)
            let doubleTap2 = UITapGestureRecognizer(target: self, action: #selector(handleTwoFingerDoubleTap))
            doubleTap2.numberOfTouchesRequired = 2
            doubleTap2.numberOfTapsRequired = 2
            doubleTap2.name = "tmuxdeck.doubleTap2"
            doubleTap2.delegate = self
            view.addGestureRecognizer(doubleTap2)

            let tripleTap2 = UITapGestureRecognizer(target: self, action: #selector(handleTwoFingerTripleTap))
            tripleTap2.numberOfTouchesRequired = 2
            tripleTap2.numberOfTapsRequired = 3
            tripleTap2.name = "tmuxdeck.tripleTap2"
            tripleTap2.delegate = self
            tripleTap2.require(toFail: doubleTap2)
            view.addGestureRecognizer(tripleTap2)
        }

        // MARK: - UIGestureRecognizerDelegate

        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer,
                  pan.name == "tmuxdeck.appPan" else { return true }
            let velocity = pan.velocity(in: pan.view)
            // Only begin if horizontal movement dominates
            return abs(velocity.x) > abs(velocity.y) * 1.5
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
            // Allow our named gestures to work alongside SwiftTerm's built-in gestures
            if gestureRecognizer.name?.hasPrefix("tmuxdeck.") == true {
                return true
            }
            return false
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRequireFailureOf otherGestureRecognizer: UIGestureRecognizer) -> Bool {
            // Our multi-touch gestures should NOT wait for SwiftTerm's single-touch gestures
            return false
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer) -> Bool {
            // When our 2/3-finger swipe is recognized, it shouldn't block SwiftTerm
            return false
        }

        // MARK: - App Mode Gesture Handler

        @objc func handleAppModePan(_ gesture: UIPanGestureRecognizer) {
            guard gesture.state == .ended else { return }
            let translation = gesture.translation(in: gesture.view)
            let velocity = gesture.velocity(in: gesture.view)
            // Threshold: 100pt displacement + 500pt/s velocity
            if abs(translation.x) > 100 && abs(velocity.x) > 500 {
                if translation.x < 0 {
                    viewModel.switchPane(direction: 1)
                    showGestureHint("Next Pane →")
                } else {
                    viewModel.switchPane(direction: -1)
                    showGestureHint("← Prev Pane")
                }
            }
        }

        // MARK: - Tmux Mode Gesture Handlers

        @objc func handleTwoFingerSwipeLeft() {
            guard let currentPos = viewModel.windows.firstIndex(where: { $0.index == viewModel.activeWindowIndex }) else { return }
            let nextPos = currentPos + 1
            if nextPos < viewModel.windows.count {
                viewModel.switchWindow(to: viewModel.windows[nextPos].index)
                showGestureHint("Next Window →")
            }
        }

        @objc func handleTwoFingerSwipeRight() {
            guard let currentPos = viewModel.windows.firstIndex(where: { $0.index == viewModel.activeWindowIndex }) else { return }
            let prevPos = currentPos - 1
            if prevPos >= 0 {
                viewModel.switchWindow(to: viewModel.windows[prevPos].index)
                showGestureHint("← Prev Window")
            }
        }

        @objc func handleTwoFingerSwipeUp() {
            viewModel.connection.scroll(direction: "up", count: 5)
            showGestureHint("Scroll ↑")
        }

        @objc func handleTwoFingerSwipeDown() {
            viewModel.connection.scroll(direction: "down", count: 5)
            showGestureHint("Scroll ↓")
        }

        @objc func handleThreeFingerSwipeLeft() {
            sendTmuxPrefix()
            viewModel.sendInput(Data([0x1b, 0x5b, 0x43])) // Right arrow: ESC [ C
            showGestureHint("Next Pane →")
        }

        @objc func handleThreeFingerSwipeRight() {
            sendTmuxPrefix()
            viewModel.sendInput(Data([0x1b, 0x5b, 0x44])) // Left arrow: ESC [ D
            showGestureHint("← Prev Pane")
        }

        @objc func handleTwoFingerDoubleTap() {
            viewModel.sendInput(Data([0x03]))
            showGestureHint("Ctrl+C")
        }

        @objc func handleTwoFingerTripleTap() {
            showQuickActions = true
        }

        private func sendTmuxPrefix() {
            viewModel.sendInput(Data([0x02])) // Ctrl+B
        }

        private func showGestureHint(_ text: String) {
            guard let tv = terminalView else { return }
            let existing = tv.viewWithTag(9999)
            existing?.removeFromSuperview()

            let label = GestureHintLabel(text: text)
            label.tag = 9999
            tv.addSubview(label)
            label.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                label.centerXAnchor.constraint(equalTo: tv.centerXAnchor),
                label.centerYAnchor.constraint(equalTo: tv.centerYAnchor)
            ])

            label.alpha = 0
            label.transform = CGAffineTransform(scaleX: 0.8, y: 0.8)
            UIView.animate(withDuration: 0.15) {
                label.alpha = 1
                label.transform = .identity
            }
            UIView.animate(withDuration: 0.25, delay: 0.6, options: .curveEaseIn) {
                label.alpha = 0
                label.transform = CGAffineTransform(scaleX: 0.9, y: 0.9)
            } completion: { _ in
                label.removeFromSuperview()
            }
        }

        // MARK: - TerminalViewDelegate

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
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

// MARK: - Gesture Hint Label

private class GestureHintLabel: UIView {
    init(text: String) {
        super.init(frame: .zero)

        let label = UILabel()
        label.text = text
        label.font = .systemFont(ofSize: 15, weight: .semibold)
        label.textColor = .white
        label.textAlignment = .center

        let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
        blur.layer.cornerRadius = 12
        blur.clipsToBounds = true

        addSubview(blur)
        addSubview(label)

        blur.translatesAutoresizingMaskIntoConstraints = false
        label.translatesAutoresizingMaskIntoConstraints = false

        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
            blur.topAnchor.constraint(equalTo: topAnchor),
            blur.bottomAnchor.constraint(equalTo: bottomAnchor),
            blur.leadingAnchor.constraint(equalTo: leadingAnchor),
            blur.trailingAnchor.constraint(equalTo: trailingAnchor),
        ])

        isUserInteractionEnabled = false
    }

    required init?(coder: NSCoder) { fatalError() }
}
