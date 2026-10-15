import Foundation

// Port of Cetus's src-tauri/src/automation.rs (schedule math + validation),
// automation_api.rs (create / update / set-enabled / delete semantics) and
// scheduler.rs (20s tick, advance-before-fire, run-now, in-flight guard).

// MARK: - Schedule math (automation.rs)

extension Schedule {
    /// Split a minute count into the coarsest whole unit (the editor's splitInterval).
    static func interval(minutes: Int) -> Schedule {
        let m = max(1, minutes)
        if m % 1440 == 0 { return .interval(every: m / 1440, unit: "days") }
        if m % 60 == 0 { return .interval(every: m / 60, unit: "hours") }
        return .interval(every: m, unit: "minutes")
    }

    var everyMinutes: Int {
        guard case .interval(let every, let unit) = self else { return 0 }
        return every * (unit == "days" ? 1440 : unit == "hours" ? 60 : 1)
    }

    var isRecurring: Bool { if case .once = self { return false }; return true }

    /// The next fire strictly after `after` (epoch ms), or nil if there is none.
    func nextAfter(_ after: Double) -> Double? {
        switch self {
        case .once(let at): return at > after ? at : nil
        case .interval: return after + Double(max(1, everyMinutes)) * 60_000
        case .daily(let time, let weekdays): return AutomationMath.nextDaily(time, weekdays, after)
        case .cron(let expr): return AutomationMath.nextCron(expr, after)
        }
    }

    /// First fire after create/enable: one-shots keep their literal (maybe past) instant.
    func initialNextRun(_ now: Double) -> Double? {
        if case .once(let at) = self { return at }
        return nextAfter(now)
    }

    /// AutomationSchedule::validate: nil when valid, else the backend's error string.
    func validationError() -> String? {
        switch self {
        case .once(let at): if at <= 0 { return "invalid timestamp" }
        case .interval: if everyMinutes < 1 { return "interval must be at least 1 minute" }
        case .daily(let time, let weekdays):
            if AutomationMath.hhmm(time) == nil { return "invalid time '\(time)', expected HH:MM" }
            if weekdays.contains(where: { $0 < 0 || $0 > 6 }) { return "weekday out of range (expected 0-6)" }
        case .cron(let expr):
            if AutomationMath.parseCron(expr) == nil { return "invalid cron expression '\(expr)'" }
        }
        if isRecurring && nextAfter(nowMs()) == nil { return "this schedule has no upcoming run time" }
        return nil
    }
}

enum AutomationMath {
    static func hhmm(_ s: String) -> (Int, Int)? {
        let p = s.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard p.count == 2, let h = Int(p[0].trimmingCharacters(in: .whitespaces)), let m = Int(p[1].trimmingCharacters(in: .whitespaces)),
              (0 ... 23).contains(h), (0 ... 59).contains(m) else { return nil }
        return (h, m)
    }

    private static var cal: Calendar { Calendar.current }

    /// A local wall-clock instant; nil inside a spring-forward gap. Ambiguous
    /// (fall-back) times resolve to the earlier instant, like chrono's fold.
    private static func local(_ day: Date, _ h: Int, _ m: Int) -> Double? {
        var c = cal.dateComponents([.year, .month, .day], from: day)
        c.hour = h; c.minute = m; c.second = 0
        guard let d = cal.date(from: c) else { return nil }
        let back = cal.dateComponents([.hour, .minute], from: d)
        guard back.hour == h, back.minute == m else { return nil }
        // Earlier of an ambiguous pair: step back an hour and see if it reads the same.
        let earlier = d.addingTimeInterval(-3600)
        let e = cal.dateComponents([.year, .month, .day, .hour, .minute], from: earlier)
        let dc = cal.dateComponents([.year, .month, .day], from: d)
        if e.hour == h, e.minute == m, e.day == dc.day, e.month == dc.month, e.year == dc.year { return earlier.timeIntervalSince1970 * 1000 }
        return d.timeIntervalSince1970 * 1000
    }

    static func nextDaily(_ time: String, _ weekdays: [Int], _ after: Double) -> Double? {
        guard let (h, m) = hhmm(time) else { return nil }
        let start = cal.startOfDay(for: Date(timeIntervalSince1970: after / 1000))
        for offset in 0 ... 8 {
            guard let day = cal.date(byAdding: .day, value: offset, to: start) else { return nil }
            let wd = cal.component(.weekday, from: day) - 1
            if !weekdays.isEmpty && !weekdays.contains(wd) { continue }
            if let ms = local(day, h, m), ms > after { return ms }
        }
        return nil
    }

