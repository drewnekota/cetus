import AppKit
import SwiftUI

/// The composer's `/` and `@` menu state and behavior, after composer.tsx
/// (syncSlash / syncMention / applySlash / applyMention / the onKeyDown nav
/// rules) and composer-view.tsx. Kept out of ComposerView so the shared file
/// only wires it in.
@MainActor @Observable
final class ComposerMenus {
    /// Caret (UTF-16 offset) in the composer text view.
    var caret = 0
    /// Esc closed the menu for the current token; the next edit re-arms it.
    var slashSuppress = false
    var mentionSuppress = false
    var slashActive = 0
    var mentionActive = 0
    var tab: MentionTab = .all
    // Slash sources, fetched each time the menu opens.
    var local: [SlashItem] = []
    var skills: [SlashItem] = []
    // Mention sources, snapshotted when the menu opens.
    var automations: [Automation] = []
    var conversations: [Conversation] = []
    var artifacts: [MentionItem] = []
    var files: [WorkspaceEntry] = []
    var filesLoading = false
    @ObservationIgnored private var filesKey = ""
    @ObservationIgnored private var filesGen = 0

    enum Token: Equatable { case slash(query: String, start: Int), mention(query: String, start: Int) }

    /// The open token at the caret: `/` beats `@` (they can't both match one token).
    func token(_ text: String, bash: Bool) -> Token? {
        guard !bash else { return nil } // `/` and `@` are path/shell characters in Terminal mode
        let caret = min(self.caret, (text as NSString).length)
        if !slashSuppress, let t = SlashCatalog.detect(text, caret: caret) { return .slash(query: t.query, start: t.start) }
        if !mentionSuppress, let t = SlashCatalog.detect(text, caret: caret, trigger: "@") { return .mention(query: t.query, start: t.start) }
        return nil
    }

    /// A fresh edit re-arms both menus.
    func edited() {
        slashSuppress = false
        mentionSuppress = false
    }

    func slashOpened() {
        local = SlashCatalog.localCommands()
        skills = SlashCatalog.localSkills()
    }

    func mentionOpened(_ controller: Controller, state: ChatState?) {
        automations = controller.automations
        // list_conversations(includeArchived: true) returns the archived set only — that's what Cetus offers.
        conversations = controller.archived
        artifacts = MentionSources.artifacts(state)
    }

    /// Root listing for an empty query, else a debounced (120ms) search incl. folders.
    func loadFiles(_ workspace: String, query: String) {
        let ws = workspace.isEmpty ? Env.chatDir : workspace
        let key = "\(ws)\n\(query)"
        guard key != filesKey else { return }
        filesKey = key
        filesGen += 1
        let gen = filesGen
        filesLoading = true
        let q = query.trimmingCharacters(in: .whitespaces)
        DispatchQueue.main.asyncAfter(deadline: .now() + (q.isEmpty ? 0 : 0.12)) {
            guard gen == self.filesGen else { return }
            MentionSources.files(ws, query: q) { entries in
                guard gen == self.filesGen else { return }
                self.files = entries
                self.filesLoading = false
            }
        }
    }

    func resetFiles() { filesKey = "" }

    /// Replace `[start, caret)` with `insert`; returns the new text and caret.
    func replace(_ text: String, start: Int, insert: String) -> (String, Int) {
        let ns = text as NSString
        let end = max(start, min(caret, ns.length))
        let next = ns.replacingCharacters(in: NSRange(location: start, length: end - start), with: insert)
        return (next, start + (insert as NSString).length)
    }

    /// Backspace right after a mention pill removes the whole `@label` (plus the
    /// space after it). Detected from the edit: one character deleted just
    /// before the caret, at the end of a token that starts a word.
    static func pillBackspace(old: String, new: String, refs: [MentionRef]) -> (String, Int)? {
        let o = old as NSString, n = new as NSString
        guard !refs.isEmpty, o.length == n.length + 1 else { return nil }
        var k = 0
        while k < n.length && o.character(at: k) == n.character(at: k) { k += 1 }
        guard o.substring(from: k + 1) == n.substring(from: k) else { return nil }
        let head = o.substring(to: k + 1)
        for token in refs.map({ "@\($0.label)" }).sorted(by: { $0.count > $1.count }) {
            let trailing = head.hasSuffix(token + " ") ? 1 : head.hasSuffix(token) ? 0 : -1
            if trailing < 0 { continue }
            let start = (head as NSString).length - (token as NSString).length - trailing
            if start > 0, let s = Unicode.Scalar(o.character(at: start - 1)), !CharacterSet.whitespacesAndNewlines.contains(s) { continue }
            return (o.substring(to: start) + o.substring(from: k + 1), start)
        }
        return nil
    }

    /// Put the caret at `pos` once the text view has taken the new string.
    static func placeCaret(_ app: AppState, _ pos: Int) {
        DispatchQueue.main.async {
            guard let v = app.composerView else { return }
            let p = min(pos, (v.string as NSString).length)
            v.setSelectedRange(NSRange(location: p, length: 0))
        }
    }
}

/// Codex's composer-handled `/status`: a toast with chat, tuning, context and quota.
enum CodexStatus {
    @MainActor static func show(app: AppState, convId: String?) {
        let s = app.selection
        let info = app.controller.rateLimits["codex"]
        var quota = "Not available yet"
        if let u = info?["utilization"].double {
            var parts = ["\(Int((u * 100).rounded()))% used"]
            if let r = info?["resetsAt"].double {
                let f = DateFormatter()
                f.dateStyle = .short
                f.timeStyle = .medium
                parts.append("resets \(f.string(from: Date(timeIntervalSince1970: r)))")
            }
            quota = parts.joined(separator: " · ")
        }
        let detail = [
            "Chat: \(convId ?? "New chat")",
            "Model: \(s.model.isEmpty ? "Default" : s.model) · Reasoning: \(s.effort.isEmpty ? "Default" : s.effort)",
            "Context: Not available until the first turn",
            "Rate limit: \(quota)",
        ].joined(separator: "\n")
        app.toast("Codex status", detail)
    }
}
