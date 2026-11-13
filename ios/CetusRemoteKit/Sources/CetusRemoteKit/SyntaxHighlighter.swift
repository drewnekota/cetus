import Foundation

/// A small tokenizer for code blocks: comments, strings, numbers, keywords
/// and called names, enough to color the languages agents write most. The
/// desktop uses highlight.js; the kinds here map onto the same theme.
public enum SyntaxHighlighter {
    public enum Kind: Sendable { case plain, comment, keyword, literal, string, title }

    public struct Piece: Sendable, Hashable {
        public var text: String
        public var kind: Kind
    }

    private struct Language {
        var keywords: Set<String>
        var literals: Set<String> = ["true", "false", "null", "nil", "None", "True", "False", "undefined"]
        var lineComments: [String] = ["//"]
        var blockComment: (String, String)? = ("/*", "*/")
        var quotes: [Character] = ["\"", "'"]
    }

    private static func words(_ s: String) -> Set<String> { Set(s.split(separator: " ").map(String.init)) }

    private static let cLike = Language(keywords: words(
        "if else for while do switch case default break continue return goto struct class enum union typedef static const void int long short char float double unsigned signed bool auto public private protected virtual override new delete this namespace using template typename try catch throw import package interface extends implements final abstract synchronized var val fun when object companion data sealed is in as null"))
    private static let script = Language(
        keywords: words(
            "const let var function return if else for while do switch case default break continue class extends new this super import export from as async await try catch finally throw typeof instanceof in of void delete yield static get set interface type enum implements public private protected readonly declare namespace abstract satisfies keyof"),
        quotes: ["\"", "'", "`"])
    private static let swift = Language(keywords: words(
        "let var func return if else guard for while repeat switch case default break continue struct class enum protocol extension import init deinit self Self super static private fileprivate internal public open final mutating throws rethrows throw try catch do async await actor some any in is as where defer lazy weak unowned override typealias associatedtype inout indirect"))
    private static let python = Language(
        keywords: words(
            "def return if elif else for while break continue class import from as try except finally raise with lambda pass yield global nonlocal assert del in is not and or async await match case self"),
        lineComments: ["#"], blockComment: nil)
    private static let rust = Language(keywords: words(
        "fn let mut return if else for while loop match break continue struct enum trait impl use mod pub crate self Self super static const unsafe async await move ref where type dyn as in extern"))
    private static let go = Language(
        keywords: words(
            "func return if else for range switch case default break continue struct interface type var const package import go defer chan select map fallthrough goto"),
        quotes: ["\"", "'", "`"])
    private static let shell = Language(
        keywords: words(
            "if then else elif fi for while until do done case esac in function return exit export local readonly set unset source alias echo cd"),
        lineComments: ["#"], blockComment: nil)
    private static let ruby = Language(
        keywords: words(
            "def end return if elsif else unless while until for in do begin rescue ensure raise class module require include extend attr_accessor attr_reader yield self then when case and or not"),
        lineComments: ["#"], blockComment: nil)
    private static let sql = Language(
        keywords: words(
            "select from where and or not insert into values update set delete create table alter drop index view join left right inner outer on as group by order having limit offset union distinct primary key foreign references default null is in like between exists case when then else end begin commit SELECT FROM WHERE AND OR NOT INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP INDEX VIEW JOIN LEFT RIGHT INNER OUTER ON AS GROUP BY ORDER HAVING LIMIT OFFSET UNION DISTINCT PRIMARY KEY FOREIGN REFERENCES DEFAULT NULL IS IN LIKE BETWEEN EXISTS CASE WHEN THEN ELSE END BEGIN COMMIT"),
        lineComments: ["--"])
    private static let data = Language(keywords: [], lineComments: ["#"], blockComment: nil)
    private static let json = Language(keywords: [], lineComments: [], blockComment: nil, quotes: ["\""])
    private static let css = Language(keywords: [], lineComments: [], blockComment: ("/*", "*/"))
    private static let markup = Language(keywords: [], lineComments: [], blockComment: ("<!--", "-->"))

