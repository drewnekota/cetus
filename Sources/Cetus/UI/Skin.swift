import AppKit

/// The active skin (Settings → Appearance → Skin): seed colors per variant from
/// which `Theme`'s neutrals derive, as in Cetus globals.css — every neutral is
/// `ink` mixed into `surface` in OKLab, scaled by `contrast`. The untouched
/// Cetus skin keeps Theme's stock hex values.
enum Skin {
    nonisolated(unsafe) private(set) static var pref = GSkinPreference.load()
    nonisolated(unsafe) private static var isDefault = pref == .from(GSkinPreset.all[0])

    /// The variant's seeds, or nil for the stock Cetus skin.
    static func seeds(dark: Bool) -> GSkinSeeds? { isDefault ? nil : dark ? pref.dark : pref.light }

    /// Switch skins and repaint every window.
    @MainActor static func apply(_ p: GSkinPreference) {
        guard p != pref else { return }
        pref = p
        isDefault = p == .from(GSkinPreset.all[0])
        refresh()
        Terminals.shared.retheme()
    }

    /// Dynamic colors resolve when drawn, but SwiftUI keeps what it resolved
    /// until the appearance changes. Swap each window to the same-looking
    /// vibrant appearance for one run-loop turn so everything resolves again
    /// against the new seeds.
    @MainActor static func refresh() {
        for w in NSApp.windows where w.isVisible {
            let original = w.appearance
            let dark = w.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            w.appearance = NSAppearance(named: dark ? .vibrantDark : .vibrantLight)
            DispatchQueue.main.async { w.appearance = original }
        }
    }

    // MARK: Derivation

    static func color(_ hex: String, alpha: CGFloat = 1) -> NSColor {
        NSColor(hex: UInt32(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) ?? 0, alpha: alpha)
    }

    /// `color-mix(in oklab, ink calc(pct * k), surface)`; `scaled: false` skips the contrast factor.
    static func neutral(_ s: GSkinSeeds, _ pct: Double, scaled: Bool = true) -> NSColor {
        let k = scaled ? Double(s.contrast) / 50 : 1
        return oklabMix(color(s.ink), color(s.surface), min(1, max(0, pct * k / 100)))
    }

    /// muted-foreground: `ink calc(base% + (contrast - 50) * 0.2%)`, not scaled by k.
    static func mutedText(_ s: GSkinSeeds, base: Double) -> NSColor {
        neutral(s, base + Double(s.contrast - 50) * 0.2, scaled: false)
    }

    /// Black or white text on the accent (WCAG luminance, Codex's threshold).
    static func onAccent(_ s: GSkinSeeds) -> NSColor {
        func ch(_ c: CGFloat) -> CGFloat { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        let c = color(s.accent)
        let l = 0.2126 * ch(c.redComponent) + 0.7152 * ch(c.greenComponent) + 0.0722 * ch(c.blueComponent)
        return l > 0.179 ? .black : .white
    }

    /// `top` at `alpha` composited over `bottom` (sRGB), for pre-blended tints.
    static func over(_ top: NSColor, _ alpha: CGFloat, _ bottom: NSColor) -> NSColor {
        let t = top.usingColorSpace(.sRGB)!, b = bottom.usingColorSpace(.sRGB)!
        return NSColor(srgbRed: t.redComponent * alpha + b.redComponent * (1 - alpha),
                       green: t.greenComponent * alpha + b.greenComponent * (1 - alpha),
                       blue: t.blueComponent * alpha + b.blueComponent * (1 - alpha), alpha: 1)
    }

    /// `color-mix(in oklab, a p, b)`.
    static func oklabMix(_ a: NSColor, _ b: NSColor, _ p: Double) -> NSColor {
        let x = oklab(a), y = oklab(b)
        return srgb((x.0 * p + y.0 * (1 - p), x.1 * p + y.1 * (1 - p), x.2 * p + y.2 * (1 - p)))
    }

    private static func oklab(_ c: NSColor) -> (Double, Double, Double) {
        let s = c.usingColorSpace(.sRGB)!
        func lin(_ v: CGFloat) -> Double { let v = Double(v); return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        let r = lin(s.redComponent), g = lin(s.greenComponent), b = lin(s.blueComponent)
        let l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
        let m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
        let q = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
        return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * q,
                1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * q,
                0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * q)
    }

    private static func srgb(_ lab: (Double, Double, Double)) -> NSColor {
        let l = pow(lab.0 + 0.3963377774 * lab.1 + 0.2158037573 * lab.2, 3)
        let m = pow(lab.0 - 0.1055613458 * lab.1 - 0.0638541728 * lab.2, 3)
        let s = pow(lab.0 - 0.0894841775 * lab.1 - 1.2914855480 * lab.2, 3)
        func gam(_ v: Double) -> CGFloat {
            let v = min(1, max(0, v))
            return CGFloat(v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1 / 2.4) - 0.055)
        }
        return NSColor(srgbRed: gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
                       green: gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
                       blue: gam(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s), alpha: 1)
    }
}
