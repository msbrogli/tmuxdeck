import SwiftUI
import UIKit

struct ScrollbackOverlayView: View {
    let historyText: String
    let theme: TerminalTheme
    let fontSize: CGFloat
    let onDismiss: () -> Void

    var body: some View {
        ZStack {
            Color(theme.background)
                .ignoresSafeArea()

            ScrollbackTextView(
                text: historyText,
                font: UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular),
                textColor: theme.foreground,
                backgroundColor: theme.background
            )
            .ignoresSafeArea(.container, edges: .bottom)

            // Dismiss button
            VStack {
                HStack {
                    Spacer()
                    Button {
                        onDismiss()
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "xmark")
                                .font(.system(size: 12, weight: .bold))
                            Text("Back to Live")
                                .font(.system(size: 12, weight: .semibold))
                        }
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(.ultraThinMaterial)
                        .clipShape(Capsule())
                    }
                    .padding(12)
                }
                Spacer()
            }
        }
    }
}

// MARK: - UITextView wrapper for native selection, copy, and ANSI color rendering

struct ScrollbackTextView: UIViewRepresentable {
    let text: String
    let font: UIFont
    let textColor: UIColor
    let backgroundColor: UIColor

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.isUserInteractionEnabled = true
        textView.backgroundColor = backgroundColor
        textView.textContainerInset = UIEdgeInsets(top: 8, left: 6, bottom: 8, right: 6)
        textView.indicatorStyle = .white
        textView.alwaysBounceVertical = true
        textView.isScrollEnabled = true
        textView.textContainer.lineBreakMode = .byCharWrapping
        textView.textContainer.lineFragmentPadding = 2
        textView.dataDetectorTypes = []
        let attributed = parseAnsi(text, font: font, defaultColor: textColor)
        textView.attributedText = attributed
        context.coordinator.lastText = text
        // Scroll to bottom after layout
        DispatchQueue.main.async {
            let bottom = NSRange(location: attributed.length, length: 0)
            textView.scrollRangeToVisible(bottom)
        }
        return textView
    }

    class Coordinator {
        var lastText: String = ""
    }

    func updateUIView(_ uiView: UITextView, context: Context) {
        // Only update if text actually changed — re-setting attributedText
        // cancels any active text selection the user is making.
        if context.coordinator.lastText != text {
            context.coordinator.lastText = text
            uiView.attributedText = parseAnsi(text, font: font, defaultColor: textColor)
            uiView.backgroundColor = backgroundColor
            let bottom = NSRange(location: uiView.attributedText.length, length: 0)
            uiView.scrollRangeToVisible(bottom)
        }
    }
}

// MARK: - ANSI escape sequence parser → NSAttributedString

private func parseAnsi(_ text: String, font: UIFont, defaultColor: UIColor) -> NSAttributedString {
    let result = NSMutableAttributedString()
    var currentFg = defaultColor
    var currentBold = false
    var currentDim = false
    var currentItalic = false
    var currentUnderline = false

    let defaultAttrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: defaultColor,
    ]

    func makeAttrs() -> [NSAttributedString.Key: Any] {
        var attrs: [NSAttributedString.Key: Any] = [.foregroundColor: currentFg]
        if currentBold {
            attrs[.font] = UIFont.monospacedSystemFont(ofSize: font.pointSize, weight: .bold)
        } else {
            attrs[.font] = font
        }
        if currentDim {
            attrs[.foregroundColor] = currentFg.withAlphaComponent(0.5)
        }
        if currentItalic {
            if let descriptor = font.fontDescriptor.withSymbolicTraits(.traitItalic) {
                attrs[.font] = UIFont(descriptor: descriptor, size: font.pointSize)
            }
        }
        if currentUnderline {
            attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
        }
        return attrs
    }

    var segment = ""
    var i = text.startIndex

    while i < text.endIndex {
        let c = text[i]

        if c == "\u{1b}" {
            // Flush current segment
            if !segment.isEmpty {
                result.append(NSAttributedString(string: segment, attributes: makeAttrs()))
                segment = ""
            }

            let next = text.index(after: i)
            guard next < text.endIndex else { break }
            let nc = text[next]

            if nc == "[" {
                // CSI sequence: parse parameters
                var j = text.index(after: next)
                var params = ""
                while j < text.endIndex {
                    let fc = text[j].asciiValue ?? 0
                    if fc >= 0x40 && fc <= 0x7E {
                        // Final byte
                        if text[j] == "m" {
                            // SGR — apply colors/styles
                            applySgr(params, fg: &currentFg, bold: &currentBold,
                                     dim: &currentDim, italic: &currentItalic,
                                     underline: &currentUnderline, defaultColor: defaultColor)
                        }
                        i = text.index(after: j)
                        break
                    }
                    params.append(text[j])
                    j = text.index(after: j)
                }
                if j >= text.endIndex { i = text.endIndex }
                continue
            } else if nc == "]" {
                // OSC: skip until ST or BEL
                var j = text.index(after: next)
                while j < text.endIndex {
                    if text[j] == "\u{07}" {
                        i = text.index(after: j)
                        break
                    }
                    if text[j] == "\u{1b}" {
                        let k = text.index(after: j)
                        if k < text.endIndex && text[k] == "\\" {
                            i = text.index(after: k)
                            break
                        }
                    }
                    j = text.index(after: j)
                }
                if j >= text.endIndex { i = text.endIndex }
                continue
            } else {
                // Other 2-char escape
                i = text.index(after: next)
                continue
            }
        }

        segment.append(c)
        i = text.index(after: i)
    }

    // Flush remaining
    if !segment.isEmpty {
        result.append(NSAttributedString(string: segment, attributes: makeAttrs()))
    }

    // Fallback if empty
    if result.length == 0 {
        result.append(NSAttributedString(string: text, attributes: defaultAttrs))
    }

    return result
}

