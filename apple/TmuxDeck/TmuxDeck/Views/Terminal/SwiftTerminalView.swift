import SwiftUI
import SwiftTerm

struct SwiftTerminalView: UIViewRepresentable {
    let viewModel: TerminalViewModel

    func makeUIView(context: Context) -> TerminalView {
        let terminalView = TerminalView()
        terminalView.terminalDelegate = context.coordinator
        terminalView.nativeForegroundColor = .white
        terminalView.nativeBackgroundColor = UIColor(red: 0.1, green: 0.1, blue: 0.12, alpha: 1.0)

        let fontSize = viewModel.fontSize
        terminalView.font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)

        context.coordinator.terminalView = terminalView

        // Give the view model a way to feed data into the terminal
        viewModel.feedHandler = { [weak terminalView] bytes in
            terminalView?.feed(byteArray: ArraySlice(bytes))
        }

        // Now that we have a feed handler, connect
        viewModel.connectIfNeeded()

        return terminalView
    }

    func updateUIView(_ uiView: TerminalView, context: Context) {
        let size = viewModel.fontSize
        if uiView.font.pointSize != size {
            uiView.font = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(viewModel: viewModel)
    }

    class Coordinator: NSObject, TerminalViewDelegate {
        let viewModel: TerminalViewModel
        weak var terminalView: TerminalView?

        init(viewModel: TerminalViewModel) {
            self.viewModel = viewModel
            super.init()
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
