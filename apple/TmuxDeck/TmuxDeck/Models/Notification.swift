import Foundation

struct NotificationResponse: Codable, Identifiable {
    let id: String
    let message: String
    let title: String
    let notificationType: String
    let sessionId: String
    let containerId: String
    let tmuxSession: String
    let tmuxWindow: Int
    let createdAt: String
    let status: String
    let channels: [String]
}

struct DismissRequest: Codable {
    var sessionId: String = ""
    var containerId: String = ""
    var tmuxSession: String = ""
    var tmuxWindow: Int?
}
