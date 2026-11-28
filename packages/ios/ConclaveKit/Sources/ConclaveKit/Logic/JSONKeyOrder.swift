import Foundation

/// The order of an object's keys as the JSON text has them. JSONDecoder drops it, but the web lists a
/// workflow's args in `Object.entries` order (args-form.tsx), which is the script's own order.
public enum JSONKeyOrder {
    /// For a top-level array of objects: the keys of each element's `field` object, in text order;
    /// nil for an element without one. Nil overall when the text is not an array.
    public static func keys(ofField field: String, inArray data: Data) -> [[String]?]? {
        var s = Scanner(bytes: [UInt8](data))
        s.ws()
        guard s.eat(UInt8(ascii: "[")) else { return nil }
        var out: [[String]?] = []
        s.ws()
        if s.eat(UInt8(ascii: "]")) { return out }
        while s.i < s.b.count {
            s.ws()
            if s.peek == UInt8(ascii: "{") {
                var found: [String]?
                s.object { key, s in
                    if key == field, s.peek == UInt8(ascii: "{") {
                        var names: [String] = []
                        s.object { k, s in names.append(k); s.skip() }
                        found = names
                    } else {
                        s.skip()
                    }
                }
                out.append(found)
            } else {
                s.skip()
                out.append(nil)
            }
            s.ws()
            if s.eat(UInt8(ascii: ",")) { continue }
            guard s.eat(UInt8(ascii: "]")) else { return nil }
            return out
        }
        return nil
    }

    private struct Scanner {
        let b: [UInt8]
        var i = 0
        init(bytes: [UInt8]) { b = bytes }

        var peek: UInt8? { i < b.count ? b[i] : nil }

        mutating func ws() { while let c = peek, c == 0x20 || c == 0x0A || c == 0x0D || c == 0x09 { i += 1 } }

        mutating func eat(_ c: UInt8) -> Bool {
            guard peek == c else { return false }
            i += 1
            return true
        }

        /// A string at `i`, escapes and all; JSONDecoder reads the escapes.
        mutating func string() -> String? {
            let start = i
            guard eat(UInt8(ascii: "\"")) else { return nil }
            while let c = peek {
                i += 1
                if c == UInt8(ascii: "\\") { i += 1 } else if c == UInt8(ascii: "\"") { break }
            }
            return try? JSONDecoder().decode(String.self, from: Data(b[start..<min(i, b.count)]))
        }

        /// Each key of the object at `i`; `value` must step over the value that follows it.
        mutating func object(_ value: (String, inout Scanner) -> Void) {
            guard eat(UInt8(ascii: "{")) else { return }
            ws()
            if eat(UInt8(ascii: "}")) { return }
            while i < b.count {
                ws()
                guard let k = string() else { return }
                ws()
                guard eat(UInt8(ascii: ":")) else { return }
                ws()
                value(k, &self)
                ws()
                if eat(UInt8(ascii: ",")) { continue }
                _ = eat(UInt8(ascii: "}"))
                return
            }
        }

        /// Step over one value of any kind.
        mutating func skip() {
            ws()
            switch peek {
            case UInt8(ascii: "\""): _ = string()
            case UInt8(ascii: "{"): object { _, s in s.skip() }
            case UInt8(ascii: "["):
                i += 1
                ws()
                if eat(UInt8(ascii: "]")) { return }
                while i < b.count {
                    skip()
                    ws()
                    if eat(UInt8(ascii: ",")) { continue }
                    _ = eat(UInt8(ascii: "]"))
                    return
                }
            default:
                // a number, true, false or null
                while let c = peek, c != UInt8(ascii: ","), c != UInt8(ascii: "}"), c != UInt8(ascii: "]"), c != 0x20, c != 0x0A, c != 0x0D, c != 0x09 { i += 1 }
            }
        }
    }
}