    struct Cron {
        var minutes: [Int], hours: [Int], doms: [Int], months: [Int], dows: [Int]
        var domWild: Bool, dowWild: Bool
    }

    static func parseField(_ field: String, _ lo: Int, _ hi: Int) -> [Int]? {
        var out = Set<Int>()
        for raw in field.split(separator: ",", omittingEmptySubsequences: false) {
            let tok = raw.trimmingCharacters(in: .whitespaces)
            if tok.isEmpty { return nil }
            var rangePart = tok, step = 1
            if let slash = tok.firstIndex(of: "/") {
                rangePart = String(tok[..<slash])
                guard let s = Int(tok[tok.index(after: slash)...].trimmingCharacters(in: .whitespaces)), s >= 1 else { return nil }
                step = s
            }
            let a: Int, b: Int
            if rangePart == "*" { (a, b) = (lo, hi) } else if let dash = rangePart.firstIndex(of: "-") {
                guard let x = Int(rangePart[..<dash].trimmingCharacters(in: .whitespaces)),
                      let y = Int(rangePart[rangePart.index(after: dash)...].trimmingCharacters(in: .whitespaces)) else { return nil }
                (a, b) = (x, y)
            } else {
                guard let v = Int(rangePart.trimmingCharacters(in: .whitespaces)) else { return nil }
                (a, b) = step == 1 ? (v, v) : (v, hi)
            }
            if a < lo || b > hi || a > b { return nil }
            var v = a
            while v <= b { out.insert(v); v += step }
        }
        return out.isEmpty ? nil : out.sorted()
    }

    static func parseCron(_ expr: String) -> Cron? {
        let p = expr.split(whereSeparator: \.isWhitespace).map(String.init)
        guard p.count == 5,
              let mi = parseField(p[0], 0, 59), let h = parseField(p[1], 0, 23), let dom = parseField(p[2], 1, 31),
              let mo = parseField(p[3], 1, 12), let dowRaw = parseField(p[4], 0, 7) else { return nil }
        return Cron(minutes: mi, hours: h, doms: dom, months: mo, dows: Set(dowRaw.map { $0 == 7 ? 0 : $0 }).sorted(),
                    domWild: p[2] == "*", dowWild: p[4] == "*")
    }

    static func nextCron(_ expr: String, _ after: Double) -> Double? {
        guard let f = parseCron(expr) else { return nil }
        let start = cal.startOfDay(for: Date(timeIntervalSince1970: after / 1000))
        for offset in 0 ... 3000 {
            guard let day = cal.date(byAdding: .day, value: offset, to: start) else { return nil }
            let c = cal.dateComponents([.month, .day, .weekday], from: day)
            guard f.months.contains(c.month!) else { continue }
            let domM = f.doms.contains(c.day!), dowM = f.dows.contains(c.weekday! - 1)
            let ok = f.domWild && f.dowWild ? true : f.dowWild ? domM : f.domWild ? dowM : (domM || dowM)
            guard ok else { continue }
            for h in f.hours {
                for m in f.minutes {
                    if let ms = local(day, h, m), ms > after { return ms }
                }
            }
        }
        return nil
    }
}

// MARK: - Display (lib/automation.ts)

enum AutomationText {
    private static let weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    static func describe(_ s: Schedule) -> String {
        switch s {
        case .once(let at): return "Once on \(dateTime(at))"
        case .interval:
            let m = max(1, s.everyMinutes)
            if m % 1440 == 0 { let d = m / 1440; return d == 1 ? "Every day" : "Every \(d) days" }
            if m % 60 == 0 { let h = m / 60; return h == 1 ? "Every hour" : "Every \(h) hours" }
            return m == 1 ? "Every minute" : "Every \(m) minutes"
        case .daily(let time, let weekdays):
            let set = Set(weekdays).sorted()
            let days: String?
            if set.isEmpty || set.count == 7 { days = nil } else if set.count == 5 && set.allSatisfy({ (1 ... 5).contains($0) }) { days = "Weekdays" } else if set == [0, 6] { days = "Weekends" } else { days = set.map { (0 ... 6).contains($0) ? weekdayNames[$0] : "\($0)" }.joined(separator: ", ") }
            return days.map { "\($0) at \(time)" } ?? "Every day at \(time)"
        case .cron(let expr): return "Cron · \(expr)"
        }
    }

