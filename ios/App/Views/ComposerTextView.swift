import SwiftUI
import UIKit

/// The composer's text area: a growing UITextView (1–8 lines) whose Paste
/// also accepts images — SwiftUI's TextField only takes text.
struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var focused: Bool
    var placeholder: String
    var onPasteImages: ([UIImage]) -> Void

    private static let font = UIFont.systemFont(ofSize: 15)
    private static let maxLines: CGFloat = 8

    func makeUIView(context: Context) -> PasteTextView {
        let v = PasteTextView()
        v.delegate = context.coordinator
        v.font = Self.font
        v.textColor = UIColor(Theme.text)
        v.tintColor = UIColor(Theme.accent)
        v.backgroundColor = .clear
        v.textContainerInset = .zero
        v.textContainer.lineFragmentPadding = 0
        v.isScrollEnabled = false
        v.keyboardDismissMode = .interactive
        v.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        v.placeholderLabel.text = placeholder
        v.placeholderLabel.font = Self.font
        v.placeholderLabel.textColor = UIColor(Theme.faint)
        v.onPasteImages = onPasteImages
        return v
    }

    func updateUIView(_ v: PasteTextView, context: Context) {
        context.coordinator.parent = self
        v.onPasteImages = onPasteImages
        if v.text != text {
            v.text = text
            v.placeholderLabel.isHidden = !text.isEmpty
        }
        v.placeholderLabel.text = placeholder
        if focused, !v.isFirstResponder, v.window != nil {
            DispatchQueue.main.async { v.becomeFirstResponder() }
        } else if !focused, v.isFirstResponder {
            DispatchQueue.main.async { v.resignFirstResponder() }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView v: PasteTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 300
        let fit = v.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
        let maxHeight = ceil(Self.font.lineHeight * Self.maxLines)
        let scroll = fit > maxHeight
        if v.isScrollEnabled != scroll {
            DispatchQueue.main.async { v.isScrollEnabled = scroll }
        }
        return CGSize(width: width, height: min(max(fit, ceil(Self.font.lineHeight)), maxHeight))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextView
        init(_ parent: ComposerTextView) { self.parent = parent }

        func textViewDidChange(_ v: UITextView) {
            parent.text = v.text
            (v as? PasteTextView)?.placeholderLabel.isHidden = !v.text.isEmpty
        }

        func textViewDidBeginEditing(_ v: UITextView) {
            if !parent.focused { parent.focused = true }
        }

        func textViewDidEndEditing(_ v: UITextView) {
            if parent.focused { parent.focused = false }
        }
    }
}

final class PasteTextView: UITextView {
    var onPasteImages: (([UIImage]) -> Void)?
    let placeholderLabel = UILabel()

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(placeholderLabel)
        NSLayoutConstraint.activate([
            placeholderLabel.leadingAnchor.constraint(equalTo: leadingAnchor),
            placeholderLabel.topAnchor.constraint(equalTo: topAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)) && UIPasteboard.general.hasImages { return true }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        let board = UIPasteboard.general
        if board.hasImages, let images = board.images, !images.isEmpty {
            onPasteImages?(images)
            // Copied web content can carry both; keep the text part too.
            if board.hasStrings, !(board.string ?? "").isEmpty, !board.hasURLs { super.paste(sender) }
            return
        }
        super.paste(sender)
    }
}
