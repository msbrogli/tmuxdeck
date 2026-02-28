import Foundation

struct TemplateResponse: Codable, Identifiable {
    let id: String
    let name: String
    let type: String
    let content: String
    let buildArgs: [String: String]
    let defaultVolumes: [String]
    let defaultEnv: [String: String]
    let createdAt: String
    let updatedAt: String
}
