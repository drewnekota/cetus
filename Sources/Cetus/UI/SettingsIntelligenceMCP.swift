import AppKit
import SwiftUI

// MARK: - MCP (connectors.tsx) — app_settings.mcp_connectors + discovery.mcpImports

struct IntelConnector: Identifiable, Equatable {
    var id: String
    var name: String
    var transport: String
    var command: String
    var args: [String]
    var env: [String: String]
    var url: String
    var headers: [String: String]
    var auth: String
    var oauthClientId: String
    var oauthScope: String
    var enabled: Bool
    var createdAt: Int64
    var updatedAt: Int64

    init(_ d: [String: Any]) {
        id = d["id"] as? String ?? ""
        name = d["name"] as? String ?? ""
        transport = d["transport"] as? String ?? "stdio"
        command = d["command"] as? String ?? ""
        args = d["args"] as? [String] ?? []
        env = d["env"] as? [String: String] ?? [:]
        url = d["url"] as? String ?? ""
        headers = d["headers"] as? [String: String] ?? [:]
        auth = d["auth"] as? String ?? ""
        oauthClientId = d["oauthClientId"] as? String ?? ""
        oauthScope = d["oauthScope"] as? String ?? ""
        enabled = d["enabled"] as? Bool ?? true
        createdAt = (d["createdAt"] as? NSNumber)?.int64Value ?? 0
        updatedAt = (d["updatedAt"] as? NSNumber)?.int64Value ?? 0
    }

    var json: [String: Any] {
        ["id": id, "name": name, "transport": transport, "command": command, "args": args, "env": env, "url": url, "headers": headers,
         "auth": auth, "oauthClientId": oauthClientId, "oauthScope": oauthScope, "enabled": enabled, "createdAt": createdAt, "updatedAt": updatedAt]
    }
}

struct IntelMcpTool: Hashable { let name: String; let description: String? }

struct IntelMcpResult {
    var ok = false
    var serverName: String?
    var serverVersion: String?
    var protocolVersion: String?
    var tools: [IntelMcpTool] = []
    var error: String?
    static func fail(_ e: String) -> IntelMcpResult { IntelMcpResult(ok: false, error: e) }
}

enum IntelMcp {
    static let protocolVersion = "2025-06-18"
    static let sources: [(id: String, label: String, icon: String?)] = [
        ("claude-code", "Claude Code", "claude-code"), ("claude-desktop", "Claude Desktop", nil), ("cursor", "Cursor", nil),
        ("vscode", "VS Code", nil), ("windsurf", "Windsurf", nil), ("codex", "Codex", "codex"), ("opencode", "opencode", "opencode"),
    ]

    static func load() -> [IntelConnector] {
        ((IntelData.settingJSON("mcp_connectors") ?? [:])["entries"] as? [[String: Any]] ?? []).map(IntelConnector.init)
    }

    static func save(_ list: [IntelConnector]) {
        let version = (IntelData.settingJSON("mcp_connectors") ?? [:])["version"] ?? 0
        IntelData.setSettingJSON("mcp_connectors", ["version": version, "entries": list.map(\.json)])
    }

    /// mcp::validate.
    static func validate(_ c: inout IntelConnector) -> String? {
        c.name = c.name.trimmingCharacters(in: .whitespaces)
        if c.name.isEmpty { return "give the MCP server a name" }
        c.transport = c.transport == "http" ? "http" : "stdio"
        if c.transport == "stdio" {
            c.command = c.command.trimmingCharacters(in: .whitespaces)
            if c.command.isEmpty { return "a stdio MCP server needs a command (e.g. npx)" }
        } else {
            c.url = c.url.trimmingCharacters(in: .whitespaces)
            if !(c.url.hasPrefix("http://") || c.url.hasPrefix("https://")) { return "an HTTP MCP server needs an http(s):// URL" }
            c.auth = c.auth.trimmingCharacters(in: .whitespaces) == "oauth" ? "oauth" : ""
        }
        return nil
    }

    // mcporter (vendored in the pi install), for OAuth servers and import previews.

    static var mcporterCLI: String? {
        for base in [IntelData.appData.path, "\(Env.home)/Library/Application Support/dev.cetus.app"] {
            let p = "\(base)/pi-install/node_modules/mcporter/dist/cli.js"
            if FileManager.default.fileExists(atPath: p) { return p }
        }
        return nil
    }

    static func mcporter(_ args: [String]) -> String? {
        guard let cli = mcporterCLI else { return nil }
        return System.run(["node", cli] + args)
    }

    static func previewImport(_ source: String) -> [(name: String, detail: String)] {
        guard let out = mcporter(["config", "import", source, "--json"]),
              let doc = (try? JSONSerialization.jsonObject(with: Data(out.trimmingCharacters(in: .whitespacesAndNewlines).utf8))) as? [String: Any],
              let entries = doc["entries"] as? [[String: Any]] else { return [] }
        return entries.compactMap { e in
            guard let name = e["name"] as? String else { return nil }
            let entry = e["entry"] as? [String: Any]
            let detail = (entry?["baseUrl"] as? String) ?? (entry?["url"] as? String) ?? (entry?["command"] as? String) ?? ""
            return (name, detail)
        }
    }

