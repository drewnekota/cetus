export const it = {
  "models.model.reasoningHint":
    "Attiva Ragionamento per i modelli con un parametro di sforzo e abilita i livelli supportati dal tuo endpoint. Ogni livello invia il proprio nome per impostazione predefinita; digita un token per sovrascriverlo. In «Formato» scegli la forma del campo attesa dal fornitore; i livelli disabilitati vengono ricondotti al più vicino abilitato.",
  "models.model.format": "Formato",
  "models.model.reasoning": "Ragionamento",
  "nav.models": "Modelli",
  "models.title": "Modelli",
  "models.description":
    "Aggiungi i tuoi provider di modelli compatibili con OpenAI: una URL base, una chiave API e gli id dei modelli. I modelli compariranno nel selettore della chat accanto a quelli integrati.",
  "models.empty": "Nessun provider personalizzato per ora.",
  "models.add": "Aggiungi provider",
  "models.noKey": "Nessuna chiave",
  "models.footnote":
    "Le attività in background (titoli automatici, note delle riunioni) usano DeepSeek se la sua chiave è configurata, altrimenti il primo provider personalizzato.",
  "models.name.label": "Nome",
  "models.name.placeholder": "OpenRouter, il mio server vLLM…",
  "models.baseUrl.label": "URL base",
  "models.baseUrl.hint":
    "Endpoint compatibile OpenAI, senza /chat/completions.",
  "models.key.label": "Chiave API",
  "models.key.placeholder": "sk-… (vuoto per endpoint locali)",
  "models.key.keepStored": "•••••••• (salvata — digita per sostituire)",
  "models.models.label": "Modelli",
  "models.model.idPlaceholder": "id del modello",
  "models.model.namePlaceholder": "nome visualizzato (facoltativo)",
  "models.model.vision": "Visione",
  "models.model.visionHint":
    "Attiva Visione per i modelli che accettano immagini: gli allegati vengono inviati direttamente al modello anziché essere prima trascritti.",
  "models.model.add": "Aggiungi modello",
  "page.title": "Impostazioni",

  "group.general": "Generale",
  "group.intelligence": "Intelligenza",
  "group.inputCapture": "Input e acquisizione",
  "group.app": "App",
  "group.data": "Dati",
  "nav.general": "Generale",
  "general.title": "Generale",
  "general.description": "Lingua e impostazioni di base dell'app.",
  "general.autoSortConversations.label": "Sposta in alto le chat attive",
  "general.autoSortConversations.description":
    "Riordina le chat quando arrivano nuovi messaggi. Disattiva per mantenere l'ordine di creazione, con le nuove chat in alto.",
  "general.autoUpdate.label": "Aggiornamenti automatici",
  "general.autoUpdate.description":
    "Cerca e installa gli aggiornamenti in background. Applicati al prossimo avvio di Cetus.",
  "general.confirmQuit.label": "Conferma prima di uscire",
  "general.confirmQuit.description":
    "Chiede conferma prima che Cmd+Q chiuda Cetus, così un tocco involontario non interrompe gli agenti in esecuzione.",
  "nav.api-keys": "Chiavi API",
  "nav.memory": "Memoria",
  "nav.skills": "Competenze",
  "nav.slash-commands": "Comandi slash",
  "nav.connectors": "MCP",
  "nav.launcher": "Launcher",
  "nav.voice": "Voce",
  "nav.screen": "Contesto schermo",
  "notifications.event.meeting.label": "Registrazione riunione",
  "notifications.event.meeting.description":
    "La trascrizione è iniziata e dopo il verbale è pronto.",
  "nav.meetings": "Riunioni",
  "nav.agent-control": "Computer e browser",
  "nav.appearance": "Aspetto",
  "nav.notifications": "Notifiche",
  "nav.permissions": "Autorizzazioni",
  "nav.archived": "Chat archiviate",

  "providers.deepseek": "DeepSeek",
  "providers.exa": "Exa (ricerca web)",
  "providers.tavily": "Tavily (ricerca web)",
  "providers.doubao": "Doubao (voce)",
  "providers.volcArk": "Volcano Ark (riscrittura)",
  "apiKeys.title": "Chiavi API",
  "apiKeys.description":
    "Le chiavi sono memorizzate nel portachiavi del tuo sistema operativo. Il salvataggio riavvia il sottoprocesso pi affinché le nuove chiavi abbiano effetto immediato.",
  "apiKeys.stored": "● memorizzata",
  "apiKeys.unsaved": "● non salvata",
  "apiKeys.replace": "Sostituisci",

  "notifications.title": "Notifiche",
  "notifications.description":
    "Ricevi una notifica desktop quando un'attività in background termina o ha bisogno di te — utile per lunghe esecuzioni dell'agente sulla board.",
  "notifications.enable.label": "Abilita le notifiche",
  "notifications.enable.description":
    "Interruttore principale per tutte le notifiche desktop.",
  "notifications.blocked":
    "Le notifiche sono bloccate dal tuo sistema. Consentile per Cetus nelle impostazioni del sistema operativo.",
  "notifications.recheck": "Ricontrolla",
  "notifications.notifyAbout": "Avvisami riguardo a",
  "notifications.behavior": "Comportamento",
  "notifications.mute.label": "Silenzia mentre Cetus è in primo piano",
  "notifications.mute.description":
    "Avvisa solo quando la finestra è in background.",
  "notifications.event.task_finished.label": "Attività completata",
  "notifications.event.task_finished.description":
    "Un'esecuzione dell'agente è terminata — una risposta in chat, un'attività sulla board o un'automazione pianificata (riuscita o con errore).",
  "notifications.event.awaiting_input.label": "Richiede il tuo input",
  "notifications.event.awaiting_input.description":
    "L'agente sta aspettando che tu risponda a una richiesta.",

  "launcher.title": "Avvio rapido",
  "launcher.description":
    "Richiama da qualsiasi punto un pannello fluttuante per avviare una sessione — facoltativamente con uno screenshot del tuo schermo come contesto.",
  "launcher.needAccessibility":
    "Il launcher richiede l'accesso all'Accessibilità per rilevare il gesto ⌘ a livello di sistema.",
  "launcher.grantAccess": "Concedi l'accesso",
  "launcher.openSettings": "Apri Impostazioni",
  "launcher.accessibilityGranted": "● Accesso all'Accessibilità concesso",
  "launcher.needScreenRecording":
    "Gli screenshot richiedono l'accesso alla Registrazione schermo — senza di esso Cetus può catturare solo lo sfondo, non le finestre sullo schermo.",
  "launcher.screenRecordingGranted":
    "● Accesso alla Registrazione schermo concesso",
  "launcher.macOnly": "Il gesto ⌘ globale è disponibile solo su macOS.",
  "launcher.enable.label": "Abilita l'avvio rapido",
  "launcher.enable.description":
    "Attivatore: {gesture}. Funziona anche quando Cetus è in background.",
  "launcher.startup.label": "Avvia all'avvio",
  "launcher.startup.description":
    "Avvia Cetus nella barra automaticamente all'accesso.",
  "launcher.gesture.doubleCmd": "Tocca due volte ⌘",
  "launcher.gesture.bothCmd": "Tieni premuti entrambi i tasti ⌘",
  "launcher.gesture.label": "Gesto di attivazione",
  "launcher.gesture.description":
    "Come richiami il pannello da qualsiasi punto.",
  "launcher.gesture.opt.both": "Entrambi i ⌘",
  "launcher.gesture.opt.bothOpt": "Entrambi gli ⌥",
  "launcher.gesture.opt.double": "Tocca due volte ⌘",
  "launcher.gesture.opt.off": "Disattivato",
  "launcher.gesture.opt.doubleOpt": "Tocca due volte ⌥ destro",
  "launcher.fn.plain.label": "Avvio rapido",
  "launcher.fn.plain.description": "Apre il launcher (senza screenshot).",
  "launcher.fn.shot.label": "Avvio rapido + screenshot",
  "launcher.fn.shot.description":
    "Apre il launcher con uno screenshot dello schermo allegato.",
  "launcher.summon.label": "Richiama Cetus",
  "launcher.summon.description":
    "Scorciatoia globale per portare Cetus in primo piano, cambiando scrivania se si trova su un'altra.",
  "launcher.summon.placeholder": "Imposta scorciatoia",
  "launcher.summon.recording": "Premi i tasti…",
  "launcher.summon.clear": "Cancella scorciatoia",
  "launcher.session.label": "Sessione predefinita",
  "launcher.session.description":
    "Avvia una nuova chat o continua la più recente.",
  "launcher.session.opt.new": "Nuova",
  "launcher.session.opt.last": "Ultima",
  "launcher.screenshot.label": "Screenshot per impostazione predefinita",
  "launcher.screenshot.description":
    "Cattura lo schermo come contesto ogni volta che il pannello si apre. Puoi comunque attivarlo o disattivarlo a ogni avvio.",

  "appearance.title": "Aspetto",
  "appearance.description":
    "Imposta il tema e i caratteri usati in tutto cetus. Le modifiche si applicano immediatamente.",
  "appearance.theme.label": "Tema",
  "appearance.theme.description":
    "Segui l'aspetto del sistema o blocca su chiaro o scuro.",
  "appearance.permaLayers.label": "Rendering fluido al passaggio del mouse",
  "appearance.permaLayers.description":
    "Mantiene le dissolvenze hover su livelli di composizione dedicati per evitare tremolii delle righe con zoom frazionario. Usa più memoria grafica; disattiva per confrontare.",

  "voice.title": "Dettatura vocale",
  "voice.description":
    "Parla invece di scrivere. Scegli il motore di riconoscimento qui sotto, poi tieni premuto il tasto push-to-talk per dettare nell'app attiva.",
  "voice.macOnly": "La dettatura vocale è disponibile solo su macOS.",
  "voice.needPerms":
    "La dettatura richiede l'accesso a Microfono e Riconoscimento vocale.",
  "voice.grantAccess": "Concedi l'accesso",
  "voice.openSettings": "Apri Impostazioni",
  "voice.permsGranted":
    "● Accesso a Microfono e Riconoscimento vocale concesso",
  "voice.engine.label": "Motore di riconoscimento",
  "voice.engine.doubaoDesc":
    "Doubao (Volcano Engine) streaming in tempo reale — il più veloce (~90ms), testo dal vivo mentre parli, ottimo con cinese/inglese misti, funziona nella Cina continentale. Richiede una chiave API Doubao (X-Api-Key).",
  "voice.engine.appleDesc":
    "Apple sul dispositivo — istantaneo, l'audio non lascia mai il tuo Mac, ma più debole con l'alternanza cinese/inglese.",
  "voice.engine.opt.doubao": "Doubao (cloud)",
  "voice.engine.opt.apple": "Apple (sul dispositivo)",
  "voice.gesture.rightOption": "⌥ destro",
  "voice.gesture.fn": "fn (Globo)",
  "voice.gesture.rightCmd": "⌘ destro",
  "voice.enable.label": "Dettatura a livello di sistema",
  "voice.enable.description":
    "Tieni premuto {gesture} ovunque per dettare; rilascia per inserire il testo nell'app attiva.",
  "voice.needAccessibility":
    "Per digitare in altre app è necessario l'accesso all'Accessibilità (la stessa autorizzazione usata dal launcher).",
  "voice.triggerKey.label": "Tasto di attivazione",
  "voice.triggerKey.holdDesc":
    "Tieni premuto questo modificatore per parlare (rilascia per inserire); toccalo due volte per la modalità a mani libere, dove ogni frase viene inserita appena la concludi — tocca di nuovo due volte per fermare. I tasti della mano destra evitano conflitti con le scorciatoie normali. La modalità a mani libere richiede il motore Doubao.",
  "voice.triggerKey.opt.rightCmd": "⌘ destro",
  "voice.triggerKey.opt.rightOption": "⌥ destro",
  "voice.triggerKey.opt.fn": "fn",
  "voice.triggerKey.opt.capsLock": "Bloc Maiusc",
  "voice.triggerKey.capsNote":
    "Cetus riassegna Bloc Maiusc alla dettatura mentre è in esecuzione e la ripristina alla chiusura.",
  "voice.insert.label": "Inserisci con",
  "voice.insert.description":
    "Digita invia battiture sintetiche; Incolla usa gli appunti + ⌘V (più robusto in alcune app, sostituisce brevemente i tuoi appunti).",
  "voice.insert.opt.type": "Digita",
  "voice.insert.opt.paste": "Incolla",
  "voice.cleanup.label": "Ripulisci con l'IA",
  "voice.cleanup.description":
    "Usa DeepSeek per rimuovere i riempitivi e correggere la punteggiatura prima di inserire. Richiede una chiave API DeepSeek. Solo push-to-talk — la modalità a mani libere inserisce ogni frase dal vivo.",
  "voice.history.label": "Salva la cronologia della dettatura",
  "voice.history.description":
    "Conserva un registro di ciò che detti così che tu — e l'agente (tramite lo strumento recall_dictation) — possiate farvi riferimento. Disattivato per impostazione predefinita.",
  "voice.history.empty":
    "Niente dettato ancora — le tue trascrizioni appariranno qui.",
  "voice.history.clear": "Cancella cronologia ({n})",

  "screen.title": "Contesto schermo",
  "screen.description":
    "Cattura periodicamente il tuo schermo e leggilo sul dispositivo (Apple Vision OCR) così che l'agente possa ricordare a cosa stavi lavorando. Immagini e testo restano sul tuo Mac — nulla viene caricato.",
  "screen.macOnly":
    "La cattura dello schermo è ottimizzata per macOS; l'OCR sul dispositivo usa Apple Vision.",
  "screen.browse": "Sfoglia i frame catturati",
  "screen.enable.label": "Abilita la cattura dello schermo",
  "screen.enable.description":
    "Disattivata per impostazione predefinita. Quando attiva, Cetus cattura lo schermo a intervalli in background.",
  "screen.interval.label": "Intervallo di cattura",
  "screen.interval.description":
    "Secondi tra le catture. I frame quasi identici vengono saltati automaticamente.",
  "screen.interval.unit": "sec",
  "screen.retention.label": "Conserva la cronologia per",
  "screen.retention.description":
    "I frame più vecchi vengono eliminati dal disco. Imposta 0 per conservarli per sempre.",
  "screen.retention.unit": "giorni",
  "screen.ocr.label": "Leggi il testo sul dispositivo (OCR)",
  "screen.ocr.description":
    "Usa Apple Vision per estrarre il testo sullo schermo così che l'agente possa cercarlo. Viene eseguito localmente.",
  "screen.excluded.label": "App escluse",
  "screen.excluded.description":
    "Nomi di app o bundle id separati da virgole. La cattura viene saltata mentre una di queste è in primo piano (es. 1Password, Messaggi).",
  "screen.frames.one":
    "{count} frame catturato · macOS chiede l'autorizzazione alla Registrazione schermo alla prima cattura.",
  "screen.frames.other":
    "{count} frame catturati · macOS chiede l'autorizzazione alla Registrazione schermo alla prima cattura.",

  "agentControl.title": "Controllo computer e browser",
  "agentControl.description":
    "Consente all'agente di pilotare il tuo browser e le app Mac. Richiede l'Accessibilità (e la Registrazione schermo per la vista dal vivo).",
  "agentControl.browser.label": "Abilita il controllo del browser",
  "agentControl.browser.description":
    "Aggiunge gli strumenti browser_* e il prompt di controllo basato su indici per pilotare un browser web. L'agente conferma le azioni rilevanti e puoi fermarlo in qualsiasi momento.",
  "agentControl.computer.label": "Abilita il controllo del computer",
  "agentControl.computer.description":
    "Aggiunge gli strumenti computer_* per controllare le app di questo Mac tramite l'accessibilità. L'agente conferma le azioni rilevanti e puoi fermarlo in qualsiasi momento.",
  "agentControl.ax.label": "Accesso all'Accessibilità",
  "agentControl.ax.notGranted":
    "Non concesso — l'agente non può leggere le interfacce delle app né cliccare/digitare per indice.",
  "agentControl.ax.granted": "Concesso.",
  "agentControl.checking": "Verifica in corso…",
  "agentControl.enabled": "Abilitato",
  "agentControl.grant": "Concedi",
  "agentControl.openSettings": "Apri Impostazioni",
  "agentControl.screen.label": "Accesso alla Registrazione schermo",
  "agentControl.screen.notGranted":
    "Non concesso — l'anteprima dello screenshot dal vivo non verrà mostrata.",
  "agentControl.screen.granted": "Concesso.",
  "agentControl.footnote":
    "L'agente agisce tramite elenchi numerati di elementi, mai pixel grezzi, e chiede prima di qualsiasi azione rilevante (inviare, eliminare, acquistare, inoltrare, autenticare). Mentre è attivo, nella chat compare un pulsante Ferma.",

  "archived.title": "Chat archiviate",
  "archived.description":
    "Conversazioni che hai archiviato dalla barra laterale. Ripristinane una per riaverla, o cancellale tutte per liberare spazio — l'eliminazione è definitiva.",
  "archived.loading": "Caricamento…",
  "archived.empty": "Nessuna chat archiviata.",
  "archived.count.one": "{count} chat archiviata",
  "archived.count.other": "{count} chat archiviate",
  "archived.deleteAllPrompt": "Eliminare tutte le {count}?",
  "archived.deleting": "Eliminazione…",
  "archived.deleteAll": "Elimina tutte",
  "archived.untitled": "Senza titolo",
  "archived.archivedOn": "Archiviata il {date}",
  "archived.restore": "Ripristina",
  "archived.deleteAria": "Elimina chat",

  "memory.title": "Memoria",
  "memory.description":
    "Note durevoli su di te — le tue preferenze, i progetti in corso e le decisioni — che l'agente porta con sé tra le conversazioni. L'agente le integra man mano che apprende; qui puoi aggiungerle, modificarle, silenziarle o eliminarle.",
  "memory.enable.label": "Abilita la memoria",
  "memory.enable.description":
    "Quando è attiva, le note abilitate qui sotto vengono iniettate nel contesto dell'agente a ogni turno. Disattivala per mettere in pausa la memoria senza perdere le tue note.",
  "memory.add.label": "Aggiungi una memoria",
  "memory.add.placeholder":
    "es. Preferisce pnpm a npm e messaggi di commit concisi.",
  "memory.category.placeholder": "Categoria (facoltativa)",
  "memory.adding": "Aggiunta in corso…",
  "memory.add.button": "Aggiungi",
  "memory.loading": "Caricamento…",
  "memory.empty": "Ancora nessuna memoria",
  "memory.count.one": "{count} memoria",
  "memory.count.other": "{count} memorie",
  "memory.deleteAllPrompt": "Eliminare tutto?",
  "memory.clearAll": "Cancella tutto",
  "memory.saving": "Salvataggio…",
  "memory.save": "Salva",
  "memory.tag.agent": "Agente",
  "memory.tag.you": "Tu",
  "memory.editedOn": "Modificata il {date}",
  "memory.muteAria": "Silenzia memoria",
  "memory.enableAria": "Abilita memoria",
  "memory.editAria": "Modifica memoria",
  "memory.deleteAria": "Elimina memoria",

  "skills.title": "Competenze",
  "skills.description":
    "Istruzioni riutilizzabili che l'agente può richiamare all'occorrenza — una cartella con un SKILL.md (nome + descrizione + passaggi), secondo lo standard aperto Agent Skills. Installane una da una cartella o scrivi la tua; le competenze abilitate vengono offerte all'agente a ogni turno.",
  "skills.enable.label": "Abilita le competenze",
  "skills.enable.description":
    "Quando è attivo, le competenze abilitate qui sotto vengono messe a disposizione dell'agente. Disattivalo per mettere in pausa tutte le competenze senza disinstallarle.",
  "skills.importing": "Importazione…",
  "skills.import": "Importa cartella",
  "skills.write": "Scrivine una",
  "skills.learn": "Scopri le competenze",
  "skills.loading": "Caricamento…",
  "skills.empty": "Nessuna competenza installata",
  "skills.count.one": "{count} competenza",
  "skills.count.other": "{count} competenze",
  "skills.source.written": "Scritta",
  "skills.source.imported": "Importata",
  "skills.source.proposed": "Proposta",
  "skills.source.byAgent": "Dall'agente",
  "skills.updatedOn": "Aggiornata il {date}",
  "skills.disableAria": "Disabilita competenza",
  "skills.enableAria": "Abilita competenza",
  "skills.openFolderAria": "Apri cartella competenza",
  "skills.delete": "Elimina",
  "skills.uninstallAria": "Disinstalla competenza",
  "skills.editor.title": "Scrivi una competenza",
  "skills.editor.namePlaceholder": "Nome, es. Stile dei messaggi di commit",
  "skills.editor.descPlaceholder":
    "Quando dovrebbe usarla l'agente? (una riga)",
  "skills.editor.bodyPlaceholder":
    "La competenza stessa, in markdown. Passaggi, esempi, regole…",
  "skills.editor.saving": "Salvataggio…",
  "skills.editor.create": "Crea competenza",

  "connectors.title": "MCP",
  "connectors.description":
    "Collega l'agente a strumenti esterni tramite server MCP (Model Context Protocol) — un comando locale o una URL remota. Aggiungi un server e usa Testa per eseguire un vero handshake e vedere gli strumenti che offre. Gli strumenti di ogni server MCP abilitato vengono caricati nell'agente così che possa richiamarli come quelli integrati; le modifiche hanno effetto nelle nuove conversazioni.",
  "connectors.loading": "Caricamento…",
  "connectors.empty": "Ancora nessun server MCP",
  "connectors.count.one": "{count} server MCP",
  "connectors.count.other": "{count} server MCP",
  "connectors.add": "Aggiungi server MCP",
  "connectors.disableAria": "Disabilita server MCP",
  "connectors.enableAria": "Abilita server MCP",
  "connectors.editAria": "Modifica server MCP",
  "connectors.removeAria": "Rimuovi server MCP",
  "connectors.editor.name": "Nome",
  "connectors.editor.namePlaceholder": "es. GitHub, Filesystem, Linear…",
  "connectors.editor.transport": "Trasporto",
  "connectors.editor.transportDesc":
    "Un processo locale (stdio) o un endpoint MCP remoto (HTTP/SSE).",
  "connectors.editor.command": "Comando",
  "connectors.editor.commandPlaceholder": "es. npx",
  "connectors.editor.args": "Argomenti",
  "connectors.editor.argsHint": "uno per riga",
  "connectors.editor.env": "Ambiente",
  "connectors.editor.envHint": "passato al processo",
  "connectors.editor.url": "URL",
  "connectors.editor.headers": "Intestazioni",
  "connectors.editor.headersHint": "inviato a ogni richiesta",
  "connectors.test.connected": "Connesso",
  "connectors.test.tools.one": "{count} strumento: {names}",
  "connectors.test.tools.other": "{count} strumenti: {names}",
  "connectors.test.noTools":
    "Handshake OK — il server non espone alcuno strumento.",
  "connectors.test.failed": "Connessione fallita.",
  "connectors.editor.saving": "Salvataggio…",
  "connectors.testing": "Test in corso…",
  "connectors.test.button": "Testa",
  "connectors.editor.envName": "CHIAVE",
  "connectors.editor.envValue": "valore",
  "connectors.editor.addEnv": "Aggiungi variabile",
  "connectors.editor.headerName": "Nome",
  "connectors.editor.headerValue": "Valore",
  "connectors.editor.addHeader": "Aggiungi header",
  "connectors.editor.removeRow": "Rimuovi",
  "connectors.details.toggleAria": "Mostra strumenti",
  "connectors.details.loading": "Caricamento strumenti…",
  "connectors.details.connected": "Connesso",
  "connectors.details.toolCount.one": "{count} strumento",
  "connectors.details.toolCount.other": "{count} strumenti",
  "connectors.oauth.auth": "Autenticazione",
  "connectors.oauth.authDesc":
    "Header statici o OAuth (Cetus esegue l’accesso).",
  "connectors.oauth.none": "Nessuna",
  "connectors.oauth.clientId": "Client ID",
  "connectors.oauth.clientIdPlaceholder": "auto (registrazione dinamica)",
  "connectors.oauth.scope": "Scope",
  "connectors.oauth.optional": "facoltativo",
  "connectors.oauth.authorize": "Autorizza",
  "connectors.oauth.authorizing": "Autorizzazione…",
  "connectors.oauth.authorized": "Autorizzato — token in cache.",
  "connectors.oauth.hint": "Apre il browser per accedere.",
  "connectors.oauth.saveHint":
    "Salva il server MCP, poi espandilo sotto e clicca Autorizza.",
  "discovery.mcp.none": "Nessun server trovato (file di config assente).",
  "discovery.mcp.title": "Importa da altre app",
  "discovery.mcp.description":
    "Carica anche i server MCP configurati in queste app. Solo per nuove chat.",
  "skills.discovered.loadLabel": "Carica skill rilevate",
  "skills.discovered.loadDesc":
    "Includi le skill della cartella sotto nelle nuove chat.",
  "skills.discovered.chooseFolder": "Scegli cartella",
};
