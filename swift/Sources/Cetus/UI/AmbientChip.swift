import SwiftUI

/// The composer's radar toggle (composer-view.tsx): shown only while the
/// ambient collector is enabled; decides whether each send leads with the
/// `<context source="cetus-ambient">` recent-activity fence.
struct AmbientChip: View {
    @AppStorage("settings.ambient") private var store = CapStored<CapAmbientSettings>()
    @AppStorage("settings.ambient.inject") private var on = false

    var body: some View {
        if store.value.enabled {
            GhostIconButton(icon: "radar", box: 32, glyph: 12, color: on ? Theme.primary : Theme.mutedForeground,
                            hoverColor: on ? Theme.primary : Theme.mutedForeground,
                            tip: on ? "Ambient context on — recent activity is attached to each message" : "Ambient context off — click to attach recent activity to messages",
                            testID: "ambient-chip") { on.toggle() }
        }
    }
}
