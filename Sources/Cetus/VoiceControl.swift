import AppKit
import SwiftUI

/// `voice …` control-harness commands (see Control.swift). Never injects
/// keystrokes into other apps and never presents the HUD on screen.
///
///     voice status                         runtime/tap/helper/perm state
///     voice hudshot <state> <png>          offscreen HUD render (ready|bars|busy|failed|target|target2|dict)
///     voice asr <pcm|wav>                  Doubao push-to-talk on a 16 kHz mono s16le file
///     voice handsfree <pcm|wav>            Doubao hands-free sentences from a file
///     voice clean <text>                   Ark cleanup + corrections + spacing
///     voice ptt <seconds>                  real mic → helper → Doubao → finish pipeline (no insertion)
///     voice corpus                         the biasing corpus a dictation would send now
@MainActor
enum VoiceControl {
    /// Register with the shared control hooks (Control+Quick.swift).
    nonisolated static func install() {
        ControlHooks.handlers.append { cmd, arg, _ in await VoiceControl.run(cmd, arg) }
    }

    static func run(_ cmd: String, _ arg: String) async -> String? {
        guard cmd == "voice" else { return nil }
        let parts = arg.split(separator: " ", maxSplits: 1).map(String.init)
        let sub = parts.first ?? "", rest = parts.count > 1 ? parts[1] : ""
        switch sub {
        case "status":
            let s = VoiceSettings.load()
            let perms = await Task.detached { VoiceHelper.permissions() }.value
            return "enabled=\(s.voiceEnabled) gesture=\(s.voiceGesture) engine=\(s.voiceAsrEngine) allowed=\(VoiceRuntime.allowed) tap=\(VoiceRuntime.shared.tapActive) ax=\(VoiceAX.trusted) helper=\(VoiceHelper.path ?? "-") shim=\(VoiceHelper.shim != nil) mic=\(perms.mic) speech=\(perms.speech) doubaoKey=\(VoiceSecrets.has("doubao")) arkKey=\(VoiceSecrets.has("volc_ark")) idle=\(await VoiceDictation.shared.isIdle)"
        case "hudshot":
            let a = rest.split(separator: " ").map(String.init)
            guard a.count == 2 else { return "usage: hudshot <state> <png>" }
            let m = VoiceHUDModel()
            switch a[0] {
            case "bars": m.heights = [3, 4.2, 6, 8.5, 11, 13.6, 15.4, 16, 15.1, 13, 10.4, 8, 5.9, 4.3, 3]
            case "busy": m.busy = true
            case "failed": m.notice = "failed"
            case "target": m.notice = "targetChanged"; m.recovery = ["x"]
            case "target2": m.notice = "targetChanged"; m.recovery = ["x", "y"]
            case "dict": m.learnedTerms = ["DeepSeek"]
            default: break
            }
            guard let img = VoiceHUD.render(m, background: Color(red: 127 / 255, green: 127 / 255, blue: 127 / 255)),
                  let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else { return "render failed" }
            try? png.write(to: URL(fileURLWithPath: a[1]))
            return "ok \(rep.pixelsWide)x\(rep.pixelsHigh)"
        case "asr", "handsfree":
            guard let key = VoiceSecrets.get("doubao") else { return "no doubao key" }
            guard let pcm = loadPCM(rest) else { return "bad audio" }
            let (stream, tx) = Doubao.PCM.makeStream()
            Task.detached {
                var i = 0
                while i < pcm.count {
                    tx.yield(pcm.subdata(in: i..<min(i + 3200, pcm.count)))
                    i += 3200
                    try? await Task.sleep(nanoseconds: 100_000_000)
                }
                tx.finish()
            }
            // Hotwords only: a test run never sends the user's focused-field text.
            let corpus = VoiceCorpus(hotwords: VoiceBiasing.hotwords(VoiceSettings.load().voiceHotwords))
            let started = Date()
            if sub == "asr" {
                let partials = VoiceBox(0)
                do {
                    let text = try await Doubao.stream(key: key, resource: Doubao.defaultResourceId, corpus: corpus, pcm: stream,
                                                       onPartial: { _ in partials.value += 1 }, session: VoiceSession())
                    return "text=\(text) partials=\(partials.value) twoPass=\(Doubao.twoPassOK.value) ms=\(Int(Date().timeIntervalSince(started) * 1000))"
                } catch { return "error \(error)" }
            }
            let sentences = VoiceBox<[String]>([])
            do {
                try await Doubao.streamHandsFree(key: key, resource: Doubao.defaultResourceId, corpus: corpus, pcm: stream,
                                                 onPartial: { _ in }, onSentence: { s in sentences.value.append(s) })
                return "sentences=\(sentences.value)"
            } catch { return "error \(error) sentences=\(sentences.value)" }
        case "clean":
            guard let key = VoiceSecrets.get("volc_ark") else { return "no ark key" }
            do {
                let c = try await VoiceCleanup.cleanup(key: key, transcript: rest, context: nil, terms: [], appName: "Cetus", recent: nil)
                return "clean=\(VoiceText.normalizeZhEnSpacing(VoiceCorrections.apply(c)))"
            } catch { return "error \(error)" }
        case "selftest":
            return selftest()
        case "corpus":
            let c = await Task.detached { VoiceBiasing.buildCorpus(VoiceSettings.load()) }.value
            return "hotwords=\(c.hotwords) context=\(c.context.map { "\($0.count) chars" } ?? "nil") recent=\(c.recent != nil)"
        case "ptt":
            let secs = Double(rest) ?? 2
            let session = VoiceSession()
            do {
                try await VoiceDictation.shared.start(target: "global", session: session, headless: true)
            } catch { return "start error \(error)" }
            try? await Task.sleep(nanoseconds: UInt64(secs * 1e9))
            let text = await VoiceRuntime.shared.finishPtt(session: session, target: nil, insert: false)
            await VoiceDictation.shared.cancel()
            return "text=\(text ?? "<nil>")"
        default:
            return "unknown voice command"
        }
    }

