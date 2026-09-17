export const es = {
  "models.model.reasoningHint":
    "Activa Razonamiento en los modelos con parámetro de esfuerzo y habilita los niveles que admite tu endpoint. Cada nivel envía su propio nombre por defecto; escribe un token para sobrescribirlo. En «Formato» elige la forma del campo de esfuerzo que espera tu proveedor; los niveles deshabilitados se ajustan al habilitado más cercano.",
  "models.model.format": "Formato",
  "models.model.reasoning": "Razonamiento",
  "nav.models": "Modelos",
  "models.title": "Modelos",
  "models.description":
    "Añade tus propios proveedores de modelos compatibles con OpenAI: una URL base, una clave API e ids de modelo. Sus modelos aparecerán en el selector del chat junto a los integrados.",
  "models.empty": "Aún no hay proveedores personalizados.",
  "models.add": "Añadir proveedor",
  "models.noKey": "Sin clave",
  "models.footnote":
    "Las tareas en segundo plano (títulos automáticos, notas de reuniones) usan DeepSeek si su clave está configurada; si no, tu primer proveedor personalizado.",
  "models.name.label": "Nombre",
  "models.name.placeholder": "OpenRouter, mi servidor vLLM…",
  "models.baseUrl.label": "URL base",
  "models.baseUrl.hint":
    "Endpoint compatible con OpenAI, sin /chat/completions.",
  "models.key.label": "Clave API",
  "models.key.placeholder": "sk-… (vacío para endpoints locales)",
  "models.key.keepStored": "•••••••• (guardada — escribe para reemplazar)",
  "models.models.label": "Modelos",
  "models.model.idPlaceholder": "id del modelo",
  "models.model.namePlaceholder": "nombre visible (opcional)",
  "models.model.vision": "Visión",
  "models.model.visionHint":
    "Activa Visión en los modelos que aceptan imágenes: los adjuntos se envían directamente al modelo en lugar de transcribirse antes.",
  "models.model.add": "Añadir modelo",
  "page.title": "Ajustes",

  "group.general": "General",
  "group.intelligence": "Inteligencia",
  "group.inputCapture": "Entrada y captura",
  "group.app": "Aplicación",
  "group.data": "Datos",
  "nav.general": "General",
  "general.title": "General",
  "general.description": "Idioma y ajustes básicos de la aplicación.",
  "general.autoSortConversations.label": "Mover chats activos arriba",
  "general.autoSortConversations.description":
    "Reordena los chats al recibir mensajes nuevos. Desactívalo para mantener el orden de creación, con los chats nuevos arriba.",
  "general.autoUpdate.label": "Actualizaciones automáticas",
  "general.autoUpdate.description":
    "Busca e instala actualizaciones en segundo plano. Se aplican la próxima vez que abras Cetus.",
  "general.confirmQuit.label": "Confirmar antes de salir",
  "general.confirmQuit.description":
    "Pregunta antes de que Cmd+Q cierre Cetus para que un descuido no interrumpa los agentes en ejecución.",
  "nav.api-keys": "Claves API",
  "nav.memory": "Memoria",
  "nav.skills": "Habilidades",
  "nav.slash-commands": "Comandos de barra",
  "nav.connectors": "MCP",
  "nav.launcher": "Lanzador",
  "nav.voice": "Voz",
  "nav.screen": "Contexto de pantalla",
  "notifications.event.meeting.label": "Captura de reunión",
  "notifications.event.meeting.description":
    "La transcripción empezó, y las actas están listas después.",
  "nav.meetings": "Reuniones",
  "nav.agent-control": "Ordenador y navegador",
  "nav.appearance": "Apariencia",
  "nav.notifications": "Notificaciones",
  "nav.permissions": "Permisos",
  "nav.archived": "Chats archivados",

  "providers.deepseek": "DeepSeek",
  "providers.exa": "Exa (búsqueda web)",
  "providers.tavily": "Tavily (búsqueda web)",
  "providers.doubao": "Doubao (voz)",
  "providers.volcArk": "Volcano Ark (reescritura)",
  "apiKeys.title": "Claves API",
  "apiKeys.description":
    "Las claves se guardan en el llavero de tu sistema operativo. Al guardar se reinicia el subproceso de pi para que las nuevas claves surtan efecto de inmediato.",
  "apiKeys.stored": "● guardada",
  "apiKeys.unsaved": "● sin guardar",
  "apiKeys.replace": "Reemplazar",

  "notifications.title": "Notificaciones",
  "notifications.description":
    "Recibe una notificación de escritorio cuando una tarea en segundo plano termine o requiera tu atención, muy útil para ejecuciones largas de agentes en el tablero.",
  "notifications.enable.label": "Activar notificaciones",
  "notifications.enable.description":
    "Interruptor principal de todas las notificaciones de escritorio.",
  "notifications.blocked":
    "Tu sistema bloquea las notificaciones. Permítelas para Cetus en los ajustes del sistema operativo.",
  "notifications.recheck": "Volver a comprobar",
  "notifications.notifyAbout": "Notificarme sobre",
  "notifications.behavior": "Comportamiento",
  "notifications.mute.label": "Silenciar mientras Cetus está en primer plano",
  "notifications.mute.description":
    "Notificar solo cuando la ventana está en segundo plano.",
  "notifications.event.task_finished.label": "Tarea finalizada",
  "notifications.event.task_finished.description":
    "Una ejecución de agente ha terminado: una respuesta de chat, una tarea del tablero o una automatización programada (haya tenido éxito o haya fallado).",
  "notifications.event.awaiting_input.label": "Necesita tu intervención",
  "notifications.event.awaiting_input.description":
    "El agente está esperando que respondas a una indicación.",

  "launcher.title": "Lanzador rápido",
  "launcher.description":
    "Invoca un panel flotante desde cualquier lugar para iniciar una sesión, opcionalmente con una captura de tu pantalla como contexto.",
  "launcher.needAccessibility":
    "El lanzador necesita acceso de Accesibilidad para detectar el gesto ⌘ en todo el sistema.",
  "launcher.grantAccess": "Conceder acceso",
  "launcher.openSettings": "Abrir Ajustes",
  "launcher.accessibilityGranted": "● Acceso de Accesibilidad concedido",
  "launcher.needScreenRecording":
    "Las capturas necesitan acceso de Grabación de pantalla; sin él, Cetus solo puede capturar tu fondo de pantalla, no las ventanas en pantalla.",
  "launcher.screenRecordingGranted":
    "● Acceso de Grabación de pantalla concedido",
  "launcher.macOnly": "El gesto global ⌘ solo está disponible en macOS.",
  "launcher.enable.label": "Activar lanzador rápido",
  "launcher.enable.description":
    "Activador: {gesture}. Funciona aunque Cetus esté en segundo plano.",
  "launcher.startup.label": "Iniciar al arrancar",
  "launcher.startup.description":
    "Inicia Cetus en la bandeja automáticamente al iniciar sesión.",
  "launcher.gesture.doubleCmd": "Pulsar ⌘ dos veces",
  "launcher.gesture.bothCmd": "Mantener ambas teclas ⌘",
  "launcher.gesture.label": "Gesto de activación",
  "launcher.gesture.description":
    "Cómo invocas el panel desde cualquier lugar.",
  "launcher.gesture.opt.both": "Ambas ⌘",
  "launcher.gesture.opt.bothOpt": "Ambas ⌥",
  "launcher.gesture.opt.double": "Pulsar ⌘ dos veces",
  "launcher.gesture.opt.off": "Desactivado",
  "launcher.gesture.opt.doubleOpt": "Pulsar ⌥ derecho dos veces",
  "launcher.fn.plain.label": "Lanzamiento rápido",
  "launcher.fn.plain.description": "Abre el lanzador (sin captura).",
  "launcher.fn.shot.label": "Lanzamiento rápido + captura",
  "launcher.fn.shot.description":
    "Abre el lanzador con una captura de tu pantalla adjunta.",
  "launcher.summon.label": "Invocar Cetus",
  "launcher.summon.description":
    "Atajo global para traer Cetus al frente, cambiando de escritorio si está en otro.",
  "launcher.summon.placeholder": "Definir atajo",
  "launcher.summon.recording": "Pulsa las teclas…",
  "launcher.summon.clear": "Borrar atajo",
  "launcher.session.label": "Sesión predeterminada",
  "launcher.session.description":
    "Inicia un chat nuevo o continúa el más reciente.",
  "launcher.session.opt.new": "Nuevo",
  "launcher.session.opt.last": "Último",
  "launcher.screenshot.label": "Captura por defecto",
  "launcher.screenshot.description":
    "Captura la pantalla como contexto cada vez que se abre el panel. Aún puedes alternarlo en cada inicio.",

  "appearance.title": "Apariencia",
  "appearance.description":
    "Define el tema y las fuentes que se usan en todo cetus. Los cambios se aplican al instante.",
  "appearance.theme.label": "Tema",
  "appearance.theme.description":
    "Sigue la apariencia del sistema, o fíjala en claro u oscuro.",
  "appearance.permaLayers.label": "Renderizado suave al pasar el cursor",
  "appearance.permaLayers.description":
    "Mantiene los fundidos de hover en capas de composición dedicadas para que las filas no tiemblen con zoom fraccionario. Usa más memoria gráfica; desactívalo para comparar.",

  "voice.title": "Dictado por voz",
  "voice.description":
    "Habla en lugar de escribir. Elige el motor de reconocimiento abajo y luego mantén pulsada la tecla de pulsar para hablar para dictar en la app enfocada.",
  "voice.macOnly": "El dictado por voz solo está disponible en macOS.",
  "voice.needPerms":
    "El dictado necesita acceso al Micrófono y al Reconocimiento de voz.",
  "voice.grantAccess": "Conceder acceso",
  "voice.openSettings": "Abrir Ajustes",
  "voice.permsGranted":
    "● Acceso al Micrófono y al Reconocimiento de voz concedido",
  "voice.engine.label": "Motor de reconocimiento",
  "voice.engine.doubaoDesc":
    "Doubao (Volcano Engine) en streaming en tiempo real: el más rápido (~90 ms), texto en vivo mientras hablas, excelente con mezcla de chino/inglés, funciona en China continental. Necesita una clave API de Doubao (X-Api-Key).",
  "voice.engine.appleDesc":
    "Apple en el dispositivo: instantáneo, el audio nunca sale de tu Mac, pero más flojo con la alternancia chino/inglés.",
  "voice.engine.opt.doubao": "Doubao (nube)",
  "voice.engine.opt.apple": "Apple (en el dispositivo)",
  "voice.gesture.rightOption": "⌥ derecha",
  "voice.gesture.fn": "fn (Globo)",
  "voice.gesture.rightCmd": "⌘ derecha",
  "voice.enable.label": "Dictado en todo el sistema",
  "voice.enable.description":
    "Mantén pulsada {gesture} en cualquier lugar para dictar; suéltala para insertar el texto en la app enfocada.",
  "voice.needAccessibility":
    "Escribir en otras apps necesita acceso de Accesibilidad (el mismo permiso que usa el lanzador).",
  "voice.triggerKey.label": "Tecla de activación",
  "voice.triggerKey.holdDesc":
    "Mantén pulsado este modificador para hablar (suelta para insertar); púlsalo dos veces para el modo manos libres, donde cada frase se inserta al terminarla; púlsalo dos veces de nuevo para detenerlo. Las teclas de la mano derecha evitan choques con los atajos habituales. El modo manos libres necesita el motor Doubao.",
  "voice.triggerKey.opt.rightCmd": "⌘ derecha",
  "voice.triggerKey.opt.rightOption": "⌥ derecha",
  "voice.triggerKey.opt.fn": "fn",
  "voice.triggerKey.opt.capsLock": "Bloq Mayús",
  "voice.triggerKey.capsNote":
    "Cetus reasigna Bloq Mayús al dictado mientras se ejecuta y lo restaura al salir.",
  "voice.insert.label": "Insertar con",
  "voice.insert.description":
    "«Escribir» envía pulsaciones de teclas sintéticas; «Pegar» usa el portapapeles + ⌘V (más robusto en algunas apps, reemplaza brevemente tu portapapeles).",
  "voice.insert.opt.type": "Escribir",
  "voice.insert.opt.paste": "Pegar",
  "voice.cleanup.label": "Limpiar con IA",
  "voice.cleanup.description":
    "Usa DeepSeek para eliminar muletillas y corregir la puntuación antes de insertar. Requiere una clave API de DeepSeek. Solo en pulsar para hablar; el modo manos libres inserta cada frase en vivo.",
  "voice.cleanup.modelLabel": "Modelo de limpieza",
  "voice.cleanup.modelHint":
    "ID del modelo de Ark usado para la reescritura. Déjalo vacío para el valor por defecto; si un snapshot se retira, Cetus vuelve automáticamente al anterior.",
  "voice.history.label": "Guardar historial de dictado",
  "voice.history.description":
    "Mantén un registro de lo que dictas para que tú y el agente (mediante la herramienta recall_dictation) podáis consultarlo después. Desactivado por defecto.",
  "voice.history.empty":
    "Aún no has dictado nada: tus transcripciones aparecerán aquí.",
  "voice.history.clear": "Borrar historial ({n})",

  "screen.title": "Contexto de pantalla",
  "screen.description":
    "Captura tu pantalla periódicamente y la lee en el dispositivo (OCR de Apple Vision) para que el agente pueda recordar en qué estabas trabajando. Las imágenes y el texto permanecen en tu Mac; no se sube nada.",
  "screen.macOnly":
    "La captura de pantalla está ajustada para macOS; el OCR en el dispositivo usa Apple Vision.",
  "screen.browse": "Explorar fotogramas capturados",
  "screen.enable.label": "Activar captura de pantalla",
  "screen.enable.description":
    "Desactivado por defecto. Cuando está activo, Cetus captura la pantalla con un temporizador en segundo plano.",
  "screen.interval.label": "Intervalo de captura",
  "screen.interval.description":
    "Segundos entre capturas. Los fotogramas casi idénticos se omiten automáticamente.",
  "screen.interval.unit": "s",
  "screen.retention.label": "Conservar el historial durante",
  "screen.retention.description":
    "Los fotogramas más antiguos se eliminan del disco. Pon 0 para conservarlos siempre.",
  "screen.retention.unit": "días",
  "screen.ocr.label": "Leer texto en el dispositivo (OCR)",
  "screen.ocr.description":
    "Usa Apple Vision para extraer el texto en pantalla y que el agente pueda buscarlo. Se ejecuta localmente.",
  "screen.excluded.label": "Apps excluidas",
  "screen.excluded.description":
    "Nombres de apps o bundle ids separados por comas. La captura se omite mientras una de estas está en primer plano (p. ej. 1Password, Mensajes).",
  "screen.frames.one":
    "{count} fotograma capturado · macOS pide permiso de Grabación de pantalla la primera vez que se ejecuta la captura.",
  "screen.frames.other":
    "{count} fotogramas capturados · macOS pide permiso de Grabación de pantalla la primera vez que se ejecuta la captura.",

  "agentControl.title": "Control de ordenador y navegador",
  "agentControl.description":
    "Permite que el agente maneje tu navegador y tus apps de Mac. Requiere Accesibilidad (y Grabación de pantalla para la vista en vivo).",
  "agentControl.browser.label": "Activar control del navegador",
  "agentControl.browser.description":
    "Añade las herramientas browser_* y el prompt de control basado en índices para manejar un navegador web. El agente confirma las acciones importantes y puedes detenerlo en cualquier momento.",
  "agentControl.computer.label": "Activar control del ordenador",
  "agentControl.computer.description":
    "Añade las herramientas computer_* para controlar las apps de este Mac mediante accesibilidad. El agente confirma las acciones importantes y puedes detenerlo en cualquier momento.",
  "agentControl.ax.label": "Acceso de Accesibilidad",
  "agentControl.ax.notGranted":
    "No concedido: el agente no puede leer las interfaces de las apps ni hacer clic/escribir por índice.",
  "agentControl.ax.granted": "Concedido.",
  "agentControl.checking": "Comprobando…",
  "agentControl.enabled": "Activado",
  "agentControl.grant": "Conceder",
  "agentControl.openSettings": "Abrir Ajustes",
  "agentControl.screen.label": "Acceso de Grabación de pantalla",
  "agentControl.screen.notGranted":
    "No concedido: la vista previa de la captura en vivo no se mostrará.",
  "agentControl.screen.granted": "Concedido.",
  "agentControl.footnote":
    "El agente actúa mediante listas de elementos numerados, nunca con píxeles en bruto, y pregunta antes de cualquier acción importante (enviar, eliminar, comprar, enviar formularios, autenticarse). Mientras está activo, aparece un botón Detener en el chat.",

  "archived.title": "Chats archivados",
  "archived.description":
    "Conversaciones que has archivado desde la barra lateral. Restaura una para recuperarla, o bórralas todas para liberar espacio: la eliminación es permanente.",
  "archived.loading": "Cargando…",
  "archived.empty": "No hay chats archivados.",
  "archived.count.one": "{count} chat archivado",
  "archived.count.other": "{count} chats archivados",
  "archived.deleteAllPrompt": "¿Eliminar los {count}?",
  "archived.deleting": "Eliminando…",
  "archived.deleteAll": "Eliminar todo",
  "archived.untitled": "Sin título",
  "archived.archivedOn": "Archivado el {date}",
  "archived.restore": "Restaurar",
  "archived.deleteAria": "Eliminar chat",

  "memory.title": "Memoria",
  "memory.description":
    "Notas duraderas sobre ti —tus preferencias, proyectos en curso y decisiones— que el agente lleva consigo de una conversación a otra. El agente las amplía a medida que aprende; aquí puedes añadir, editar, silenciar o eliminar cualquiera de ellas.",
  "memory.enable.label": "Activar memoria",
  "memory.enable.description":
    "Cuando está activa, las notas habilitadas de abajo se inyectan en el contexto del agente en cada turno. Desactívala para pausar la memoria sin perder tus notas.",
  "memory.add.label": "Añadir una memoria",
  "memory.add.placeholder":
    "p. ej. Prefiere pnpm a npm, y mensajes de commit concisos.",
  "memory.category.placeholder": "Categoría (opcional)",
  "memory.adding": "Añadiendo…",
  "memory.add.button": "Añadir",
  "memory.loading": "Cargando…",
  "memory.empty": "Aún no hay memorias",
  "memory.count.one": "{count} memoria",
  "memory.count.other": "{count} memorias",
  "memory.deleteAllPrompt": "¿Eliminar todo?",
  "memory.clearAll": "Borrar todo",
  "memory.saving": "Guardando…",
  "memory.save": "Guardar",
  "memory.tag.agent": "Agente",
  "memory.tag.you": "Tú",
  "memory.editedOn": "Editado el {date}",
  "memory.muteAria": "Silenciar memoria",
  "memory.enableAria": "Activar memoria",
  "memory.editAria": "Editar memoria",
  "memory.deleteAria": "Eliminar memoria",

  "skills.title": "Habilidades",
  "skills.description":
    "Instrucciones reutilizables que el agente puede incorporar a demanda: una carpeta con un SKILL.md (nombre + descripción + pasos), siguiendo el estándar abierto Agent Skills. Instala una desde una carpeta o escribe la tuya; las habilidades activadas se ofrecen al agente en cada turno.",
  "skills.enable.label": "Activar habilidades",
  "skills.enable.description":
    "Cuando está activo, las habilidades habilitadas de abajo se ponen a disposición del agente. Desactívalo para pausar todas las habilidades sin desinstalarlas.",
  "skills.importing": "Importando…",
  "skills.import": "Importar carpeta",
  "skills.write": "Escribir una",
  "skills.learn": "Más información sobre las habilidades",
  "skills.loading": "Cargando…",
  "skills.empty": "No hay habilidades instaladas",
  "skills.count.one": "{count} habilidad",
  "skills.count.other": "{count} habilidades",
  "skills.source.written": "Escrita",
  "skills.source.imported": "Importada",
  "skills.source.proposed": "Propuesta",
  "skills.source.byAgent": "Por el agente",
  "skills.updatedOn": "Actualizada el {date}",
  "skills.disableAria": "Desactivar habilidad",
  "skills.enableAria": "Activar habilidad",
  "skills.openFolderAria": "Abrir carpeta de la habilidad",
  "skills.delete": "Eliminar",
  "skills.uninstallAria": "Desinstalar habilidad",
  "skills.editor.title": "Escribir una habilidad",
  "skills.editor.namePlaceholder":
    "Nombre, p. ej. Estilo de mensajes de commit",
  "skills.editor.descPlaceholder":
    "¿Cuándo debería usarla el agente? (una línea)",
  "skills.editor.bodyPlaceholder":
    "La habilidad en sí, en markdown. Pasos, ejemplos, reglas…",
  "skills.editor.saving": "Guardando…",
  "skills.editor.create": "Crear habilidad",

  "connectors.title": "MCP",
  "connectors.description":
    "Conecta el agente a herramientas externas mediante servidores MCP (Model Context Protocol): un comando local o una URL remota. Añade un servidor y pulsa Probar para ejecutar un handshake real y ver las herramientas que ofrece. Las herramientas de cada servidor MCP activado se cargan en el agente para que pueda invocarlas como las suyas integradas; los cambios surten efecto en las conversaciones nuevas.",
  "connectors.loading": "Cargando…",
  "connectors.empty": "Aún no hay servidores MCP",
  "connectors.count.one": "{count} servidor MCP",
  "connectors.count.other": "{count} servidores MCP",
  "connectors.add": "Añadir servidor MCP",
  "connectors.disableAria": "Desactivar servidor MCP",
  "connectors.enableAria": "Activar servidor MCP",
  "connectors.editAria": "Editar servidor MCP",
  "connectors.removeAria": "Eliminar servidor MCP",
  "connectors.editor.name": "Nombre",
  "connectors.editor.namePlaceholder": "p. ej. GitHub, Filesystem, Linear…",
  "connectors.editor.transport": "Transporte",
  "connectors.editor.transportDesc":
    "Un proceso local (stdio) o un endpoint MCP remoto (HTTP/SSE).",
  "connectors.editor.command": "Comando",
  "connectors.editor.commandPlaceholder": "p. ej. npx",
  "connectors.editor.args": "Argumentos",
  "connectors.editor.argsHint": "uno por línea",
  "connectors.editor.env": "Entorno",
  "connectors.editor.envHint": "se pasa al proceso",
  "connectors.editor.url": "URL",
  "connectors.editor.headers": "Cabeceras",
  "connectors.editor.headersHint": "se envía con cada solicitud",
  "connectors.test.connected": "Conectado",
  "connectors.test.tools.one": "{count} herramienta: {names}",
  "connectors.test.tools.other": "{count} herramientas: {names}",
  "connectors.test.noTools":
    "Handshake correcto: el servidor no expone herramientas.",
  "connectors.test.failed": "La conexión falló.",
  "connectors.editor.saving": "Guardando…",
  "connectors.testing": "Probando…",
  "connectors.test.button": "Probar",
  "connectors.editor.envName": "CLAVE",
  "connectors.editor.envValue": "valor",
  "connectors.editor.addEnv": "Añadir variable",
  "connectors.editor.headerName": "Nombre",
  "connectors.editor.headerValue": "Valor",
  "connectors.editor.addHeader": "Añadir cabecera",
  "connectors.editor.removeRow": "Eliminar",
  "connectors.details.toggleAria": "Mostrar herramientas",
  "connectors.details.loading": "Cargando herramientas…",
  "connectors.details.connected": "Conectado",
  "connectors.details.toolCount.one": "{count} herramienta",
  "connectors.details.toolCount.other": "{count} herramientas",
  "connectors.oauth.auth": "Autenticación",
  "connectors.oauth.authDesc":
    "Cabeceras estáticas u OAuth (Cetus ejecuta el inicio de sesión).",
  "connectors.oauth.none": "Ninguna",
  "connectors.oauth.clientId": "Client ID",
  "connectors.oauth.clientIdPlaceholder": "auto (registro dinámico)",
  "connectors.oauth.scope": "Scope",
  "connectors.oauth.optional": "opcional",
  "connectors.oauth.authorize": "Autorizar",
  "connectors.oauth.authorizing": "Autorizando…",
  "connectors.oauth.authorized": "Autorizado: tokens en caché.",
  "connectors.oauth.hint": "Abre el navegador para iniciar sesión.",
  "connectors.oauth.saveHint":
    "Guarda el servidor MCP, luego expándelo abajo y pulsa Autorizar.",
  "discovery.mcp.none": "No se encontraron servidores (sin archivo de config).",
  "discovery.mcp.title": "Importar de otras apps",
  "discovery.mcp.description":
    "Carga también servidores MCP configurados en estas apps. Solo para chats nuevos.",
  "skills.discovered.loadLabel": "Cargar skills descubiertas",
  "skills.discovered.loadDesc":
    "Incluir skills de la carpeta de abajo en chats nuevos.",
  "skills.discovered.chooseFolder": "Elegir carpeta",
};
