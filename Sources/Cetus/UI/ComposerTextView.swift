import AppKit
import SwiftUI

/// The composer's text view: a real NSTextView, so input methods (marked
/// text, candidate windows), undo, spelling and services all behave natively.
/// Key commands arrive through `doCommandBy` only when the IME isn't
/// composing, which is what keeps Enter from sending a half-typed word.
final class ComposerNSTextView: NSTextView {
    var onPasteFiles: (([String]) -> Void)?
    var onPasteImage: ((NSImage) -> Void)?
    var placeholder = "" { didSet { needsDisplay = true } }
    var placeholderFont: NSFont = .systemFont(ofSize: 14)
    var placeholderPara = NSParagraphStyle()
    var placeholderLift: CGFloat = 0
    var placeholderColor: NSColor?

    override func paste(_ sender: Any?) {
        let pb = NSPasteboard.general
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            onPasteFiles?(urls.map(\.path))
            return
        }
        // Screenshots and copied images arrive without a string flavor.
        if pb.string(forType: .string) == nil, let img = NSImage(pasteboard: pb) {
            onPasteImage?(img)
            return
        }
        pasteAsPlainText(sender)
    }

    // ⌘V straight to paste(_:) so image paste works even when the menu bar isn't consulted.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if window?.firstResponder === self, event.type == .keyDown,
           event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command, event.keyCode == 9 {
            paste(nil)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    override var acceptableDragTypes: [NSPasteboard.PasteboardType] { [.fileURL] + super.acceptableDragTypes }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        if let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
            onPasteFiles?(urls.map(\.path))
            return true
        }
        return super.performDragOperation(sender)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if string.isEmpty && !hasMarkedText() && !placeholder.isEmpty {
            let attrs: [NSAttributedString.Key: Any] = [.font: placeholderFont, .foregroundColor: placeholderColor ?? NSColor(Theme.mutedForeground), .paragraphStyle: placeholderPara, .baselineOffset: placeholderLift]
            let inset = textContainerInset
            let pad = textContainer?.lineFragmentPadding ?? 0
            let r = NSRect(x: inset.width + pad, y: inset.height, width: bounds.width - inset.width * 2 - pad * 2, height: bounds.height - inset.height * 2)
            (placeholder as NSString).draw(with: r, options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attrs)
        }
    }

    // One click both activates the window and places the caret.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func becomeFirstResponder() -> Bool {
        needsDisplay = true
        return super.becomeFirstResponder()
    }
}

enum ComposerCommand { case submit, newline, up, down, tab, backtab, escape }

