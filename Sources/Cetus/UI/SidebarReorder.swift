import SwiftUI

/// Drag-to-reorder for the sidebar's workspace folders, after app-sidebar.tsx's
/// dnd-kit sortable: the dragged item follows the pointer, the others reflow
/// live, and the drop persists the order as `recentWorkspaces`. "Pinned" and
/// "Chat" stay on top and never move.
@MainActor @Observable
final class WorkspaceReorder {
    static let space = "workspace-reorder"

    struct Drag {
        let dir: String
        var order: [String]
        /// Pointer offset from the item's top when the drag began.
        let grabDY: CGFloat
        var y: CGFloat
    }

    private(set) var drag: Drag?
    /// Layout frames (without the drag offset) in the `space` coordinate space.
    var frames: [String: CGRect] = [:]
    @ObservationIgnored private var endedAt = Date.distantPast

    /// Releasing a drag on a header can also land as a click on it (collapse /
    /// select); swallow clicks right after a drop like the web build does.
    var justEnded: Bool { Date().timeIntervalSince(endedAt) < 0.25 }

    /// `dirs` in the live drag order while dragging.
    func order(_ dirs: [String]) -> [String] {
        guard let d = drag else { return dirs }
        return d.order.filter(dirs.contains) + dirs.filter { !d.order.contains($0) }
    }

    func offset(_ dir: String) -> CGFloat {
        guard let d = drag, d.dir == dir, let f = frames[dir] else { return 0 }
        return d.y - d.grabDY - f.minY
    }

    func gesture(_ dir: String, folders: [String], commit: @escaping ([String]) -> Void) -> some Gesture {
        DragGesture(minimumDistance: 4, coordinateSpace: .named(Self.space))
            .onChanged { [weak self] v in MainActor.assumeIsolated { self?.changed(dir, v, folders: folders) } }
            .onEnded { [weak self] _ in MainActor.assumeIsolated { self?.ended(commit) } }
    }

    private func changed(_ dir: String, _ v: DragGesture.Value, folders: [String]) {
        if drag == nil {
            guard let f = frames[dir] else { return }
            drag = Drag(dir: dir, order: folders, grabDY: v.startLocation.y - f.minY, y: v.location.y)
        }
        guard var d = drag, d.dir == dir, let me = frames[dir], let from = d.order.firstIndex(of: dir) else { return }
        d.y = v.location.y
        // Swap once the dragged item's middle crosses a neighbour's middle; the
        // direction check keeps unequal heights from swapping back and forth.
        let mid = d.y - d.grabDY + me.height / 2
        var to = from
        for (i, other) in d.order.enumerated() where other != dir {
            guard let f = frames[other] else { continue }
            if i > from && mid > f.midY { to = max(to, i) }
            if i < from && mid < f.midY { to = min(to, i) }
        }
        if to == from { drag = d; return }
        d.order.remove(at: from)
        d.order.insert(dir, at: to)
        withAnimation(.easeOut(duration: 0.15)) { drag = d }
    }

    private func ended(_ commit: ([String]) -> Void) {
        guard let d = drag else { return }
        endedAt = Date()
        withAnimation(.easeOut(duration: 0.15)) { drag = nil }
        commit(d.order)
    }
}

extension View {
    /// The sortable item: lifts and follows the pointer while it's the one dragged.
    func workspaceReorderItem(_ dir: String, _ r: WorkspaceReorder) -> some View {
        let dragging = r.drag?.dir == dir
        return self
            .background {
                if dragging {
                    RoundedRectangle(cornerRadius: 8).fill(Theme.sidebar)
                        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
                }
            }
            .offset(y: r.offset(dir))
            .zIndex(dragging ? 1 : 0)
            // The dragged item tracks the pointer exactly; only its neighbours animate.
            .transaction { if dragging { $0.animation = nil } }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(WorkspaceReorder.space)) } action: { r.frames[dir] = $0 }
    }
}