    private static let languages: [String: Language] = {
        var out: [String: Language] = [:]
        func add(_ names: String, _ l: Language) { for n in names.split(separator: " ") { out[String(n)] = l } }
        add("c h cc cpp hpp cxx m mm java kt kts kotlin cs csharp scala dart php", cLike)
        add("js jsx ts tsx mjs cjs javascript typescript", script)
        add("swift", swift)
        add("py python", python)
        add("rs rust", rust)
        add("go golang", go)
        add("sh bash zsh shell fish console", shell)
        add("rb ruby", ruby)
        add("sql", sql)
        add("yaml yml toml ini conf env dockerfile makefile", data)
        add("json jsonc json5", json)
        add("css scss less", css)
        add("html htm xml svg vue", markup)
        return out
    }()

    /// Whether a fence tag or file extension names a language to color.
    public static func knows(_ language: String) -> Bool {
        languages[language.lowercased()] != nil
    }

    /// `code` cut into colored runs. Unknown languages and very long blocks
    /// come back as one plain piece.
    public static func pieces(_ code: String, language: String) -> [Piece] {
        guard let lang = languages[language.lowercased()], code.utf8.count <= 40_000 else {
            return [Piece(text: code, kind: .plain)]
        }
        let c = Array(code)
        var out: [Piece] = []
        var plain = ""
        func flush() {
            if !plain.isEmpty { out.append(Piece(text: plain, kind: .plain)) }
            plain = ""
        }
        func emit(_ text: String, _ kind: Kind) {
            if kind == .plain { plain += text; return }
            flush()
            out.append(Piece(text: text, kind: kind))
        }
        func starts(_ s: String, at i: Int) -> Bool {
            let p = Array(s)
            guard i + p.count <= c.count else { return false }
            for (k, ch) in p.enumerated() where c[i + k] != ch { return false }
            return true
        }
        var i = 0
        while i < c.count {
            let ch = c[i]
            if let (open, close) = lang.blockComment, starts(open, at: i) {
                var j = i + open.count
                while j < c.count, !starts(close, at: j) { j += 1 }
                j = min(c.count, j + close.count)
                emit(String(c[i..<j]), .comment)
                i = j
            } else if lang.lineComments.contains(where: { starts($0, at: i) }) {
                var j = i
                while j < c.count, c[j] != "\n" { j += 1 }
                emit(String(c[i..<j]), .comment)
                i = j
            } else if lang.quotes.contains(ch) {
                var j = i + 1
                while j < c.count, c[j] != ch {
                    // A plain quote ends with its line; a backtick may span.
                    if c[j] == "\n", ch != "`" { break }
                    j += c[j] == "\\" ? 2 : 1
                }
                j = min(c.count, j + 1)
                emit(String(c[i..<j]), .string)
                i = j
            } else if ch.isNumber, i == 0 || !(c[i - 1].isLetter || c[i - 1] == "_") {
                var j = i
                while j < c.count, c[j].isNumber || c[j].isLetter || c[j] == "." || c[j] == "_" { j += 1 }
                emit(String(c[i..<j]), .literal)
                i = j
            } else if ch.isLetter || ch == "_" || ch == "$" || ch == "@" {
                var j = i + 1
                while j < c.count, c[j].isLetter || c[j].isNumber || c[j] == "_" || c[j] == "$" { j += 1 }
                let word = String(c[i..<j])
                if lang.keywords.contains(word) {
                    emit(word, .keyword)
                } else if lang.literals.contains(word) {
                    emit(word, .literal)
                } else if j < c.count, c[j] == "(", !lang.keywords.isEmpty {
                    emit(word, .title)
                } else {
                    emit(word, .plain)
                }
                i = j
            } else {
                plain.append(ch)
                i += 1
            }
        }
        flush()
        return out
    }
}