struct ComposerTextView: NSViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    var placeholder: String
    var fontSize: CGFloat
    /// Settings → Appearance → Line height.
    var lineScale: CGFloat = 1
    var mono: Bool
    var mentionLabels: [String]
    var minHeight: CGFloat
    var maxHeight: CGFloat
    /// Text inset inside the field (Cetus: hero 12/12, docked 10/8).
    var inset = NSSize(width: 10, height: 8)
    /// Return true when the command was handled.
    var onCommand: (ComposerCommand) -> Bool
    var onPasteFiles: ([String]) -> Void
    var onPasteImage: (NSImage) -> Void
    var register: (NSTextView) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        let storage = NSTextStorage()
        let layout = NSLayoutManager()
        storage.addLayoutManager(layout)
        let container = NSTextContainer(size: NSSize(width: 100, height: CGFloat.greatestFiniteMagnitude))
        container.widthTracksTextView = true
        layout.addTextContainer(container)
        let tv = ComposerNSTextView(frame: .zero, textContainer: container)
        tv.isRichText = false
        tv.importsGraphics = false
        tv.allowsUndo = true
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.isAutomaticDashSubstitutionEnabled = false
        tv.isAutomaticTextReplacementEnabled = false
        tv.isContinuousSpellCheckingEnabled = false
        tv.drawsBackground = false
        tv.isVerticallyResizable = true
        tv.isHorizontallyResizable = false
        tv.autoresizingMask = [.width]
        tv.textContainerInset = inset
        container.lineFragmentPadding = 0
        tv.delegate = context.coordinator
        tv.setAccessibilityIdentifier("composer")
        tv.registerForDraggedTypes([.fileURL])
        scroll.documentView = tv
        context.coordinator.textView = tv
        apply(tv)
        tv.string = text
        register(tv)
        DispatchQueue.main.async { context.coordinator.recalcHeight() }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let tv = context.coordinator.textView else { return }
        apply(tv)
        if tv.string != text && !tv.hasMarkedText() {
            tv.string = text
            tv.setSelectedRange(NSRange(location: (text as NSString).length, length: 0))
            context.coordinator.recalcHeight()
        }
        context.coordinator.colorMentions()
        // Fill the whole field so a click anywhere in it focuses the text.
        let h = scroll.contentSize.height
        if tv.minSize.height != h { tv.minSize = NSSize(width: 0, height: h) }
        register(tv)
    }

    private func apply(_ tv: ComposerNSTextView) {
        let font: NSFont = mono ? .monospacedSystemFont(ofSize: fontSize - 1, weight: .regular) : .systemFont(ofSize: fontSize)
        if tv.font != font {
            tv.font = font
            tv.typingAttributes[.font] = font
            tv.placeholderFont = font
        }
        if tv.textContainerInset != inset { tv.textContainerInset = inset }
        // 14px text on a 20px line (Tailwind text-sm).
        let lh = (fontSize * 1.43 * lineScale).rounded()
        let para = NSMutableParagraphStyle()
        para.minimumLineHeight = lh
        para.maximumLineHeight = lh
        // CSS splits the extra line height above and below the glyphs; TextKit
        // puts it all above. Lift the baseline by half to match.
        let lift = ((lh - (font.ascender - font.descender)) / 2).rounded(toPlaces: 2)
        tv.placeholderPara = para
        tv.placeholderLift = lift
        tv.defaultParagraphStyle = para
        tv.typingAttributes[.paragraphStyle] = para
        tv.typingAttributes[.baselineOffset] = lift
        let ink = NSColor(Theme.foreground)
        tv.typingAttributes[.foregroundColor] = ink
        tv.textColor = ink
        tv.insertionPointColor = ink // caret-color: auto → currentColor
        tv.placeholder = placeholder
        tv.onPasteFiles = onPasteFiles
        tv.onPasteImage = onPasteImage
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextView
        weak var textView: ComposerNSTextView?

        init(_ parent: ComposerTextView) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let tv = textView else { return }
            if parent.text != tv.string { parent.text = tv.string }
            recalcHeight()
            colorMentions()
        }

        func recalcHeight() {
            guard let tv = textView, let lm = tv.layoutManager, let tc = tv.textContainer else { return }
            lm.ensureLayout(for: tc)
            let used = lm.usedRect(for: tc).height + tv.textContainerInset.height * 2
            let h = min(parent.maxHeight, max(parent.minHeight, ceil(used)))
            if tv.minSize.height != h { tv.minSize = NSSize(width: 0, height: h) }
            if abs(parent.height - h) > 0.5 {
                DispatchQueue.main.async { self.parent.height = h }
            }
        }

        /// Draw `@label` tokens as accent text without touching the string.
        func colorMentions() {
            guard let tv = textView, let lm = tv.layoutManager else { return }
            let full = NSRange(location: 0, length: (tv.string as NSString).length)
            lm.removeTemporaryAttribute(.foregroundColor, forCharacterRange: full)
            lm.removeTemporaryAttribute(.backgroundColor, forCharacterRange: full)
            let s = tv.string
            for span in Mentions.spans(s, labels: parent.mentionLabels) {
                let r = NSRange(span.range, in: s)
                let dark = tv.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
                lm.addTemporaryAttributes([.backgroundColor: NSColor(hex: 0x827BE6, alpha: dark ? 0.45 : 0.35)], forCharacterRange: r)
            }
        }

        func textView(_ textView: NSTextView, doCommandBy selector: Selector) -> Bool {
            let shift = NSApp.currentEvent?.modifierFlags.contains(.shift) ?? false
            switch selector {
            case #selector(NSResponder.insertNewline(_:)):
                if shift { return parent.onCommand(.newline) ? true : false }
                return parent.onCommand(.submit)
            case #selector(NSResponder.insertLineBreak(_:)), #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)):
                textView.insertText("\n", replacementRange: textView.selectedRange())
                return true
            case #selector(NSResponder.moveUp(_:)):
                return parent.onCommand(.up)
            case #selector(NSResponder.moveDown(_:)):
                return parent.onCommand(.down)
            case #selector(NSResponder.insertTab(_:)):
                return parent.onCommand(.tab)
            case #selector(NSResponder.insertBacktab(_:)):
                return parent.onCommand(.backtab)
            case #selector(NSResponder.cancelOperation(_:)):
                return parent.onCommand(.escape)
            default:
                return false
            }
        }
    }
}

private extension CGFloat {
    func rounded(toPlaces n: Int) -> CGFloat { let m = pow(10, CGFloat(n)); return (self * m).rounded() / m }
}
