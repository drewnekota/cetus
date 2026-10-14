import AppKit
import SwiftUI

/// One row of the workspace file tree, as `list_workspace_directory` returns it.
struct WorkspaceEntry: Identifiable, Hashable {
    let name: String
    let path: String
    let relativePath: String
    let isDir: Bool
    var isIgnored = false
    var gitStatus: String?
    var isSymlink = false
    var symlinkTarget: String?
    var sizeBytes: Int64?
    var modified: Date?
    var id: String { path }
}

/// Directory listing / search / git status, after src-tauri commands/workspace.rs.
enum WorkspaceListing {
    static let maxChildren = 500

    /// `git status --porcelain=v1 -z --ignored=matching --untracked-files=all -- <scope>`.
    static func gitRecords(root: String, scope: String) -> [(path: String, status: String)] {
        guard let top = System.run(["git", "-C", root, "rev-parse", "--show-toplevel"])?
            .trimmingCharacters(in: .whitespacesAndNewlines), !top.isEmpty else { return [] }
        let repo = (top as NSString).resolvingSymlinksInPath
        let scopeReal = (scope as NSString).resolvingSymlinksInPath
        var rel = scopeReal.hasPrefix(repo) ? String(scopeReal.dropFirst(repo.count)) : scopeReal
        if rel.hasPrefix("/") { rel.removeFirst() }
        guard let out = System.run(["git", "-C", repo, "status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all", "--", rel.isEmpty ? "." : rel])
        else { return [] }
        let chunks = out.split(separator: "\0", omittingEmptySubsequences: false).map(String.init)
        var records: [(String, String)] = []
        var i = 0
        while i < chunks.count {
            let c = chunks[i]
            guard c.count >= 4 else { i += 1; continue }
            let xy = String(c.prefix(2))
            var p = String(c.dropFirst(3))
            if p.hasSuffix("/") { p.removeLast() }
            records.append(((repo as NSString).appendingPathComponent(p), porcelain(xy)))
            if xy.first == "R" || xy.first == "C" { i += 1 }
            i += 1
        }
        return records
    }

    static func porcelain(_ xy: String) -> String {
        if xy == "!!" { return "ignored" }
        if xy == "??" { return "untracked" }
        if xy.contains("U") || xy == "AA" || xy == "DD" { return "conflict" }
        if xy.contains("D") { return "deleted" }
        if xy.contains("R") { return "renamed" }
        if xy.contains("A") { return "added" }
        return "modified"
    }

    /// Status by path: a record's own status, and for folders the most severe
    /// non-ignored status anywhere beneath them. Built once per listing so each
    /// entry is a dictionary hit rather than a scan of every record.
    struct StatusIndex {
        private static let rank = ["conflict": 0, "deleted": 1, "modified": 2, "renamed": 3, "added": 4, "untracked": 5, "ignored": 6]
        private var map: [String: String] = [:]
        let records: [(path: String, status: String)]

        init(_ records: [(path: String, status: String)]) {
            self.records = records
            func merge(_ path: String, _ status: String) {
                if let old = map[path], (Self.rank[old] ?? 7) <= (Self.rank[status] ?? 7) { return }
                map[path] = status
            }
            for r in records {
                merge(r.path, r.status)
                guard r.status != "ignored" else { continue }
                var d = (r.path as NSString).deletingLastPathComponent
                while d.count > 1 {
                    merge(d, r.status)
                    d = (d as NSString).deletingLastPathComponent
                }
            }
        }

        func status(for path: String) -> String? { map[path] }
    }

