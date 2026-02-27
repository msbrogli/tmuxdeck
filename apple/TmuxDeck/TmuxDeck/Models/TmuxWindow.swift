import Foundation

struct TmuxWindowResponse: Codable, Identifiable, Hashable {
    let index: Int
    let name: String
    let active: Bool
    let panes: Int
    let bell: Bool
    let activity: Bool
    let command: String
    let paneStatus: String

    var id: Int { index }

    enum CodingKeys: String, CodingKey {
        case index, name, active, panes, bell, activity, command
        case paneStatus
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        index = try container.decode(Int.self, forKey: .index)
        name = try container.decode(String.self, forKey: .name)
        active = try container.decode(Bool.self, forKey: .active)
        panes = try container.decode(Int.self, forKey: .panes)
        bell = try container.decode(Bool.self, forKey: .bell)
        activity = try container.decode(Bool.self, forKey: .activity)
        command = try container.decodeIfPresent(String.self, forKey: .command) ?? ""
        paneStatus = try container.decodeIfPresent(String.self, forKey: .paneStatus) ?? ""
    }
}

struct CreateWindowRequest: Codable {
    let name: String?
}

struct SwapWindowsRequest: Codable {
    let index1: Int
    let index2: Int
}

struct MoveWindowRequest: Codable {
    let windowIndex: Int
    let targetSessionId: String
}
