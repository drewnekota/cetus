import Foundation

struct Option: Identifiable, Hashable { let id: String; let label: String }

struct Runtime: Identifiable, Hashable {
    let id: String
    let label: String
    let color: UInt32
    let models: [Option]
    let efforts: [Option]
}

struct SlashCommand: Equatable, Hashable {
    var name: String
    var description: String
    var argumentHint: String
    var kind: String
}

/// Same ids and catalog as Cetus's backend picker (CLI_MODELS / CLI_EFFORTS).
enum Runtimes {
    static let all: [Runtime] = [
        // Built-in pi runtime on DeepSeek; brands in the app's primary (--runtime-pi).
        Runtime(id: "pi", label: "Cetus", color: 0x827BE6,
                models: [.init(id: "flash", label: "Flash")],
                efforts: [.init(id: "off", label: "Off"), .init(id: "high", label: "High"), .init(id: "max", label: "Max")]),
        Runtime(id: "claude-code", label: "Claude Code", color: 0xD97757,
                models: [.init(id: "fable", label: "Fable"), .init(id: "opus", label: "Opus"), .init(id: "sonnet", label: "Sonnet"), .init(id: "haiku", label: "Haiku")],
                efforts: [.init(id: "low", label: "Low"), .init(id: "medium", label: "Medium"), .init(id: "high", label: "High"), .init(id: "xhigh", label: "XHigh"), .init(id: "max", label: "Max")]),
        Runtime(id: "codex", label: "Codex", color: 0x10A37F,
                models: [.init(id: "gpt-5.5", label: "GPT-5.5"), .init(id: "gpt-5.4", label: "GPT-5.4"), .init(id: "gpt-5.4-mini", label: "GPT-5.4-Mini"), .init(id: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark")],
                efforts: [.init(id: "low", label: "Low"), .init(id: "medium", label: "Medium"), .init(id: "high", label: "High"), .init(id: "xhigh", label: "XHigh")]),
        Runtime(id: "opencode", label: "OpenCode", color: 0x7F7F7F, models: [], efforts: []),
        Runtime(id: "grok", label: "Grok Build", color: 0x71717A,
                models: [.init(id: "grok-4.5", label: "Grok 4.5")],
                efforts: [.init(id: "low", label: "Low"), .init(id: "medium", label: "Medium"), .init(id: "high", label: "High")]),
        Runtime(id: "kimi", label: "Kimi CLI", color: 0x1783FF, models: [], efforts: []),
        // dsh brands in ink: its color tracks the foreground (see Theme.runtimeColor).
        Runtime(id: "dsh", label: "DeepSeek Harness", color: 0x1B1B1B,
                models: [.init(id: "deepseek-flash", label: "DeepSeek V4.1 Flash")],
                efforts: [.init(id: "off", label: "Off"), .init(id: "low", label: "Low"), .init(id: "high", label: "High"), .init(id: "max", label: "Max")]),
    ]

    /// Runtimes with a model · effort menu (backendSupportsTuning).
    static func tunable(_ id: String) -> Bool { ["claude-code", "codex", "grok", "dsh"].contains(id) }

    /// Runtimes whose composer shows a model · reasoning menu (pi's ModelPicker or CliTuningMenu).
    static func hasModelMenu(_ id: String) -> Bool { id == "pi" || tunable(id) }

    /// pi's full reasoning axis, for clamping a stored level to the ones a model exposes.
    static let piReasoningAxis = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

    static func byId(_ id: String) -> Runtime { all.first { $0.id == id } ?? all.first { $0.id == "claude-code" }! }

    /// Ctrl+1…9 order: the saved order first, then any runtime it misses; disabled ones drop out.
    static func ordered(_ prefs: Prefs) -> [Runtime] {
        let order = prefs.runtimeOrder + all.map(\.id).filter { !prefs.runtimeOrder.contains($0) }
        return order.compactMap { id in all.first { $0.id == id } }.filter { !prefs.disabledRuntimes.contains($0.id) }
    }

    /// Fallback slash catalogs before a session reports its own.
    static let fallbackCommands: [String: [SlashCommand]] = [
        "claude-code": [
            .init(name: "usage", description: "Show plan usage limits", argumentHint: "", kind: "command"),
            .init(name: "cost", description: "Show the total cost and duration of the session", argumentHint: "", kind: "command"),
            .init(name: "context", description: "Visualize current context usage", argumentHint: "", kind: "command"),
            .init(name: "compact", description: "Clear history but keep a summary in context", argumentHint: "[instructions]", kind: "command"),
        ],
        "codex": [
            .init(name: "status", description: "Show session configuration and token usage", argumentHint: "", kind: "command"),
            .init(name: "model", description: "Choose the model and reasoning effort", argumentHint: "", kind: "command"),
            .init(name: "compact", description: "Summarize the conversation to free context", argumentHint: "", kind: "command"),
        ],
    ]
}

extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