    /// toLocaleDateString({month: short, day: numeric}) + " HH:mm".
    private static func dateTime(_ ms: Double) -> String {
        let d = Date(timeIntervalSince1970: ms / 1000)
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.dateFormat = "MMM d"
        let t = DateFormatter()
        t.dateFormat = "HH:mm"
        return "\(f.string(from: d)) \(t.string(from: d))"
    }

    /// formatNextRun: "Today 14:30", "Tomorrow 09:00", "Jun 3, 09:00", "—".
    static func nextRun(_ ms: Double?) -> String {
        guard let ms else { return "—" }
        let d = Date(timeIntervalSince1970: ms / 1000)
        let t = DateFormatter()
        t.dateFormat = "HH:mm"
        let time = t.string(from: d)
        let cal = Calendar.current
        if cal.isDateInToday(d) { return "Today \(time)" }
        if cal.isDateInTomorrow(d) { return "Tomorrow \(time)" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.dateFormat = "MMM d"
        return "\(f.string(from: d)), \(time)"
    }

    /// formatLastRun: "Just now", "5m ago", "2h ago", else "Jun 3".
    static func lastRun(_ ms: Double?) -> String {
        guard let ms else { return "Never run" }
        let min = Int(((nowMs() - ms) / 60_000).rounded())
        if min < 1 { return "Just now" }
        if min < 60 { return "\(min)m ago" }
        let hr = Int((Double(min) / 60).rounded())
        if hr < 24 { return "\(hr)h ago" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.dateFormat = "MMM d"
        return f.string(from: Date(timeIntervalSince1970: ms / 1000))
    }
}

// MARK: - CRUD + scheduler (automation_api.rs, scheduler.rs)

/// What the editor submits (AutomationInput). next_run / run-state are derived here.
struct AutomationFailure: Error { let message: String; init(_ m: String) { message = m } }

struct AutomationInput {
    var name: String
    var prompt: String
    var workspaceDir: String
    var backend: String
    var model: String
    var effort: String
    var schedule: Schedule
    var enabled: Bool
}

enum AutomationScheduler {
    /// TICK: minute-granularity schedules tolerate a sub-minute slip.
    static let tick: TimeInterval = 20
    nonisolated(unsafe) private static var timer: Timer?
    /// Ids with a fire in flight (manual run-now vs a tick can't double-fire).
    nonisolated(unsafe) private static var inflight = Set<String>()

    private static func workspace(_ dir: String) -> String {
        dir.trimmingCharacters(in: .whitespaces).isEmpty ? Env.defaultWorkspace : dir
    }

    static func create(_ c: Controller, _ input: AutomationInput) -> Result<Automation, AutomationFailure> {
        if let e = input.schedule.validationError() { return .failure(AutomationFailure(e)) }
        let now = nowMs()
        let a = Automation(id: UUID().uuidString.lowercased(), name: input.name.trimmingCharacters(in: .whitespacesAndNewlines), prompt: input.prompt,
                           backend: input.backend, model: input.model, effort: input.effort, workspaceDir: workspace(input.workspaceDir),
                           schedule: input.schedule, enabled: input.enabled, lastRunAt: nil, lastConversationId: nil, lastError: nil,
                           createdAt: now, updatedAt: now, runCount: 0, lastStatus: nil,
                           nextRunAt: input.enabled ? input.schedule.initialNextRun(now) : nil)
        c.store.saveAutomation(a)
        c.reload()
        return .success(a)
    }

    static func update(_ c: Controller, id: String, _ input: AutomationInput) -> Result<Automation, AutomationFailure> {
        if let e = input.schedule.validationError() { return .failure(AutomationFailure(e)) }
        guard var a = c.store.automations().first(where: { $0.id == id }) else { return .failure(AutomationFailure("automation not found")) }
        let now = nowMs()
        a.name = input.name.trimmingCharacters(in: .whitespacesAndNewlines)
        a.prompt = input.prompt
        a.workspaceDir = workspace(input.workspaceDir)
        a.backend = input.backend
        a.model = input.model
        a.effort = input.effort
        a.schedule = input.schedule
        a.enabled = input.enabled
        a.nextRunAt = input.enabled ? input.schedule.initialNextRun(now) : nil
        c.store.saveAutomation(a)
        c.reload()
        return .success(a)
    }

    static func setEnabled(_ c: Controller, id: String, _ enabled: Bool) {
        guard var a = c.store.automations().first(where: { $0.id == id }) else { return }
        let now = nowMs()
        a.enabled = enabled
        // Keep a still-future slot; otherwise compute a fresh one from now.
        a.nextRunAt = enabled ? (a.nextRunAt.flatMap { $0 > now ? $0 : nil } ?? a.schedule.initialNextRun(now)) : nil
        c.store.saveAutomation(a)
        c.reload()
    }

    static func delete(_ c: Controller, id: String) {
        c.store.deleteAutomation(id)
        c.reload()
    }

    /// Entry point: self-heal missing next-run slots once, then tick forever.
    static func start(_ c: Controller) {
        DispatchQueue.main.async { DialogControl.install() }
        let now = nowMs()
        for var a in c.store.automations() where a.enabled && a.nextRunAt == nil {
            a.nextRunAt = a.schedule.initialNextRun(now)
            c.store.saveAutomation(a)
        }
        c.reload()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: tick, repeats: true) { [weak c] _ in
            if let c { fireDue(c) }
        }
    }

    static func fireDue(_ c: Controller) {
        let now = nowMs()
        let due = c.store.automations().filter { $0.enabled && ($0.nextRunAt.map { $0 <= now } ?? false) }.sorted { ($0.nextRunAt ?? 0) < ($1.nextRunAt ?? 0) }
        for a in due where !inflight.contains(a.id) { _ = run(c, a, manual: false) }
    }

    /// Run-now: fires immediately without shifting the schedule; returns the minted conversation.
    static func runNow(_ c: Controller, id: String) -> Result<String, AutomationFailure> {
        guard let a = c.store.automations().first(where: { $0.id == id }) else { return .failure(AutomationFailure("automation not found")) }
        if inflight.contains(id) { return .failure(AutomationFailure("this automation is already running")) }
        return run(c, a, manual: true)
    }

    private static func run(_ c: Controller, _ auto: Automation, manual: Bool) -> Result<String, AutomationFailure> {
        inflight.insert(auto.id)
        defer { inflight.remove(auto.id) }
        // At-most-once: advance the schedule BEFORE firing (a one-shot is spent → disabled).
        if !manual, var a = c.store.automations().first(where: { $0.id == auto.id }) {
            let now = nowMs()
            if a.schedule.isRecurring { a.nextRunAt = a.schedule.nextAfter(now); a.enabled = true } else { a.nextRunAt = nil; a.enabled = false }
            c.store.saveAutomation(a)
        }
        let dir = workspace(auto.workspaceDir)
        let isRemote = dir.hasPrefix("ssh://") || dir.range(of: #"^[^/:\s]+@?[^/:\s]+:"#, options: .regularExpression) != nil
        var failure: String?
        if !isRemote {
            do { try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true) } catch { failure = error.localizedDescription }
        }
        let title = { () -> String in
            let n = auto.name.trimmingCharacters(in: .whitespacesAndNewlines)
            return n.isEmpty ? "Automation" : String(n.prefix(80))
        }()
        var convId: String?
        if failure == nil {
            let id = c.send(SendOptions(conversationId: nil, text: auto.prompt, backend: auto.backend, model: auto.model, effort: auto.effort,
                                        workspaceDir: dir, title: title, sourceAutomationId: auto.id))
            if id.isEmpty { failure = "failed to start the run" } else { convId = id }
        }
        // record_automation_outcome: last-run metadata + run_count; schedule untouched.
        if var a = c.store.automations().first(where: { $0.id == auto.id }) {
            a.lastRunAt = nowMs()
            a.lastConversationId = convId
            a.lastStatus = failure == nil ? "ok" : "error"
            a.lastError = failure
            a.runCount += 1
            c.store.saveAutomation(a)
        }
        c.reload()
        if let convId { return .success(convId) }
        return .failure(AutomationFailure(failure ?? "failed"))
    }
}
