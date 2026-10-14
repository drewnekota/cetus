import SwiftUI

/// Element frames for the e2e driver, keyed by test id. Recorded only when
/// the driver is active (`CETUS_DRIVE`), so normal runs pay nothing.
final class TestRegistry {
    nonisolated(unsafe) static let shared = TestRegistry()
    static let enabled = ProcessInfo.processInfo.environment["CETUS_DRIVE"] != nil || ProcessInfo.processInfo.environment["CETUS_CONTROL"] != nil

    struct Entry { var frame: CGRect; var seq: Int; var owner: UUID }
    private(set) var frames: [String: Entry] = [:]
    private var seq = 0

    func set(_ id: String, _ frame: CGRect, owner: UUID) {
        seq += 1
        frames[id] = Entry(frame: frame, seq: seq, owner: owner)
    }

    /// Only the view that registered an id may remove it (a replacement view
    /// with the same id can appear before the old one disappears).
    func remove(_ id: String, owner: UUID) {
        if frames[id]?.owner == owner { frames.removeValue(forKey: id) }
    }

    func frame(_ id: String) -> CGRect? {
        guard let f = frames[id]?.frame, f.width > 0, f.height > 0, f.minX > -1000 else { return nil }
        return f
    }

    func ids(matching pattern: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
        return frames.keys.filter { re.firstMatch(in: $0, range: NSRange($0.startIndex..., in: $0)) != nil && frame($0) != nil }.sorted()
    }
}

private struct TestIDModifier: ViewModifier {
    let id: String
    @State private var owner = UUID()
    func body(content: Content) -> some View {
        content
            .accessibilityIdentifier(id)
            .background(
                GeometryReader { g in
                    Color.clear
                        .onAppear { TestRegistry.shared.set(id, g.frame(in: .global), owner: owner) }
                        .onChange(of: g.frame(in: .global)) { _, f in TestRegistry.shared.set(id, f, owner: owner) }
                        .onDisappear { TestRegistry.shared.remove(id, owner: owner) }
                }
            )
    }
}

extension View {
    @ViewBuilder
    func testID(_ id: String?) -> some View {
        if let id, TestRegistry.enabled { modifier(TestIDModifier(id: id)) }
        else if let id { accessibilityIdentifier(id) }
        else { self }
    }
}
