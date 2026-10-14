import AppKit
import SwiftUI

/// Settings → Appearance → Background image: the chosen image, cover-fit behind
/// the Chats page under a `fade`% veil of the background color (wallpaper-frame.tsx).
struct ChatWallpaper: View {
    @AppStorage("settings.wallpaper") private var path = ""
    @AppStorage("settings.wallpaperFade") private var fade = 60.0

    var body: some View {
        if let img = Self.image(path) {
            GeometryReader { g in
                Image(nsImage: img).resizable().aspectRatio(contentMode: .fill)
                    .frame(width: g.size.width, height: g.size.height).clipped()
                    .overlay(Theme.background.opacity(fade / 100))
            }
            .allowsHitTesting(false)
        }
    }

    private static var cache: (path: String, date: Date?, image: NSImage)?

    /// Decoded once per file version; nil when unset or unreadable.
    static func image(_ path: String) -> NSImage? {
        guard !path.isEmpty else { return nil }
        let date = (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date
        if let c = cache, c.path == path, c.date == date { return c.image }
        guard let img = NSImage(contentsOfFile: path) else { return nil }
        cache = (path, date, img)
        return img
    }
}

extension View {
    /// Draws the chat wallpaper behind the view when one is set.
    func chatWallpaper() -> some View { background { ChatWallpaper() } }
}