    private static func oauthDoc(_ c: IntelConnector) -> URL {
        var spec: [String: Any] = ["url": c.url, "auth": "oauth"]
        if !c.headers.isEmpty { spec["headers"] = c.headers }
        if !c.oauthClientId.trimmingCharacters(in: .whitespaces).isEmpty { spec["oauthClientId"] = c.oauthClientId.trimmingCharacters(in: .whitespaces) }
        if !c.oauthScope.trimmingCharacters(in: .whitespaces).isEmpty { spec["oauthScope"] = c.oauthScope.trimmingCharacters(in: .whitespaces) }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("cetus-swift-mcp-\(UUID().uuidString).json")
        IntelData.writeJSON(tmp, ["mcpServers": [c.name: spec], "imports": [String]()])
        return tmp
    }

    static func authorize(_ c: IntelConnector) -> String {
        guard mcporterCLI != nil else { return "mcporter CLI not found in the pi install" }
        let tmp = oauthDoc(c)
        defer { try? FileManager.default.removeItem(at: tmp) }
        return mcporter(["auth", c.name, "--config", tmp.path]) != nil ? "Authorized — tokens cached." : "Authorization failed."
    }

    /// mcp::test_connector — a real handshake (initialize + tools/list).
    static func test(_ input: IntelConnector) async -> IntelMcpResult {
        var c = input
        if let e = validate(&c) { return .fail(e) }
        if c.transport == "http" && c.auth == "oauth" {
            return await Task.detached { () -> IntelMcpResult in
                guard mcporterCLI != nil else { return .fail("mcporter CLI not found in the pi install") }
                let tmp = oauthDoc(c)
                defer { try? FileManager.default.removeItem(at: tmp) }
                guard let out = mcporter(["list", c.name, "--config", tmp.path, "--json"]) else { return .fail("authorization required — click Authorize") }
                let doc = out.components(separatedBy: .newlines).reversed().lazy.compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }.first
                    ?? (try? JSONSerialization.jsonObject(with: Data(out.utf8))) as? [String: Any]
                guard let doc else { return .fail("couldn't parse mcporter output") }
                let server = (doc["servers"] as? [[String: Any]])?.first
                return IntelMcpResult(ok: true, serverName: server?["name"] as? String, tools: tools(server?["tools"]))
            }.value
        }
        return await withTaskGroup(of: IntelMcpResult.self) { g in
            g.addTask { c.transport == "http" ? await testHTTP(c.url, c.headers) : await Task.detached { testStdio(c.command, c.args, c.env) }.value }
            g.addTask { try? await Task.sleep(nanoseconds: 20_000_000_000); return .fail("timed out after 20s") }
            let r = await g.next()!
            g.cancelAll()
            return r
        }
    }

    static func tools(_ v: Any?) -> [IntelMcpTool] {
        (v as? [[String: Any]] ?? []).compactMap { t in
            guard let n = t["name"] as? String else { return nil }
            let d = (t["description"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return IntelMcpTool(name: n, description: (d?.isEmpty ?? true) ? nil : d)
        }
    }

    private static func initParams() -> [String: Any] {
        ["jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": ["protocolVersion": protocolVersion, "capabilities": [String: Any](), "clientInfo": ["name": "cetus", "version": "0.1.0"]]]
    }

    private static func result(from initResp: [String: Any], tools t: [String: Any]?) -> IntelMcpResult {
        if let err = initResp["error"] as? [String: Any] { return .fail(err["message"] as? String ?? "initialize failed") }
        let r = initResp["result"] as? [String: Any] ?? [:]
        let info = r["serverInfo"] as? [String: Any]
        return IntelMcpResult(ok: true, serverName: info?["name"] as? String, serverVersion: info?["version"] as? String,
                              protocolVersion: r["protocolVersion"] as? String, tools: tools((t?["result"] as? [String: Any])?["tools"]))
    }

    private static func parseJSONOrSSE(_ body: String) -> [String: Any]? {
        if let v = (try? JSONSerialization.jsonObject(with: Data(body.trimmingCharacters(in: .whitespacesAndNewlines).utf8))) as? [String: Any] { return v }
        for line in body.components(separatedBy: .newlines) {
            let l = line.trimmingCharacters(in: .whitespaces)
            if l.hasPrefix("data:"), let v = (try? JSONSerialization.jsonObject(with: Data(l.dropFirst(5).trimmingCharacters(in: .whitespaces).utf8))) as? [String: Any] { return v }
        }
        return nil
    }

    static func testHTTP(_ url: String, _ headers: [String: String]) async -> IntelMcpResult {
        guard let u = URL(string: url) else { return .fail("invalid URL") }
        func post(_ body: [String: Any], _ session: String?) async throws -> (String, HTTPURLResponse) {
            var req = URLRequest(url: u, timeoutInterval: 20)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
            for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
            if let session { req.setValue(session, forHTTPHeaderField: "mcp-session-id") }
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, resp) = try await URLSession.shared.data(for: req)
            return (String(decoding: data, as: UTF8.self), resp as! HTTPURLResponse)
        }
        do {
            let (body, resp) = try await post(initParams(), nil)
            guard (200 ..< 300).contains(resp.statusCode) else {
                return .fail("HTTP \(resp.statusCode)\(body.isEmpty ? "" : ": " + String(body.prefix(200)))")
            }
            guard let initResp = parseJSONOrSSE(body) else { return .fail("couldn't parse the initialize response") }
            let session = resp.value(forHTTPHeaderField: "mcp-session-id")
            _ = try? await post(["jsonrpc": "2.0", "method": "notifications/initialized"], session)
            let toolsResp = try? await post(["jsonrpc": "2.0", "id": 2, "method": "tools/list"], session)
            return result(from: initResp, tools: toolsResp.flatMap { parseJSONOrSSE($0.0) })
        } catch {
            return .fail(error.localizedDescription)
        }
    }

    static func testStdio(_ command: String, _ args: [String], _ env: [String: String]) -> IntelMcpResult {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = [command] + args
        p.environment = Env.shell.merging(env) { $1 }
        let inPipe = Pipe(), outPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return .fail("couldn't launch `\(command)`: \(error.localizedDescription)") }
        defer { if p.isRunning { p.terminate() } }
        var buffer = Data()
        func send(_ obj: [String: Any]) {
            guard var d = try? JSONSerialization.data(withJSONObject: obj) else { return }
            d.append(0x0A)
            try? inPipe.fileHandleForWriting.write(contentsOf: d)
        }
        func read(id: Int) -> [String: Any]? {
            let deadline = Date().addingTimeInterval(20)
            while Date() < deadline {
                while let nl = buffer.firstIndex(of: 0x0A) {
                    let line = buffer[buffer.startIndex ..< nl]
                    buffer.removeSubrange(buffer.startIndex ... nl)
                    if let v = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any], (v["id"] as? Int) == id { return v }
                }
                let chunk = outPipe.fileHandleForReading.availableData
                if chunk.isEmpty { return nil }
                buffer.append(chunk)
            }
            return nil
        }
        send(initParams())
        guard let initResp = read(id: 1) else { return .fail("server exited before answering initialize") }
        send(["jsonrpc": "2.0", "method": "notifications/initialized"])
        send(["jsonrpc": "2.0", "id": 2, "method": "tools/list"])
        return result(from: initResp, tools: read(id: 2))
    }
}

