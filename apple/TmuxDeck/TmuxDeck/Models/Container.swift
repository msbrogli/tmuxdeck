import Foundation

struct ContainerResponse: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let displayName: String
    let status: String
    let image: String
    let isHost: Bool?
    let isLocal: Bool?
    let templateId: String?
    let sessions: [TmuxSessionResponse]
    let createdAt: String

    var isSpecial: Bool {
        isHost == true || isLocal == true
    }

    var statusColor: String {
        switch status.lowercased() {
        case "running": return "green"
        case "exited", "stopped": return "red"
        case "creating": return "yellow"
        default: return "gray"
        }
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }

    static func == (lhs: ContainerResponse, rhs: ContainerResponse) -> Bool {
        lhs.id == rhs.id
    }
}

struct ContainerListResponse: Codable {
    let containers: [ContainerResponse]
    let dockerError: String?
}

struct CreateContainerRequest: Codable {
    let templateId: String
    let name: String
    var env: [String: String] = [:]
    var volumes: [String] = []
    var mountSsh: Bool = true
    var mountClaude: Bool = true
}

struct RenameContainerRequest: Codable {
    let displayName: String
}
