import AppKit
import SwiftUI

/// One row of an in-window menu (composer pickers).
struct MenuItem: Identifiable {
    var id: String
    var title: String
    var subtitle: String? = nil
    var icon: AnyView? = nil
    /// Lucide glyph for the native-menu row (`NativeMenu`), tinted like its text.
    var glyph: String? = nil
    var checked = false
    var hint: String? = nil
    var group: String? = nil
    var testID: String? = nil
    var destructive = false
    /// Muted row text (`text-muted-foreground` items such as "Add folder…").
    var muted = false
    var enabled = true
    /// Rows of a cascading submenu opened from this row (DropdownMenuSub).
    var submenu: [MenuItem]? = nil
    var action: () -> Void = {}
}

/// The two shadcn menu primitives the composer uses: `Select` (bordered
/// surface, check pinned to the right gutter) and `DropdownMenu` (ring
/// surface, inline check, labels and submenus).
enum MenuStyle { case select, dropdown, sub }

/// Grouped menu list. 4px padding, 28.2px rows (py-1.5 + text-xs line box),
/// accent hover. A group named " " renders as a separator only; other group
/// names render as an uppercase label.
struct MenuList: View {
    let items: [MenuItem]
    var style: MenuStyle = .dropdown
    var minWidth: CGFloat = 0
    var maxWidth: CGFloat = .infinity
    /// Row text size: 12 for `text-xs` items, 14 for the default `text-sm`.
    var textSize: CGFloat = 12
    @Environment(AppState.self) private var app
    @State private var hovered: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                if let g = item.group, i == 0 || items[i - 1].group != g {
                    if i > 0 { Rectangle().fill(Theme.border).frame(height: 1).padding(.horizontal, -4).padding(.vertical, 4) }
                    if !g.trimmingCharacters(in: .whitespaces).isEmpty {
                        Text(g.uppercased()).font(.system(size: 12, weight: .medium)).tracking(0.3)
                            .foregroundStyle(Theme.mutedForeground)
                            .lineBox(16.2).padding(.horizontal, 8).padding(.vertical, 6)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                MenuRowView(item: item, style: style, textSize: textSize,
                            highlighted: hovered == item.id || (item.submenu != nil && app.subPopup?.id == item.id),
                            onHover: { inside, frame in hover(item, inside, frame) })
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(4)
        .padding(style == .select ? 1 : 0) // Select's border is part of its box
        .frame(minWidth: minWidth, maxWidth: maxWidth)
        .fixedSize(horizontal: true, vertical: false)
    }

    private func hover(_ item: MenuItem, _ inside: Bool, _ frame: CGRect) {
        if inside {
            hovered = item.id
            if let sub = item.submenu {
                guard app.subPopup?.id != item.id else { return }
                app.subPopup = PopupSpec(id: item.id, anchor: frame, content: AnyView(MenuList(items: sub, style: .sub, minWidth: minWidth)))
            } else if style != .sub {
                app.subPopup = nil
            }
        } else if hovered == item.id {
            hovered = nil
        }
    }
}

private struct MenuRowView: View {
    let item: MenuItem
    let style: MenuStyle
    var textSize: CGFloat = 12
    let highlighted: Bool
    let onHover: (Bool, CGRect) -> Void
    @State private var frame: CGRect = .zero

    private var textColor: Color { item.destructive ? Theme.destructive : item.muted ? Theme.mutedForeground : Theme.foreground }