struct IntelMcpSection: View {
    @State private var list: [IntelConnector]?
    @State private var editing: String? // id | "new"
    @State private var error: String?

    var body: some View {
        let connectors = list ?? []
        VStack(alignment: .leading, spacing: 0) {
            IntelHeading(title: "MCP", description: "Connect the agent to external tools through MCP (Model Context Protocol) servers — a local command or a remote URL. Add a server and Test it to run a real handshake and see the tools it offers. Every enabled MCP server's tools are loaded into the agent so it can call them like its built-ins; changes take effect in new conversations.")
            HStack(spacing: 16) {
                IntelCaption(text: list == nil ? "Loading…" : connectors.isEmpty ? "No MCP servers yet" : intelCount(connectors.count, "MCP server", "MCP servers"))
                Spacer(minLength: 0)
                if editing != "new" {
                    Button { editing = "new" } label: { IntelLabel(icon: "plus", text: "Add MCP server") }.buttonStyle(IntelButtonStyle()).testID("mcp-add")
                }
            }
            .padding(.top, 24)

            if editing == "new" {
                IntelConnectorEditor(initial: nil, embedded: false, onCancel: { editing = nil }, onSaved: { editing = nil; reload() }, onError: { error = $0 })
                    .padding(.top, 12)
            }
            if !connectors.isEmpty {
                IntelList {
                    ForEach(connectors) { c in
                        if editing == c.id {
                            IntelConnectorEditor(initial: c, embedded: true, onCancel: { editing = nil }, onSaved: { editing = nil; reload() }, onError: { error = $0 })
                        } else {
                            IntelConnectorRow(connector: c, onToggle: toggle, onEdit: { editing = c.id }, onRemove: remove)
                        }
                    }
                }
                .padding(.top, 12)
            }
            IntelMcpImports(onError: { error = $0 }).padding(.top, 24)
            IntelError(text: error)
        }
        .onAppear(perform: reload)
    }

    private func reload() { list = IntelMcp.load() }

    private func toggle(_ id: String, _ on: Bool) {
        var l = IntelMcp.load()
        if let i = l.firstIndex(where: { $0.id == id }) { l[i].enabled = on; l[i].updatedAt = IntelData.nowMs() }
        IntelMcp.save(l)
        reload()
    }

    private func remove(_ id: String) {
        IntelMcp.save(IntelMcp.load().filter { $0.id != id })
        reload()
    }
}

private struct IntelConnectorRow: View {
    let connector: IntelConnector
    let onToggle: (String, Bool) -> Void
    let onEdit: () -> Void
    let onRemove: (String) -> Void
    @State private var confirming = false
    @State private var expanded = false

