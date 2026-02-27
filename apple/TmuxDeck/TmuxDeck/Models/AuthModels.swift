import Foundation

struct AuthStatus: Codable {
    let authenticated: Bool
    let pinSet: Bool
}

struct PINRequest: Codable {
    let pin: String
}

struct ChangePINRequest: Codable {
    let currentPin: String
    let newPin: String
}

struct OkResponse: Codable {
    let ok: Bool
}

struct ErrorResponse: Codable {
    let detail: String
}
