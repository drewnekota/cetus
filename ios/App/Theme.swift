import SwiftUI
import UIKit

/// Neutral, low-contrast surfaces in the spirit of the desktop app: one
/// background, slightly raised cards, hairline borders, and an accent used
/// only for state (running, unread, send).
enum Theme {
    // Same ramp as Paseo's default theme (zinc in light, teal-tinted dark).
    static let background = dynamic(light: 0xFFFFFF, dark: 0x181B1A)
    static let surface = dynamic(light: 0xF4F4F5, dark: 0x1E2120)
    static let raised = dynamic(light: 0xE4E4E7, dark: 0x272A29)
    static let border = dynamic(light: 0xE4E4E7, dark: 0x252B2A)
    static let borderAccent = dynamic(light: 0xECECF1, dark: 0x2F3534)
    static let text = dynamic(light: 0x1A1A1E, dark: 0xFAFAFA)
    static let muted = dynamic(light: 0x71717A, dark: 0xA1A5A4)
    static let faint = dynamic(light: 0xA1A1AA, dark: 0x717574)
    static let accent = Color("AccentColor")
    static let success = dynamic(light: 0x299F51, dark: 0x35C264)

    // Type ramp: 15 for content, 14 for lists, 12 for meta.
    static let content = Font.system(size: 15)
    static let row = Font.system(size: 15)
    static let label = Font.system(size: 14)
    static let meta = Font.system(size: 12)

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

/// Rounded-square initial for a folder, its hue derived from the name so a
/// folder keeps its color everywhere.
struct FolderAvatar: View {
    let name: String
    var size: CGFloat = 22

    private static let palette: [UInt32] = [0xB0577F, 0x4F8A8B, 0x7C6BD6, 0xC27C3E, 0x5A7FC2, 0x6E9A4F, 0xA05BB0, 0x8A7560]

    var body: some View {
        let initial = name.first.map { String($0).uppercased() } ?? "·"
        let hash = name.unicodeScalars.reduce(UInt32(5381)) { ($0 &<< 5) &+ $0 &+ $1.value }
        let color = Color(uiColor: UIColor(hex: Self.palette[Int(hash % UInt32(Self.palette.count))]))
        Text(initial)
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(color, in: RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
    }
}

/// The small leading marker of a chat row: a spinner while the agent works,
/// an accent dot for unseen replies, a faint dot otherwise.
struct StatusDot: View {
    let running: Bool
    let unread: Bool

    var body: some View {
        ZStack {
            if running {
                ProgressView()
                    .controlSize(.mini)
                    .tint(Theme.accent)
            } else {
                Circle()
                    .fill(unread ? Theme.accent : Theme.faint.opacity(0.6))
                    .frame(width: unread ? 7 : 5, height: unread ? 7 : 5)
            }
        }
        .frame(width: 16, height: 16)
    }
}

/// Paseo-style labelled selector card ("Folder / Mac / Runtime").
struct FieldCard<Content: View>: View {
    let label: String
    @ViewBuilder var content: Content

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(label)
                    .font(Theme.meta)
                    .foregroundStyle(Theme.muted)
                content
                    .font(Theme.label)
                    .foregroundStyle(Theme.text)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.down")
                .font(.footnote.weight(.medium))
                .foregroundStyle(Theme.muted)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 56)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .contentShape(Rectangle())
    }
}

extension String {
    /// Last path component, or "Chat" for the default (empty) workspace.
    var folderName: String {
        let last = (self as NSString).lastPathComponent
        return last.isEmpty ? "Chat" : last
    }
}