    var body: some View {
        let summary = connector.transport == "http" ? connector.url : ([connector.command] + connector.args).joined(separator: " ")
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        IntelLine(text: connector.name, weight: .medium)
                        IntelTag(text: connector.transport == "http" ? "HTTP" : "stdio")
                    }
                    IntelLine(text: summary.trimmingCharacters(in: .whitespaces).isEmpty ? "—" : summary, size: 12, lh: 16.2, mono: true, color: Theme.mutedForeground)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 2) {
                    IntelIconButton(icon: "chevron-down", glyph: 16, rotate: expanded ? 180 : 0, testID: "mcp-expand-\(connector.name)") { expanded.toggle() }
                    IntelSwitch(isOn: connector.enabled, testID: "mcp-toggle-\(connector.name)") { onToggle(connector.id, $0) }
                    IntelIconButton(icon: "pencil", testID: "mcp-edit-\(connector.name)", action: onEdit)
                    if confirming {
                        Button { onRemove(connector.id) } label: { Text("Remove") }.buttonStyle(IntelButtonStyle(variant: .destructive))
                        Button { confirming = false } label: { Text("Cancel") }.buttonStyle(IntelButtonStyle(variant: .ghost, muted: true))
                    } else {
                        IntelIconButton(icon: "trash-2", destructiveHover: true) { confirming = true }
                    }
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .compositingGroup()
            .opacity(connector.enabled ? 1 : 0.5)
            if expanded {
                IntelConnectorDetails(connector: connector)
                    .compositingGroup()
                    .opacity(connector.enabled ? 1 : 0.5)
            }
        }
        .background(Theme.card)
    }
}

/// Inline "name — description" tool line (mono name, muted description).
private func intelToolLine(_ t: IntelMcpTool) -> Text {
    let name = Text(t.name).font(.system(size: 12, design: .monospaced)).foregroundColor(Theme.foreground)
    guard let d = t.description else { return name }
    return name + Text(" — \(d)").font(.system(size: 12)).foregroundColor(Theme.mutedForeground)
}

private struct IntelConnectorDetails: View {
    let connector: IntelConnector
    @State private var result: IntelMcpResult?
    @State private var loading = true
    @State private var authorizing = false
    @State private var authMsg: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if connector.auth == "oauth" {
                HStack(spacing: 8) {
                    Button { authorize() } label: { IntelLabel(icon: "key-round", text: authorizing ? "Authorizing…" : "Authorize") }
                        .buttonStyle(IntelButtonStyle()).disabled(authorizing)
                    if let authMsg { IntelLine(text: authMsg, size: 12, lh: 16.2, color: Theme.mutedForeground) }
                }
            }
            if loading {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini).frame(width: 14, height: 14)
                    IntelLine(text: "Loading tools…", size: 12, lh: 16.2, color: Theme.mutedForeground)
                }
            } else if let r = result, r.ok {
                VStack(alignment: .leading, spacing: 8) {
                    header(r).intelText(12, 16.2).fixedSize(horizontal: false, vertical: true)
                    if r.tools.isEmpty {
                        IntelPara(text: "Handshake OK — server exposes no tools.")
                    } else {
                        VStack(alignment: .leading, spacing: 6) {
                            IntelLine(text: intelCount(r.tools.count, "tool", "tools"), size: 12, lh: 16.2, weight: .medium)
                            VStack(alignment: .leading, spacing: 4) {
                                ForEach(r.tools, id: \.self) { t in
                                    intelToolLine(t).intelText(12, 16.5).fixedSize(horizontal: false, vertical: true)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                    }
                }
            } else {
                IntelPara(text: result?.error ?? "Connection failed.", color: Theme.destructive)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 1)
        .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
        .task(id: connector) { await probe() }
    }

    private func header(_ r: IntelMcpResult) -> Text {
        var t: Text
        if let n = r.serverName {
            t = Text(n + (r.serverVersion.map { " v\($0)" } ?? "")).fontWeight(.medium).foregroundColor(Theme.foreground)
        } else {
            t = Text("Connected").foregroundColor(Theme.mutedForeground)
        }
        if let p = r.protocolVersion { t = t + Text(" · MCP \(p)").foregroundColor(Theme.mutedForeground) }
        return t
    }

    private func probe() async {
        loading = true
        result = nil
        result = await IntelMcp.test(connector)
        loading = false
    }

    private func authorize() {
        authorizing = true
        authMsg = nil
        let c = connector
        Task {
            let msg = await Task.detached { IntelMcp.authorize(c) }.value
            authMsg = msg
            authorizing = false
            await probe()
        }
    }
}

private struct IntelKV: Identifiable { let id = UUID(); var key: String; var value: String }

private struct IntelKVRows: View {
    @Binding var pairs: [IntelKV]
    let keyPlaceholder: String
    let valuePlaceholder: String
    let addLabel: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach($pairs) { $p in
                HStack(spacing: 6) {
                    IntelInput(placeholder: keyPlaceholder, text: $p.key, mono: true)
                    IntelInput(placeholder: valuePlaceholder, text: $p.value, mono: true)
                    IntelIconButton(icon: "x", destructiveHover: true) { pairs.removeAll { $0.id == p.id } }
                }
            }
            Button { pairs.append(IntelKV(key: "", value: "")) } label: { IntelLabel(icon: "plus", text: addLabel) }.buttonStyle(IntelButtonStyle())
        }
    }
}

