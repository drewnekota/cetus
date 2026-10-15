import AppKit
import SwiftUI

enum Zoom {
    /// Browser zoom ladder (same as Cetus/Chrome): 90 → 100 → 110 → 125 → 150.
    static let levels: [Double] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

    static func step(_ z: Double, up: Bool) -> Double {
        up ? (levels.first { $0 > z + 1e-6 } ?? levels.last!) : (levels.last { $0 < z - 1e-6 } ?? levels.first!)
    }
}

/// Zooms the whole SwiftUI tree: lay out in a smaller space, then scale up,
/// so text, padding and hit-testing all follow (like webview zoom in Cetus).
struct ZoomRoot<Content: View>: View {
    @Environment(AppState.self) private var app
    @ViewBuilder var content: Content
    var body: some View {
        let z = CGFloat(app.prefs.zoom)
        GeometryReader { g in
            content
                .frame(width: g.size.width / z, height: g.size.height / z)
                .scaleEffect(z, anchor: .topLeading)
                .frame(width: g.size.width, height: g.size.height, alignment: .topLeading)
        }
        .ignoresSafeArea()
    }
}

/// Transient "110%" pill shown on ⌘+/⌘−/⌘0.
struct ZoomHud: View {
    let pct: Int
    var body: some View {
        Text("\(pct)%")
            .font(.system(size: 18).monospacedDigit())
            .foregroundStyle(Theme.background)
            .padding(.horizontal, 20).padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 12).fill(Theme.foreground.opacity(0.9)))
            .shadow(color: .black.opacity(0.2), radius: 10, y: 4)
            .allowsHitTesting(false)
    }
}