    /// The Rust unit-test vectors (corrections.rs, titling.rs, focused_text.rs, doubao.rs).
    private static func selftest() -> String {
        var fails: [String] = []
        func eq<T: Equatable>(_ a: T, _ b: T, _ name: String) { if a != b { fails.append("\(name): \(a) != \(b)") } }
        func pairs(_ a: String, _ b: String) -> [String] { VoiceCorrections.minePairs(a, b).map { "\($0.0)→\($0.1)" } }
        eq(pairs("我去权利买东西然后回家", "我去全联买东西然后回家"), ["权利→全联"], "cjk homophone")
        eq(pairs("把图表改成蓝色的样子", "把图表改成红色的样子"), [], "single cjk swap")
        eq(pairs("please ping Deep Seek about the launch", "please ping DeepSeek about the launch"), ["Deep Seek→DeepSeek"], "ascii fix")
        eq(pairs("send it to A today", "send it to B today"), [], "one char ascii")
        eq(pairs("lets meet tomorrow at noon", "let's meet tomorrow at noon"), ["lets→let's"], "punctuation slice")
        eq(pairs("我们明天下午三点开会", "完全不同的另一句话在这里"), [], "full rewrite")
        eq(pairs("hello world", "prefix hello world suffix"), [], "untouched")
        eq(VoiceCorrections.editedSpan("我去权利买东西然后回家。", "上文在这里。我去全联买东西然后回家。下文继续"), "我去全联买东西然后回家。", "edited span")
        eq(VoiceCorrections.editedSpan("please ping Deep Seek about the launch", "ok. please ping Deep Seek directly about the launch now"),
           "please ping Deep Seek directly about the launch", "edited span rewrite")
        eq(VoiceCorrections.editedSpan("hello world", "prefix hello world suffix"), nil, "edited untouched")
        eq(VoiceCorrections.editedSpan("我们明天下午三点开会", "完全不同的另一句话在这里"), nil, "edited rewrite none")
        eq(VoiceCorrections.replaceASCIIWord("eric and generic", "eric", "Erik"), "Erik and generic", "word boundary")
        eq(VoiceCorrections.replaceASCIIWord("see deepseek.com or mail a@deepseek.io", "deepseek", "DeepSeek"), "see deepseek.com or mail a@deepseek.io", "urls")
        eq(VoiceCorrections.replaceASCIIWord("ping deepseek. thanks", "deepseek", "DeepSeek"), "ping DeepSeek. thanks", "sentence dot")
        eq(VoiceCorrections.replaceASCIIWord("用 deepseek 跑 İstanbul 的测试", "deepseek", "DeepSeek"), "用 DeepSeek 跑 İstanbul 的测试", "non-ascii haystack")
        eq(VoiceText.normalizeZhEnSpacing("这个PRD已经review了"), "这个 PRD 已经 review 了", "spacing 1")
        eq(VoiceText.normalizeZhEnSpacing("用Claude Code跑backtest"), "用 Claude Code 跑 backtest", "spacing 2")
        eq(VoiceText.normalizeZhEnSpacing("这个PRD v2已经更新到3.14版本"), "这个 PRD v2 已经更新到 3.14 版本", "spacing 3")
        eq(VoiceText.normalizeZhEnSpacing("用C++代码"), "用 C++ 代码", "spacing 4")
        eq(VoiceText.normalizeZhEnSpacing("中文之间不要空格"), "中文之间不要空格", "spacing 5")
        let parts = VoiceFocusedText.splitUTF16("ab😀中文cd", 2, 3)
        eq([parts.0, parts.1, parts.2], ["ab", "😀中", "文cd"], "utf16 split")
        let snap = VoiceFocusedText(before: "0123456789", selected: "XX", after: "abcdefghij")
        eq(snap.nearby(10), "6789XXabcd", "nearby")
        let payload = Data("你好 hello".utf8)
        eq(VoiceGzip.decompress(VoiceGzip.compress(payload)), payload, "gzip roundtrip")
        let gz = VoiceGzip.compress(Data(#"{"result":{"text":"hi","utterances":[{"text":"a","definite":true},{"text":"b"}]}}"#.utf8))
        var frame = Data([0x11, 0x93, 0x11, 0x00, 0, 0, 0, 1])
        var n = UInt32(gz.count).bigEndian
        frame.append(Data(bytes: &n, count: 4)); frame.append(gz)
        if let p = try? Doubao.parse(frame) {
            eq([p.text ?? "", p.sentences.joined(), p.interim ?? "", "\(p.last)"], ["hi", "a", "b", "true"], "parse")
        } else { fails.append("parse threw") }
        eq(VoiceBiasing.asciiTerms("Use the DeepSeek API with pnpm 12px and 2024"), ["DeepSeek", "API", "pnpm", "12px"], "ascii terms")
        return fails.isEmpty ? "selftest ok" : "FAIL " + fails.joined(separator: " | ")
    }

    /// Raw s16le 16 kHz mono, or any audio file converted with afconvert.
    private static func loadPCM(_ path: String) -> Data? {
        if path.hasSuffix(".pcm") || path.hasSuffix(".raw") { return try? Data(contentsOf: URL(fileURLWithPath: path)) }
        let out = NSTemporaryDirectory() + "voice-ctl-\(getpid()).wav"
        defer { try? FileManager.default.removeItem(atPath: out) }
        guard voiceRun("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", path, out]) == 0,
              let d = try? Data(contentsOf: URL(fileURLWithPath: out)) else { return nil }
        // Skip RIFF chunks up to "data".
        let b = [UInt8](d)
        var i = 12
        while i + 8 <= b.count {
            let id = String(decoding: b[i..<(i + 4)], as: UTF8.self)
            let size = Int(b[i + 4]) | Int(b[i + 5]) << 8 | Int(b[i + 6]) << 16 | Int(b[i + 7]) << 24
            if id == "data" { return Data(b[(i + 8)..<min(i + 8 + size, b.count)]) }
            i += 8 + size + (size & 1)
        }
        return nil
    }
}