/// `SegmentRow`: label + description, with a bordered muted segmented control.
private struct IntelSegmentRow: View {
    let label: String
    let description: String
    let value: String
    let options: [(String, String)]
    let set: (String) -> Void
    var body: some View {
        HStack(spacing: 16) {
            VStack(alignment: .leading, spacing: 2) {
                IntelLine(text: label, size: 14, lh: 14, weight: .medium)
                IntelPara(text: description)
            }
            HStack(spacing: 0) {
                ForEach(options, id: \.0) { o in
                    Button { set(o.0) } label: {
                        Text(o.1).font(.system(size: 12, weight: .medium))
                            .foregroundStyle(value == o.0 ? Theme.foreground : Theme.mutedForeground)
                            .padding(.horizontal, 10).frame(height: 24.2)
                            .background(RoundedRectangle(cornerRadius: 4).fill(value == o.0 ? Theme.background : .clear)
                                .shadow(color: value == o.0 ? .black.opacity(0.1) : .clear, radius: 1.5, y: 1))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(3)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.muted))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
            .fixedSize()
        }
    }
}

private struct IntelConnectorEditor: View {
    let initial: IntelConnector?
    let embedded: Bool
    let onCancel: () -> Void
    let onSaved: () -> Void
    let onError: (String) -> Void
    @State private var name: String
    @State private var transport: String
    @State private var command: String
    @State private var argsText: String
    @State private var env: [IntelKV]
    @State private var url: String
    @State private var headers: [IntelKV]
    @State private var auth: String
    @State private var clientId: String
    @State private var scope: String
    @State private var testing = false
    @State private var testResult: IntelMcpResult?

    init(initial: IntelConnector?, embedded: Bool, onCancel: @escaping () -> Void, onSaved: @escaping () -> Void, onError: @escaping (String) -> Void) {
        self.initial = initial
        self.embedded = embedded
        self.onCancel = onCancel
        self.onSaved = onSaved
        self.onError = onError
        _name = State(initialValue: initial?.name ?? "")
        _transport = State(initialValue: initial?.transport ?? "stdio")
        _command = State(initialValue: initial?.command ?? "")
        _argsText = State(initialValue: (initial?.args ?? []).joined(separator: "\n"))
        _env = State(initialValue: (initial?.env ?? [:]).sorted { $0.key < $1.key }.map { IntelKV(key: $0.key, value: $0.value) })
        _url = State(initialValue: initial?.url ?? "")
        _headers = State(initialValue: (initial?.headers ?? [:]).sorted { $0.key < $1.key }.map { IntelKV(key: $0.key, value: $0.value) })
        _auth = State(initialValue: initial?.auth == "oauth" ? "oauth" : "none")
        _clientId = State(initialValue: initial?.oauthClientId ?? "")
        _scope = State(initialValue: initial?.oauthScope ?? "")
    }