    static func entry(_ path: String, root: String, records: StatusIndex) -> WorkspaceEntry {
        let fm = FileManager.default
        let link = (try? fm.attributesOfItem(atPath: path))?[.type] as? FileAttributeType == .typeSymbolicLink
        var isDir: ObjCBool = false
        fm.fileExists(atPath: path, isDirectory: &isDir)
        let attrs = try? fm.attributesOfItem(atPath: (path as NSString).resolvingSymlinksInPath)
        let git = records.status(for: path)
        var rel = path.hasPrefix(root) ? String(path.dropFirst(root.count)) : path
        if rel.hasPrefix("/") { rel.removeFirst() }
        return WorkspaceEntry(
            name: (path as NSString).lastPathComponent, path: path, relativePath: rel, isDir: isDir.boolValue,
            isIgnored: git == "ignored", gitStatus: git, isSymlink: link,
            symlinkTarget: link ? try? fm.destinationOfSymbolicLink(atPath: path) : nil,
            sizeBytes: isDir.boolValue ? nil : (attrs?[.size] as? NSNumber)?.int64Value,
            modified: attrs?[.modificationDate] as? Date)
    }

    static func list(root: String, dir: String, records: StatusIndex? = nil) -> (entries: [WorkspaceEntry], truncated: Bool) {
        let fm = FileManager.default
        let records = records ?? StatusIndex(gitRecords(root: root, scope: dir))
        var names = ((try? fm.contentsOfDirectory(atPath: dir)) ?? []).filter { $0 != ".git" }
        func isDir(_ n: String) -> Bool {
            var d: ObjCBool = false
            fm.fileExists(atPath: (dir as NSString).appendingPathComponent(n), isDirectory: &d)
            return d.boolValue
        }
        let dirs = Set(names.filter(isDir))
        names.sort { a, b in
            let da = dirs.contains(a), db = dirs.contains(b)
            return da != db ? da : a.lowercased() < b.lowercased()
        }
        let truncated = names.count > maxChildren
        var entries = names.prefix(maxChildren).map { entry((dir as NSString).appendingPathComponent($0), root: root, records: records) }
        for r in records.records where r.status == "deleted" && (r.path as NSString).deletingLastPathComponent == dir && !entries.contains(where: { $0.path == r.path }) {
            var rel = String(r.path.dropFirst(root.count))
            if rel.hasPrefix("/") { rel.removeFirst() }
            entries.append(WorkspaceEntry(name: (r.path as NSString).lastPathComponent, path: r.path, relativePath: rel, isDir: false, gitStatus: "deleted"))
        }
        return (entries, truncated)
    }

    /// Substring match on the relative path, files only, at most 100 (+1 for "truncated").
    static func search(root: String, query: String, completion: @escaping ([WorkspaceEntry], Bool) -> Void) {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        WorkspaceFiles.list(root) { files in
            DispatchQueue.global(qos: .userInitiated).async {
                let records = StatusIndex(gitRecords(root: root, scope: root))
                var hits: [WorkspaceEntry] = []
                for f in files where !f.isDir && f.rel.lowercased().contains(q) {
                    hits.append(entry(f.path, root: root, records: records))
                    if hits.count > 100 { break }
                }
                hits.sort { a, b in
                    let ia = a.name.lowercased().range(of: q)?.lowerBound.utf16Offset(in: a.name.lowercased()) ?? Int.max
                    let ib = b.name.lowercased().range(of: q)?.lowerBound.utf16Offset(in: b.name.lowercased()) ?? Int.max
                    return ia != ib ? ia < ib : a.relativePath.count != b.relativePath.count ? a.relativePath.count < b.relativePath.count : a.relativePath < b.relativePath
                }
                let truncated = hits.count > 100
                DispatchQueue.main.async { completion(Array(hits.prefix(100)), truncated) }
            }
        }
    }
}

/// `formatBytes` from lib/artifact.ts.
func workspaceFormatBytes(_ n: Int64) -> String {
    if n < 0 { return "0 B" }
    if n < 1024 { return "\(n) B" }
    if n < 1024 * 1024 { return String(format: "%.1f KB", Double(n) / 1024) }
    if n < 1024 * 1024 * 1024 { return String(format: "%.1f MB", Double(n) / 1048576) }
    return String(format: "%.2f GB", Double(n) / 1073741824)
}

