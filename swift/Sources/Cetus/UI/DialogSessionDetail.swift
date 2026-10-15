import SwiftUI

/// Cetus's session-detail-dialog.tsx: clicking a Kanban card opens the run in a
/// near-fullscreen dialog (inset 16, rounded-xl, bg-background) — a header with
/// title, workspace · "Updated …", the panel toggles, "Open in chat" and close,
/// then the live transcript + composer of that conversation.
struct SessionDetailDialog: View {
    @Environment(AppState.self) private var app
    let id: String

    static func present(_ app: AppState, id: String) {
        // The dialog's composer runs on the conversation's own runtime/model; the
        // global choice and the window's docks come back when it closes.
        let saved = app.selection
        let docks = (app.side.open, app.bottom.open)
        if let c = app.controller.conversation(id) {
            app.setSelection { $0.runtime = c.backend; $0.model = c.cliModel; $0.effort = c.cliEffort }
        }
        app.updateDock(.side) { $0.open = false }
        app.updateDock(.bottom) { $0.open = false }
        DialogHost.present("session-detail", app: app) { SessionDetailDialog(id: id) }
        DialogHost.onDismiss = {
            app.setSelection { $0 = saved }
            app.updateDock(.side) { $0.open = docks.0 }
            app.updateDock(.bottom) { $0.open = docks.1 }
        }
        app.focusComposer()
    }

    var body: some View {
        let conv = app.controller.conversation(id)
        let chat = app.controller.chat(id)
        VStack(spacing: 0) {
            header(conv, streaming: chat.isStreaming)
            if app.bottom.open {
                VStack(spacing: 0) {
                    ChatPane(chat: chat).frame(maxHeight: .infinity).modifier(NoOpticalNudge())
                    WorkspacePanel(layout: .bottom)
                        .frame(height: 300)
                        .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
                }
            } else {
                HStack(spacing: 0) {
                    ChatPane(chat: chat).frame(maxWidth: .infinity).modifier(NoOpticalNudge())
                    if app.side.open {
                        WorkspacePanel(layout: .side)
                            .frame(width: 520)
                            .overlay(alignment: .leading) { Rectangle().fill(Theme.border).frame(width: 1) }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .dialogSurface(fill: Theme.background)
        .padding(16)
        .testID("session-detail")
    }

    private func header(_ c: Conversation?, streaming: Bool) -> some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                Text((c?.title).flatMap { $0.isEmpty ? nil : $0 } ?? "Untitled")
                    .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).lineLimit(1).lineBox(20.02)
                HStack(spacing: 8) {
                    if let c {
                        let chatDir = ComposerView.isChatWorkspace(c.workspaceDir)
                        Glyph(name: chatDir ? "message-square" : "folder", size: 12)
                        Text(chatDir ? "Chat" : Env.folderName(c.workspaceDir)).lineLimit(1).help(chatDir ? "" : c.workspaceDir)
                        Text("·")
                        Text("Updated \(Self.timestamp(c.updatedAt))")
                    }
                    if streaming {
                        Text("·")
                        HStack(spacing: 6) {
                            Circle().fill(Theme.warning).frame(width: 6, height: 6)
                            Text("streaming")
                        }
                        .foregroundStyle(Theme.warning)
                    }
                }
                .font(.system(size: 12)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 4) {
                GhostIconButton(icon: "panel-right", box: 32, glyph: 16, color: Theme.foreground, tip: "Open side panel", testID: "detail-open-side") {
                    app.updateDock(.bottom) { $0.open = false }
                    app.openWorkspace(layout: .side)
                }
                GhostIconButton(icon: "panel-bottom", box: 32, glyph: 16, color: Theme.foreground, tip: "Open bottom panel", testID: "detail-open-bottom") {
                    app.updateDock(.side) { $0.open = false }
                    app.openWorkspace(layout: .bottom)
                }
                Button {
                    guard c != nil else { return }
                    DialogHost.dismiss()
                    app.openChat(id)
                } label: {
                    HStack(spacing: 8) { // gap-1 + the icon's ml-1
                        Text("Open in chat")
                        Glyph(name: "arrow-right", size: 14, color: Theme.primaryForeground)
                    }
                }
                .buttonStyle(CetusButtonStyle(variant: .primary, height: 32))
                .disabled(c == nil)
                .testID("detail-open-in-chat")
                GhostIconButton(icon: "x", box: 32, glyph: 16, color: Theme.foreground, tip: "Close (Esc)", testID: "detail-close") { DialogHost.dismiss() }
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
        .padding(.bottom, 1)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.border).frame(height: 1) }
    }

    /// formatTimestamp: "02:06 PM" today, else "Jun 3".
    static func timestamp(_ ms: Double) -> String {
        let d = Date(timeIntervalSince1970: ms / 1000)
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = Calendar.current.isDateInToday(d) ? "hh:mm a" : "MMM d"
        return f.string(from: d)
    }
}

/// The detail ChatPane isn't optically centered (no `opticalCenter`): keep the
/// viewport width under OpticalNudge's 1280 breakpoint inside the dialog.
private struct NoOpticalNudge: ViewModifier {
    @Environment(\.windowWidth) private var width
    func body(content: Content) -> some View { content.environment(\.windowWidth, min(width, 1279)) }
}
