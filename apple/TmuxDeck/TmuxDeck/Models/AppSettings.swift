import Foundation

struct SettingsResponse: Codable {
    let telegramBotToken: String
    let telegramAllowedUsers: [String]
    let defaultVolumeMounts: [String]
    let sshKeyPath: String
    let telegramRegistrationSecret: String
    let telegramNotificationTimeoutSecs: Int
    let hotkeys: [String: String]
}

struct UpdateSettingsRequest: Codable {
    var telegramBotToken: String?
    var telegramAllowedUsers: [String]?
    var defaultVolumeMounts: [String]?
    var sshKeyPath: String?
    var telegramRegistrationSecret: String?
    var telegramNotificationTimeoutSecs: Int?
    var hotkeys: [String: String]?
}