private struct DirState {
    var entries: [WorkspaceEntry] = []
    var truncated = false
    var loading = false
    var error: String?
}

/// files-panel.tsx: path header, search row, tree (minmax(210px,36%)) and preview.
struct WorkspaceFilesPanel: View {
    let root: String
    let testPrefix: String
    /// Polling for changes only runs while the tab is on screen.
    var visible = true
    @Environment(AppState.self) private var app
    @State private var dirs: [String: DirState] = [:]
    @State private var expanded: Set<String> = []
    @State private var selectedPath: String?
    @State private var query = ""
    @State private var results: [WorkspaceEntry]?
    @State private var resultsTruncated = false
    @State private var searching = false
    @State private var actionError: String?
    @State private var moreFrame: CGRect = .zero
    /// Row frames for the right-click catcher. A plain reference, not state:
    /// every row reports on each layout/scroll, and publishing that re-rendered
    /// the whole panel per row — the lag on big folders.
    @State private var frames = FrameBox()
    @State private var searchToken = 0
    @State private var polling = false
    private let poll = Timer.publish(every: 3, on: .main, in: .common).autoconnect()

    private struct Row { let entry: WorkspaceEntry; let depth: Int; let parent: String }
    private final class FrameBox {
        var rows: [String: CGRect] = [:]
        var tree: CGRect = .zero
    }

