import Foundation

struct TmuxSessionResponse: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let windows: [TmuxWindowResponse]
    let created: String
    let attached: Bool
    let summary: String?

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }

    static func == (lhs: TmuxSessionResponse, rhs: TmuxSessionResponse) -> Bool {
        lhs.id == rhs.id
    }
}

struct CreateSessionRequest: Codable {
    let name: String
}

struct RenameSessionRequest: Codable {
    let name: String
}
