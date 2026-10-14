import SwiftUI

/// Line diff for edit-style tool calls: LCS over lines, grouped into hunks
/// with three lines of context, like a unified patch.
struct DiffLine: Equatable {
    enum Kind { case context, added, removed, hunk }
    let kind: Kind
    let text: String
    let oldNo: Int?
    let newNo: Int?
}

struct LineDiff {
    let lines: [DiffLine]
    let added: Int
    let removed: Int

    static func compute(_ before: String, _ after: String, context: Int = 3) -> LineDiff {
        let a = before.isEmpty ? [] : before.components(separatedBy: "\n")
        let b = after.isEmpty ? [] : after.components(separatedBy: "\n")
        // Trim common prefix/suffix to keep the LCS table small.
        var start = 0
        while start < a.count && start < b.count && a[start] == b[start] { start += 1 }
        var endA = a.count, endB = b.count
        while endA > start && endB > start && a[endA - 1] == b[endB - 1] { endA -= 1; endB -= 1 }
        let ma = Array(a[start ..< endA]), mb = Array(b[start ..< endB])
        var ops: [(DiffLine.Kind, Int, Int)] = [] // kind, index in a, index in b
        for i in 0 ..< start { ops.append((.context, i, i)) }
        if ma.count * mb.count > 4_000_000 {
            for (i, _) in ma.enumerated() { ops.append((.removed, start + i, -1)) }
            for (j, _) in mb.enumerated() { ops.append((.added, -1, start + j)) }
        } else {
            let n = ma.count, m = mb.count
            var dp = Array(repeating: Array(repeating: 0, count: m + 1), count: n + 1)
            if n > 0 && m > 0 {
                for i in stride(from: n - 1, through: 0, by: -1) {
                    for j in stride(from: m - 1, through: 0, by: -1) {
                        dp[i][j] = ma[i] == mb[j] ? dp[i + 1][j + 1] + 1 : max(dp[i + 1][j], dp[i][j + 1])
                    }
                }
            }
            var i = 0, j = 0
            while i < n || j < m {
                if i < n && j < m && ma[i] == mb[j] { ops.append((.context, start + i, start + j)); i += 1; j += 1 }
                else if j < m && (i == n || dp[i][j + 1] >= dp[i + 1][j]) { ops.append((.added, -1, start + j)); j += 1 }
                else { ops.append((.removed, start + i, -1)); i += 1 }
            }
        }
        let tail = a.count - endA
        for k in 0 ..< tail { ops.append((.context, endA + k, endB + k)) }

        var keep = Array(repeating: false, count: ops.count)
        for (idx, op) in ops.enumerated() where op.0 != .context {
            for k in max(0, idx - context) ... min(ops.count - 1, idx + context) { keep[k] = true }
        }
        var lines: [DiffLine] = []
        var added = 0, removed = 0
        var lastKept = -2
        for (idx, op) in ops.enumerated() where keep[idx] {
            if idx != lastKept + 1 {
                let o = op.1 >= 0 ? op.1 + 1 : (op.2 + 1)
                lines.append(DiffLine(kind: .hunk, text: "@@ line \(o) @@", oldNo: nil, newNo: nil))
            }
            lastKept = idx
            switch op.0 {
            case .context: lines.append(DiffLine(kind: .context, text: a[op.1], oldNo: op.1 + 1, newNo: op.2 + 1))
            case .removed: removed += 1; lines.append(DiffLine(kind: .removed, text: a[op.1], oldNo: op.1 + 1, newNo: nil))
            case .added: added += 1; lines.append(DiffLine(kind: .added, text: b[op.2], oldNo: nil, newNo: op.2 + 1))
            case .hunk: break
            }
        }
        return LineDiff(lines: lines, added: added, removed: removed)
    }
}

struct DiffView: View {
    let diff: LineDiff
    var maxLines = 400

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(diff.lines.prefix(maxLines).enumerated()), id: \.offset) { _, line in
                    HStack(spacing: 0) {
                        Text(line.oldNo.map(String.init) ?? "").frame(width: 36, alignment: .trailing).foregroundStyle(Theme.mutedForeground.opacity(0.7))
                        Text(line.newNo.map(String.init) ?? "").frame(width: 36, alignment: .trailing).foregroundStyle(Theme.mutedForeground.opacity(0.7))
                        Text(marker(line.kind)).frame(width: 18).foregroundStyle(color(line.kind))
                        Text(line.text.isEmpty ? " " : line.text)
                            .foregroundStyle(line.kind == .hunk ? Theme.mutedForeground : Theme.foreground)
                            .fixedSize()
                            .padding(.trailing, 12)
                    }
                    .font(.system(size: 12, design: .monospaced))
                    .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 1)
                    .background(background(line.kind))
                }
                if diff.lines.count > maxLines {
                    Text("… \(diff.lines.count - maxLines) more lines").cetusFont(11).foregroundStyle(Theme.mutedForeground).padding(8)
                }
            }
            .padding(.vertical, 6)
            .textSelection(.enabled)
        }
        // A trackpad swipe must not wiggle a diff whose lines fit (AppKit allows horizontal rubber-banding by default).
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
    }

    private func marker(_ k: DiffLine.Kind) -> String { k == .added ? "+" : k == .removed ? "−" : "" }
    private func color(_ k: DiffLine.Kind) -> Color { k == .added ? Theme.added : k == .removed ? Theme.removed : Theme.mutedForeground }
    private func background(_ k: DiffLine.Kind) -> Color {
        switch k {
        case .added: Theme.added.opacity(0.12)
        case .removed: Theme.removed.opacity(0.12)
        case .hunk: Theme.muted.opacity(0.4)
        case .context: .clear
        }
    }
}