    var body: some View {
        let rows = rows
        let selected = rows.first { $0.entry.path == selectedPath }?.entry
        return VStack(spacing: 0) {
            // `flex h-10 items-center gap-2 border-b px-3`
            HStack(spacing: 8) {
                Text(root).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.mutedForeground)
                    .lineLimit(1).truncationMode(.tail).lineBox(16.2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(action: refreshLoaded) {
                    Group {
                        if dirs[root]?.loading == true { Spinner(size: 14) } else { Glyph(name: "refresh-cw", size: 14, color: Theme.foreground) }
                    }
                    .frame(width: 22, height: 22)
                    .hoverFill(Theme.ghostHover, radius: 7)
                    .padding(1)
                }
                .buttonStyle(PressDownStyle())
                .help("Refresh")
                .testID("\(testPrefix)-refresh")
            }
            .padding(.horizontal, 12)
            .frame(height: 39)
            .padding(.bottom, 1)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
            // `flex h-9 items-center gap-1 border-b px-2`
            HStack(spacing: 4) {
                Glyph(name: "search", size: 14, color: Theme.mutedForeground)
                TextField("", text: $query, prompt: Text("Search files").foregroundColor(Theme.mutedForeground))
                    .textFieldStyle(.plain).font(.system(size: 12)).foregroundStyle(Theme.foreground)
                    .testID("\(testPrefix)-search")
                if searching { Spinner(size: 12) }
                Button(action: openActions) {
                    Glyph(name: "more-horizontal", size: 14, color: Theme.foreground)
                        .frame(width: 22, height: 22)
                        // aria-expanded: bg-muted while the menu is open.
                        .hoverFill(Theme.ghostHover, radius: 7, active: app.openMenu == "\(testPrefix)-file-actions", activeFill: Theme.muted)
                        .padding(1)
                }
                .buttonStyle(PressDownStyle())
                .readFrame($moreFrame)
                .testID("\(testPrefix)-actions")
            }
            .padding(.horizontal, 8)
            .frame(height: 35)
            .padding(.bottom, 1)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
            if let actionError {
                Text(actionError).font(.system(size: 12)).foregroundStyle(Theme.destructive)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.destructive.opacity(0.1))
                    .overlay(alignment: .bottom) { Rectangle().fill(Theme.destructive.opacity(0.2)).frame(height: 1) }
            }
            GeometryReader { g in
                HStack(spacing: 0) {
                    tree(rows)
                        .frame(width: max(210, g.size.width * 0.36))
                        .overlay(alignment: .trailing) { Rectangle().fill(Theme.border).frame(width: 1) }
                    WorkspacePreview(entry: selected.flatMap { $0.isDir ? nil : $0 }, root: root, testPrefix: testPrefix)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .onAppear { if dirs[root] == nil { load(root) } }
        .onReceive(poll) { _ in if visible && NSApp.isActive { pollLoaded() } }
        .onChange(of: query) { _, q in runSearch(q) }
        .testID("\(testPrefix)-files")
    }

    // MARK: Tree

    private var rows: [Row] {
        if let results { return results.map { Row(entry: $0, depth: 0, parent: ($0.path as NSString).deletingLastPathComponent) } }
        var out: [Row] = []
        var seen = Set<String>()
        func walk(_ dir: String, _ depth: Int) {
            guard seen.insert(dir).inserted else { return }
            for e in dirs[dir]?.entries ?? [] {
                out.append(Row(entry: e, depth: depth, parent: dir))
                if e.isDir && expanded.contains(e.path) { walk(e.path, depth + 1) }
            }
        }
        walk(root, 0)
        return out
    }

    private var selectedRow: Row? { rows.first { $0.entry.path == selectedPath } }

    private func tree(_ rows: [Row]) -> some View {
        let rootState = dirs[root]
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if rootState == nil && results == nil {
                    HStack(spacing: 8) { Spinner(size: 14); Text("Loading") }
                        .font(.system(size: 12)).foregroundStyle(Theme.mutedForeground)
                        .padding(12)
                } else if let err = rootState?.error, rootState?.entries.isEmpty == true {
                    note(err, Theme.destructive)
                } else if rows.isEmpty {
                    note(query.isEmpty ? "No files" : "No matching files", Theme.mutedForeground)
                } else {
                    ForEach(rows, id: \.entry.path) { r in
                        WorkspaceTreeRow(entry: r.entry, depth: r.depth, selected: r.entry.path == selectedPath,
                                         expanded: expanded.contains(r.entry.path), loading: dirs[r.entry.path]?.loading == true,
                                         testID: "\(testPrefix)-file-\(r.entry.name)") {
                            selectedPath = r.entry.path
                            if r.entry.isDir { toggle(r.entry) }
                        } onOpen: {
                            if !r.entry.isDir { System.open(r.entry.path) }
                        }
                        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { [frames] in frames.rows[r.entry.path] = $0 }
                        if expanded.contains(r.entry.path), let st = dirs[r.entry.path] {
                            if let err = st.error { subNote(err, Theme.destructive, depth: r.depth) }
                            if st.truncated { subNote("Only the first 500 entries are shown.", Theme.amber, depth: r.depth) }
                        }
                    }
                }
                if results != nil ? resultsTruncated : rootState?.truncated == true {
                    Text("More files exist; refine the search or open a subfolder.")
                        .font(.system(size: 11)).foregroundStyle(Theme.amber)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                }
            }
            .padding(.vertical, 4)
        }
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { [frames] in frames.tree = $0 }
        .overlay(WorkspaceRightClick { pt in
            // One catcher for the whole tree; the row comes from SwiftUI's own layout.
            // LazyVStack drops rows scrolled away, so their last frame can be stale:
            // the tree bounds check keeps those from matching.
            guard frames.tree.contains(pt), let r = rows.first(where: { frames.rows[$0.entry.path]?.contains(pt) == true }) else { return false }
            openContextMenu(r)
            return true
        })
    }

    private func note(_ text: String, _ color: Color) -> some View {
        Text(text).font(.system(size: 12)).foregroundStyle(color).lineBox(16.2)
            .padding(.horizontal, 12).padding(.vertical, 12)
    }

