export const de = {
  "search.placeholder": "Einstellungen suchen…",
  "search.clear": "Suche löschen",
  "search.empty": "Keine passenden Einstellungen",

  "models.model.reasoningHint":
    "Aktiviere Reasoning bei Modellen mit Effort-Parameter und schalte die Stufen frei, die dein Endpunkt unterstützt. Jede Stufe sendet standardmäßig ihren eigenen Namen; ein eingetragenes Token überschreibt das. Unter „Format“ wählst du die Feldform deines Anbieters; deaktivierte Stufen werden auf die nächste aktive geklemmt.",
  "models.model.format": "Format",
  "models.model.reasoning": "Reasoning",
  "nav.models": "Modelle",
  "models.title": "Modelle",
  "models.description":
    "Füge eigene OpenAI-kompatible Modellanbieter hinzu — Basis-URL, API-Schlüssel und Modell-IDs. Die Modelle erscheinen dann im Modell-Picker des Chats neben den integrierten Stufen.",
  "models.empty": "Noch keine eigenen Anbieter.",
  "models.add": "Anbieter hinzufügen",
  "models.noKey": "Kein Schlüssel",
  "models.footnote":
    "Hintergrundaufgaben (automatische Titel, Meeting-Notizen) nutzen DeepSeek, wenn dessen Schlüssel gesetzt ist, sonst deinen ersten eigenen Anbieter.",
  "models.name.label": "Name",
  "models.name.placeholder": "OpenRouter, mein vLLM-Server …",
  "models.baseUrl.label": "Basis-URL",
  "models.baseUrl.hint": "OpenAI-kompatibler Endpunkt, ohne /chat/completions.",
  "models.key.label": "API-Schlüssel",
  "models.key.placeholder": "sk-… (leer für lokale Endpunkte)",
  "models.key.keepStored": "•••••••• (gespeichert — tippen zum Ersetzen)",
  "models.models.label": "Modelle",
  "models.model.idPlaceholder": "Modell-ID",
  "models.model.namePlaceholder": "Anzeigename (optional)",
  "models.model.vision": "Vision",
  "models.model.visionHint":
    "Aktiviere Vision bei Modellen mit Bildeingabe — Anhänge gehen dann direkt ans Modell statt vorher transkribiert zu werden.",
  "models.model.add": "Modell hinzufügen",
  "page.title": "Einstellungen",

  "group.general": "Allgemein",
  "group.intelligence": "Intelligenz",
  "group.inputCapture": "Eingabe & Erfassung",
  "group.app": "App",
  "group.data": "Daten",
  "nav.general": "Allgemein",
  "general.title": "Allgemein",
  "general.description": "Sprache und grundlegende App-Einstellungen.",
  "general.autoSortConversations.label": "Aktive Chats nach oben verschieben",
  "general.autoSortConversations.description":
    "Sortiert Chats bei neuen Nachrichten neu. Deaktivieren, um die Erstellungsreihenfolge mit neuen Chats oben beizubehalten.",
  "general.autoUpdate.label": "Automatische Updates",
  "general.autoUpdate.description":
    "Sucht und installiert Updates im Hintergrund. Wird beim nächsten Start von Cetus angewendet.",
  "general.confirmQuit.label": "Vor dem Beenden nachfragen",
  "general.confirmQuit.description":
    "Fragt nach, bevor Cmd+Q Cetus beendet, damit ein Fehlgriff keine laufenden Agenten unterbricht.",
  "general.keepAwake.label": "Mac während der Arbeit wach halten",
  "general.keepAwake.description":
    "Verhindert den Ruhezustand, solange ein Agent-Durchlauf oder eine Meeting-Aufnahme läuft. Das Display schaltet sich weiterhin ab und sperrt sich; Zuklappen versetzt den Mac weiterhin in den Ruhezustand.",
  "nav.api-keys": "API-Schlüssel",
  "nav.memory": "Gedächtnis",
  "nav.skills": "Fähigkeiten",
  "nav.slash-commands": "Slash-Befehle",
  "nav.connectors": "MCP",
  "nav.launcher": "Launcher",
  "nav.voice": "Sprache",
  "nav.screen": "Bildschirmkontext",
  "notifications.event.meeting.label": "Meeting-Aufzeichnung",
  "notifications.event.meeting.description":
    "Transkription gestartet, und danach ist das Protokoll fertig.",
  "nav.meetings": "Meetings",
  "nav.agent-control": "Computer & Browser",
  "nav.appearance": "Erscheinungsbild",
  "nav.notifications": "Benachrichtigungen",
  "nav.permissions": "Berechtigungen",
  "nav.archived": "Archivierte Chats",

  "providers.deepseek": "DeepSeek",
  "providers.exa": "Exa (Websuche)",
  "providers.tavily": "Tavily (Websuche)",
  "providers.doubao": "Doubao (Sprache)",
  "providers.volcArk": "Volcano Ark (Umschreiben)",
  "apiKeys.title": "API-Schlüssel",
  "apiKeys.description":
    "Schlüssel werden im Schlüsselbund deines Betriebssystems gespeichert. Beim Speichern wird der pi-Subprozess neu gestartet, damit neue Schlüssel sofort wirksam werden.",
  "apiKeys.stored": "● gespeichert",
  "apiKeys.unsaved": "● ungespeichert",
  "apiKeys.replace": "Ersetzen",

  "notifications.title": "Benachrichtigungen",
  "notifications.description":
    "Erhalte eine Desktop-Benachrichtigung, wenn eine Hintergrundaufgabe abgeschlossen ist oder dich braucht — praktisch für lange Agenten-Läufe auf dem Board.",
  "notifications.enable.label": "Benachrichtigungen aktivieren",
  "notifications.enable.description":
    "Hauptschalter für alle Desktop-Benachrichtigungen.",
  "notifications.blocked":
    "Benachrichtigungen werden von deinem System blockiert. Erlaube sie für Cetus in den Einstellungen deines Betriebssystems.",
  "notifications.recheck": "Erneut prüfen",
  "notifications.notifyAbout": "Benachrichtige mich über",
  "notifications.behavior": "Verhalten",
  "notifications.mute.label": "Stummschalten, während Cetus im Fokus ist",
  "notifications.mute.description":
    "Nur benachrichtigen, wenn das Fenster im Hintergrund ist.",
  "notifications.event.task_finished.label": "Aufgabe abgeschlossen",
  "notifications.event.task_finished.description":
    "Ein Agenten-Lauf wurde abgeschlossen — eine Chat-Antwort, eine Board-Aufgabe oder eine geplante Automatisierung (ob erfolgreich oder mit Fehler).",
  "notifications.event.awaiting_input.label": "Benötigt deine Eingabe",
  "notifications.event.awaiting_input.description":
    "Der Agent wartet darauf, dass du auf eine Eingabeaufforderung antwortest.",

  "launcher.title": "Schnellstarter",
  "launcher.description":
    "Rufe von überall ein schwebendes Panel auf, um eine Sitzung zu starten — optional mit einem Screenshot deines Bildschirms als Kontext.",
  "launcher.needAccessibility":
    "Der Launcher benötigt Bedienungshilfen-Zugriff, um die ⌘-Geste systemweit zu erkennen.",
  "launcher.grantAccess": "Zugriff gewähren",
  "launcher.openSettings": "Einstellungen öffnen",
  "launcher.accessibilityGranted": "● Bedienungshilfen-Zugriff gewährt",
  "launcher.needScreenRecording":
    "Screenshots benötigen Bildschirmaufnahme-Zugriff — ohne ihn kann Cetus nur dein Hintergrundbild erfassen, nicht die Fenster auf dem Bildschirm.",
  "launcher.screenRecordingGranted": "● Bildschirmaufnahme-Zugriff gewährt",
  "launcher.macOnly": "Die globale ⌘-Geste ist nur unter macOS verfügbar.",
  "launcher.enable.label": "Schnellstarter aktivieren",
  "launcher.enable.description":
    "Auslöser: {gesture}. Funktioniert auch, wenn Cetus im Hintergrund ist.",
  "launcher.startup.label": "Beim Start ausführen",
  "launcher.startup.description":
    "Startet Cetus bei der Anmeldung automatisch in der Leiste.",
  "launcher.gesture.doubleCmd": "⌘ doppelt tippen",
  "launcher.gesture.bothCmd": "Beide ⌘-Tasten halten",
  "launcher.gesture.label": "Auslösegeste",
  "launcher.gesture.description": "Wie du das Panel von überall aufrufst.",
  "launcher.gesture.opt.both": "Beide ⌘",
  "launcher.gesture.opt.bothOpt": "Beide ⌥",
  "launcher.gesture.opt.double": "⌘ doppelt tippen",
  "launcher.gesture.opt.off": "Aus",
  "launcher.gesture.opt.doubleOpt": "Rechtes ⌥ doppelt tippen",
  "launcher.fn.plain.label": "Schnellstart",
  "launcher.fn.plain.description": "Öffnet den Launcher (ohne Screenshot).",
  "launcher.fn.shot.label": "Schnellstart + Screenshot",
  "launcher.fn.shot.description":
    "Öffnet den Launcher mit einem angehängten Screenshot deines Bildschirms.",
  "launcher.summon.label": "Cetus aufrufen",
  "launcher.summon.description":
    "Globales Tastenkürzel, um Cetus in den Vordergrund zu holen – wechselt bei Bedarf den Schreibtisch.",
  "launcher.summon.placeholder": "Kürzel festlegen",
  "launcher.summon.recording": "Tasten drücken…",
  "launcher.summon.clear": "Kürzel löschen",
  "launcher.session.label": "Standardsitzung",
  "launcher.session.description":
    "Beginne einen neuen Chat oder setze deinen letzten fort.",
  "launcher.session.opt.new": "Neu",
  "launcher.session.opt.last": "Letzter",
  "launcher.screenshot.label": "Standardmäßig Screenshot",
  "launcher.screenshot.description":
    "Erfasse den Bildschirm jedes Mal als Kontext, wenn das Panel geöffnet wird. Du kannst es weiterhin pro Start umschalten.",

  "appearance.title": "Erscheinungsbild",
  "appearance.description":
    "Lege das in Cetus verwendete Theme und die Schriftarten fest. Änderungen werden sofort übernommen.",
  "appearance.theme.label": "Theme",
  "appearance.theme.description":
    "Dem Systemerscheinungsbild folgen oder auf hell oder dunkel festlegen.",
  "appearance.permaLayers.label": "Flüssiges Hover-Rendering",
  "appearance.permaLayers.description":
    "Hält Hover-Überblendungen auf eigenen Compositing-Ebenen, damit Zeilen bei gebrochenem Zoom nicht zittern. Verbraucht zusätzlichen Grafikspeicher; zum Vergleich abschaltbar.",

  "voice.title": "Sprachdiktat",
  "voice.description":
    "Sprich, statt zu tippen. Wähle unten die Erkennungs-Engine und halte dann die Push-to-Talk-Taste, um in die fokussierte App zu diktieren.",
  "voice.macOnly": "Sprachdiktat ist nur unter macOS verfügbar.",
  "voice.needPerms": "Diktat benötigt Mikrofon- und Spracherkennungszugriff.",
  "voice.grantAccess": "Zugriff gewähren",
  "voice.openSettings": "Einstellungen öffnen",
  "voice.permsGranted": "● Mikrofon- und Spracherkennungszugriff gewährt",
  "voice.engine.label": "Erkennungs-Engine",
  "voice.engine.doubaoDesc":
    "Doubao (Volcano Engine) Echtzeit-Streaming — am schnellsten (~90ms), Live-Text während du sprichst, hervorragend bei gemischtem Chinesisch/Englisch, funktioniert in Festlandchina. Benötigt einen Doubao-API-Schlüssel (X-Api-Key).",
  "voice.engine.appleDesc":
    "Apple auf dem Gerät — sofort, Audio verlässt nie deinen Mac, aber schwächer beim Wechsel zwischen Chinesisch/Englisch.",
  "voice.engine.opt.doubao": "Doubao (Cloud)",
  "voice.engine.opt.apple": "Apple (auf dem Gerät)",
  "voice.gesture.rightOption": "Rechte ⌥",
  "voice.gesture.fn": "fn (Globus)",
  "voice.gesture.rightCmd": "Rechte ⌘",
  "voice.enable.label": "Systemweites Diktat",
  "voice.enable.description":
    "Halte überall {gesture}, um zu diktieren; loslassen, um den Text in die fokussierte App einzufügen.",
  "voice.needAccessibility":
    "Das Tippen in andere Apps benötigt Bedienungshilfen-Zugriff (dieselbe Berechtigung wie der Launcher).",
  "voice.triggerKey.label": "Auslösetaste",
  "voice.triggerKey.holdDesc":
    "Halte diesen Modifikator zum Sprechen (loslassen zum Einfügen); doppeltippe ihn für freihändig, wobei jeder Satz beim Beenden eingefügt wird — erneut doppeltippen zum Stoppen. Tasten der rechten Hand vermeiden Konflikte mit normalen Tastenkürzeln. Freihändig benötigt die Doubao-Engine.",
  "voice.triggerKey.opt.rightCmd": "Rechte ⌘",
  "voice.triggerKey.opt.rightOption": "Rechte ⌥",
  "voice.triggerKey.opt.fn": "fn",
  "voice.triggerKey.opt.capsLock": "Feststelltaste",
  "voice.triggerKey.capsNote":
    "Cetus belegt die Feststelltaste während der Ausführung mit dem Diktat und stellt sie beim Beenden wieder her.",
  "voice.insert.label": "Einfügen mit",
  "voice.insert.description":
    "Tippen sendet synthetische Tastenanschläge; Einfügen verwendet die Zwischenablage + ⌘V (in manchen Apps robuster, ersetzt kurzzeitig deine Zwischenablage).",
  "voice.insert.opt.type": "Tippen",
  "voice.insert.opt.paste": "Einfügen",
  "voice.cleanup.label": "Mit KI bereinigen",
  "voice.cleanup.description":
    "Nutze DeepSeek, um Füllwörter zu entfernen und die Zeichensetzung vor dem Einfügen zu korrigieren. Erfordert einen DeepSeek-API-Schlüssel. Nur Push-to-Talk — freihändig fügt jeden Satz live ein.",
  "voice.history.label": "Diktatverlauf speichern",
  "voice.history.description":
    "Führe ein Protokoll über das, was du diktierst, damit du — und der Agent (über das recall_dictation-Tool) — darauf zurückgreifen kannst. Standardmäßig aus.",
  "voice.history.empty":
    "Noch nichts diktiert — deine Transkripte erscheinen hier.",
  "voice.history.clear": "Verlauf löschen ({n})",

  "screen.title": "Bildschirmkontext",
  "screen.description":
    "Erfasse regelmäßig deinen Bildschirm und lies ihn auf dem Gerät (Apple Vision OCR), damit der Agent sich erinnern kann, woran du gearbeitet hast. Bilder und Text bleiben auf deinem Mac — nichts wird hochgeladen.",
  "screen.macOnly":
    "Die Bildschirmerfassung ist für macOS abgestimmt; die OCR auf dem Gerät nutzt Apple Vision.",
  "screen.browse": "Erfasste Frames durchsuchen",
  "screen.enable.label": "Bildschirmerfassung aktivieren",
  "screen.enable.description":
    "Standardmäßig aus. Wenn aktiviert, erfasst Cetus den Bildschirm im Hintergrund per Timer.",
  "screen.interval.label": "Erfassungsintervall",
  "screen.interval.description":
    "Sekunden zwischen den Erfassungen. Nahezu identische Frames werden automatisch übersprungen.",
  "screen.interval.unit": "Sek.",
  "screen.retention.label": "Verlauf behalten für",
  "screen.retention.description":
    "Ältere Frames werden von der Festplatte gelöscht. Setze 0, um sie für immer zu behalten.",
  "screen.retention.unit": "Tage",
  "screen.ocr.label": "Text auf dem Gerät lesen (OCR)",
  "screen.ocr.description":
    "Nutze Apple Vision, um Text auf dem Bildschirm zu extrahieren, damit der Agent ihn durchsuchen kann. Läuft lokal.",
  "screen.excluded.label": "Ausgeschlossene Apps",
  "screen.excluded.description":
    "Durch Kommas getrennte App-Namen oder Bundle-IDs. Die Erfassung wird übersprungen, solange eine davon im Vordergrund ist (z. B. 1Password, Nachrichten).",
  "screen.frames.one":
    "{count} Frame erfasst · macOS fragt beim ersten Erfassen nach der Bildschirmaufnahme-Berechtigung.",
  "screen.frames.other":
    "{count} Frames erfasst · macOS fragt beim ersten Erfassen nach der Bildschirmaufnahme-Berechtigung.",

  "agentControl.title": "Computer- & Browser-Steuerung",
  "agentControl.description":
    "Erlaubt dem Agenten, deinen Browser und Mac-Apps zu steuern. Erfordert Bedienungshilfen (und Bildschirmaufnahme für die Live-Ansicht).",
  "agentControl.browser.label": "Browser-Steuerung aktivieren",
  "agentControl.browser.description":
    "Fügt die browser_*-Tools und den indexbasierten Steuerungs-Prompt zum Steuern eines Webbrowsers hinzu. Der Agent bestätigt folgenreiche Aktionen und du kannst ihn jederzeit stoppen.",
  "agentControl.computer.label": "Computer-Steuerung aktivieren",
  "agentControl.computer.description":
    "Fügt die computer_*-Tools hinzu, um die Apps dieses Macs über die Bedienungshilfen zu steuern. Der Agent bestätigt folgenreiche Aktionen und du kannst ihn jederzeit stoppen.",
  "agentControl.ax.label": "Bedienungshilfen-Zugriff",
  "agentControl.ax.notGranted":
    "Nicht gewährt — der Agent kann App-Oberflächen nicht lesen oder per Index klicken/tippen.",
  "agentControl.ax.granted": "Gewährt.",
  "agentControl.checking": "Wird geprüft…",
  "agentControl.enabled": "Aktiviert",
  "agentControl.grant": "Gewähren",
  "agentControl.openSettings": "Einstellungen öffnen",
  "agentControl.screen.label": "Bildschirmaufnahme-Zugriff",
  "agentControl.screen.notGranted":
    "Nicht gewährt — die Live-Screenshot-Vorschau wird nicht angezeigt.",
  "agentControl.screen.granted": "Gewährt.",
  "agentControl.footnote":
    "Der Agent handelt über nummerierte Elementlisten, nie über rohe Pixel, und fragt vor allem Folgenreichen nach (Senden, Löschen, Kaufen, Absenden, Authentifizieren). Während er aktiv ist, erscheint im Chat eine Stopp-Schaltfläche.",

  "archived.title": "Archivierte Chats",
  "archived.description":
    "Unterhaltungen, die du aus der Seitenleiste archiviert hast. Stelle eine wieder her, um sie zurückzuholen, oder lösche alle, um Speicherplatz freizugeben — das Löschen ist endgültig.",
  "archived.loading": "Wird geladen…",
  "archived.empty": "Keine archivierten Chats.",
  "archived.count.one": "{count} archivierter Chat",
  "archived.count.other": "{count} archivierte Chats",
  "archived.deleteAllPrompt": "Alle {count} löschen?",
  "archived.deleting": "Wird gelöscht…",
  "archived.deleteAll": "Alle löschen",
  "archived.untitled": "Ohne Titel",
  "archived.archivedOn": "Archiviert am {date}",
  "archived.restore": "Wiederherstellen",
  "archived.deleteAria": "Chat löschen",

  "memory.title": "Gedächtnis",
  "memory.description":
    "Dauerhafte Notizen über dich — deine Vorlieben, laufenden Projekte und Entscheidungen —, die der Agent über Gespräche hinweg mitnimmt. Der Agent ergänzt sie, während er lernt; du kannst sie hier hinzufügen, bearbeiten, stummschalten oder löschen.",
  "memory.enable.label": "Gedächtnis aktivieren",
  "memory.enable.description":
    "Wenn aktiviert, werden die unten aktivierten Notizen in jeder Runde in den Kontext des Agenten eingefügt. Schalte es aus, um das Gedächtnis zu pausieren, ohne deine Notizen zu verlieren.",
  "memory.add.label": "Erinnerung hinzufügen",
  "memory.add.placeholder":
    "z. B. Bevorzugt pnpm gegenüber npm und prägnante Commit-Nachrichten.",
  "memory.category.placeholder": "Kategorie (optional)",
  "memory.adding": "Wird hinzugefügt…",
  "memory.add.button": "Hinzufügen",
  "memory.loading": "Wird geladen…",
  "memory.empty": "Noch keine Erinnerungen",
  "memory.count.one": "{count} Erinnerung",
  "memory.count.other": "{count} Erinnerungen",
  "memory.deleteAllPrompt": "Alle löschen?",
  "memory.clearAll": "Alle löschen",
  "memory.saving": "Wird gespeichert…",
  "memory.save": "Speichern",
  "memory.tag.agent": "Agent",
  "memory.tag.you": "Du",
  "memory.editedOn": "Bearbeitet am {date}",
  "memory.muteAria": "Erinnerung stummschalten",
  "memory.enableAria": "Erinnerung aktivieren",
  "memory.editAria": "Erinnerung bearbeiten",
  "memory.deleteAria": "Erinnerung löschen",

  "skills.title": "Fähigkeiten",
  "skills.description":
    "Wiederverwendbare Anweisungen, die der Agent bei Bedarf heranziehen kann — ein Ordner mit einer SKILL.md (Name + Beschreibung + Schritte), gemäß dem offenen Agent-Skills-Standard. Installiere eine aus einem Ordner oder schreibe deine eigene; aktivierte Fähigkeiten werden dem Agenten in jeder Runde angeboten.",
  "skills.enable.label": "Fähigkeiten aktivieren",
  "skills.enable.description":
    "Wenn aktiviert, werden die unten aktivierten Fähigkeiten dem Agenten zur Verfügung gestellt. Schalte es aus, um alle Fähigkeiten zu pausieren, ohne sie zu deinstallieren.",
  "skills.importing": "Wird importiert…",
  "skills.import": "Ordner importieren",
  "skills.write": "Eine schreiben",
  "skills.learn": "Mehr über Fähigkeiten",
  "skills.loading": "Wird geladen…",
  "skills.empty": "Keine Fähigkeiten installiert",
  "skills.count.one": "{count} Fähigkeit",
  "skills.count.other": "{count} Fähigkeiten",
  "skills.source.written": "Geschrieben",
  "skills.source.imported": "Importiert",
  "skills.source.proposed": "Vorgeschlagen",
  "skills.source.byAgent": "Vom Agent",
  "skills.updatedOn": "Aktualisiert am {date}",
  "skills.disableAria": "Fähigkeit deaktivieren",
  "skills.enableAria": "Fähigkeit aktivieren",
  "skills.openFolderAria": "Fähigkeitsordner öffnen",
  "skills.delete": "Löschen",
  "skills.uninstallAria": "Fähigkeit deinstallieren",
  "skills.editor.title": "Eine Fähigkeit schreiben",
  "skills.editor.namePlaceholder": "Name, z. B. Stil der Commit-Nachrichten",
  "skills.editor.descPlaceholder":
    "Wann soll der Agent sie verwenden? (eine Zeile)",
  "skills.editor.bodyPlaceholder":
    "Die Fähigkeit selbst, in Markdown. Schritte, Beispiele, Regeln…",
  "skills.editor.saving": "Wird gespeichert…",
  "skills.editor.create": "Fähigkeit erstellen",

  "connectors.title": "MCP",
  "connectors.description":
    "Verbinde den Agenten über MCP-Server (Model Context Protocol) mit externen Tools — einem lokalen Befehl oder einer entfernten URL. Füge einen Server hinzu und teste ihn, um einen echten Handshake auszuführen und die angebotenen Tools zu sehen. Die Tools jedes aktivierten MCP-Servers werden in den Agenten geladen, damit er sie wie seine eingebauten Tools aufrufen kann; Änderungen werden in neuen Gesprächen wirksam.",
  "connectors.loading": "Wird geladen…",
  "connectors.empty": "Noch keine MCP-Server",
  "connectors.count.one": "{count} MCP-Server",
  "connectors.count.other": "{count} MCP-Server",
  "connectors.add": "MCP-Server hinzufügen",
  "connectors.disableAria": "MCP-Server deaktivieren",
  "connectors.enableAria": "MCP-Server aktivieren",
  "connectors.editAria": "MCP-Server bearbeiten",
  "connectors.removeAria": "MCP-Server entfernen",
  "connectors.editor.name": "Name",
  "connectors.editor.namePlaceholder": "z. B. GitHub, Filesystem, Linear…",
  "connectors.editor.transport": "Transport",
  "connectors.editor.transportDesc":
    "Ein lokaler Prozess (stdio) oder ein entfernter MCP-Endpunkt (HTTP/SSE).",
  "connectors.editor.command": "Befehl",
  "connectors.editor.commandPlaceholder": "z. B. npx",
  "connectors.editor.args": "Argumente",
  "connectors.editor.argsHint": "eines pro Zeile",
  "connectors.editor.env": "Umgebung",
  "connectors.editor.envHint": "an den Prozess übergeben",
  "connectors.editor.url": "URL",
  "connectors.editor.headers": "Header",
  "connectors.editor.headersHint": "bei jeder Anfrage gesendet",
  "connectors.test.connected": "Verbunden",
  "connectors.test.tools.one": "{count} Tool: {names}",
  "connectors.test.tools.other": "{count} Tools: {names}",
  "connectors.test.noTools":
    "Handshake OK — der Server stellt keine Tools bereit.",
  "connectors.test.failed": "Verbindung fehlgeschlagen.",
  "connectors.editor.saving": "Wird gespeichert…",
  "connectors.testing": "Wird getestet…",
  "connectors.test.button": "Testen",
  "connectors.editor.envName": "SCHLÜSSEL",
  "connectors.editor.envValue": "Wert",
  "connectors.editor.addEnv": "Variable hinzufügen",
  "connectors.editor.headerName": "Name",
  "connectors.editor.headerValue": "Wert",
  "connectors.editor.addHeader": "Header hinzufügen",
  "connectors.editor.removeRow": "Entfernen",
  "connectors.details.toggleAria": "Tools ein-/ausblenden",
  "connectors.details.loading": "Tools werden geladen…",
  "connectors.details.connected": "Verbunden",
  "connectors.details.toolCount.one": "{count} Tool",
  "connectors.details.toolCount.other": "{count} Tools",
  "connectors.oauth.auth": "Authentifizierung",
  "connectors.oauth.authDesc":
    "Statische Header oder OAuth (Cetus führt die Anmeldung aus).",
  "connectors.oauth.none": "Keine",
  "connectors.oauth.clientId": "Client-ID",
  "connectors.oauth.clientIdPlaceholder": "auto (dynamische Registrierung)",
  "connectors.oauth.scope": "Scope",
  "connectors.oauth.optional": "optional",
  "connectors.oauth.authorize": "Autorisieren",
  "connectors.oauth.authorizing": "Autorisierung…",
  "connectors.oauth.authorized": "Autorisiert — Tokens zwischengespeichert.",
  "connectors.oauth.hint": "Öffnet den Browser zur Anmeldung.",
  "connectors.oauth.saveHint":
    "MCP-Server speichern, unten ausklappen und auf Autorisieren klicken.",
  "discovery.mcp.none": "Keine Server gefunden (Konfigdatei fehlt).",
  "discovery.mcp.title": "Aus anderen Apps importieren",
  "discovery.mcp.description":
    "Lädt auch in diesen Apps konfigurierte MCP-Server. Gilt nur für neue Chats.",
  "skills.discovered.loadLabel": "Entdeckte Skills laden",
  "skills.discovered.loadDesc":
    "Skills aus dem Ordner unten in neue Chats einbeziehen.",
  "skills.discovered.chooseFolder": "Ordner wählen",
};
