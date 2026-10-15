import Foundation

/// App preferences, persisted as one JSON file next to the database. Mirrors
/// the keys Cetus keeps in localStorage (theme, shortcuts, runtime order,
/// recent workspaces, drafts) so behaviour carries over one to one.

enum ThemePreference: String, Codable, CaseIterable { case system, light, dark }

struct Draft: Codable, Equatable {
    var text: String
    var attachments: [String]
    var mentions: [MentionRef]? = nil
    /// Pending "Add to chat" quote, sent as a leading `>` blockquote.
    var quote: String? = nil
}

struct NotificationPrefs: Codable, Equatable {
    var enabled = true
    var muteWhenFocused = false
    var taskFinished = true
    var awaitingInput = true
}

struct Tuning: Codable, Equatable { var model: String; var effort: String }

struct Prefs: Codable, Equatable {
    var theme: ThemePreference = .system
    var fontSize: Double = 14
    var lineScale: Double = 1
    /// Whole-window zoom (⌘+ / ⌘− / ⌘0), on the browser ladder.
    var zoom: Double = 1
    /// Ctrl+1…9 order over runtime ids. Missing runtimes append.
    var runtimeOrder: [String] = []
    var disabledRuntimes: [String] = []
    /// Last picked runtime, model and effort for new chats.
    var runtime = "claude-code"
    var model = ""
    var effort = ""
    var tuning: [String: Tuning] = [:]
    var workspace = Env.defaultWorkspace
    var recentWorkspaces: [String] = []
    var hiddenWorkspaces: [String] = []
    /// Accelerator overrides by shortcut id.
    var shortcuts: [String: String] = [:]
    var bypassApprovals = true
    var moveActiveToTop = true
    var notifications = NotificationPrefs()
    var sidebar = true
    var sidebarWidth: Double = 224
    var collapsedGroups: [String] = []
    var drafts: [String: Draft] = [:]

    init() {}

    // Tolerant decoding: unknown or missing keys fall back to defaults.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = Prefs()
        func v<T: Decodable>(_ k: CodingKeys, _ def: T) -> T { (try? c.decodeIfPresent(T.self, forKey: k)) ?? def }
        theme = v(.theme, d.theme)
        fontSize = v(.fontSize, d.fontSize)
        lineScale = v(.lineScale, d.lineScale)
        zoom = v(.zoom, d.zoom)
        runtimeOrder = v(.runtimeOrder, d.runtimeOrder)
        disabledRuntimes = v(.disabledRuntimes, d.disabledRuntimes)
        runtime = v(.runtime, d.runtime)
        model = v(.model, d.model)
        effort = v(.effort, d.effort)
        tuning = v(.tuning, d.tuning)
        workspace = v(.workspace, d.workspace)
        recentWorkspaces = v(.recentWorkspaces, d.recentWorkspaces)
        hiddenWorkspaces = v(.hiddenWorkspaces, d.hiddenWorkspaces)
        shortcuts = v(.shortcuts, d.shortcuts)
        bypassApprovals = v(.bypassApprovals, d.bypassApprovals)
        moveActiveToTop = v(.moveActiveToTop, d.moveActiveToTop)
        notifications = v(.notifications, d.notifications)
        sidebar = v(.sidebar, d.sidebar)
        sidebarWidth = v(.sidebarWidth, d.sidebarWidth)
        collapsedGroups = v(.collapsedGroups, d.collapsedGroups)
        drafts = v(.drafts, d.drafts)
    }
}

final class PrefStore {
    private let url: URL
    private(set) var value: Prefs
    private var saveWork: DispatchWorkItem?
    var onChange: (() -> Void)?

    init(dataDir: URL) {
        url = dataDir.appendingPathComponent("prefs.json")
        if let data = try? Data(contentsOf: url), let p = try? JSONDecoder().decode(Prefs.self, from: data) {
            value = p
        } else {
            value = Prefs()
        }
    }

    func set(_ mutate: (inout Prefs) -> Void) {
        let before = value
        mutate(&value)
        if value != before {
            onChange?()
            scheduleSave()
        }
    }

    /// Drafts change on every keystroke: save without notifying observers.
    func setDraft(_ key: String, _ draft: Draft?) {
        if let draft, !(draft.text.isEmpty && draft.attachments.isEmpty && (draft.quote ?? "").isEmpty) { value.drafts[key] = draft }
        else { value.drafts.removeValue(forKey: key) }
        scheduleSave()
    }

    /// Using a folder must not reorder the sidebar (that order is the user's,
    /// via drag-to-reorder): a known folder stays put, a new one goes first.
    func touchWorkspace(_ dir: String) {
        set { p in
            p.workspace = dir
            if !p.recentWorkspaces.contains(dir) {
                p.recentWorkspaces.insert(dir, at: 0)
            }
            p.hiddenWorkspaces.removeAll { $0 == dir }
        }
    }

    /// Encoding and the atomic write run here, in order: saves follow typing pauses.
    private let io = DispatchQueue(label: "cetus.prefs", qos: .utility)

    private func scheduleSave() {
        saveWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.write(wait: false) }
        saveWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
    }

    /// Save now and wait for it (quit).
    func flush() { write(wait: true) }

    private func write(wait: Bool) {
        saveWork?.cancel()
        saveWork = nil
        let snapshot = value, url = url
        let job = {
            let enc = JSONEncoder()
            enc.outputFormatting = [.prettyPrinted, .sortedKeys]
            guard let data = try? enc.encode(snapshot) else { return }
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
        if wait { io.sync(execute: job) } else { io.async(execute: job) }
    }
}

/// Process environment: the data directory, the default workspace, and the
/// login shell's environment (a Finder-launched app gets a bare PATH, so the
/// runtimes would not be found without it).
enum Env {
    static let home = FileManager.default.homeDirectoryForCurrentUser.path
    static var process: [String: String] { ProcessInfo.processInfo.environment }

    static var dataDir: URL {
        if let d = process["CETUS_SWIFT_DATA"], !d.isEmpty { return URL(fileURLWithPath: d) }
        return URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support/dev.cetus.swift")
    }

    static var defaultWorkspace: String {
        if let w = process["CETUS_WORKSPACE"], !w.isEmpty { return w }
        return "\(home)/cetus"
    }

    static let chatDir = "\(home)/cetus"

    /// The login shell's environment merged over ours.
    nonisolated(unsafe) static var shell: [String: String] = process

    static func adoptLoginShell() {
        let shellPath = process["SHELL"] ?? "/bin/zsh"
        let p = Foundation.Process()
        p.executableURL = URL(fileURLWithPath: shellPath)
        p.arguments = ["-lic", "env -0"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return }
        let deadline = Date().addingTimeInterval(5)
        var data = Data()
        let handle = out.fileHandleForReading
        DispatchQueue.global().async {
            data = handle.readDataToEndOfFile()
        }
        while p.isRunning && Date() < deadline { usleep(20_000) }
        if p.isRunning { p.terminate(); return }
        usleep(20_000)
        var env = process
        for entry in data.split(separator: 0) {
            guard let s = String(data: Data(entry), encoding: .utf8), let eq = s.firstIndex(of: "=") else { continue }
            let k = String(s[..<eq])
            if ["PWD", "SHLVL", "_", "OLDPWD"].contains(k) { continue }
            env[k] = String(s[s.index(after: eq)...])
        }
        shell = env
    }

    static func tildify(_ path: String) -> String {
        path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
    }

    static func folderName(_ path: String) -> String {
        if path.isEmpty { return "~" }
        return URL(fileURLWithPath: path).lastPathComponent
    }
}