    private func subNote(_ text: String, _ color: Color, depth: Int) -> some View {
        Text(text).font(.system(size: 11)).foregroundStyle(color)
            .padding(.leading, 36 + CGFloat(depth + 1) * 14).padding(.trailing, 8).padding(.vertical, 4)
    }

    /// The tree's own context menu at the pointer.
    private func openContextMenu(_ r: Row) {
        selectedPath = r.entry.path
        let e = r.entry
        var items: [MenuItem] = []
        if !e.isDir { items.append(MenuItem(id: "add", title: "Add to chat", glyph: "paperclip") { addToChat(e) }) }
        items.append(MenuItem(id: "copy", title: "Copy relative path", glyph: "copy") { System.copy(e.relativePath) })
        items.append(MenuItem(id: "reveal", title: "Reveal in Finder", glyph: "external-link") { System.reveal(e.path) })
        items.append(MenuItem(id: "rename", title: "Rename", glyph: "pencil", group: " ") { rename(r) })
        items.append(MenuItem(id: "trash", title: "Move to Trash", glyph: "trash-2", group: " ") { trash(r) })
        NativeMenu.show(items, anchor: .zero, placement: .pointer, app: app, id: "\(testPrefix)-context")
    }

    // MARK: Actions menu

    private func openActions() {
        let sel = selectedRow
        let items: [MenuItem] = [
            MenuItem(id: "new-file", title: "New file", glyph: "file-plus") { create(dir: false) },
            MenuItem(id: "new-folder", title: "New folder", glyph: "folder-plus") { create(dir: true) },
            MenuItem(id: "add", title: "Add to chat", glyph: "paperclip", group: " ", enabled: sel.map { !$0.entry.isDir } ?? false) { if let e = sel?.entry { addToChat(e) } },
            MenuItem(id: "copy-rel", title: "Copy relative path", glyph: "copy", group: " ", enabled: sel != nil) { if let e = sel?.entry { System.copy(e.relativePath) } },
            MenuItem(id: "copy-abs", title: "Copy absolute path", glyph: "copy", group: " ", enabled: sel != nil) { if let e = sel?.entry { System.copy(e.path) } },
            MenuItem(id: "reveal", title: "Reveal in Finder", glyph: "external-link", group: " ", enabled: sel != nil) { if let e = sel?.entry { System.reveal(e.path) } },
            MenuItem(id: "terminal", title: "Open in terminal", glyph: "terminal", group: " ", enabled: sel != nil) { if let r = sel { openInTerminal(r) } },
            MenuItem(id: "rename", title: "Rename", glyph: "pencil", group: "  ", enabled: sel != nil) { if let r = sel { rename(r) } },
            MenuItem(id: "trash", title: "Move to Trash", glyph: "trash-2", group: "  ", enabled: sel != nil) { if let r = sel { trash(r) } },
        ]
        NativeMenu.show(items, anchor: moreFrame, placement: .belowEnd, app: app, id: "\(testPrefix)-file-actions")
    }

    /// `cetus-insert-file-paths` → the composer's `insertPaths`: the absolute path at the caret,
    /// on its own line when text precedes it, followed by a space; then focus the composer.
    private func addToChat(_ e: WorkspaceEntry) {
        WorkspaceComposerBridge.insertPaths([e.path], app: app)
    }

    private func openInTerminal(_ r: Row) {
        let dir = r.entry.isDir ? r.entry.path : r.parent
        let cmd = "cd '\(dir.replacingOccurrences(of: "'", with: "'\\''"))'"
        let bottom = app.dock(.bottom)
        if let t = bottom.tabs.first(where: { $0.id == bottom.active && $0.kind == .terminal }) ?? bottom.tabs.first(where: { $0.kind == .terminal }) {
            app.updateDock(.bottom) { $0.active = t.id; $0.open = true }
            Terminals.shared.existing(t.id)?.send(txt: cmd + "\r")
            app.focusTerminal(.bottom)
        } else {
            app.updateDock(.bottom) { $0.add(.terminal, cwd: dir) }
            app.focusTerminal(.bottom)
        }
    }

