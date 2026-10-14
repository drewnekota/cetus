import AppKit
import SwiftUI

/// `tr <sub> [args]` — transcript performance probes for comparison runs (CETUS_CONTROL):
///
///     tr open <convId>    open a chat, force its first layout+paint; reports the
///                         time and the worst main-thread stall over the next 800ms
///     tr trace <convId>   open a chat and sample distance-from-bottom/content height every 40ms
///     tr snap <path>      PNG of the main window's content (no screen-recording permission needed)
///     tr scroll <dy>      scroll the transcript by dy points (negative = up), then let it settle
///     tr pos              offset, max offset, and the mounted row window
///     tr scrollers        every NSScrollView in the window with its elasticity
///     tr find <query>     open find with a query; tr findgo <n> makes match n active
@MainActor
enum TranscriptControl {
    nonisolated(unsafe) private static var installed = false

    static func install() {
        guard !installed, Env.process["CETUS_CONTROL"] != nil else { return }
        installed = true
        ControlHooks.handlers.append { cmd, arg, app in
            guard cmd == "tr" else { return nil }
            return await run(arg, app)
        }
    }

    private static func sleep(_ ms: Int) async { try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000) }

    private static func run(_ line: String, _ app: AppState) async -> String {
        let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
        let sub = parts.first ?? "", arg = parts.count > 1 ? parts[1] : ""
        guard let window = app.window else { return "no window" }
        let s = TranscriptScroller.shared
        switch sub {
        case "open":
            let t0 = CACurrentMediaTime()
            app.openChat(arg)
            window.contentView?.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            let first = CACurrentMediaTime() - t0
            var last = CACurrentMediaTime(), worst = 0.0
            while CACurrentMediaTime() - t0 < 0.8 {
                await sleep(2)
                let now = CACurrentMediaTime()
                worst = max(worst, now - last)
                last = now
            }
            return String(format: "first %.0fms worstStall %.0fms", first * 1000, worst * 1000)
        case "trace":
            app.openChat(arg)
            let t0 = CACurrentMediaTime()
            var out: [String] = []
            while CACurrentMediaTime() - t0 < (Double(Env.process["CETUS_TR_TRACE_MS"] ?? "") ?? 800) / 1000 {
                await sleep(40)
                out.append(String(format: "%.0f:%.0f/%.0f", (CACurrentMediaTime() - t0) * 1000, s.maxOffset - s.offset, s.maxOffset))
            }
            return out.joined(separator: " ")
        case "snap":
            guard let v = window.contentView, let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return "no view" }
            v.cacheDisplay(in: v.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: arg))
            return "ok"
        case "scroll":
            let t0 = CACurrentMediaTime()
            s.scroll(to: s.offset + (Double(arg) ?? 0))
            window.contentView?.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            let first = CACurrentMediaTime() - t0
            // What's on screen must stay put while the window mounts/unmounts rows around it:
            // follow a visible text view's real (AppKit) window position every few ms.
            guard let sv = s.scrollView, let doc = sv.documentView else { return "no scroller" }
            let visible = sv.convert(sv.contentView.bounds, from: sv.contentView)
            var probe: NSView?
            func walk(_ v: NSView) {
                for c in v.subviews where probe == nil {
                    if c is ProseTextView, !c.isHidden {
                        let r = c.convert(c.bounds, to: sv)
                        if r.intersects(visible), r.height > 10 { probe = c }
                    } else { walk(c) }
                }
            }
            walk(doc)
            guard let target = probe else {
                await sleep(400)
                return String(format: "%.0fms offset %.0f no visible text rows %@", first * 1000, s.offset, TranscriptWindowProbe.describe)
            }
            let start = target.convert(target.bounds, to: nil).minY
            var worst: CGFloat = 0, final: CGFloat = 0, gone = false
            let y0 = s.offset
            while CACurrentMediaTime() - t0 < 0.4 {
                await sleep(4)
                guard target.window != nil else { gone = true; break }
                final = abs(target.convert(target.bounds, to: nil).minY - start)
                worst = max(worst, final)
            }
            return String(format: "%.0fms offset %.0f max %.0f jump %@ final %.1f dy %.0f rows %@", first * 1000, s.offset, s.maxOffset,
                          gone ? "view-gone" : String(format: "%.1f", worst), final, s.offset - y0, TranscriptWindowProbe.describe)
        case "find":
            app.openFind()
            guard var f = app.find else { return "no find" }
            f.query = arg
            f.active = 0
            app.find = f
            await sleep(400)
            return "active \(app.find?.active ?? -1) of \(app.find?.count ?? -1) rows \(TranscriptWindowProbe.describe)"
        case "findgo":
            guard var f = app.find else { return "no find" }
            f.active = Int(arg) ?? 0
            app.find = f
            await sleep(600)
            return String(format: "active %d of %d offset %.0f max %.0f rows %@", app.find?.active ?? -1, app.find?.count ?? -1, s.offset, s.maxOffset, TranscriptWindowProbe.describe)
        case "pos":
            return String(format: "offset %.0f max %.0f bottom %.0f rows %@", s.offset, s.maxOffset, s.maxOffset - s.offset, TranscriptWindowProbe.describe)
        case "scrollers":
            var out: [String] = []
            func walk(_ v: NSView, _ depth: Int) {
                if let sv = v as? NSScrollView {
                    let doc = sv.documentView?.frame.size ?? .zero
                    out.append("\(depth) h=\(sv.horizontalScrollElasticity.rawValue) v=\(sv.verticalScrollElasticity.rawValue) hs=\(sv.hasHorizontalScroller) clip=\(Int(sv.contentView.bounds.width))x\(Int(sv.contentView.bounds.height)) doc=\(Int(doc.width))x\(Int(doc.height)) \(type(of: sv))")
                }
                for c in v.subviews { walk(c, depth + 1) }
            }
            if let v = window.contentView { walk(v, 0) }
            return out.joined(separator: " | ")
        default:
            return "unknown tr \(sub)"
        }
    }
}

/// The mounted row window of the open transcript, for `tr pos`.
@MainActor
enum TranscriptWindowProbe {
    static var describe = "-"
    static weak var frames: ChatFindRowFrames?

    /// The topmost row at least partly on screen, and its top in viewport coordinates.
    static func firstVisible() -> (id: String, y: CGFloat)? {
        guard let f = frames?.frames else { return nil }
        return f.filter { $0.value.maxY > 0 }.min { $0.value.minY < $1.value.minY }.map { ($0.key, $0.value.minY) }
    }
}