    private func label(_ s: String, hint: String? = nil) -> some View {
        HStack(spacing: 16) { // label gap-2 + span ml-2
            IntelLine(text: s, size: 12, lh: 16.2, weight: .medium)
            if let hint { IntelLine(text: hint, size: 12, lh: 16.2, color: Theme.mutedForeground) }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                label("Name")
                IntelInput(placeholder: "e.g. GitHub, Filesystem, Linear…", text: $name, autofocus: true, testID: "mcp-editor-name")
            }
            IntelSegmentRow(label: "Transport", description: "A local process (stdio) or a remote MCP endpoint (HTTP/SSE).", value: transport,
                            options: [("stdio", "stdio"), ("http", "HTTP")]) { transport = $0 }
            if transport == "stdio" {
                VStack(alignment: .leading, spacing: 6) {
                    label("Command")
                    IntelInput(placeholder: "e.g. npx", text: $command, mono: true)
                }
                VStack(alignment: .leading, spacing: 6) {
                    label("Arguments", hint: "one per line")
                    IntelTextArea(placeholder: "-y\n@modelcontextprotocol/server-filesystem\n/path/to/dir", text: $argsText, rows: 3, mono: true)
                }
                VStack(alignment: .leading, spacing: 6) {
                    label("Environment", hint: "passed to the process")
                    IntelKVRows(pairs: $env, keyPlaceholder: "KEY", valuePlaceholder: "value", addLabel: "Add variable")
                }
            } else {
                VStack(alignment: .leading, spacing: 6) {
                    label("URL")
                    IntelInput(placeholder: "https://example.com/mcp", text: $url, mono: true)
                }
                VStack(alignment: .leading, spacing: 6) {
                    label("Headers", hint: "sent with each request")
                    IntelKVRows(pairs: $headers, keyPlaceholder: "Name", valuePlaceholder: "Value", addLabel: "Add header")
                }
                IntelSegmentRow(label: "Authentication", description: "Static headers, or OAuth (Cetus runs the sign-in flow).", value: auth,
                                options: [("none", "None"), ("oauth", "OAuth")]) { auth = $0 }
                if auth == "oauth" {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(alignment: .top, spacing: 8) {
                            VStack(alignment: .leading, spacing: 6) {
                                label("Client ID", hint: "optional")
                                IntelInput(placeholder: "auto (dynamic registration)", text: $clientId, mono: true)
                            }
                            VStack(alignment: .leading, spacing: 6) {
                                label("Scope", hint: "optional")
                                IntelInput(placeholder: "read write", text: $scope, mono: true)
                            }
                        }
                        IntelPara(text: "Save the MCP server, then expand it below and click Authorize.")
                    }
                    .padding(13)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.background.opacity(0.6)))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
                }
            }
            if let r = testResult {
                VStack(alignment: .leading, spacing: 2) {
                    if r.ok {
                        IntelPara(text: "Connected" + (r.serverName.map { " — \($0)" } ?? "") + (r.serverVersion.map { " v\($0)" } ?? ""), weight: .medium, color: Theme.success)
                        IntelPara(text: r.tools.isEmpty ? "Handshake OK — server exposes no tools."
                            : "\(intelCount(r.tools.count, "tool", "tools")): \(r.tools.prefix(8).map(\.name).joined(separator: ", "))\(r.tools.count > 8 ? "…" : "")")
                    } else {
                        IntelPara(text: r.error ?? "Connection failed.", color: Theme.destructive)
                    }
                }
                .padding(.horizontal, 13).padding(.vertical, 9)
                .background(RoundedRectangle(cornerRadius: 8).fill((r.ok ? Theme.success : Theme.destructive).opacity(0.05)))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder((r.ok ? Theme.success : Theme.destructive).opacity(0.4), lineWidth: 1))
            }
            HStack(spacing: 8) {
                Button { save() } label: { Text(initial == nil ? "Add" : "Save") }.buttonStyle(IntelButtonStyle(variant: .primary))
                Button { test() } label: {
                    HStack(spacing: 6) {
                        if testing { ProgressView().controlSize(.mini).frame(width: 14, height: 14) } else { IntelIcon(name: "rotate-cw", size: 14) }
                        Text(testing ? "Testing…" : "Test")
                    }
                }
                .buttonStyle(IntelButtonStyle()).disabled(testing)
                Button { onCancel() } label: { Text("Cancel") }.buttonStyle(IntelButtonStyle(variant: .ghost)).testID("mcp-editor-cancel")
            }
        }
        .padding(embedded ? 16 : 17)
        .background(embedded ? AnyView(Theme.muted.opacity(0.3)) : AnyView(RoundedRectangle(cornerRadius: 10).fill(Theme.muted.opacity(0.3))))
        .overlay { if !embedded { RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1) } }
    }

    private func build() -> IntelConnector {
        var c = initial ?? IntelConnector(["id": IntelData.uuid(), "enabled": true, "createdAt": IntelData.nowMs()])
        c.name = name.trimmingCharacters(in: .whitespaces)
        c.transport = transport
        c.command = command.trimmingCharacters(in: .whitespaces)
        c.args = argsText.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        c.env = Dictionary(env.compactMap { p in let k = p.key.trimmingCharacters(in: .whitespaces); return k.isEmpty ? nil : (k, p.value.trimmingCharacters(in: .whitespaces)) }) { $1 }
        c.url = url.trimmingCharacters(in: .whitespaces)
        c.headers = Dictionary(headers.compactMap { p in let k = p.key.trimmingCharacters(in: .whitespaces); return k.isEmpty ? nil : (k, p.value.trimmingCharacters(in: .whitespaces)) }) { $1 }
        c.auth = transport == "http" && auth == "oauth" ? "oauth" : ""
        c.oauthClientId = clientId.trimmingCharacters(in: .whitespaces)
        c.oauthScope = scope.trimmingCharacters(in: .whitespaces)
        return c
    }

    private func save() {
        onError("")
        var c = build()
        if let e = IntelMcp.validate(&c) { onError(e); return }
        c.updatedAt = IntelData.nowMs()
        var list = IntelMcp.load()
        if let i = list.firstIndex(where: { $0.id == c.id }) { list[i] = c } else { list.append(c) }
        IntelMcp.save(list)
        onSaved()
    }

    private func test() {
        testing = true
        testResult = nil
        let c = build()
        Task {
            testResult = await IntelMcp.test(c)
            testing = false
        }
    }
}