    /// `window.prompt`: OK returns the text as typed (an empty answer cancels).
    private func prompt(_ title: String, _ value: String = "") -> String? {
        // Test hook: answer without a modal so a driven instance can exercise the flow.
        if let canned = ProcessInfo.processInfo.environment["CETUS_TEST_PROMPT_ANSWER"] { return canned.isEmpty ? nil : canned }
        let alert = NSAlert()
        alert.messageText = title
        let field = NSTextField(string: value)
        field.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        let s = field.stringValue
        return s.isEmpty ? nil : s
    }

    /// `sanitize_segment` (files.rs): separators/controls → `_`, trimmed of dots and spaces.
    static func sanitize(_ name: String) -> String {
        let mapped = String(name.map { c -> Character in
            c == "/" || c == "\\" || c.unicodeScalars.allSatisfy({ CharacterSet.controlCharacters.contains($0) }) ? "_" : c
        })
        return mapped.trimmingCharacters(in: CharacterSet(charactersIn: ". "))
    }

    private static func osError(_ error: Error) -> String {
        let ns = error as NSError
        if let posix = (ns.userInfo[NSUnderlyingErrorKey] as? NSError), posix.domain == NSPOSIXErrorDomain {
            return "\(String(cString: strerror(Int32(posix.code)))) (os error \(posix.code))"
        }
        return ns.localizedDescription
    }

