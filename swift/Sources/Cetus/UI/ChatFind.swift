import SwiftUI

/// Row frames (in the transcript's scroll viewport) for ⌘F's firstMatchFrom:
/// a reference box so scrolling records them without re-rendering the list.
final class ChatFindRowFrames {
    var frames: [String: CGRect] = [:]

    /// Index of the first match whose row is at or below the top visible row; 0 when all are above.
    func firstMatch(items: [TranscriptItem], owners: [String]) -> Int {
        let top = items.firstIndex { (frames[$0.id]?.maxY ?? -1) > 0 } ?? 0
        let order = Dictionary(uniqueKeysWithValues: items.enumerated().map { ($0.element.id, $0.offset) })
        return owners.firstIndex { (order[$0] ?? 0) >= top } ?? 0
    }
}
