import Foundation

struct RawStreamEvent: Decodable {
    let event: String
    let step: String?
    let message: String?
    let line: String?
    let container: ContainerResponse?
}

enum ContainerStreamEvent {
    case step(key: String, message: String)
    case log(line: String)
    case complete(container: ContainerResponse)
    case error(step: String?, message: String)

    init(from raw: RawStreamEvent) {
        switch raw.event {
        case "step":
            self = .step(key: raw.step ?? "", message: raw.message ?? "")
        case "log":
            self = .log(line: raw.line ?? "")
        case "complete":
            if let container = raw.container {
                self = .complete(container: container)
            } else {
                self = .error(step: nil, message: "Complete event missing container")
            }
        case "error":
            self = .error(step: raw.step, message: raw.message ?? "Unknown error")
        default:
            self = .error(step: nil, message: "Unknown event: \(raw.event)")
        }
    }
}