    /// `create_workspace_entry`, in the selected folder (or the selected file's folder).
    private func create(dir: Bool) {
        let sel = selectedRow
        let parent = sel?.entry.isDir == true ? sel!.entry.path : (sel?.parent ?? root)
        guard let name = prompt(dir ? "Folder name" : "File name") else { return }
        let safe = Self.sanitize(name)
        guard !safe.isEmpty, safe == name else { actionError = "invalid file name"; return }
        let path = (parent as NSString).appendingPathComponent(safe)
        do {
            if dir {
                try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: false)
            } else {
                let fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0o644)
                if fd < 0 { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
                close(fd)
            }
            load(parent)
            selectedPath = path
        } catch {
            let ns = error as NSError
            actionError = ns.domain == NSPOSIXErrorDomain ? "\(String(cString: strerror(Int32(ns.code)))) (os error \(ns.code))" : Self.osError(error)
        }
    }

    /// `rename_workspace_entry`: same folder, sanitized name.
    private func rename(_ r: Row) {
        guard let name = prompt("New name", r.entry.name), name != r.entry.name else { return }
        let safe = Self.sanitize(name)
        guard !safe.isEmpty, safe == name else { actionError = "invalid file name"; return }
        let dest = (r.parent as NSString).appendingPathComponent(safe)
        if Darwin.rename(r.entry.path, dest) != 0 {
            actionError = "\(String(cString: strerror(errno))) (os error \(errno))"
            return
        }
        load(r.parent)
        selectedPath = dest
    }

    /// Tauri's `window.confirm` is the dialog plugin's async override, so `!window.confirm(…)`
    /// is always false: the entry goes to the Trash straight away (recoverable from Finder).
    private func trash(_ r: Row) {
        do {
            try FileManager.default.trashItem(at: URL(fileURLWithPath: r.entry.path), resultingItemURL: nil)
            load(r.parent)
            selectedPath = nil
        } catch { actionError = error.localizedDescription }
    }

    // MARK: Loading

    private func refreshLoaded() {
        actionError = nil
        WorkspaceFiles.invalidate(root)
        for d in dirs.isEmpty ? [root] : Array(dirs.keys) { load(d) }
    }

    private func toggle(_ e: WorkspaceEntry) {
        guard e.isDir else { return }
        if expanded.contains(e.path) { expanded.remove(e.path) } else {
            expanded.insert(e.path)
            if dirs[e.path] == nil { load(e.path) }
        }
    }

    /// The 3s refresh: one `git status` for the whole tree instead of one per
    /// expanded folder, skipped while the previous pass is still running.
    private func pollLoaded() {
        guard !polling, !dirs.isEmpty else { return }
        polling = true
        let root = root, loaded = Array(dirs.keys)
        DispatchQueue.global(qos: .utility).async {
            let index = WorkspaceListing.StatusIndex(WorkspaceListing.gitRecords(root: root, scope: root))
            var out: [String: (entries: [WorkspaceEntry], truncated: Bool)?] = [:]
            for dir in loaded {
                var isDir: ObjCBool = false
                let exists = FileManager.default.fileExists(atPath: dir, isDirectory: &isDir) && isDir.boolValue
                out[dir] = exists ? WorkspaceListing.list(root: root, dir: dir, records: index) : nil
            }
            DispatchQueue.main.async {
                polling = false
                for (dir, listing) in out { apply(dir, listing, quiet: true) }
            }
        }
    }

    private func load(_ dir: String, quiet: Bool = false) {
        if !quiet {
            var st = dirs[dir] ?? DirState()
            st.loading = true
            st.error = nil
            dirs[dir] = st
        }
        let root = root
        DispatchQueue.global(qos: .userInitiated).async {
            var isDir: ObjCBool = false
            let exists = FileManager.default.fileExists(atPath: dir, isDirectory: &isDir) && isDir.boolValue
            let listing = exists ? WorkspaceListing.list(root: root, dir: dir) : nil
            DispatchQueue.main.async { apply(dir, listing, quiet: quiet) }
        }
    }

    private func apply(_ dir: String, _ listing: (entries: [WorkspaceEntry], truncated: Bool)?, quiet: Bool) {
        var st = dirs[dir] ?? DirState()
        st.loading = false
        if let listing {
            st.entries = listing.entries
            st.truncated = listing.truncated
            st.error = nil
        } else {
            st.error = "No such file or directory (os error 2)"
        }
        if quiet, let old = dirs[dir], old.entries == st.entries, old.truncated == st.truncated, old.error == st.error, !old.loading { return }
        dirs[dir] = st
        if dir == root, selectedPath == nil, let l = listing {
            selectedPath = l.entries.first { !$0.isDir }?.path ?? l.entries.first?.path
        }
    }

    private func runSearch(_ q: String) {
        searchToken += 1
        let token = searchToken
        let trimmed = q.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { results = nil; resultsTruncated = false; searching = false; return }
        searching = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
            guard token == searchToken else { return }
            WorkspaceListing.search(root: root, query: trimmed) { hits, truncated in
                guard token == searchToken else { return }
                results = hits
                resultsTruncated = truncated
                searching = false
            }
        }
    }
}

/// `FileTreeRow`: h-7 gap-1.5 pr-2 text-xs, pl 8+14·depth, hover/selected bg-muted.
private struct WorkspaceTreeRow: View {
    let entry: WorkspaceEntry
    let depth: Int
    let selected: Bool
    let expanded: Bool
    let loading: Bool
    let testID: String
    let onClick: () -> Void
    let onOpen: () -> Void
    @State private var hover = false