/// "Import from other apps" card.
private struct IntelMcpImports: View {
    let onError: (String) -> Void
    @State private var enabled: [String] = []
    @State private var loaded = false
    @State private var imports: [String: [(name: String, detail: String)]] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            IntelLine(text: "Import from other apps", weight: .medium)
            IntelPara(text: "Also load MCP servers configured in these apps. Applies to new chats only.").padding(.top, 4)
            IntelFlow(spacing: 8) {
                ForEach(IntelMcp.sources, id: \.id) { src in chip(src) }
            }
            .padding(.top, 12)
            if !enabled.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(enabled, id: \.self) { id in
                        let src = IntelMcp.sources.first { $0.id == id }
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                if let icon = src?.icon { RuntimeIcon(id: icon, size: 14).clipShape(RoundedRectangle(cornerRadius: 2)) }
                                IntelLine(text: src?.label ?? id, size: 12, lh: 16.2, weight: .medium, color: Theme.mutedForeground)
                            }
                            if let entries = imports[id] {
                                if entries.isEmpty {
                                    IntelPara(text: "No servers found (config file absent).")
                                } else {
                                    VStack(alignment: .leading, spacing: 2) {
                                        ForEach(entries, id: \.name) { e in
                                            intelToolLine(IntelMcpTool(name: e.name, description: e.detail.isEmpty ? nil : e.detail))
                                                .intelText(12, 16.5).fixedSize(horizontal: false, vertical: true)
                                        }
                                    }
                                }
                            } else {
                                IntelPara(text: "Loading tools…")
                            }
                        }
                    }
                }
                .padding(.top, 13)
                .overlay(alignment: .top) { Rectangle().fill(Theme.border).frame(height: 1) }
                .padding(.top, 12)
            }
        }
        .padding(17)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.card))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
        .onAppear(perform: load)
    }

    private func chip(_ src: (id: String, label: String, icon: String?)) -> some View {
        let on = enabled.contains(src.id)
        return IntelChip(on: on, label: src.label, icon: src.icon) { toggle(src.id, !on) }
            .disabled(!loaded)
            .testID("mcp-import-\(src.id)")
    }

    private func load() {
        enabled = IntelSkills.discovery()["mcpImports"] as? [String] ?? []
        loaded = true
        enabled.forEach(fetch)
    }

    private func fetch(_ id: String) {
        imports[id] = nil
        Task {
            let e = await Task.detached { IntelMcp.previewImport(id) }.value
            imports[id] = e
        }
    }

    private func toggle(_ id: String, _ on: Bool) {
        if on { enabled.append(id); fetch(id) } else { enabled.removeAll { $0 == id } }
        var d = IntelSkills.discovery()
        d["mcpImports"] = enabled
        IntelSkills.setDiscovery(d)
    }
}

private struct IntelChip: View {
    let on: Bool
    let label: String
    let icon: String?
    let action: () -> Void
    @State private var hover = false
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let icon { RuntimeIcon(id: icon, size: 14).clipShape(RoundedRectangle(cornerRadius: 2)) }
                Text(label).font(.system(size: 12, weight: .medium))
                    .foregroundStyle(on || hover ? Theme.foreground : Theme.mutedForeground)
            }
            .padding(.horizontal, 10.8)
            .frame(height: 26.2)
            .background(RoundedRectangle(cornerRadius: 8).fill(on ? Theme.primary.opacity(0.1) : .clear))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(on ? Theme.primary : Theme.border, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

/// Wrapping row layout (`flex flex-wrap gap-N`).
struct IntelFlow: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0, maxX: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x > 0 && x + sz.width > width { x = 0; y += rowH + spacing; rowH = 0 }
            x += sz.width + spacing
            rowH = max(rowH, sz.height)
            maxX = max(maxX, x - spacing)
        }
        return CGSize(width: proposal.width ?? maxX, height: y + rowH)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x > bounds.minX && x + sz.width > bounds.maxX { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(sz))
            x += sz.width + spacing
            rowH = max(rowH, sz.height)
        }
    }
}

// MARK: - Plugins (plugins.tsx) — built-in cetus-plugins + <app data>/plugins

struct IntelPlugin: Identifiable {
    let id: String
    let displayName: String
    let description: String
    let builtIn: Bool
    let available: Bool
    let unavailableReason: String?
    let surface: String?
    let enabledByDefault: Bool
    let path: String
    var enabled = false
}

enum IntelPlugins {
    static func scan(_ dir: String, builtIn: Bool) -> [IntelPlugin] {
        guard let items = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return [] }
        var out: [IntelPlugin] = []
        for item in items {
            let root = "\(dir)/\(item)"
            guard let m = IntelData.readJSON(URL(fileURLWithPath: "\(root)/.codex-plugin/plugin.json")) as? [String: Any] else { continue }
            let id = ((m["id"] as? String) ?? (m["name"] as? String) ?? "").trimmingCharacters(in: .whitespaces)
            guard !id.isEmpty else { continue }
            let iface = m["interface"] as? [String: Any] ?? [:]
            let act = m["activation"] as? [String: Any] ?? [:]
            var name = (m["displayName"] as? String ?? "").trimmingCharacters(in: .whitespaces)
            if name.isEmpty { name = iface["displayName"] as? String ?? id }
            var desc = (m["description"] as? String ?? "").trimmingCharacters(in: .whitespaces)
            if desc.isEmpty { desc = iface["shortDescription"] as? String ?? "" }
            out.append(IntelPlugin(id: id, displayName: name, description: desc, builtIn: builtIn, available: act["available"] as? Bool ?? true,
                                   unavailableReason: act["unavailableReason"] as? String, surface: act["agentControlSurface"] as? String,
                                   enabledByDefault: act["enabledByDefault"] as? Bool ?? false, path: root))
        }
        return out.sorted { $0.id < $1.id }
    }

    static func load() -> [IntelPlugin] {
        var seen = Set<String>()
        var list: [IntelPlugin] = []
        for p in scan(IntelData.file("pi-install/cetus-plugins").path, builtIn: true) where seen.insert(p.id).inserted { list.append(p) }
        list += scan(userDir.path, builtIn: false)
        let control = IntelData.settingJSON("agent_control") ?? [:]
        let settings = (IntelData.settingJSON("plugins") ?? [:])["enabled"] as? [String: Bool] ?? [:]
        return list.map { p in
            var p = p
            if !p.available { p.enabled = false }
            else if let s = p.surface { p.enabled = control[s] as? Bool ?? false }
            else { p.enabled = settings[p.id] ?? p.enabledByDefault }
            return p
        }
    }

    static var userDir: URL { IntelData.file("plugins") }

    static func setEnabled(_ p: IntelPlugin, _ on: Bool) {
        if let s = p.surface {
            var c = IntelData.settingJSON("agent_control") ?? [:]
            c[s] = on
            IntelData.setSettingJSON("agent_control", c)
        } else {
            var st = IntelData.settingJSON("plugins") ?? [:]
            var en = st["enabled"] as? [String: Bool] ?? [:]
            en[p.id] = on
            st["enabled"] = en
            IntelData.setSettingJSON("plugins", st)
        }
    }
}

