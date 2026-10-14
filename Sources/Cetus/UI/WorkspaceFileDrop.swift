import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// file-drop-host.tsx: the whole window takes file drops and routes them to the
/// composer on screen (highlighting it while a file drag hovers), instead of only
/// the composer's own few pixels. With no composer visible the drop is ignored.
struct WorkspaceFileDropHost: ViewModifier {
    @Environment(AppState.self) private var app
    @State private var targeted = false

    func body(content: Content) -> some View {
        content
            .onDrop(of: [.fileURL], isTargeted: $targeted) { providers in
                guard composerVisible else { return false }
                var paths: [String] = []
                let group = DispatchGroup()
                let lock = NSLock()
                for p in providers {
                    group.enter()
                    _ = p.loadObject(ofClass: URL.self) { url, _ in
                        if let url, url.isFileURL { lock.lock(); paths.append(url.path); lock.unlock() }
                        group.leave()
                    }
                }
                group.notify(queue: .main) {
                    app.fileDragActive = false
                    guard !paths.isEmpty, composerVisible else { return }
                    app.composerDrop = (paths, Int.random(in: 0 ... Int.max))
                }
                return true
            }
            .onChange(of: targeted) { _, t in app.fileDragActive = t && composerVisible }
    }

    private var composerVisible: Bool {
        guard let v = app.composerView, v.window != nil, !v.isHiddenOrHasHiddenAncestor else { return false }
        return true
    }
}
