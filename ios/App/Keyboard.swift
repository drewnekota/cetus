import SwiftUI
import UIKit

extension UIApplication {
    func dismissKeyboard() {
        sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

extension View {
    /// Tapping empty space hides the keyboard. Buttons and links inside keep
    /// their own taps (a child gesture wins over this one).
    func tapDismissesKeyboard() -> some View {
        contentShape(Rectangle())
            .onTapGesture { UIApplication.shared.dismissKeyboard() }
    }

    /// A downward swipe hides the keyboard — for views that don't scroll
    /// (scroll views use `.scrollDismissesKeyboard` instead).
    func swipeDownDismissesKeyboard() -> some View {
        simultaneousGesture(
            DragGesture(minimumDistance: 20).onEnded { g in
                if g.translation.height > 30 && g.translation.height > abs(g.translation.width) {
                    UIApplication.shared.dismissKeyboard()
                }
            }
        )
    }
}
