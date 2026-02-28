import SwiftUI
import AVFoundation

struct ServerSetupView: View {
    @Environment(AppState.self) private var appState
    @State private var serverURL = ""
    @State private var serverName = ""
    @State private var isValidating = false
    @State private var validationError: String?
    @State private var showScanner = false
    @State private var discovery = ServerDiscovery()

    var body: some View {
        NavigationStack {
            List {
                if !appState.servers.isEmpty {
                    Section("Saved Servers") {
                        ForEach(appState.servers) { server in
                            ServerRow(server: server) {
                                appState.selectServer(server)
                                Task {
                                    await appState.checkAuthAndNavigate()
                                }
                            }
                        }
                        .onDelete { indices in
                            for index in indices {
                                appState.removeServer(appState.servers[index])
                            }
                        }
                    }
                }

                if let error = appState.errorMessage {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                            .font(.caption)
                    }
                }

                if appState.isLoading {
                    Section {
                        HStack {
                            ProgressView()
                            Text("Connecting...")
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Section("Add Server") {
                    TextField("Server Name", text: $serverName)
                        .textContentType(.organizationName)

                    TextField("Server URL (e.g., 192.168.1.100:8000)", text: $serverURL)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)

                    if let error = validationError {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                            .font(.caption)
                    }

                    Button {
                        Task { await connectToServer() }
                    } label: {
                        HStack {
                            Text("Connect")
                            Spacer()
                            if isValidating {
                                ProgressView()
                            }
                        }
                    }
                    .disabled(serverURL.isEmpty || isValidating)
                }

                Section("Quick Connect") {
                    Button {
                        showScanner = true
                    } label: {
                        Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                    }

                    Button {
                        discovery.startBonjourDiscovery()
                    } label: {
                        Label(
                            discovery.isScanning ? "Scanning..." : "Find on Network",
                            systemImage: "network"
                        )
                    }
                    .disabled(discovery.isScanning)
                }

                if !discovery.discoveredServers.isEmpty {
                    Section("Discovered") {
                        ForEach(discovery.discoveredServers) { server in
                            Button {
                                serverURL = server.url
                                serverName = server.name
                            } label: {
                                VStack(alignment: .leading) {
                                    Text(server.name)
                                        .font(.headline)
                                    Text(server.url)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("TmuxDeck")
            .sheet(isPresented: $showScanner) {
                QRScannerView { code in
                    if let url = discovery.parseQRCode(code) {
                        serverURL = url
                        showScanner = false
                    }
                }
            }
        }
    }

    private func connectToServer() async {
        isValidating = true
        validationError = nil

        var url = serverURL
        if !url.hasPrefix("http://") && !url.hasPrefix("https://") {
            url = "http://\(url)"
        }

        let isValid = await discovery.validateServer(url: url)

        if isValid {
            let name = serverName.isEmpty ? url : serverName
            appState.addServer(name: name, url: url)
            if let server = appState.servers.last {
                appState.selectServer(server)
                await appState.checkAuthAndNavigate()
            }
        } else {
            validationError = "Could not connect to server"
        }

        isValidating = false
    }
}

struct ServerRow: View {
    let server: ServerConfig
    let onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack {
                VStack(alignment: .leading) {
                    Text(server.name)
                        .font(.headline)
                    Text(server.url)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if server.isActive {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                }
            }
        }
    }
}

// MARK: - QR Scanner

struct QRScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerViewController {
        let vc = QRScannerViewController()
        vc.onScan = onScan
        return vc
    }

    func updateUIViewController(_ uiViewController: QRScannerViewController, context: Context) {}
}

class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onScan: ((String) -> Void)?
    private var captureSession: AVCaptureSession?

    override func viewDidLoad() {
        super.viewDidLoad()

        let session = AVCaptureSession()
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else {
            return
        }

        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.frame = view.bounds
        previewLayer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(previewLayer)

        captureSession = session

        DispatchQueue.global(qos: .userInitiated).async {
            session.startRunning()
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        captureSession?.stopRunning()
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = object.stringValue else {
            return
        }
        captureSession?.stopRunning()
        onScan?(value)
    }
}
