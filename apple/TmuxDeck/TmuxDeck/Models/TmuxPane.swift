import Foundation

struct TmuxPaneResponse: Codable, Identifiable, Hashable {
    let index: Int
    let active: Bool
    let width: Int
    let height: Int
    let title: String
    let command: String

    var id: Int { index }
}
