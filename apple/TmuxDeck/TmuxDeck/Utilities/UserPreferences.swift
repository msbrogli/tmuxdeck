import SwiftUI
import UIKit

struct TerminalTheme: Identifiable, Equatable {
    let id: String
    let name: String
    let foreground: UIColor
    let background: UIColor
    let cursor: UIColor

    static let dark = TerminalTheme(
        id: "dark",
        name: "Dark",
        foreground: .white,
        background: UIColor(red: 0.1, green: 0.1, blue: 0.12, alpha: 1.0),
        cursor: UIColor(red: 0.8, green: 0.8, blue: 0.8, alpha: 1.0)
    )

    static let light = TerminalTheme(
        id: "light",
        name: "Light",
        foreground: UIColor(red: 0.15, green: 0.15, blue: 0.15, alpha: 1.0),
        background: UIColor(red: 0.98, green: 0.98, blue: 0.98, alpha: 1.0),
        cursor: UIColor(red: 0.2, green: 0.2, blue: 0.2, alpha: 1.0)
    )

    static let solarizedDark = TerminalTheme(
        id: "solarizedDark",
        name: "Solarized Dark",
        foreground: UIColor(red: 0.51, green: 0.58, blue: 0.59, alpha: 1.0),
        background: UIColor(red: 0.0, green: 0.17, blue: 0.21, alpha: 1.0),
        cursor: UIColor(red: 0.58, green: 0.63, blue: 0.63, alpha: 1.0)
    )

    static let solarizedLight = TerminalTheme(
        id: "solarizedLight",
        name: "Solarized Light",
        foreground: UIColor(red: 0.4, green: 0.48, blue: 0.51, alpha: 1.0),
        background: UIColor(red: 0.99, green: 0.96, blue: 0.89, alpha: 1.0),
        cursor: UIColor(red: 0.35, green: 0.43, blue: 0.46, alpha: 1.0)
    )

    static let monokai = TerminalTheme(
        id: "monokai",
        name: "Monokai",
        foreground: UIColor(red: 0.97, green: 0.97, blue: 0.95, alpha: 1.0),
        background: UIColor(red: 0.16, green: 0.16, blue: 0.14, alpha: 1.0),
        cursor: UIColor(red: 0.97, green: 0.97, blue: 0.95, alpha: 1.0)
    )

    static let allThemes: [TerminalTheme] = [.dark, .light, .solarizedDark, .solarizedLight, .monokai]

    static func named(_ id: String) -> TerminalTheme {
        allThemes.first { $0.id == id } ?? .dark
    }
}

@Observable
final class UserPreferences {
    var fontSize: CGFloat {
        didSet { UserDefaults.standard.set(Double(fontSize), forKey: "tmuxdeck_fontSize") }
    }

    var themeName: String {
        didSet { UserDefaults.standard.set(themeName, forKey: "tmuxdeck_themeName") }
    }

    var biometricsEnabled: Bool {
        didSet { UserDefaults.standard.set(biometricsEnabled, forKey: "tmuxdeck_biometricsEnabled") }
    }

    var preferAppMode: Bool {
        didSet { UserDefaults.standard.set(preferAppMode, forKey: "tmuxdeck_preferAppMode") }
    }

    var currentTheme: TerminalTheme {
        TerminalTheme.named(themeName)
    }

    init() {
        let defaults = UserDefaults.standard
        let savedFontSize = defaults.double(forKey: "tmuxdeck_fontSize")
        self.fontSize = savedFontSize > 0 ? CGFloat(savedFontSize) : 14
        self.themeName = defaults.string(forKey: "tmuxdeck_themeName") ?? "dark"
        self.biometricsEnabled = defaults.bool(forKey: "tmuxdeck_biometricsEnabled")
        if defaults.object(forKey: "tmuxdeck_preferAppMode") != nil {
            self.preferAppMode = defaults.bool(forKey: "tmuxdeck_preferAppMode")
        } else {
            self.preferAppMode = UIDevice.current.userInterfaceIdiom == .phone
        }
    }
}
