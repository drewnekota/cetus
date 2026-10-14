import AppKit
import SwiftUI

// Settings → Remote access (components/settings/sections/remote.tsx), backed by RemoteAccess.

private enum RemoteTheme {
    /// bg-muted/15 over the card.
    static let panelFill = GTheme.dyn(0xEFEFF0, 0x252528, 0.15, 0.15)
    /// text-foreground/80.
    static let url = Theme.foreground.opacity(0.8)
    static let emerald = Color(nsColor: NSColor(hex: 0x00BC7D))
    static let amber = Color(nsColor: NSColor(hex: 0xFE9A00))
    /// text-amber-600 dark:text-amber-500.
    static let proxyHint = GTheme.amberHint
    static let qrDark = Color(nsColor: NSColor(hex: 0x171717))
}

struct RemoteAccessSection: View {
    @State private var model = RemoteModel.shared

    var body: some View {
        let remote = model.snapshot
        let busy = model.busy
        VStack(alignment: .leading, spacing: 0) {
            GSectionHeading(title: "Remote access", description: "Continue Cetus conversations securely from your phone through Tailscale.")
            VStack(spacing: 0) {
                HStack(spacing: 20) {
                    HStack(alignment: .top, spacing: 12) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 10).fill(Theme.primary.opacity(0.1))
                            RoundedRectangle(cornerRadius: 11).strokeBorder(Theme.primary.opacity(0.2), lineWidth: 1).padding(-1)
                            Glyph(name: "cloud", size: 16, color: Theme.primary)
                        }
                        .frame(width: 36, height: 36)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Enable mobile companion").font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).lineBox(14)
                            GDetail(text: "Starts a localhost-only server and configures Tailscale Serve when available.", lineHeight: 19.5)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    GSwitch(isOn: remote?.enabled ?? false, disabled: remote == nil || busy, testID: "toggle-remote") { v in
                        Task { await RemoteAccess.setEnabled(v) }
                    }
                }
                .padding(16)
                if let remote, remote.enabled {
                    Rectangle().fill(Theme.border).frame(height: 1)
                    enabledPanel(remote, busy: busy)
                        .padding(16)
                        .background(RemoteTheme.panelFill)
                }
            }
            .background(Theme.card)
            .clipShape(RoundedRectangle(cornerRadius: 13))
            .padding(1)
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Theme.border, lineWidth: 1))
            .padding(.top, 24)
            GToggleRow(title: "Keep this Mac awake for remote access",
                       detail: "While the mobile companion is on, hold off system sleep so your phone can always reach this Mac. The display still sleeps and locks.",
                       isOn: remote?.keepAwake ?? false, disabled: remote == nil || busy, testID: "toggle-remote-keep-awake") { v in
                Task { await RemoteAccess.setKeepAwake(v) }
            }
            .padding(.top, 8)
            GDetail(text: "Only conversation features are exposed. API keys, terminal control, local file browsing and Cetus settings stay on this Mac.", lineHeight: 19.5)
                .padding(.top, 16)
        }
        .task { await RemoteAccess.refresh() }
    }

    private func enabledPanel(_ r: RemoteSnapshot, busy: Bool) -> some View {
        HStack(alignment: .top, spacing: 20) {
            RemoteQR(text: r.pairingUrl)
                .frame(width: 156, height: 156)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 14).fill(Color.white))
                .testID("remote-qr")
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 8) {
                        Circle().fill(r.tailscaleReady ? RemoteTheme.emerald : RemoteTheme.amber).frame(width: 8, height: 8)
                        Text(r.tailscaleReady ? "Tailnet address ready" : "Local server ready")
                            .font(.system(size: 14, weight: .medium)).foregroundStyle(Theme.foreground).lineBox(20.02)
                    }
                    GDetail(text: r.tailscaleMessage)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(r.accessUrl).font(.system(size: 12, design: .monospaced)).foregroundStyle(RemoteTheme.url)
                        .lineLimit(1).truncationMode(.tail).lineBox(16.2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    GDetail(text: "Scan this QR code once. Your phone keeps an authenticated session afterwards.", lineHeight: 19.5)
                    GDetail(text: "Your phone needs the Tailscale app, signed into the same tailnet as this Mac.", lineHeight: 19.5)
                    GDetail(text: "Running a proxy app on the phone (Clash, Shadowrocket, Surge…)? Add a DIRECT rule for *.ts.net first — fake-IP DNS hijacks Tailscale addresses and the pairing page won't open.",
                            lineHeight: 19.5, color: RemoteTheme.proxyHint)
                }
                .padding(13) // p-3 + the 1px border
                .background(RoundedRectangle(cornerRadius: 10).fill(Theme.background))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.border, lineWidth: 1))
                HStack(spacing: 8) {
                    GButton(title: "Copy pairing link", icon: "copy", testID: "remote-copy") { System.copy(r.pairingUrl) }
                    GButton(title: "Revoke phones", icon: "key-round", variant: .ghost, muted: true, disabled: busy, testID: "remote-rotate") {
                        Task { await RemoteAccess.rotate() }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// The pairing QR: dark #171717 modules on white with a 4-module quiet zone,
/// scaled to the 156pt column (the qrcode crate's SVG under `[&>svg]:w-full`).
struct RemoteQR: View {
    let text: String
    var body: some View {
        let modules = RemoteAccess.qrModules(text) ?? []
        Canvas { ctx, size in
            guard !modules.isEmpty else { return }
            let n = CGFloat(modules.count + 8)
            let m = size.width / n
            ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.white))
            var path = Path()
            for (y, row) in modules.enumerated() {
                for (x, dark) in row.enumerated() where dark {
                    path.addRect(CGRect(x: (CGFloat(x) + 4) * m, y: (CGFloat(y) + 4) * m, width: m, height: m))
                }
            }
            ctx.fill(path, with: .color(Color(nsColor: NSColor(hex: 0x171717))))
        }
    }
}
