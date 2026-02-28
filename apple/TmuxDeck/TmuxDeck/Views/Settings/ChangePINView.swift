import SwiftUI

struct ChangePINView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss

    enum Step { case current, newPin, confirm }

    @State private var step: Step = .current
    @State private var currentPin = ""
    @State private var newPin = ""
    @State private var confirmPin = ""
    @State private var error: String?
    @State private var isLoading = false

    var body: some View {
        Form {
            switch step {
            case .current:
                Section {
                    SecureField("Current PIN", text: $currentPin)
                        .keyboardType(.numberPad)
                } header: {
                    Text("Enter your current PIN")
                } footer: {
                    if let error { Text(error).foregroundStyle(.red) }
                }

                Section {
                    Button("Next") { validateCurrentAndProceed() }
                        .disabled(currentPin.count < 4)
                }

            case .newPin:
                Section {
                    SecureField("New PIN", text: $newPin)
                        .keyboardType(.numberPad)
                } header: {
                    Text("Enter your new PIN (4+ digits)")
                }

                Section {
                    Button("Next") { step = .confirm }
                        .disabled(newPin.count < 4)
                }

            case .confirm:
                Section {
                    SecureField("Confirm New PIN", text: $confirmPin)
                        .keyboardType(.numberPad)
                } header: {
                    Text("Confirm your new PIN")
                } footer: {
                    if let error { Text(error).foregroundStyle(.red) }
                }

                Section {
                    Button("Change PIN") { Task { await changePIN() } }
                        .disabled(confirmPin.count < 4 || isLoading)
                }
            }
        }
        .navigationTitle("Change PIN")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func validateCurrentAndProceed() {
        error = nil
        step = .newPin
    }

    private func changePIN() async {
        guard newPin == confirmPin else {
            error = "PINs do not match"
            return
        }

        isLoading = true
        error = nil
        do {
            try await appState.apiClient.changePIN(currentPin: currentPin, newPin: newPin)
            dismiss()
        } catch let apiError as APIError {
            switch apiError {
            case .unauthorized:
                error = "Current PIN is incorrect"
                step = .current
                currentPin = ""
            default:
                error = apiError.localizedDescription
            }
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }
}