// MARK: - SGR parameter handler

private func applySgr(
    _ params: String,
    fg: inout UIColor,
    bold: inout Bool,
    dim: inout Bool,
    italic: inout Bool,
    underline: inout Bool,
    defaultColor: UIColor
) {
    let codes = params.split(separator: ";").compactMap { Int($0) }
    if codes.isEmpty {
        // ESC[m is equivalent to ESC[0m
        fg = defaultColor
        bold = false
        dim = false
        italic = false
        underline = false
        return
    }

    var idx = 0
    while idx < codes.count {
        let code = codes[idx]
        switch code {
        case 0:
            fg = defaultColor
            bold = false
            dim = false
            italic = false
            underline = false
        case 1: bold = true
        case 2: dim = true
        case 3: italic = true
        case 4: underline = true
        case 22: bold = false; dim = false
        case 23: italic = false
        case 24: underline = false
        case 30: fg = UIColor(red: 0, green: 0, blue: 0, alpha: 1)
        case 31: fg = UIColor(red: 0.8, green: 0.2, blue: 0.2, alpha: 1)
        case 32: fg = UIColor(red: 0.2, green: 0.8, blue: 0.2, alpha: 1)
        case 33: fg = UIColor(red: 0.8, green: 0.8, blue: 0.2, alpha: 1)
        case 34: fg = UIColor(red: 0.3, green: 0.5, blue: 0.9, alpha: 1)
        case 35: fg = UIColor(red: 0.8, green: 0.3, blue: 0.8, alpha: 1)
        case 36: fg = UIColor(red: 0.3, green: 0.8, blue: 0.8, alpha: 1)
        case 37: fg = UIColor(red: 0.8, green: 0.8, blue: 0.8, alpha: 1)
        case 39: fg = defaultColor
        case 90: fg = UIColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1)
        case 91: fg = UIColor(red: 1.0, green: 0.3, blue: 0.3, alpha: 1)
        case 92: fg = UIColor(red: 0.3, green: 1.0, blue: 0.3, alpha: 1)
        case 93: fg = UIColor(red: 1.0, green: 1.0, blue: 0.3, alpha: 1)
        case 94: fg = UIColor(red: 0.4, green: 0.6, blue: 1.0, alpha: 1)
        case 95: fg = UIColor(red: 1.0, green: 0.4, blue: 1.0, alpha: 1)
        case 96: fg = UIColor(red: 0.4, green: 1.0, blue: 1.0, alpha: 1)
        case 97: fg = .white
        case 38:
            // Extended color: 38;5;N (256-color) or 38;2;R;G;B (truecolor)
            if idx + 1 < codes.count {
                if codes[idx + 1] == 5 && idx + 2 < codes.count {
                    fg = color256(codes[idx + 2], defaultColor: defaultColor)
                    idx += 2
                } else if codes[idx + 1] == 2 && idx + 4 < codes.count {
                    let r = CGFloat(codes[idx + 2]) / 255.0
                    let g = CGFloat(codes[idx + 3]) / 255.0
                    let b = CGFloat(codes[idx + 4]) / 255.0
                    fg = UIColor(red: r, green: g, blue: b, alpha: 1)
                    idx += 4
                }
            }
        default:
            break // Ignore background colors and other codes
        }
        idx += 1
    }
}

// MARK: - 256-color lookup

private func color256(_ n: Int, defaultColor: UIColor) -> UIColor {
    if n < 8 {
        // Standard colors
        let colors: [UIColor] = [
            UIColor(red: 0, green: 0, blue: 0, alpha: 1),
            UIColor(red: 0.8, green: 0.2, blue: 0.2, alpha: 1),
            UIColor(red: 0.2, green: 0.8, blue: 0.2, alpha: 1),
            UIColor(red: 0.8, green: 0.8, blue: 0.2, alpha: 1),
            UIColor(red: 0.3, green: 0.5, blue: 0.9, alpha: 1),
            UIColor(red: 0.8, green: 0.3, blue: 0.8, alpha: 1),
            UIColor(red: 0.3, green: 0.8, blue: 0.8, alpha: 1),
            UIColor(red: 0.8, green: 0.8, blue: 0.8, alpha: 1),
        ]
        return colors[n]
    } else if n < 16 {
        // Bright colors
        let colors: [UIColor] = [
            UIColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1),
            UIColor(red: 1.0, green: 0.3, blue: 0.3, alpha: 1),
            UIColor(red: 0.3, green: 1.0, blue: 0.3, alpha: 1),
            UIColor(red: 1.0, green: 1.0, blue: 0.3, alpha: 1),
            UIColor(red: 0.4, green: 0.6, blue: 1.0, alpha: 1),
            UIColor(red: 1.0, green: 0.4, blue: 1.0, alpha: 1),
            UIColor(red: 0.4, green: 1.0, blue: 1.0, alpha: 1),
            .white,
        ]
        return colors[n - 8]
    } else if n < 232 {
        // 216-color cube (6x6x6)
        let idx = n - 16
        let r = CGFloat((idx / 36) % 6) / 5.0
        let g = CGFloat((idx / 6) % 6) / 5.0
        let b = CGFloat(idx % 6) / 5.0
        return UIColor(red: r, green: g, blue: b, alpha: 1)
    } else if n < 256 {
        // Grayscale ramp
        let level = CGFloat(n - 232) / 23.0
        return UIColor(red: level, green: level, blue: level, alpha: 1)
    }
    return defaultColor
}
