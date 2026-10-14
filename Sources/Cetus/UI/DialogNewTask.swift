import SwiftUI

/// Overrides what the composer does after a send (default: jump into the chat).
/// The New task dialog keeps the user on the board instead.
struct ComposerSentKey: EnvironmentKey { static let defaultValue: ((String) -> Void)? = nil }
struct ComposerPlaceholderKey: EnvironmentKey { static let defaultValue: String? = nil }
extension EnvironmentValues {
    var composerPlaceholder: String? {
        get { self[ComposerPlaceholderKey.self] }
        set { self[ComposerPlaceholderKey.self] = newValue }
    }
    var composerSent: ((String) -> Void)? {
        get { self[ComposerSentKey.self] }
        set { self[ComposerSentKey.self] = newValue }
    }
}

/// Cetus's create-task-dialog.tsx: "cetus › New task" breadcrumb with a
/// "Create more" switch, then the hero composer. ⏎ creates the task in the
/// background and closes (or stays open with "Create more"); Esc closes.
struct NewTaskDialog: View {
    @Environment(AppState.self) private var app
    /// useState in a dialog that stays mounted: sticky for the session, not persisted.
    nonisolated(unsafe) private static var createMoreSession = false
    @State private var createMore = NewTaskDialog.createMoreSession

    static func present(_ app: AppState, workspace: String? = nil) {
        if let workspace { app.setSelection { $0.workspace = workspace } }
        DialogHost.present("new-task", app: app) { NewTaskDialog() }
        app.focusComposer()
    }

    var body: some View {
        GeometryReader { g in
            VStack(spacing: 0) {
                DialogBreadcrumb(icon: nil, root: "cetus", leaf: "New task") {
                    HStack(spacing: 8) {
                        CetusSwitch(isOn: $createMore, testID: "new-task-create-more")
                            .scaleEffect(0.75, anchor: .trailing) // scale-75 origin-right: layout keeps 32×18.4
                        Button { createMore.toggle() } label: {
                            Text("Create more").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.mutedForeground).lineBox(16.2)
                        }
                        .buttonStyle(.plain)
                    }
                    .onChange(of: createMore) { _, v in NewTaskDialog.createMoreSession = v }
                }
                ComposerView(convId: nil, hero: true)
                    .environment(\.composerSent) { _ in
                        if createMore { app.focusComposer() } else { DialogHost.dismiss() }
                    }
                    .environment(\.composerPlaceholder, "Describe your task.")
                    .padding(16)
            }
            .frame(width: min(672, g.size.width * 0.9))
            .fixedSize(horizontal: false, vertical: true)
            .dialogSurface()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .testID("new-task-dialog")
    }
}
