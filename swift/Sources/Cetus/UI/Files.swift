import Foundation

struct WorkspaceFile: Hashable {
    let rel: String
    let path: String
    let isDir: Bool
    var name: String { (rel as NSString).lastPathComponent }
}

/// Workspace listing for @-mentions and file search: `git ls-files` when the
/// folder is a repo, otherwise a bounded walk. Cached briefly per root.
enum WorkspaceFiles {
    nonisolated(unsafe) private static var cache: [String: (at: Date, files: [WorkspaceFile])] = [:]
    private static let skip: Set<String> = [".git", "node_modules", ".build", "target", "dist", ".next", "build", ".venv", "__pycache__", "DerivedData", ".DS_Store"]

    static func list(_ root: String, completion: @escaping ([WorkspaceFile]) -> Void) {
        if let hit = cache[root], Date().timeIntervalSince(hit.at) < 30 { completion(hit.files); return }
        DispatchQueue.global(qos: .userInitiated).async {
            let files = scan(root)
            DispatchQueue.main.async {
                cache[root] = (Date(), files)
                completion(files)
            }
        }
    }

    static func invalidate(_ root: String) { cache.removeValue(forKey: root) }

    private static func scan(_ root: String) -> [WorkspaceFile] {
        var rels: [String] = []
        if let out = System.run(["git", "ls-files", "--cached", "--others", "--exclude-standard"], cwd: root) {
            rels = out.split(separator: "\n").map(String.init).prefix(20000).map { $0 }
        } else {
            let fm = FileManager.default
            if let e = fm.enumerator(atPath: root) {
                while let rel = e.nextObject() as? String {
                    let name = (rel as NSString).lastPathComponent
                    if skip.contains(name) { e.skipDescendants(); continue }
                    if name.hasPrefix(".") { if (e.fileAttributes?[.type] as? FileAttributeType) == .typeDirectory { e.skipDescendants() }; continue }
                    if (e.fileAttributes?[.type] as? FileAttributeType) == .typeRegular { rels.append(rel) }
                    if rels.count > 5000 { break }
                }
            }
        }
        var dirs = Set<String>()
        for r in rels {
            var d = (r as NSString).deletingLastPathComponent
            while !d.isEmpty && d != "." && !dirs.contains(d) {
                dirs.insert(d)
                d = (d as NSString).deletingLastPathComponent
            }
        }
        let base = URL(fileURLWithPath: root)
        return dirs.sorted().map { WorkspaceFile(rel: $0, path: base.appendingPathComponent($0).path, isDir: true) }
            + rels.map { WorkspaceFile(rel: $0, path: base.appendingPathComponent($0).path, isDir: false) }
    }

    static func gitBranch(_ root: String, completion: @escaping (String?) -> Void) {
        DispatchQueue.global().async {
            let b = System.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd: root)?.trimmingCharacters(in: .whitespacesAndNewlines)
            DispatchQueue.main.async { completion(b?.isEmpty == false ? b : nil) }
        }
    }

    /// Porcelain status by repo-relative path ("M", "A", "D", "U" for untracked).
    static func gitStatus(_ root: String) -> (top: String, status: [String: String])? {
        guard let top = System.run(["git", "rev-parse", "--show-toplevel"], cwd: root)?.trimmingCharacters(in: .whitespacesAndNewlines), !top.isEmpty,
              let out = System.run(["git", "status", "--porcelain", "-uall"], cwd: root)
        else { return nil }
        var m: [String: String] = [:]
        for line in out.split(separator: "\n") where line.count > 3 {
            let code = line.prefix(2).trimmingCharacters(in: .whitespaces)
            var path = String(line.dropFirst(3))
            if let arrow = path.range(of: " -> ") { path = String(path[arrow.upperBound...]) }
            m[path] = code == "??" ? "U" : String(code.prefix(1))
        }
        return (top, m)
    }
}

/// Subsequence fuzzy match: contiguous runs, word starts and short candidates score higher.
enum Fuzzy {
    static func score(_ candidate: String, _ query: String) -> Int? {
        if query.isEmpty { return 0 }
        let c = Array(candidate.lowercased()), q = Array(query.lowercased())
        var qi = 0, score = 0, run = 0, last = -2
        for (i, ch) in c.enumerated() where qi < q.count {
            if ch == q[qi] {
                run = (i == last + 1) ? run + 1 : 1
                score += 1 + run * 2
                if i == 0 || "/._- ".contains(c[i - 1]) { score += 6 }
                last = i
                qi += 1
            }
        }
        guard qi == q.count else { return nil }
        if candidate.lowercased().contains(query.lowercased()) { score += 20 }
        return score * 100 - c.count
    }

    static func rank<T>(_ items: [T], _ query: String, limit: Int = 50, key: (T) -> String) -> [T] {
        if query.isEmpty { return Array(items.prefix(limit)) }
        return items.compactMap { item in score(key(item), query).map { (item, $0) } }
            .sorted { $0.1 > $1.1 }
            .prefix(limit)
            .map(\.0)
    }
}
