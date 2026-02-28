import SwiftUI

struct CreateContainerView: View {
    let apiClient: APIClient
    var onCreated: (() -> Void)?
    @Environment(\.dismiss) private var dismiss

    @State private var templates: [TemplateResponse] = []
    @State private var selectedTemplate: TemplateResponse?
    @State private var containerName = ""
    @State private var envVars: [(key: String, value: String)] = []
    @State private var volumes: [String] = []
    @State private var newVolume = ""
    @State private var mountSsh = true
    @State private var mountClaude = true
    @State private var isLoadingTemplates = false
    @State private var error: String?

    // Streaming creation state
    @State private var isCreating = false
    @State private var stepStatuses: [String: StepStatus] = [:]
    @State private var buildLogs: [String] = []
    @State private var showBuildLogs = false
    @State private var creationError: String?

    enum StepStatus {
        case pending, active, done, error
    }

    private let steps: [(key: String, label: String)] = [
        ("building_image", "Building image"),
        ("creating_container", "Creating container"),
        ("starting_container", "Starting container"),
        ("initializing", "Initializing tmux session"),
    ]

    var body: some View {
        NavigationStack {
            Group {
                if isCreating {
                    creationProgressView
                } else {
                    formView
                }
            }
            .navigationTitle("New Container")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isCreating)
                }
                if !isCreating {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Create") {
                            Task { await createContainer() }
                        }
                        .disabled(selectedTemplate == nil || containerName.isEmpty)
                    }
                }
            }
            .task { await loadTemplates() }
        }
    }

    private var formView: some View {
        Form {
            Section("Template") {
                if templates.isEmpty && isLoadingTemplates {
                    ProgressView()
                } else if templates.isEmpty {
                    Text("No templates available")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(templates) { template in
                        Button {
                            selectedTemplate = template
                            if containerName.isEmpty {
                                containerName = template.name
                            }
                            envVars = template.defaultEnv.map { (key: $0.key, value: $0.value) }
                            volumes = template.defaultVolumes
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(template.name)
                                        .foregroundStyle(.primary)
                                    Text(template.type)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                if selectedTemplate?.id == template.id {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(.tint)
                                }
                            }
                        }
                    }
                }
            }

            Section("Container Name") {
                TextField("Name", text: $containerName)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            }

            Section("Options") {
                Toggle("Mount SSH Keys", isOn: $mountSsh)
                Toggle("Mount Claude Config", isOn: $mountClaude)
            }

            Section("Environment Variables") {
                ForEach(envVars.indices, id: \.self) { index in
                    HStack {
                        TextField("Key", text: Binding(
                            get: { envVars[index].key },
                            set: { envVars[index].key = $0 }
                        ))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                        TextField("Value", text: Binding(
                            get: { envVars[index].value },
                            set: { envVars[index].value = $0 }
                        ))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    }
                }
                .onDelete { indices in
                    envVars.remove(atOffsets: indices)
                }

                Button("Add Variable") {
                    envVars.append((key: "", value: ""))
                }
            }

            Section("Volume Mounts") {
                ForEach(volumes, id: \.self) { volume in
                    Text(volume)
                        .font(.system(.caption, design: .monospaced))
                }
                .onDelete { indices in
                    volumes.remove(atOffsets: indices)
                }

                HStack {
                    TextField("/host:/container", text: $newVolume)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))

                    Button("Add") {
                        guard !newVolume.isEmpty else { return }
                        volumes.append(newVolume)
                        newVolume = ""
                    }
                    .disabled(newVolume.isEmpty)
                }
            }

            if let error {
                Section {
                    Text(error)
                        .foregroundStyle(.red)
                        .font(.caption)
                }
            }
        }
    }

    private var creationProgressView: some View {
        List {
            Section("Progress") {
                ForEach(steps, id: \.key) { step in
                    HStack(spacing: 12) {
                        stepIcon(for: stepStatuses[step.key] ?? .pending)
                            .frame(width: 20)
                        Text(step.label)
                            .font(.subheadline)
                        Spacer()
                    }
                    .padding(.vertical, 2)
                }
            }

            if !buildLogs.isEmpty {
                Section {
                    DisclosureGroup("Build Logs (\(buildLogs.count) lines)", isExpanded: $showBuildLogs) {
                        ScrollViewReader { proxy in
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: 1) {
                                    ForEach(Array(buildLogs.enumerated()), id: \.offset) { index, line in
                                        Text(line)
                                            .font(.system(.caption2, design: .monospaced))
                                            .foregroundStyle(.secondary)
                                            .textSelection(.enabled)
                                            .id(index)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .frame(maxHeight: 200)
                            .onChange(of: buildLogs.count) { _, _ in
                                if let last = buildLogs.indices.last {
                                    proxy.scrollTo(last, anchor: .bottom)
                                }
                            }
                        }
                    }
                }
            }

            if let creationError {
                Section {
                    Text(creationError)
                        .foregroundStyle(.red)
                        .font(.caption)

                    Button("Retry") {
                        Task { await createContainer() }
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
    }

    @ViewBuilder
    private func stepIcon(for status: StepStatus) -> some View {
        switch status {
        case .pending:
            Image(systemName: "circle")
                .foregroundStyle(.secondary)
        case .active:
            ProgressView()
                .controlSize(.small)
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .error:
            Image(systemName: "xmark.circle.fill")
                .foregroundStyle(.red)
        }
    }

    private func loadTemplates() async {
        isLoadingTemplates = true
        do {
            templates = try await apiClient.getTemplates()
        } catch {
            self.error = error.localizedDescription
        }
        isLoadingTemplates = false
    }

    private func createContainer() async {
        guard let template = selectedTemplate else { return }
        isCreating = true
        creationError = nil
        stepStatuses = [:]
        buildLogs = []

        var env: [String: String] = [:]
        for pair in envVars where !pair.key.isEmpty {
            env[pair.key] = pair.value
        }

        let request = CreateContainerRequest(
            templateId: template.id,
            name: containerName,
            env: env,
            volumes: volumes,
            mountSsh: mountSsh,
            mountClaude: mountClaude
        )

        do {
            _ = try await apiClient.createContainerStream(request) { event in
                switch event {
                case .step(let key, _):
                    // Mark all previous steps as done
                    for s in steps {
                        if s.key == key { break }
                        if stepStatuses[s.key] == .active {
                            stepStatuses[s.key] = .done
                        }
                    }
                    stepStatuses[key] = .active
                    if key == "building_image" {
                        showBuildLogs = true
                    }
                case .log(let line):
                    buildLogs.append(line)
                case .complete:
                    for s in steps {
                        stepStatuses[s.key] = .done
                    }
                case .error(let step, let message):
                    if let step {
                        stepStatuses[step] = .error
                    }
                    creationError = message
                }
            }
            onCreated?()
            dismiss()
        } catch {
            creationError = error.localizedDescription
            // Mark active step as error
            for s in steps where stepStatuses[s.key] == .active {
                stepStatuses[s.key] = .error
            }
        }
    }
}
