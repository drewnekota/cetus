import AppKit
import Observation
import SwiftUI
import SwiftTerm

enum Page: String, CaseIterable { case chats = "Chats", kanban = "Kanban", automations = "Automations" }

struct Selection: Equatable {
    var runtime: String
    var model: String
    var effort: String
    var workspace: String
}

struct ViewState: Equatable {
    var page: Page
    var active: String?
}

enum TabKind: String { case files = "Files", terminal = "Terminal", browser = "Browser" }

struct WorkspaceTab: Identifiable, Equatable {
    let id: Int
    let kind: TabKind
    let cwd: String
    var title: String?
}

struct WorkspaceState: Equatable {
    var open = false
    var layout: Layout = .side
    var tabs: [WorkspaceTab] = []
    var active: Int?

    enum Layout: String { case side, bottom }

    private static var nextId = 1

    mutating func add(_ kind: TabKind, cwd: String) {
        let id = Self.nextId
        Self.nextId += 1
        let n = tabs.filter { $0.kind == kind }.count + 1
        tabs.append(WorkspaceTab(id: id, kind: kind, cwd: cwd, title: n == 1 ? kind.rawValue : "\(kind.rawValue) \(n)"))
        active = id
        open = true
    }

    mutating func close(_ id: Int) {
        guard let at = tabs.firstIndex(where: { $0.id == id }) else { return }
        tabs.remove(at: at)
        if active == id { active = tabs.isEmpty ? nil : tabs[min(at, tabs.count - 1)].id }
        if tabs.isEmpty { open = false }
    }

    mutating func step(_ delta: Int) {
        guard !tabs.isEmpty else { return }
        let at = tabs.firstIndex { $0.id == active } ?? 0
        active = tabs[(at + delta + tabs.count) % tabs.count].id
    }

    /// Show the tab of `kind`, opening one when there is none.
    mutating func focus(_ kind: TabKind, cwd: String) {
        if let existing = (activeTab?.kind == kind ? activeTab : nil) ?? tabs.first(where: { $0.kind == kind }) {
            open = true
            active = existing.id
        } else {
            add(kind, cwd: cwd)
        }
    }

    var activeTab: WorkspaceTab? { tabs.first { $0.id == active } }
}

struct FindState: Equatable {
    var query = ""
    var active = 0
    var count = 0
}

/// An anchored menu drawn above everything in the window (composer pickers).
struct PopupSpec {
    let id: String
    let anchor: CGRect
    var style: MenuStyle = .select
    /// align="end": right edges line up instead of left edges.
    var alignEnd = false
    /// side="right" align="start": beside the trigger, top edges aligned.
    var sideRight = false
    var radius: CGFloat = 8
    let content: AnyView
}

struct Toast: Identifiable, Equatable {
    let id = UUID()
    enum Kind { case plain, success, error }
    var title: String
    var detail: String?
    var kind: Kind = .plain
    /// Sonner `action` button (e.g. "Reveal" on a saved artifact).
    var actionLabel: String? = nil
    var action: (() -> Void)? = nil
    static func == (l: Toast, r: Toast) -> Bool { l.id == r.id }
}

struct SidebarGroup: Identifiable {
    let id: String
    let label: String
    let dir: String?
    var items: [Conversation]
    /// A user folder: reorderable, unlike "Pinned" and the default "Chat".
    var isFolder: Bool { id != "pinned" && id != "chat" }
}

/// Window-level UI state and every app action the shortcuts, menus and
/// palette can trigger.
@Observable
final class AppState {
    @ObservationIgnored let controller: Controller

    var view = ViewState(page: .chats, active: nil) {
        // Docks are per chat (workspaceDocksByChat).
        didSet { if oldValue.active != view.active { WorkspaceDocks.swap(self, from: oldValue.active, to: view.active) } }
    }
    @ObservationIgnored private var back: [ViewState] = []
    @ObservationIgnored private var forward: [ViewState] = []
    /// Most recently opened chats, newest first (Ctrl+Tab).
    @ObservationIgnored private(set) var recent: [String] = []
    var selection: Selection
    /// Cetus has two independent docks: the side panel (⌘\\, Files by default)
    /// and the bottom panel (⌘J, Terminal by default).
    var side = WorkspaceState(layout: .side)
    var bottom = WorkspaceState(layout: .bottom)