    var body: some View {
        // A submenu row opens its submenu on click as well as on hover.
        Button(action: { item.submenu != nil ? onHover(true, frame) : item.action() }) {
            HStack(spacing: 0) {
                if let icon = item.icon { icon.frame(width: 16, height: 16).padding(.trailing, 8) }
                Text(item.title).font(.system(size: textSize)).foregroundStyle(textColor).lineLimit(1).lineBox(textSize == 12 ? 16.2 : 20.02).layoutPriority(1)
                if let s = item.subtitle {
                    Text(s).font(.system(size: 11)).foregroundStyle(Theme.mutedForeground.opacity(0.7)).lineLimit(1).padding(.leading, 12)
                }
                Spacer(minLength: 0)
                if let h = item.hint {
                    Text(h).font(.system(size: 11)).tracking(0.275).foregroundStyle(Theme.mutedForeground.opacity(0.7)).padding(.leading, 20)
                }
                if style != .select {
                    if item.submenu != nil {
                        Glyph(name: "chevron-right", size: 16, color: Theme.foreground).padding(.leading, 8)
                    } else if item.checked {
                        Glyph(name: "check", size: 14, color: Theme.foreground).padding(.leading, 8)
                    }
                }
            }
            .padding(.leading, 8).padding(.trailing, style == .select ? 32 : 8).padding(.vertical, 6)
            .overlay(alignment: .trailing) {
                if style == .select && item.checked {
                    Glyph(name: "check", size: 16, color: Theme.mutedForeground).frame(width: 14, height: 14).padding(.trailing, 8)
                }
            }
            .background(RoundedRectangle(cornerRadius: 6).fill(highlighted ? Theme.accent : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(GeometryReader { g in
            Color.clear
                .onAppear { frame = g.frame(in: .global) }
                .onChange(of: g.frame(in: .global)) { _, f in frame = f }
        })
        .onHover { onHover($0, frame) }
        .testID(item.testID)
    }
}

/// shadcn popover surface, radius 8. `select`: 1px border + shadow-md;
/// `dropdown`: foreground/10 ring outside the box + shadow-md; `sub`: ring + shadow-lg.
struct PopupSurface<Content: View>: View {
    var style: MenuStyle = .select
    var radius: CGFloat = 8
    @ViewBuilder let content: Content
    var body: some View {
        content
            .background(RoundedRectangle(cornerRadius: radius).fill(Theme.popover))
            .clipShape(RoundedRectangle(cornerRadius: radius))
            .overlay {
                if style == .select {
                    RoundedRectangle(cornerRadius: radius).strokeBorder(Theme.border, lineWidth: 1)
                } else {
                    RoundedRectangle(cornerRadius: radius + 1).strokeBorder(Theme.foreground.opacity(0.1), lineWidth: 1).padding(-1)
                }
            }
            .shadow(color: .black.opacity(0.1), radius: style == .sub ? 6 : 2.5, y: style == .sub ? 10 : 4)
            .shadow(color: .black.opacity(0.1), radius: style == .sub ? 2.5 : 1.5, y: style == .sub ? 4 : 2)
    }
}

/// Window-wide layer for `AppState.popup` (and its cascading `subPopup`): a
/// click-away catcher plus menus placed like Radix popper — below the trigger
/// with a 4px gap, flipped above when it does not fit; submenus to the right of
/// their row, shifted up to stay inside the window.
struct PopupLayer: View {
    @Environment(AppState.self) private var app

    var body: some View {
        GeometryReader { geo in
            if let p = app.popup {
                let origin = geo.frame(in: .global).origin
                let a = Self.local(p.anchor, origin, app)
                ZStack(alignment: .topLeading) {
                    Color.black.opacity(0.001)
                        .onTapGesture { app.popup = nil }
                    PopupSurface(style: p.style, radius: p.radius) { p.content }
                        .alignmentGuide(.top) { d in
                            if p.sideRight { return -max(0, min(a.minY, geo.size.height - d.height)) }
                            let fitsBelow = a.maxY + 4 + d.height <= geo.size.height
                            return fitsBelow || a.minY - 4 - d.height < 0 ? -(a.maxY + 4) : -(a.minY - 4 - d.height)
                        }
                        .alignmentGuide(.leading) { d in -max(0, min(p.sideRight ? a.maxX + 4 : p.alignEnd ? a.maxX - d.width : a.minX, geo.size.width - d.width)) }
                        .testID("popup-\(p.id)")
                    if let s = app.subPopup {
                        let sa = Self.local(s.anchor, origin, app)
                        PopupSurface(style: .sub) { s.content }
                            .alignmentGuide(.top) { d in -max(0, min(sa.minY, geo.size.height - d.height)) }
                            .alignmentGuide(.leading) { d in sa.maxX + d.width <= geo.size.width ? -sa.maxX : -(sa.minX - d.width) }
                            .testID("popup-sub")
                    }
                }
                .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
            }
        }
        .onChange(of: app.popup?.id) { _, _ in app.subPopup = nil }
    }

    /// Anchors are read in `.global`, which already includes ZoomRoot's
    /// scaleEffect; this layer lays out in the unscaled space, so undo it.
    static func local(_ anchor: CGRect, _ origin: CGPoint, _ app: AppState) -> CGRect {
        let z = CGFloat(app.prefs.zoom)
        return CGRect(x: (anchor.minX - origin.x) / z, y: (anchor.minY - origin.y) / z, width: anchor.width / z, height: anchor.height / z)
    }
}

/// Reports a view's global frame, for anchoring popups.
struct FrameReader: ViewModifier {
    @Binding var frame: CGRect
    func body(content: Content) -> some View {
        content.background(GeometryReader { g in
            Color.clear
                .onAppear { frame = g.frame(in: .global) }
                .onChange(of: g.frame(in: .global)) { _, f in frame = f }
        })
    }
}

extension View {
    func readFrame(_ frame: Binding<CGRect>) -> some View { modifier(FrameReader(frame: frame)) }
}

// MARK: - Native menus

/// Where a native action menu opens relative to its trigger.
enum MenuPlacement {
    /// Under the trigger, left edges aligned.
    case below
    /// Under the trigger, right edges aligned.
    case belowEnd
    /// Beside the trigger, top edges aligned.
    case right
    /// Context menu at the mouse pointer (the anchor is ignored).
    case pointer
}

/// "More" (⋯) and right-click action menus as system `NSMenu`s. Anchors are
/// window-content coordinates with a top-left origin, as `.global` frames read.
@MainActor
enum NativeMenu {
    static func show(_ items: [MenuItem], anchor: CGRect, placement: MenuPlacement = .below, app: AppState, id: String) {
        guard !items.isEmpty, let win = NSApp.keyWindow ?? NSApp.mainWindow, let view = win.contentView else { return }
        let menu = build(items)
        app.openMenu = id
        // Let the trigger repaint as pressed before the menu's tracking loop starts.
        DispatchQueue.main.async {
            defer { if app.openMenu == id { app.openMenu = nil } }
            let r = NSRect(x: anchor.minX, y: view.isFlipped ? anchor.minY : view.bounds.height - anchor.maxY,
                           width: anchor.width, height: anchor.height)
            let top = view.isFlipped ? r.minY : r.maxY
            let bottom = view.isFlipped ? r.maxY + 4 : r.minY - 4
            let at: NSPoint
            switch placement {
            case .below: at = NSPoint(x: r.minX, y: bottom)
            case .belowEnd: at = NSPoint(x: r.maxX - menu.size.width, y: bottom)
            case .right: at = NSPoint(x: r.maxX + 4, y: top)
            case .pointer: at = view.convert(win.mouseLocationOutsideOfEventStream, from: nil)
            }
            menu.popUp(positioning: nil, at: at, in: view)
        }
    }

    /// A group named " " (or any blank name) starts with a separator; other names add a section header.
    static func build(_ items: [MenuItem]) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        for (i, item) in items.enumerated() {
            if let g = item.group, i == 0 || items[i - 1].group != g {
                if i > 0 { menu.addItem(.separator()) }
                let title = g.trimmingCharacters(in: .whitespaces)
                if !title.isEmpty { menu.addItem(.sectionHeader(title: title)) }
            }
            menu.addItem(nsItem(item))
        }
        return menu
    }

    private static func nsItem(_ item: MenuItem) -> NSMenuItem {
        let mi = NSMenuItem(title: item.title, action: nil, keyEquivalent: "")
        mi.subtitle = item.subtitle
        mi.state = item.checked ? .on : .off
        mi.isEnabled = item.enabled
        if let name = item.glyph, let img = Theme.lucide(name)?.copy() as? NSImage {
            img.size = NSSize(width: 16, height: 16)
            img.isTemplate = true
            mi.image = img
        }
        if let h = item.hint, let (key, mods) = keyEquivalent(h) {
            mi.keyEquivalent = key
            mi.keyEquivalentModifierMask = mods
        }
        if let sub = item.submenu {
            mi.submenu = build(sub)
        } else {
            let box = Action(item.action)
            mi.target = box
            mi.action = #selector(Action.fire(_:))
            mi.representedObject = box // NSMenuItem.target is weak
        }
        return mi
    }

    /// "⌘⇧T" → ("t", [.command, .shift]); nil for hints a key equivalent cannot show.
    static func keyEquivalent(_ hint: String) -> (String, NSEvent.ModifierFlags)? {
        let flags: [Character: NSEvent.ModifierFlags] = ["⌃": .control, "⌥": .option, "⇧": .shift, "⌘": .command]
        var mods: NSEvent.ModifierFlags = []
        var rest = Substring(hint)
        while let c = rest.first, let f = flags[c] { mods.insert(f); rest = rest.dropFirst() }
        let special: [String: Int] = ["←": NSLeftArrowFunctionKey, "→": NSRightArrowFunctionKey, "↑": NSUpArrowFunctionKey,
                                      "↓": NSDownArrowFunctionKey, "⌦": NSDeleteFunctionKey]
        let named: [String: String] = ["⇥": "\t", "↩": "\r", "⎋": "\u{1b}", "⌫": "\u{8}", "Space": " "]
        let key = String(rest)
        guard !mods.isEmpty, !key.isEmpty else { return nil }
        if let u = special[key], let s = UnicodeScalar(u) { return (String(Character(s)), mods) }
        if let s = named[key] { return (s, mods) }
        guard key.count == 1 else { return nil }
        return (key.lowercased(), mods)
    }

    private final class Action: NSObject {
        let run: () -> Void
        init(_ run: @escaping () -> Void) { self.run = run }
        @objc func fire(_ sender: Any?) { run() }
    }
}