    var body: some View {
        HStack(spacing: 6) {
            ZStack {
                Color.clear
                if entry.isDir {
                    if loading { Spinner(size: 12) } else { Glyph(name: expanded ? "chevron-down" : "chevron-right", size: 14, color: Theme.mutedForeground) }
                }
            }
            .frame(width: 16, height: 16)
            Glyph(name: entry.isDir ? (expanded ? "folder-open" : "folder") : "file", size: 14, color: Theme.mutedForeground)
            if entry.isSymlink {
                Glyph(name: "link-2", size: 10, color: Theme.mutedForeground).padding(.leading, -8).offset(y: 4)
            }
            Text(entry.name).font(.system(size: 12))
                .foregroundStyle(entry.isIgnored && !selected ? Theme.mutedForeground.opacity(0.5) : Theme.foreground)
                .lineLimit(1).truncationMode(.tail).lineBox(16.2)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let g = entry.gitStatus, g != "ignored" { WorkspaceGitBadge(status: g) }
            if !entry.isDir, let s = entry.sizeBytes {
                Text(workspaceFormatBytes(s)).font(.system(size: 11).monospacedDigit()).foregroundStyle(Theme.mutedForeground)
                    .lineLimit(1).fixedSize()
            }
        }
        .padding(.leading, 8 + CGFloat(depth) * 14).padding(.trailing, 8)
        .frame(height: 28)
        .background(selected || hover ? Theme.muted : .clear)
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .gesture(TapGesture(count: 2).onEnded { onOpen() }.exclusively(before: TapGesture().onEnded { onClick() }))
        .help(entry.path + (entry.symlinkTarget.map { " → \($0)" } ?? ""))
        .testID(testID)
    }
}

private struct WorkspaceGitBadge: View {
    let status: String
    var body: some View {
        let labels = ["modified": "M", "added": "A", "deleted": "D", "renamed": "R", "untracked": "U", "conflict": "!"]
        let color: Color = status == "conflict" || status == "deleted" ? Color(nsColor: NSColor(hex: 0xFB2C36))
            : status == "untracked" || status == "added" ? Color(nsColor: NSColor(hex: 0x00BC7D)) : Theme.amber
        Text(labels[status] ?? "").font(.system(size: 11, weight: .semibold)).foregroundStyle(color).frame(width: 12)
    }
}

/// Reports right-clicks (in window content coordinates, top-left origin) without
/// taking any other mouse events from the SwiftUI content underneath.
struct WorkspaceRightClick: NSViewRepresentable {
    /// Returns whether the click was handled (and so swallowed).
    let onRightClick: (CGPoint) -> Bool
    func makeNSView(context: Context) -> CatcherView { CatcherView(onRightClick) }
    func updateNSView(_ v: CatcherView, context: Context) { v.onRightClick = onRightClick }

    /// Never takes part in hit-testing (an overlay that does swallows the row's SwiftUI taps);
    /// a local monitor catches right-clicks / ctrl-clicks that land inside its bounds.
    final class CatcherView: NSView {
        var onRightClick: (CGPoint) -> Bool
        private var monitor: Any?
        init(_ f: @escaping (CGPoint) -> Bool) { onRightClick = f; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError() }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let m = monitor { NSEvent.removeMonitor(m); monitor = nil }
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.rightMouseDown, .leftMouseDown]) { [weak self] e in
                guard let self, let win = self.window, e.window === win,
                      e.type == .rightMouseDown || e.modifierFlags.contains(.control) else { return e }
                let local = self.convert(e.locationInWindow, from: nil)
                guard self.visibleRect.contains(local), let content = win.contentView else { return e }
                let p = content.convert(e.locationInWindow, from: nil)
                return self.onRightClick(CGPoint(x: p.x, y: content.isFlipped ? p.y : content.bounds.height - p.y)) ? nil : e
            }
        }
    }
}

/// Hands paths to the composer like Tauri's `cetus-insert-file-paths` event.
@MainActor
enum WorkspaceComposerBridge {
    static func insertPaths(_ paths: [String], app: AppState) {
        guard !paths.isEmpty, let tv = app.composerView else { return }
        let ns = tv.string as NSString
        let caret = min(tv.selectedRange().location, ns.length)
        let before = ns.substring(to: caret)
        let needsLead = !before.isEmpty && !(before.last?.isWhitespace ?? false)
        let insert = (needsLead ? "\n" : "") + paths.joined(separator: "\n") + " "
        tv.insertText(insert, replacementRange: NSRange(location: caret, length: tv.selectedRange().length))
        app.focusComposer()
    }
}
