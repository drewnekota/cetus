export const fr = {
  "search.placeholder": "Rechercher un réglage…",
  "search.clear": "Effacer la recherche",
  "search.empty": "Aucun réglage trouvé",

  "models.model.reasoningHint":
    "Activez Raisonnement pour les modèles dotés d'un réglage d'effort, puis activez les niveaux pris en charge par votre endpoint. Chaque niveau envoie son propre nom par défaut ; saisissez un token pour le remplacer. « Format » définit la forme du champ d'effort attendue par votre fournisseur ; les niveaux désactivés sont ramenés au niveau activé le plus proche.",
  "models.model.format": "Format",
  "models.model.reasoning": "Raisonnement",
  "nav.models": "Modèles",
  "models.title": "Modèles",
  "models.description":
    "Ajoutez vos propres fournisseurs de modèles compatibles OpenAI : une URL de base, une clé API et des ids de modèles. Ils apparaissent ensuite dans le sélecteur de modèle du chat, aux côtés des modèles intégrés.",
  "models.empty": "Aucun fournisseur personnalisé pour l'instant.",
  "models.add": "Ajouter un fournisseur",
  "models.noKey": "Pas de clé",
  "models.footnote":
    "Les tâches d'arrière-plan (titres automatiques, notes de réunion) utilisent DeepSeek si sa clé est configurée, sinon votre premier fournisseur personnalisé.",
  "models.name.label": "Nom",
  "models.name.placeholder": "OpenRouter, mon serveur vLLM…",
  "models.baseUrl.label": "URL de base",
  "models.baseUrl.hint": "Endpoint compatible OpenAI, sans /chat/completions.",
  "models.key.label": "Clé API",
  "models.key.placeholder": "sk-… (vide pour un endpoint local)",
  "models.key.keepStored": "•••••••• (enregistrée — saisissez pour remplacer)",
  "models.models.label": "Modèles",
  "models.model.idPlaceholder": "id du modèle",
  "models.model.namePlaceholder": "nom affiché (facultatif)",
  "models.model.vision": "Vision",
  "models.model.visionHint":
    "Activez Vision pour les modèles qui acceptent les images : les pièces jointes sont envoyées directement au modèle au lieu d'être transcrites.",
  "models.model.add": "Ajouter un modèle",
  "page.title": "Réglages",

  "group.general": "Général",
  "group.intelligence": "Intelligence",
  "group.inputCapture": "Saisie et capture",
  "group.app": "Application",
  "group.data": "Données",
  "nav.general": "Général",
  "general.title": "Général",
  "general.description": "Langue et réglages de base de l'application.",
  "general.autoSortConversations.label": "Remonter les discussions actives",
  "general.autoSortConversations.description":
    "Réorganise les discussions à l'arrivée de nouveaux messages. Désactivez cette option pour conserver l'ordre de création, avec les nouvelles discussions en haut.",
  "general.autoUpdate.label": "Mises à jour automatiques",
  "general.autoUpdate.description":
    "Recherche et installe les mises à jour en arrière-plan. Appliquées au prochain lancement de Cetus.",
  "general.confirmQuit.label": "Confirmer avant de quitter",
  "general.confirmQuit.description":
    "Demande confirmation avant que Cmd+Q ne ferme Cetus, pour qu'une fausse manipulation n'interrompe pas les agents en cours.",
  "general.keepAwake.label": "Garder le Mac éveillé pendant le travail",
  "general.keepAwake.description":
    "Empêche la mise en veille tant qu'un tour d'agent ou un enregistrement de réunion est en cours. L'écran s'éteint et se verrouille toujours ; fermer le capot met toujours en veille.",
  "nav.api-keys": "Clés API",
  "nav.memory": "Mémoire",
  "nav.skills": "Compétences",
  "nav.slash-commands": "Commandes slash",
  "nav.connectors": "MCP",
  "nav.launcher": "Lanceur",
  "nav.voice": "Voix",
  "nav.screen": "Contexte d'écran",
  "notifications.event.meeting.label": "Capture de réunion",
  "notifications.event.meeting.description":
    "La transcription a démarré, puis le compte rendu est prêt.",
  "nav.meetings": "Réunions",
  "nav.agent-control": "Ordinateur et navigateur",
  "nav.appearance": "Apparence",
  "nav.notifications": "Notifications",
  "nav.permissions": "Autorisations",
  "nav.archived": "Conversations archivées",

  "providers.deepseek": "DeepSeek",
  "providers.exa": "Exa (recherche web)",
  "providers.tavily": "Tavily (recherche web)",
  "providers.doubao": "Doubao (voix)",
  "providers.volcArk": "Volcano Ark (réécriture)",
  "apiKeys.title": "Clés API",
  "apiKeys.description":
    "Les clés sont stockées dans le trousseau de votre système d'exploitation. L'enregistrement redémarre le sous-processus pi pour que les nouvelles clés prennent effet immédiatement.",
  "apiKeys.stored": "● enregistrée",
  "apiKeys.unsaved": "● non enregistrée",
  "apiKeys.replace": "Remplacer",

  "notifications.title": "Notifications",
  "notifications.description":
    "Recevez une notification sur le bureau lorsqu'une tâche en arrière-plan se termine ou requiert votre attention — pratique pour les longues exécutions d'agents sur le tableau.",
  "notifications.enable.label": "Activer les notifications",
  "notifications.enable.description":
    "Interrupteur principal de toutes les notifications du bureau.",
  "notifications.blocked":
    "Votre système bloque les notifications. Autorisez-les pour Cetus dans les réglages du système d'exploitation.",
  "notifications.recheck": "Revérifier",
  "notifications.notifyAbout": "Me notifier à propos de",
  "notifications.behavior": "Comportement",
  "notifications.mute.label": "Couper le son quand Cetus est au premier plan",
  "notifications.mute.description":
    "Notifier uniquement quand la fenêtre est en arrière-plan.",
  "notifications.event.task_finished.label": "Tâche terminée",
  "notifications.event.task_finished.description":
    "Une exécution d'agent s'est terminée — une réponse de conversation, une tâche du tableau ou une automatisation planifiée (qu'elle ait réussi ou échoué).",
  "notifications.event.awaiting_input.label": "Nécessite votre intervention",
  "notifications.event.awaiting_input.description":
    "L'agent attend que vous répondiez à une invite.",

  "launcher.title": "Lanceur rapide",
  "launcher.description":
    "Invoquez un panneau flottant depuis n'importe où pour démarrer une session — éventuellement avec une capture de votre écran comme contexte.",
  "launcher.needAccessibility":
    "Le lanceur a besoin de l'accès à l'Accessibilité pour détecter le geste ⌘ à l'échelle du système.",
  "launcher.grantAccess": "Accorder l'accès",
  "launcher.openSettings": "Ouvrir les Réglages",
  "launcher.accessibilityGranted": "● Accès à l'Accessibilité accordé",
  "launcher.needScreenRecording":
    "Les captures nécessitent l'accès à l'Enregistrement de l'écran — sans lui, Cetus ne peut capturer que votre fond d'écran, pas les fenêtres à l'écran.",
  "launcher.screenRecordingGranted":
    "● Accès à l'Enregistrement de l'écran accordé",
  "launcher.macOnly": "Le geste global ⌘ n'est disponible que sur macOS.",
  "launcher.enable.label": "Activer le lanceur rapide",
  "launcher.enable.description":
    "Déclencheur : {gesture}. Fonctionne même quand Cetus est en arrière-plan.",
  "launcher.startup.label": "Lancer au démarrage",
  "launcher.startup.description":
    "Démarre Cetus dans la barre d'état automatiquement à la connexion.",
  "launcher.gesture.doubleCmd": "Appuyer deux fois sur ⌘",
  "launcher.gesture.bothCmd": "Maintenir les deux touches ⌘",
  "launcher.gesture.label": "Geste de déclenchement",
  "launcher.gesture.description":
    "Comment vous invoquez le panneau depuis n'importe où.",
  "launcher.gesture.opt.both": "Les deux ⌘",
  "launcher.gesture.opt.bothOpt": "Les deux ⌥",
  "launcher.gesture.opt.double": "Appuyer deux fois sur ⌘",
  "launcher.gesture.opt.off": "Désactivé",
  "launcher.gesture.opt.doubleOpt": "Appuyer deux fois sur ⌥ droit",
  "launcher.fn.plain.label": "Lancement rapide",
  "launcher.fn.plain.description": "Ouvre le lanceur (sans capture).",
  "launcher.fn.shot.label": "Lancement rapide + capture",
  "launcher.fn.shot.description":
    "Ouvre le lanceur avec une capture de votre écran jointe.",
  "launcher.summon.label": "Appeler Cetus",
  "launcher.summon.description":
    "Raccourci global pour mettre Cetus au premier plan, en changeant de bureau s'il est sur un autre.",
  "launcher.summon.placeholder": "Définir le raccourci",
  "launcher.summon.recording": "Appuyez sur les touches…",
  "launcher.summon.clear": "Effacer le raccourci",
  "launcher.session.label": "Session par défaut",
  "launcher.session.description":
    "Démarrez une nouvelle conversation ou continuez la plus récente.",
  "launcher.session.opt.new": "Nouvelle",
  "launcher.session.opt.last": "Dernière",
  "launcher.screenshot.label": "Capture par défaut",
  "launcher.screenshot.description":
    "Capture l'écran comme contexte à chaque ouverture du panneau. Vous pouvez toujours l'activer ou non à chaque lancement.",

  "appearance.title": "Apparence",
  "appearance.description":
    "Définissez le thème et les polices utilisés dans tout cetus. Les changements s'appliquent instantanément.",
  "appearance.theme.label": "Thème",
  "appearance.theme.description":
    "Suivez l'apparence du système, ou verrouillez en clair ou sombre.",
  "appearance.permaLayers.label": "Rendu fluide au survol",
  "appearance.permaLayers.description":
    "Conserve les fondus de survol sur des calques de composition dédiés pour éviter le tremblement des lignes en zoom fractionnaire. Utilise plus de mémoire graphique ; désactivez pour comparer.",

  "voice.title": "Dictée vocale",
  "voice.description":
    "Parlez au lieu de taper. Choisissez le moteur de reconnaissance ci-dessous, puis maintenez la touche d'appui-pour-parler enfoncée pour dicter dans l'app active.",
  "voice.macOnly": "La dictée vocale n'est disponible que sur macOS.",
  "voice.needPerms":
    "La dictée nécessite l'accès au Microphone et à la Reconnaissance vocale.",
  "voice.grantAccess": "Accorder l'accès",
  "voice.openSettings": "Ouvrir les Réglages",
  "voice.permsGranted":
    "● Accès au Microphone et à la Reconnaissance vocale accordé",
  "voice.engine.label": "Moteur de reconnaissance",
  "voice.engine.doubaoDesc":
    "Doubao (Volcano Engine) en streaming en temps réel — le plus rapide (~90 ms), texte en direct pendant que vous parlez, excellent pour le mélange chinois/anglais, fonctionne en Chine continentale. Nécessite une clé API Doubao (X-Api-Key).",
  "voice.engine.appleDesc":
    "Apple sur l'appareil — instantané, l'audio ne quitte jamais votre Mac, mais plus faible pour l'alternance chinois/anglais.",
  "voice.engine.opt.doubao": "Doubao (cloud)",
  "voice.engine.opt.apple": "Apple (sur l'appareil)",
  "voice.gesture.rightOption": "⌥ droite",
  "voice.gesture.fn": "fn (Globe)",
  "voice.gesture.rightCmd": "⌘ droite",
  "voice.enable.label": "Dictée à l'échelle du système",
  "voice.enable.description":
    "Maintenez {gesture} enfoncée n'importe où pour dicter ; relâchez pour insérer le texte dans l'app active.",
  "voice.needAccessibility":
    "Taper dans d'autres apps nécessite l'accès à l'Accessibilité (la même autorisation que celle utilisée par le lanceur).",
  "voice.triggerKey.label": "Touche de déclenchement",
  "voice.triggerKey.holdDesc":
    "Maintenez ce modificateur enfoncé pour parler (relâchez pour insérer) ; appuyez deux fois dessus pour le mode mains libres, où chaque phrase est insérée dès que vous la terminez — appuyez de nouveau deux fois pour arrêter. Les touches de droite évitent les conflits avec les raccourcis habituels. Le mode mains libres nécessite le moteur Doubao.",
  "voice.triggerKey.opt.rightCmd": "⌘ droite",
  "voice.triggerKey.opt.rightOption": "⌥ droite",
  "voice.triggerKey.opt.fn": "fn",
  "voice.triggerKey.opt.capsLock": "Verr. Maj",
  "voice.triggerKey.capsNote":
    "Cetus réaffecte Verr. Maj à la dictée pendant son exécution et la rétablit à la fermeture.",
  "voice.insert.label": "Insérer avec",
  "voice.insert.description":
    "« Taper » envoie des frappes synthétiques ; « Coller » utilise le presse-papiers + ⌘V (plus robuste dans certaines apps, remplace brièvement votre presse-papiers).",
  "voice.insert.opt.type": "Taper",
  "voice.insert.opt.paste": "Coller",
  "voice.cleanup.label": "Nettoyer avec l'IA",
  "voice.cleanup.description":
    "Utilisez DeepSeek pour supprimer les mots de remplissage et corriger la ponctuation avant l'insertion. Nécessite une clé API DeepSeek. Uniquement en appui-pour-parler — le mode mains libres insère chaque phrase en direct.",
  "voice.history.label": "Enregistrer l'historique de dictée",
  "voice.history.description":
    "Conservez un journal de ce que vous dictez afin que vous — et l'agent (via l'outil recall_dictation) — puissiez le consulter plus tard. Désactivé par défaut.",
  "voice.history.empty":
    "Rien de dicté pour l'instant — vos transcriptions apparaîtront ici.",
  "voice.history.clear": "Effacer l'historique ({n})",

  "screen.title": "Contexte d'écran",
  "screen.description":
    "Capture périodiquement votre écran et le lit sur l'appareil (OCR Apple Vision) afin que l'agent puisse se rappeler ce sur quoi vous travailliez. Les images et le texte restent sur votre Mac — rien n'est téléversé.",
  "screen.macOnly":
    "La capture d'écran est optimisée pour macOS ; l'OCR sur l'appareil utilise Apple Vision.",
  "screen.browse": "Parcourir les images capturées",
  "screen.enable.label": "Activer la capture d'écran",
  "screen.enable.description":
    "Désactivé par défaut. Une fois activé, Cetus capture l'écran selon un minuteur en arrière-plan.",
  "screen.interval.label": "Intervalle de capture",
  "screen.interval.description":
    "Secondes entre les captures. Les images quasi identiques sont ignorées automatiquement.",
  "screen.interval.unit": "s",
  "screen.retention.label": "Conserver l'historique pendant",
  "screen.retention.description":
    "Les images plus anciennes sont supprimées du disque. Mettez 0 pour les conserver indéfiniment.",
  "screen.retention.unit": "jours",
  "screen.ocr.label": "Lire le texte sur l'appareil (OCR)",
  "screen.ocr.description":
    "Utilisez Apple Vision pour extraire le texte à l'écran afin que l'agent puisse le rechercher. S'exécute localement.",
  "screen.excluded.label": "Apps exclues",
  "screen.excluded.description":
    "Noms d'apps ou bundle ids séparés par des virgules. La capture est ignorée tant que l'une d'elles est au premier plan (p. ex. 1Password, Messages).",
  "screen.frames.one":
    "{count} image capturée · macOS demande l'autorisation d'Enregistrement de l'écran la première fois que la capture s'exécute.",
  "screen.frames.other":
    "{count} images capturées · macOS demande l'autorisation d'Enregistrement de l'écran la première fois que la capture s'exécute.",

  "agentControl.title": "Contrôle de l'ordinateur et du navigateur",
  "agentControl.description":
    "Permet à l'agent de piloter votre navigateur et vos apps Mac. Nécessite l'Accessibilité (et l'Enregistrement de l'écran pour la vue en direct).",
  "agentControl.browser.label": "Activer le contrôle du navigateur",
  "agentControl.browser.description":
    "Ajoute les outils browser_* et le prompt de contrôle basé sur les index pour piloter un navigateur web. L'agent confirme les actions importantes et vous pouvez l'arrêter à tout moment.",
  "agentControl.computer.label": "Activer le contrôle de l'ordinateur",
  "agentControl.computer.description":
    "Ajoute les outils computer_* pour contrôler les apps de ce Mac via l'accessibilité. L'agent confirme les actions importantes et vous pouvez l'arrêter à tout moment.",
  "agentControl.ax.label": "Accès à l'Accessibilité",
  "agentControl.ax.notGranted":
    "Non accordé — l'agent ne peut pas lire les interfaces des apps ni cliquer/taper par index.",
  "agentControl.ax.granted": "Accordé.",
  "agentControl.checking": "Vérification…",
  "agentControl.enabled": "Activé",
  "agentControl.grant": "Accorder",
  "agentControl.openSettings": "Ouvrir les Réglages",
  "agentControl.screen.label": "Accès à l'Enregistrement de l'écran",
  "agentControl.screen.notGranted":
    "Non accordé — l'aperçu de la capture en direct ne s'affichera pas.",
  "agentControl.screen.granted": "Accordé.",
  "agentControl.footnote":
    "L'agent agit via des listes d'éléments numérotés, jamais des pixels bruts, et demande avant toute action importante (envoyer, supprimer, acheter, soumettre, s'authentifier). Un bouton Arrêter apparaît dans la conversation tant qu'il est actif.",

  "archived.title": "Conversations archivées",
  "archived.description":
    "Conversations que vous avez archivées depuis la barre latérale. Restaurez-en une pour la récupérer, ou effacez-les toutes pour libérer de l'espace — la suppression est définitive.",
  "archived.loading": "Chargement…",
  "archived.empty": "Aucune conversation archivée.",
  "archived.count.one": "{count} conversation archivée",
  "archived.count.other": "{count} conversations archivées",
  "archived.deleteAllPrompt": "Supprimer les {count} ?",
  "archived.deleting": "Suppression…",
  "archived.deleteAll": "Tout supprimer",
  "archived.untitled": "Sans titre",
  "archived.archivedOn": "Archivée le {date}",
  "archived.restore": "Restaurer",
  "archived.deleteAria": "Supprimer la conversation",

  "memory.title": "Mémoire",
  "memory.description":
    "Notes durables à votre sujet — vos préférences, vos projets en cours et vos décisions — que l'agent emporte d'une conversation à l'autre. L'agent les enrichit au fil de son apprentissage ; vous pouvez en ajouter, en modifier, en couper ou en supprimer ici.",
  "memory.enable.label": "Activer la mémoire",
  "memory.enable.description":
    "Lorsqu'elle est activée, les notes activées ci-dessous sont injectées dans le contexte de l'agent à chaque tour. Désactivez-la pour suspendre la mémoire sans perdre vos notes.",
  "memory.add.label": "Ajouter une mémoire",
  "memory.add.placeholder":
    "p. ex. Préfère pnpm à npm, et des messages de commit concis.",
  "memory.category.placeholder": "Catégorie (facultatif)",
  "memory.adding": "Ajout…",
  "memory.add.button": "Ajouter",
  "memory.loading": "Chargement…",
  "memory.empty": "Aucune mémoire pour l'instant",
  "memory.count.one": "{count} mémoire",
  "memory.count.other": "{count} mémoires",
  "memory.deleteAllPrompt": "Tout supprimer ?",
  "memory.clearAll": "Tout effacer",
  "memory.saving": "Enregistrement…",
  "memory.save": "Enregistrer",
  "memory.tag.agent": "Agent",
  "memory.tag.you": "Vous",
  "memory.editedOn": "Modifiée le {date}",
  "memory.muteAria": "Couper la mémoire",
  "memory.enableAria": "Activer la mémoire",
  "memory.editAria": "Modifier la mémoire",
  "memory.deleteAria": "Supprimer la mémoire",

  "skills.title": "Compétences",
  "skills.description":
    "Instructions réutilisables que l'agent peut intégrer à la demande — un dossier avec un SKILL.md (nom + description + étapes), conforme à la norme ouverte Agent Skills. Installez-en une depuis un dossier ou écrivez la vôtre ; les compétences activées sont proposées à l'agent à chaque tour.",
  "skills.enable.label": "Activer les compétences",
  "skills.enable.description":
    "Lorsqu'il est activé, les compétences activées ci-dessous sont mises à la disposition de l'agent. Désactivez-le pour suspendre toutes les compétences sans les désinstaller.",
  "skills.importing": "Importation…",
  "skills.import": "Importer un dossier",
  "skills.write": "En écrire une",
  "skills.learn": "En savoir plus sur les compétences",
  "skills.loading": "Chargement…",
  "skills.empty": "Aucune compétence installée",
  "skills.count.one": "{count} compétence",
  "skills.count.other": "{count} compétences",
  "skills.source.written": "Écrite",
  "skills.source.imported": "Importée",
  "skills.source.proposed": "Proposée",
  "skills.source.byAgent": "Par l'agent",
  "skills.updatedOn": "Mise à jour le {date}",
  "skills.disableAria": "Désactiver la compétence",
  "skills.enableAria": "Activer la compétence",
  "skills.openFolderAria": "Ouvrir le dossier de la compétence",
  "skills.delete": "Supprimer",
  "skills.uninstallAria": "Désinstaller la compétence",
  "skills.editor.title": "Écrire une compétence",
  "skills.editor.namePlaceholder": "Nom, p. ex. Style des messages de commit",
  "skills.editor.descPlaceholder":
    "Quand l'agent doit-il l'utiliser ? (une ligne)",
  "skills.editor.bodyPlaceholder":
    "La compétence elle-même, en markdown. Étapes, exemples, règles…",
  "skills.editor.saving": "Enregistrement…",
  "skills.editor.create": "Créer la compétence",

  "connectors.title": "MCP",
  "connectors.description":
    "Connectez l'agent à des outils externes via des serveurs MCP (Model Context Protocol) — une commande locale ou une URL distante. Ajoutez un serveur et utilisez Tester pour exécuter une vraie poignée de main et voir les outils qu'il propose. Les outils de chaque serveur MCP activé sont chargés dans l'agent pour qu'il puisse les appeler comme ses outils intégrés ; les changements prennent effet dans les nouvelles conversations.",
  "connectors.loading": "Chargement…",
  "connectors.empty": "Aucun serveur MCP pour l'instant",
  "connectors.count.one": "{count} serveur MCP",
  "connectors.count.other": "{count} serveurs MCP",
  "connectors.add": "Ajouter un serveur MCP",
  "connectors.disableAria": "Désactiver le serveur MCP",
  "connectors.enableAria": "Activer le serveur MCP",
  "connectors.editAria": "Modifier le serveur MCP",
  "connectors.removeAria": "Supprimer le serveur MCP",
  "connectors.editor.name": "Nom",
  "connectors.editor.namePlaceholder": "p. ex. GitHub, Filesystem, Linear…",
  "connectors.editor.transport": "Transport",
  "connectors.editor.transportDesc":
    "Un processus local (stdio) ou un endpoint MCP distant (HTTP/SSE).",
  "connectors.editor.command": "Commande",
  "connectors.editor.commandPlaceholder": "p. ex. npx",
  "connectors.editor.args": "Arguments",
  "connectors.editor.argsHint": "un par ligne",
  "connectors.editor.env": "Environnement",
  "connectors.editor.envHint": "transmis au processus",
  "connectors.editor.url": "URL",
  "connectors.editor.headers": "En-têtes",
  "connectors.editor.headersHint": "envoyé à chaque requête",
  "connectors.test.connected": "Connecté",
  "connectors.test.tools.one": "{count} outil : {names}",
  "connectors.test.tools.other": "{count} outils : {names}",
  "connectors.test.noTools":
    "Poignée de main OK — le serveur n'expose aucun outil.",
  "connectors.test.failed": "La connexion a échoué.",
  "connectors.editor.saving": "Enregistrement…",
  "connectors.testing": "Test…",
  "connectors.test.button": "Tester",
  "connectors.editor.envName": "CLÉ",
  "connectors.editor.envValue": "valeur",
  "connectors.editor.addEnv": "Ajouter une variable",
  "connectors.editor.headerName": "Nom",
  "connectors.editor.headerValue": "Valeur",
  "connectors.editor.addHeader": "Ajouter un en-tête",
  "connectors.editor.removeRow": "Supprimer",
  "connectors.details.toggleAria": "Afficher les outils",
  "connectors.details.loading": "Chargement des outils…",
  "connectors.details.connected": "Connecté",
  "connectors.details.toolCount.one": "{count} outil",
  "connectors.details.toolCount.other": "{count} outils",
  "connectors.oauth.auth": "Authentification",
  "connectors.oauth.authDesc":
    "En-têtes statiques ou OAuth (Cetus gère la connexion).",
  "connectors.oauth.none": "Aucune",
  "connectors.oauth.clientId": "Client ID",
  "connectors.oauth.clientIdPlaceholder": "auto (enregistrement dynamique)",
  "connectors.oauth.scope": "Scope",
  "connectors.oauth.optional": "facultatif",
  "connectors.oauth.authorize": "Autoriser",
  "connectors.oauth.authorizing": "Autorisation…",
  "connectors.oauth.authorized": "Autorisé — jetons en cache.",
  "connectors.oauth.hint": "Ouvre le navigateur pour se connecter.",
  "connectors.oauth.saveHint":
    "Enregistrez le serveur MCP, puis dépliez-le ci-dessous et cliquez sur Autoriser.",
  "discovery.mcp.none": "Aucun serveur trouvé (fichier de config absent).",
  "discovery.mcp.title": "Importer depuis d’autres apps",
  "discovery.mcp.description":
    "Charge aussi les serveurs MCP configurés dans ces apps. Nouveaux chats uniquement.",
  "skills.discovered.loadLabel": "Charger les skills découvertes",
  "skills.discovered.loadDesc":
    "Inclure les skills du dossier ci-dessous dans les nouveaux chats.",
  "skills.discovered.chooseFolder": "Choisir un dossier",
};