    func dock(_ layout: WorkspaceState.Layout) -> WorkspaceState { layout == .side ? side : bottom }
    func updateDock(_ layout: WorkspaceState.Layout, _ f: (inout WorkspaceState) -> Void) {
        if layout == .side { f(&side) } else { f(&bottom) }
    }
    var palette = false
    var settings = false
    var settingsSection = "General"
    var find: FindState?
    var toasts: [Toast] = []
    var popup: PopupSpec?
    /// Cascading submenu of the open `popup` (DropdownMenuSub).
    var subPopup: PopupSpec?
    /// Id of the native action menu being tracked, so its trigger can show as pressed.
    var openMenu: String?
    /// The composer's Remote SSH workspace dialog.
    var remoteSSH = false
    var composerMenuOpen = false
    /// Bumped to ask the transcript to jump to the bottom.
    var scrollToBottomToken = 0
    /// Text queued for the composer (Edit on a queued message, quote reply).
    var composerInsert: (text: String, replace: Bool, token: Int)?
    /// Transcript selection sent with "Add to chat": the composer holds it as a quote.
    var quoteRequest: (text: String, token: Int)?
    /// Window-wide file drops routed to the composer (WorkspaceFileDropHost).
    var composerDrop: (paths: [String], token: Int)?
    var fileDragActive = false
    /// Ctrl+Tab switcher: candidates and the highlighted index while Ctrl is held.
    var switcher: (ids: [String], index: Int)?
    /// Cmd held long enough to show the numbered chat hints.
    var showNumberHints = false

    /// Set while Settings records a shortcut: receives the next key instead of the shortcut table.
    @ObservationIgnored var recorder: ((NSEvent) -> Bool)?
    @ObservationIgnored weak var composerView: NSTextView?
    @ObservationIgnored weak var findField: NSTextField?
    @ObservationIgnored weak var window: NSWindow?

    init(controller: Controller) {
        self.controller = controller
        let p = controller.prefs
        selection = Selection(runtime: p.runtime, model: p.model, effort: p.effort, workspace: p.workspace)
    }

    var prefs: Prefs { controller.prefs }
    var active: String? { view.active }
    var page: Page { view.page }
    var activeConversation: Conversation? { controller.conversation(view.active) }
    var cwd: String { activeConversation?.workspaceDir.isEmpty == false ? activeConversation!.workspaceDir : selection.workspace }

    // MARK: - Navigation

    func setView(_ next: ViewState, record: Bool = true) {
        if record && next != view {
            back.append(view)
            forward = []
        }
        if let a = next.active, a != view.active {
            recent = Array(([a] + recent.filter { $0 != a }).prefix(20))
        }
        view = next
        controller.setVisible(next.page == .chats ? next.active : nil)
    }

    func setSelection(_ mutate: (inout Selection) -> Void) {
        var next = selection
        mutate(&next)
        selection = next
        let isNew = activeConversation == nil
        controller.setPrefs { p in
            p.runtime = next.runtime
            p.model = next.model
            p.effort = next.effort
            if isNew { p.workspace = next.workspace }
            p.tuning[next.runtime] = Tuning(model: next.model, effort: next.effort)
        }
    }

    func selectRuntime(_ id: String) {
        let t = prefs.tuning[id]
        setSelection { s in
            s.runtime = id
            s.model = t?.model ?? ""
            s.effort = t?.effort ?? ""
        }
    }

    func cycleRuntime(_ delta: Int) {
        let list = Runtimes.ordered(prefs)
        guard !list.isEmpty else { return }
        let at = list.firstIndex { $0.id == selection.runtime } ?? 0
        selectRuntime(list[(at + delta + list.count) % list.count].id)
    }

