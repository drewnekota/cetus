import Foundation

/// Control commands for the dialogs (gestures can't take the first click in a
/// background window, so comparison runs open them directly):
///     detail <conversationId>   open the Kanban session-detail dialog
///     newtask [folder]          open the New task dialog
///     dialog                    print the open dialog id (or "none")
///     dismiss                   close the open dialog
enum DialogControl {
    nonisolated(unsafe) private static var installed = false

    static func install() {
        guard !installed else { return }
        installed = true
        ControlHooks.handlers.append { cmd, arg, app in
            switch cmd {
            case "detail": SessionDetailDialog.present(app, id: arg); return "ok"
            case "newtask": NewTaskDialog.present(app, workspace: arg.isEmpty ? nil : arg); return "ok"
            case "dialog": return DialogHost.openId ?? "none"
            case "dismiss": DialogHost.dismiss(); return "ok"
            default: return nil
            }
        }
    }
}