struct IntelPluginsSection: View {
    @State private var plugins: [IntelPlugin]?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            IntelHeading(title: "Plugins", description: "Capability packages that can contribute prompt guidance, tools, MCP servers, skills, and trusted native integrations.")
            Button { importFolder() } label: { IntelLabel(icon: "folder-open", text: "Import folder") }.buttonStyle(IntelButtonStyle())
                .padding(.top, 16).testID("plugins-import")

            VStack(alignment: .leading, spacing: 8) {
                IntelLine(text: "Choose the right surface", size: 12, lh: 16.2, weight: .medium)
                HStack(alignment: .top, spacing: 8) {
                    surface("@Computer", "Native desktop apps, cross-app GUI work, or anything no structured tool can reach.")
                    surface("@Browser", "Cetus-managed browser for local dev servers, public pages, and isolated temporary sessions.")
                }
            }
            .padding(.horizontal, 13).padding(.vertical, 11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.muted.opacity(0.3)))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
            .padding(.top, 16)

            if let error {
                IntelPara(text: error, size: 14, lh: 20.02, color: Theme.destructive)
                    .padding(.horizontal, 13).padding(.vertical, 9)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.destructive.opacity(0.1)))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.destructive.opacity(0.3), lineWidth: 1))
                    .padding(.top, 16)
            }

            if let plugins {
                if plugins.isEmpty {
                    VStack(spacing: 0) {
                        IntelIcon(name: "blocks", size: 32, color: Theme.mutedForeground).padding(.bottom, 12)
                        IntelLine(text: "No plugins found", weight: .medium)
                    }
                    .frame(maxWidth: .infinity).frame(height: 192)
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
                    .padding(.top, 16)
                } else {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(plugins) { p in card(p) }
                    }
                    .padding(.top, 16)
                }
            }
        }
        .onAppear(perform: load)
    }

    private func surface(_ name: String, _ desc: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            IntelLine(text: name, size: 12, lh: 16.2, weight: .medium, mono: true)
            IntelPara(text: desc, lh: 16.5)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func card(_ p: IntelPlugin) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    IntelLine(text: p.displayName, weight: .medium)
                    IntelPara(text: p.description.isEmpty ? p.id : p.description, lh: 16.5, lineLimit: 3)
                    if !p.available, let r = p.unavailableReason {
                        IntelPara(text: r, lh: 16.2, color: Theme.warning)
                            .padding(.horizontal, 9).padding(.vertical, 7)
                            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.warning.opacity(0.1)))
                            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.warning.opacity(0.3), lineWidth: 1))
                            .padding(.top, 4)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                IntelSwitch(isOn: p.enabled, disabled: !p.available, testID: "plugin-toggle-\(p.id)") { v in
                    IntelPlugins.setEnabled(p, v)
                    load()
                }
            }
            HStack(spacing: 8) {
                IntelLine(text: p.id, size: 12, lh: 16.2, mono: true, color: Theme.mutedForeground)
                Spacer(minLength: 0)
                HStack(spacing: 4) {
                    Button { System.reveal(p.path) } label: { IntelLabel(icon: "external-link", text: "Open folder") }
                        .buttonStyle(IntelButtonStyle(variant: .ghost, height: 28, horizontal: 8))
                    if !p.builtIn {
                        IntelIconButton(icon: "trash-2", box: 28, destructiveHover: true) { delete(p) }
                    }
                }
            }
        }
        .padding(.horizontal, 17).padding(.vertical, 13)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.card))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Theme.border, lineWidth: 1))
        .compositingGroup()
        .opacity(p.enabled ? 1 : 0.7)
    }

    private func load() { plugins = IntelPlugins.load() }

    private func importFolder() {
        guard let path = IntelData.pickFolder() else { return }
        guard FileManager.default.fileExists(atPath: "\(path)/.codex-plugin/plugin.json") else { error = "that folder has no .codex-plugin/plugin.json"; return }
        let dst = IntelPlugins.userDir.appendingPathComponent(URL(fileURLWithPath: path).lastPathComponent)
        do {
            try FileManager.default.createDirectory(at: IntelPlugins.userDir, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: dst)
            error = nil
        } catch { self.error = error.localizedDescription }
        load()
    }

    private func delete(_ p: IntelPlugin) {
        guard !p.builtIn else { return }
        let a = NSAlert()
        a.messageText = "Delete this plugin?"
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Cancel")
        guard a.runModal() == .alertFirstButtonReturn else { return }
        try? FileManager.default.removeItem(atPath: p.path)
        load()
    }
}