    func focusComposer() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { [weak self] in
            guard let self, let v = self.composerView, let w = v.window else { return }
            w.makeFirstResponder(v)
        }
    }

    func openChat(_ id: String) {
        setView(ViewState(page: .chats, active: id))
        if let c = controller.conversation(id) {
            selection.runtime = c.backend
            selection.model = c.cliModel
            selection.effort = c.cliEffort
            if !c.workspaceDir.isEmpty { selection.workspace = c.workspaceDir }
        }
        find = nil
        scrollToBottomToken += 1
        focusComposer()
    }

    func newChat(_ dir: String? = nil) {
        setView(ViewState(page: .chats, active: nil))
        // page.tsx onNew: the hero keeps the current workspace and model choice
        // (the last opened chat's); only an explicit folder replaces the workspace.
        if let dir { selection.workspace = dir }
        find = nil
        heroIndex = (heroIndex + Int.random(in: 1 ..< 12)) % 12
        placeholderIndex = (placeholderIndex + Int.random(in: 1 ..< 12)) % 12
        focusComposer()
    }

    func toast(_ title: String, _ detail: String? = nil, kind: Toast.Kind = .plain, action: (label: String, run: () -> Void)? = nil) {
        let t = Toast(title: title, detail: detail, kind: kind, actionLabel: action?.label, action: action?.run)
        toasts.append(t)
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in self?.toasts.removeAll { $0.id == t.id } }
    }

    // MARK: - Sidebar order

    /// Pinned, Chat (the default folder), then one group per workspace folder.
    /// Pinned (when any) → Chat (always) → folders in workspace order, like Cetus's groupByWorkspace.
    func groups() -> [SidebarGroup] {
        let convs = controller.conversations
        let moveTop = prefs.moveActiveToTop
        func sort(_ list: [Conversation]) -> [Conversation] {
            guard moveTop else { return list }
            let running = Set(list.filter { $0.runState == .running }.map(\.id))
            return list.enumerated().sorted { a, b in
                let ra = running.contains(a.element.id), rb = running.contains(b.element.id)
                return ra != rb ? ra : a.offset < b.offset
            }.map(\.element)
        }
        let chatDir = Env.chatDir
        func dirOf(_ c: Conversation) -> String { c.workspaceDir.isEmpty ? chatDir : c.workspaceDir }
        let hidden = Set(prefs.hiddenWorkspaces).subtracting([chatDir])
        var order: [String] = []
        var map: [String: [Conversation]] = [:]
        func ensure(_ dir: String) {
            guard !dir.isEmpty, !hidden.contains(dir), map[dir] == nil else { return }
            map[dir] = []
            order.append(dir)
        }
        ensure(chatDir)
        for d in prefs.recentWorkspaces { ensure(d) }
        // Folders only known from their chats: order by when the folder's first
        // chat was created (newest folder first), never by chat activity, so new
        // messages don't reshuffle the sidebar.
        var firstCreated: [String: Double] = [:]
        for c in convs { firstCreated[dirOf(c)] = min(firstCreated[dirOf(c)] ?? .infinity, c.createdAt) }
        for d in firstCreated.keys.sorted(by: { firstCreated[$0]! != firstCreated[$1]! ? firstCreated[$0]! > firstCreated[$1]! : $0 < $1 }) { ensure(d) }
        for c in convs where c.pinnedAt == nil { map[dirOf(c)]?.append(c) }
        var groups: [SidebarGroup] = []
        let pinned = convs.filter { $0.pinnedAt != nil }.sorted { ($0.pinnedAt ?? 0) > ($1.pinnedAt ?? 0) }
        if !pinned.isEmpty { groups.append(SidebarGroup(id: "pinned", label: "Pinned", dir: nil, items: pinned)) }
        for dir in order {
            groups.append(SidebarGroup(id: dir == chatDir ? "chat" : dir, label: dir == chatDir ? "Chat" : Env.folderName(dir), dir: dir, items: sort(map[dir] ?? [])))
        }
        return groups
    }

    /// Rows a group currently shows (5 unless expanded).
    func visibleItems(_ g: SidebarGroup) -> [Conversation] {
        if g.id == "pinned" || expandedGroups.contains(g.id) { return g.items }
        return Array(g.items.prefix(5))
    }

    /// Cmd+1…9 and Alt+Cmd+Up/Down walk the sidebar top to bottom.
    func order() -> [Conversation] {
        groups().filter { !prefs.collapsedGroups.contains($0.id) }.flatMap { visibleItems($0) }
    }

    func stepChat(_ delta: Int) {
        let o = order()
        guard !o.isEmpty else { return }
        let at = o.firstIndex { $0.id == active }
        let next = at.map { o[($0 + delta + o.count) % o.count] } ?? (delta > 0 ? o.first! : o.last!)
        openChat(next.id)
    }

    func archiveActive() {
        guard let active else { return }
        let o = order()
        let at = o.firstIndex { $0.id == active } ?? 0
        controller.archive(active)
        let candidates = [o.indices.contains(at + 1) ? o[at + 1] : nil, at > 0 ? o[at - 1] : nil].compactMap { $0 }
        if let next = candidates.first(where: { $0.id != active }) { openChat(next.id) } else { newChat() }
    }

    /// ⌘J: hide the bottom panel, or show it focused on a terminal.
    func toggleTerminal() {
        if bottom.open {
            bottom.open = false
            focusComposer()
            return
        }
        bottom.focus(.terminal, cwd: cwd)
        focusTerminal()
    }

    /// Give the bottom panel's active terminal keyboard focus once its view is in the window.
    func focusTerminal(_ layout: WorkspaceState.Layout = .bottom, attempt: Int = 0) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in
            guard let self, let tab = self.dock(layout).activeTab, tab.kind == .terminal else { return }
            if let v = Terminals.shared.existing(tab.id), let w = v.window {
                w.makeFirstResponder(v)
            } else if attempt < 10 {
                self.focusTerminal(layout, attempt: attempt + 1)
            }
        }
    }

    /// ⌘\\: hide the side panel, or open it (with Files when empty).
    func toggleWorkspace() {
        if side.open { side.open = false; return }
        openWorkspace(layout: .side)
    }

    /// Header buttons: open a dock, seeding Files (side) or Terminal (bottom).
    func openWorkspace(layout: WorkspaceState.Layout) {
        updateDock(layout) { d in
            d.open = true
            if d.tabs.isEmpty { d.add(layout == .bottom ? .terminal : .files, cwd: cwd) }
        }
        if layout == .bottom { focusTerminal() }
    }

    func addTab(_ layout: WorkspaceState.Layout, _ kind: TabKind) {
        updateDock(layout) { $0.add(kind, cwd: cwd) }
        if kind == .terminal { focusTerminal(layout) }
    }

    func closeTab(_ layout: WorkspaceState.Layout, _ id: Int) {
        updateDock(layout) { $0.close(id) }
        MainActor.assumeIsolated { Terminals.shared.close(id) }
    }

    func openFind() {
        guard page == .chats, active != nil else { return }
        if find == nil { find = FindState() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            guard let f = self?.findField else { return }
            f.window?.makeFirstResponder(f)
        }
    }

    func closeFind() {
        find = nil
        focusComposer()
    }

    // MARK: - Shortcuts

    @discardableResult
    func runShortcut(_ id: String) -> Bool {
        if id.hasPrefix("runtime"), let n = Int(id.dropFirst(7)) {
            let list = Runtimes.ordered(prefs)
            guard list.indices.contains(n - 1) else { return false }
            selectRuntime(list[n - 1].id)
            return true
        }
        if id.hasPrefix("chat"), let n = Int(id.dropFirst(4)) {
            let o = order()
            guard o.indices.contains(n - 1) else { return false }
            openChat(o[n - 1].id)
            return true
        }
        switch id {
        case "commandPalette": palette.toggle(); return true
        case "findInChat":
            guard page == .chats, active != nil else { return false }
            openFind()
            return true
        case "newChat":
            // Cmd+N on Kanban with a concrete folder filter creates a task there (create-task dialog).
            if page == .kanban, let f = kanbanFilter, f != Env.defaultWorkspace { NewTaskDialog.present(self, workspace: f); return true }
            newChat(page == .kanban ? Env.defaultWorkspace : nil); return true
        case "newDefaultChat": newChat(Env.chatDir); return true
        case "archiveChat":
            guard active != nil else { return false }
            archiveActive()
            return true
        case "openSettings": settings = true; return true
        case "switchChats": setView(ViewState(page: .chats, active: active)); return true
        case "switchBoard": setView(ViewState(page: .kanban, active: active)); return true
        case "switchAutomations": setView(ViewState(page: .automations, active: active)); return true
        case "switchPreviousView":
            let candidates = recent.filter { id in id != active && controller.conversations.contains { $0.id == id } }
            guard let prev = candidates.first else { return false }
            openChat(prev)
            return true
        case "navigateBack":
            guard let prev = back.popLast() else { return false }
            forward.append(view)
            setView(prev, record: false)
            return true
        case "navigateForward":
            guard let next = forward.popLast() else { return false }
            back.append(view)
            setView(next, record: false)
            return true
        case "toggleSidebar": controller.setPrefs { $0.sidebar.toggle() }; return true
        case "toggleWorkspace": toggleWorkspace(); return true
        case "toggleTerminal": toggleTerminal(); return true
        case "openFilesTab": side.focus(.files, cwd: cwd); return true
        case "openBrowserTab": side.add(.browser, cwd: cwd); return true
        case "closeWorkspaceTab":
            guard side.open, let a = side.active ?? side.tabs.first?.id else { return false }
            closeTab(.side, a)
            return true
        case "previousWorkspaceTab":
            guard side.open else { return false }
            if side.tabs.count > 1 { side.step(-1) }
            return true
        case "nextWorkspaceTab":
            guard side.open else { return false }
            if side.tabs.count > 1 { side.step(1) }
            return true
        case "previousChat", "previousChatAlternate": stepChat(-1); return true
        case "nextChat", "nextChatAlternate": stepChat(1); return true
        case "lastChat":
            guard let c = order().last else { return false }
            openChat(c.id)
            return true
        default: return false
        }
    }

    /// The window's key handler, ahead of the responder chain. Returns true when consumed.
    func handleKey(_ event: NSEvent) -> Bool {
        if let recorder { return recorder(event) }
        if WorkspaceBrowserKeys.handle(event, self) { return true }
        let f = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let modal = palette || settings
        // Ctrl+Tab while the switcher is up steps through it.
        if switcher != nil, event.keyCode == 48, f.contains(.control) {
            stepSwitcher(f.contains(.shift) ? -1 : 1)
            return true
        }
        for s in Shortcuts.all {
            let accel = Shortcuts.accelerator(s.id, prefs.shortcuts)
            guard Shortcuts.matches(event, accel) else { continue }
            if modal && !["commandPalette", "navigateBack", "navigateForward"].contains(s.id) { continue }
            if s.id == "switchPreviousView" { return beginSwitcher() }
            if runShortcut(s.id) { return true }
        }
        if f.contains(.command), f.isDisjoint(with: [.control, .option]), let key = Shortcuts.keyNames[event.keyCode], ["Equal", "Minus", "0"].contains(key) {
            setZoom(key == "0" ? 1 : Zoom.step(prefs.zoom, up: key == "Equal"))
            return true
        }
        if event.keyCode == 53 { // Escape
            if palette { palette = false; return true }
            if settings { return false }
            if composerMenuOpen, window?.firstResponder === composerView { return false }
            return escape()
        }
        if modal { return false }
        let chars = event.charactersIgnoringModifiers ?? ""
        if ["/", "、", "／"].contains(chars), f.isDisjoint(with: [.command, .control]), page == .chats,
           !(window?.firstResponder is NSText), !(window?.firstResponder is NSTextView), !(window?.firstResponder is TerminalView)
        {
            focusComposer()
            return true
        }
        return false
    }

    var zoomHud: (pct: Int, token: Int)?
    var tooltip: TooltipSpec?
    /// Hero headline / placeholder picks, re-rolled per new chat (never repeating).
    var heroIndex = Int.random(in: 0 ..< 12)
    var placeholderIndex = Int.random(in: 0 ..< 12)
    /// Kanban workspace filter (nil = all).
    var kanbanFilter: String?
    /// Sidebar groups showing past the 5-row limit ("Show more").
    var expandedGroups: Set<String> = []
    /// Row details card shown beside a hovered sidebar row.

    func setZoom(_ z: Double) {
        controller.setPrefs { $0.zoom = z }
        let token = (zoomHud?.token ?? 0) + 1
        zoomHud = (Int((z * 100).rounded()), token)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
            if self?.zoomHud?.token == token { self?.zoomHud = nil }
        }
    }

    /// Esc outside menus: close find, else stop the running turn.
    @discardableResult
    func escape() -> Bool {
        if find != nil { closeFind(); return true }
        if let active, controller.chat(active).isStreaming {
            controller.abort(active)
            return true
        }
        return false
    }

    // MARK: - Ctrl+Tab switcher

    private func beginSwitcher() -> Bool {
        let others = recent.filter { id in id != active && controller.conversations.contains { $0.id == id } }
        guard !others.isEmpty else { return false }
        if let active { switcher = ([active] + others, 1) } else { switcher = (others, 0) }
        return true
    }

    func stepSwitcher(_ delta: Int) {
        guard var s = switcher else { return }
        s.index = (s.index + delta + s.ids.count) % s.ids.count
        switcher = s
    }

    /// Ctrl released: open the highlighted chat.
    func commitSwitcher() {
        guard let s = switcher else { return }
        switcher = nil
        openChat(s.ids[s.index])
    }
}
