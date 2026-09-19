export const ru = {
  "models.model.reasoningHint":
    "Включите «Рассуждение» для моделей с параметром усилия и активируйте уровни, которые поддерживает ваш endpoint. Каждый уровень по умолчанию отправляет своё имя; введите токен, чтобы переопределить. В «Формате» выберите форму поля усилия вашего провайдера; отключённые уровни сводятся к ближайшему включённому.",
  "models.model.format": "Формат",
  "models.model.reasoning": "Рассуждение",
  "nav.models": "Модели",
  "models.title": "Модели",
  "models.description":
    "Добавьте собственных провайдеров моделей, совместимых с OpenAI: базовый URL, ключ API и идентификаторы моделей. Модели появятся в списке выбора в чате рядом со встроенными.",
  "models.empty": "Пользовательских провайдеров пока нет.",
  "models.add": "Добавить провайдера",
  "models.noKey": "Нет ключа",
  "models.footnote":
    "Фоновые задачи (автозаголовки, заметки встреч) используют DeepSeek, если задан его ключ, иначе — первого пользовательского провайдера.",
  "models.name.label": "Название",
  "models.name.placeholder": "OpenRouter, мой сервер vLLM…",
  "models.baseUrl.label": "Базовый URL",
  "models.baseUrl.hint": "OpenAI-совместимый endpoint, без /chat/completions.",
  "models.key.label": "Ключ API",
  "models.key.placeholder": "sk-… (пусто для локальных endpoint'ов)",
  "models.key.keepStored": "•••••••• (сохранён — введите, чтобы заменить)",
  "models.models.label": "Модели",
  "models.model.idPlaceholder": "id модели",
  "models.model.namePlaceholder": "отображаемое имя (необязательно)",
  "models.model.vision": "Зрение",
  "models.model.visionHint":
    "Включите «Зрение» для моделей с поддержкой изображений — вложения будут отправляться модели напрямую, без предварительной транскрипции.",
  "models.model.add": "Добавить модель",
  "page.title": "Настройки",

  "group.general": "Основные",
  "group.intelligence": "Интеллект",
  "group.inputCapture": "Ввод и захват",
  "group.app": "Приложение",
  "group.data": "Данные",
  "nav.general": "Основные",
  "general.title": "Основные",
  "general.description": "Язык и основные параметры приложения.",
  "general.autoSortConversations.label": "Перемещать активные чаты вверх",
  "general.autoSortConversations.description":
    "Меняет порядок чатов при новых сообщениях. Отключите, чтобы сохранить порядок создания с новыми чатами сверху.",
  "general.autoUpdate.label": "Автоматические обновления",
  "general.autoUpdate.description":
    "Проверяет и устанавливает обновления в фоне. Применяются при следующем запуске Cetus.",
  "general.confirmQuit.label": "Подтверждать выход",
  "general.confirmQuit.description":
    "Спрашивать перед тем, как Cmd+Q закроет Cetus, чтобы случайное нажатие не прервало работающих агентов.",
  "general.keepAwake.label": "Не давать Mac засыпать во время работы",
  "general.keepAwake.description":
    "Блокирует переход в режим сна, пока выполняется ход агента или идёт запись встречи. Экран по-прежнему гаснет и блокируется; закрытие крышки по-прежнему переводит в сон.",
  "nav.api-keys": "API-ключи",
  "nav.memory": "Память",
  "nav.skills": "Навыки",
  "nav.slash-commands": "Слэш-команды",
  "nav.connectors": "MCP",
  "nav.launcher": "Лаунчер",
  "nav.voice": "Голос",
  "nav.screen": "Контекст экрана",
  "notifications.event.meeting.label": "Запись встречи",
  "notifications.event.meeting.description":
    "Началась расшифровка, а после готов протокол.",
  "nav.meetings": "Встречи",
  "nav.agent-control": "Компьютер и браузер",
  "nav.appearance": "Оформление",
  "nav.notifications": "Уведомления",
  "nav.permissions": "Разрешения",
  "nav.archived": "Архивные чаты",

  "providers.deepseek": "DeepSeek",
  "providers.exa": "Exa (веб-поиск)",
  "providers.tavily": "Tavily (веб-поиск)",
  "providers.doubao": "Doubao (голос)",
  "providers.volcArk": "Volcano Ark (перезапись)",
  "apiKeys.title": "API-ключи",
  "apiKeys.description":
    "Ключи хранятся в связке ключей вашей ОС. При сохранении подпроцесс pi перезапускается, чтобы новые ключи вступили в силу немедленно.",
  "apiKeys.stored": "● сохранён",
  "apiKeys.unsaved": "● не сохранён",
  "apiKeys.replace": "Заменить",

  "notifications.title": "Уведомления",
  "notifications.description":
    "Получайте уведомление на рабочем столе, когда фоновая задача завершается или требует вашего участия — удобно для долгих запусков агента на доске.",
  "notifications.enable.label": "Включить уведомления",
  "notifications.enable.description":
    "Главный переключатель для всех уведомлений на рабочем столе.",
  "notifications.blocked":
    "Уведомления заблокированы вашей системой. Разрешите их для Cetus в настройках ОС.",
  "notifications.recheck": "Проверить снова",
  "notifications.notifyAbout": "Уведомлять меня о",
  "notifications.behavior": "Поведение",
  "notifications.mute.label": "Без звука, пока Cetus в фокусе",
  "notifications.mute.description": "Уведомлять только когда окно в фоне.",
  "notifications.event.task_finished.label": "Задача завершена",
  "notifications.event.task_finished.description":
    "Запуск агента завершён — ответ в чате, задача на доске или запланированная автоматизация (успешно или с ошибкой).",
  "notifications.event.awaiting_input.label": "Требуется ваш ввод",
  "notifications.event.awaiting_input.description":
    "Агент ждёт, пока вы ответите на запрос.",

  "launcher.title": "Быстрый запуск",
  "launcher.description":
    "Вызовите плавающую панель откуда угодно, чтобы начать сеанс — при желании со скриншотом экрана в качестве контекста.",
  "launcher.needAccessibility":
    "Лаунчеру нужен доступ к Универсальному доступу, чтобы распознавать жест ⌘ во всей системе.",
  "launcher.grantAccess": "Предоставить доступ",
  "launcher.openSettings": "Открыть настройки",
  "launcher.accessibilityGranted":
    "● Доступ к Универсальному доступу предоставлен",
  "launcher.needScreenRecording":
    "Для скриншотов нужен доступ к Записи экрана — без него Cetus может захватить только обои, а не окна на экране.",
  "launcher.screenRecordingGranted": "● Доступ к Записи экрана предоставлен",
  "launcher.macOnly": "Глобальный жест ⌘ доступен только в macOS.",
  "launcher.enable.label": "Включить быстрый запуск",
  "launcher.enable.description":
    "Триггер: {gesture}. Работает, даже когда Cetus в фоне.",
  "launcher.startup.label": "Запускать при старте",
  "launcher.startup.description":
    "Автоматически запускает Cetus в трее при входе в систему.",
  "launcher.gesture.doubleCmd": "Двойное нажатие ⌘",
  "launcher.gesture.bothCmd": "Удерживать обе клавиши ⌘",
  "launcher.gesture.label": "Жест-триггер",
  "launcher.gesture.description": "Как вы вызываете панель откуда угодно.",
  "launcher.gesture.opt.both": "Обе ⌘",
  "launcher.gesture.opt.bothOpt": "Оба ⌥",
  "launcher.gesture.opt.double": "Двойное нажатие ⌘",
  "launcher.gesture.opt.off": "Выкл.",
  "launcher.gesture.opt.doubleOpt": "Двойное нажатие правого ⌥",
  "launcher.fn.plain.label": "Быстрый запуск",
  "launcher.fn.plain.description":
    "Открывает панель запуска (без снимка экрана).",
  "launcher.fn.shot.label": "Быстрый запуск + снимок",
  "launcher.fn.shot.description":
    "Открывает панель запуска с прикреплённым снимком экрана.",
  "launcher.summon.label": "Вызвать Cetus",
  "launcher.summon.description":
    "Глобальное сочетание клавиш, чтобы вывести Cetus на передний план, переключаясь на другой рабочий стол при необходимости.",
  "launcher.summon.placeholder": "Задать сочетание",
  "launcher.summon.recording": "Нажмите клавиши…",
  "launcher.summon.clear": "Очистить сочетание",
  "launcher.session.label": "Сеанс по умолчанию",
  "launcher.session.description":
    "Начните новый чат или продолжите самый недавний.",
  "launcher.session.opt.new": "Новый",
  "launcher.session.opt.last": "Последний",
  "launcher.screenshot.label": "Скриншот по умолчанию",
  "launcher.screenshot.description":
    "Захватывайте экран как контекст при каждом открытии панели. Вы по-прежнему можете переключать это при каждом запуске.",

  "appearance.title": "Оформление",
  "appearance.description":
    "Задайте тему и шрифты, используемые во всём cetus. Изменения применяются мгновенно.",
  "appearance.theme.label": "Тема",
  "appearance.theme.description":
    "Следовать оформлению системы или зафиксировать светлую либо тёмную.",
  "appearance.permaLayers.label": "Плавная отрисовка при наведении",
  "appearance.permaLayers.description":
    "Держит эффекты наведения на отдельных слоях композиции, чтобы строки не дёргались при дробном масштабе. Использует больше графической памяти; можно отключить для сравнения.",

  "voice.title": "Голосовая диктовка",
  "voice.description":
    "Говорите вместо набора текста. Выберите движок распознавания ниже, затем удерживайте клавишу push-to-talk, чтобы диктовать в активное приложение.",
  "voice.macOnly": "Голосовая диктовка доступна только в macOS.",
  "voice.needPerms": "Диктовке нужен доступ к Микрофону и Распознаванию речи.",
  "voice.grantAccess": "Предоставить доступ",
  "voice.openSettings": "Открыть настройки",
  "voice.permsGranted":
    "● Доступ к Микрофону и Распознаванию речи предоставлен",
  "voice.engine.label": "Движок распознавания",
  "voice.engine.doubaoDesc":
    "Doubao (Volcano Engine) потоковая передача в реальном времени — самый быстрый (~90 мс), текст вживую по мере речи, отлично справляется со смешанным китайским/английским, работает в материковом Китае. Нужен API-ключ Doubao (X-Api-Key).",
  "voice.engine.appleDesc":
    "Apple на устройстве — мгновенно, звук никогда не покидает ваш Mac, но слабее при переключении между китайским/английским.",
  "voice.engine.opt.doubao": "Doubao (облако)",
  "voice.engine.opt.apple": "Apple (на устройстве)",
  "voice.gesture.rightOption": "Правый ⌥",
  "voice.gesture.fn": "fn (Глобус)",
  "voice.gesture.rightCmd": "Правый ⌘",
  "voice.enable.label": "Диктовка во всей системе",
  "voice.enable.description":
    "Удерживайте {gesture} где угодно, чтобы диктовать; отпустите, чтобы вставить текст в активное приложение.",
  "voice.needAccessibility":
    "Для ввода в другие приложения нужен доступ к Универсальному доступу (то же разрешение, что и у лаунчера).",
  "voice.triggerKey.label": "Клавиша-триггер",
  "voice.triggerKey.holdDesc":
    "Удерживайте этот модификатор, чтобы говорить (отпустите для вставки); дважды нажмите его для режима без рук, когда каждое предложение вставляется по мере завершения — дважды нажмите снова, чтобы остановить. Клавиши правой руки не конфликтуют с обычными сочетаниями. Режим без рук требует движка Doubao.",
  "voice.triggerKey.opt.rightCmd": "Правый ⌘",
  "voice.triggerKey.opt.rightOption": "Правый ⌥",
  "voice.triggerKey.opt.fn": "fn",
  "voice.triggerKey.opt.capsLock": "Caps Lock",
  "voice.triggerKey.capsNote":
    "Пока Cetus работает, он переназначает Caps Lock на диктовку и восстанавливает её при выходе.",
  "voice.insert.label": "Вставлять с помощью",
  "voice.insert.description":
    "Набор отправляет синтетические нажатия клавиш; Вставка использует буфер обмена + ⌘V (надёжнее в некоторых приложениях, ненадолго заменяет ваш буфер обмена).",
  "voice.insert.opt.type": "Набор",
  "voice.insert.opt.paste": "Вставка",
  "voice.cleanup.label": "Очистить с помощью ИИ",
  "voice.cleanup.description":
    "Используйте DeepSeek, чтобы удалить слова-паразиты и исправить пунктуацию перед вставкой. Требуется API-ключ DeepSeek. Только push-to-talk — режим без рук вставляет каждое предложение вживую.",
  "voice.history.label": "Сохранять историю диктовки",
  "voice.history.description":
    "Ведите журнал того, что вы диктуете, чтобы вы — и агент (через инструмент recall_dictation) — могли к нему вернуться. По умолчанию выключено.",
  "voice.history.empty":
    "Пока ничего не продиктовано — ваши расшифровки появятся здесь.",
  "voice.history.clear": "Очистить историю ({n})",

  "screen.title": "Контекст экрана",
  "screen.description":
    "Периодически захватывайте ваш экран и читайте его на устройстве (Apple Vision OCR), чтобы агент мог вспомнить, над чем вы работали. Изображения и текст остаются на вашем Mac — ничего не загружается.",
  "screen.macOnly":
    "Захват экрана настроен под macOS; OCR на устройстве использует Apple Vision.",
  "screen.browse": "Просмотреть захваченные кадры",
  "screen.enable.label": "Включить захват экрана",
  "screen.enable.description":
    "По умолчанию выключено. Когда включено, Cetus захватывает экран по таймеру в фоне.",
  "screen.interval.label": "Интервал захвата",
  "screen.interval.description":
    "Секунды между захватами. Почти одинаковые кадры пропускаются автоматически.",
  "screen.interval.unit": "сек",
  "screen.retention.label": "Хранить историю",
  "screen.retention.description":
    "Старые кадры удаляются с диска. Установите 0, чтобы хранить вечно.",
  "screen.retention.unit": "дней",
  "screen.ocr.label": "Читать текст на устройстве (OCR)",
  "screen.ocr.description":
    "Используйте Apple Vision для извлечения текста на экране, чтобы агент мог его искать. Выполняется локально.",
  "screen.excluded.label": "Исключённые приложения",
  "screen.excluded.description":
    "Имена приложений или bundle id через запятую. Захват пропускается, пока одно из них на переднем плане (напр. 1Password, Сообщения).",
  "screen.frames.one":
    "Захвачен {count} кадр · macOS запрашивает разрешение на Запись экрана при первом захвате.",
  "screen.frames.other":
    "Захвачено кадров: {count} · macOS запрашивает разрешение на Запись экрана при первом захвате.",

  "agentControl.title": "Управление компьютером и браузером",
  "agentControl.description":
    "Позволяет агенту управлять вашим браузером и приложениями Mac. Требует Универсального доступа (и Записи экрана для живого просмотра).",
  "agentControl.browser.label": "Включить управление браузером",
  "agentControl.browser.description":
    "Добавляет инструменты browser_* и подсказку управления на основе индексов для работы с веб-браузером. Агент подтверждает важные действия, и вы можете остановить его в любой момент.",
  "agentControl.computer.label": "Включить управление компьютером",
  "agentControl.computer.description":
    "Добавляет инструменты computer_* для управления приложениями этого Mac через универсальный доступ. Агент подтверждает важные действия, и вы можете остановить его в любой момент.",
  "agentControl.ax.label": "Доступ к Универсальному доступу",
  "agentControl.ax.notGranted":
    "Не предоставлен — агент не может читать интерфейсы приложений или кликать/печатать по индексу.",
  "agentControl.ax.granted": "Предоставлен.",
  "agentControl.checking": "Проверка…",
  "agentControl.enabled": "Включено",
  "agentControl.grant": "Предоставить",
  "agentControl.openSettings": "Открыть настройки",
  "agentControl.screen.label": "Доступ к Записи экрана",
  "agentControl.screen.notGranted":
    "Не предоставлен — живой предпросмотр скриншота не будет показан.",
  "agentControl.screen.granted": "Предоставлен.",
  "agentControl.footnote":
    "Агент действует через нумерованные списки элементов, никогда не через сырые пиксели, и спрашивает перед чем-либо важным (отправка, удаление, покупка, отправка формы, аутентификация). Пока он активен, в чате появляется кнопка «Стоп».",

  "archived.title": "Архивные чаты",
  "archived.description":
    "Беседы, которые вы заархивировали из боковой панели. Восстановите одну, чтобы вернуть её, или очистите все, чтобы освободить место — удаление необратимо.",
  "archived.loading": "Загрузка…",
  "archived.empty": "Нет архивных чатов.",
  "archived.count.one": "{count} архивный чат",
  "archived.count.other": "Архивных чатов: {count}",
  "archived.deleteAllPrompt": "Удалить все {count}?",
  "archived.deleting": "Удаление…",
  "archived.deleteAll": "Удалить все",
  "archived.untitled": "Без названия",
  "archived.archivedOn": "Заархивировано {date}",
  "archived.restore": "Восстановить",
  "archived.deleteAria": "Удалить чат",

  "memory.title": "Память",
  "memory.description":
    "Устойчивые заметки о вас — ваши предпочтения, текущие проекты и решения — которые агент переносит из беседы в беседу. Агент дополняет их по мере обучения; здесь вы можете добавлять, редактировать, отключать или удалять любую из них.",
  "memory.enable.label": "Включить память",
  "memory.enable.description":
    "Когда включено, включённые ниже заметки внедряются в контекст агента на каждом ходу. Выключите, чтобы приостановить память, не теряя заметок.",
  "memory.add.label": "Добавить запись в память",
  "memory.add.placeholder":
    "напр. Предпочитает pnpm вместо npm и лаконичные сообщения коммитов.",
  "memory.category.placeholder": "Категория (необязательно)",
  "memory.adding": "Добавление…",
  "memory.add.button": "Добавить",
  "memory.loading": "Загрузка…",
  "memory.empty": "Пока нет записей в памяти",
  "memory.count.one": "{count} запись в памяти",
  "memory.count.other": "Записей в памяти: {count}",
  "memory.deleteAllPrompt": "Удалить всё?",
  "memory.clearAll": "Очистить всё",
  "memory.saving": "Сохранение…",
  "memory.save": "Сохранить",
  "memory.tag.agent": "Агент",
  "memory.tag.you": "Вы",
  "memory.editedOn": "Отредактировано {date}",
  "memory.muteAria": "Отключить запись памяти",
  "memory.enableAria": "Включить запись памяти",
  "memory.editAria": "Редактировать запись памяти",
  "memory.deleteAria": "Удалить запись памяти",

  "skills.title": "Навыки",
  "skills.description":
    "Многоразовые инструкции, которые агент может подключить по запросу — папка с SKILL.md (имя + описание + шаги), следующая открытому стандарту Agent Skills. Установите навык из папки или напишите свой; включённые навыки предлагаются агенту на каждом ходу.",
  "skills.enable.label": "Включить навыки",
  "skills.enable.description":
    "Когда включено, включённые ниже навыки становятся доступны агенту. Выключите, чтобы приостановить все навыки, не удаляя их.",
  "skills.importing": "Импорт…",
  "skills.import": "Импортировать папку",
  "skills.write": "Написать свой",
  "skills.learn": "Узнать о навыках",
  "skills.loading": "Загрузка…",
  "skills.empty": "Навыки не установлены",
  "skills.count.one": "{count} навык",
  "skills.count.other": "Навыков: {count}",
  "skills.source.written": "Написан",
  "skills.source.imported": "Импортирован",
  "skills.source.proposed": "Предложен",
  "skills.source.byAgent": "От агента",
  "skills.updatedOn": "Обновлён {date}",
  "skills.disableAria": "Отключить навык",
  "skills.enableAria": "Включить навык",
  "skills.openFolderAria": "Открыть папку навыка",
  "skills.delete": "Удалить",
  "skills.uninstallAria": "Удалить навык",
  "skills.editor.title": "Написать навык",
  "skills.editor.namePlaceholder": "Имя, напр. Стиль сообщений коммитов",
  "skills.editor.descPlaceholder":
    "Когда агенту следует его использовать? (одна строка)",
  "skills.editor.bodyPlaceholder":
    "Сам навык в формате markdown. Шаги, примеры, правила…",
  "skills.editor.saving": "Сохранение…",
  "skills.editor.create": "Создать навык",

  "connectors.title": "MCP",
  "connectors.description":
    "Подключайте агента к внешним инструментам через серверы MCP (Model Context Protocol) — локальную команду или удалённый URL. Добавьте сервер и нажмите «Проверить», чтобы выполнить настоящее рукопожатие и увидеть предлагаемые инструменты. Инструменты каждого включённого MCP-сервера загружаются в агента, чтобы он мог вызывать их как встроенные; изменения вступают в силу в новых беседах.",
  "connectors.loading": "Загрузка…",
  "connectors.empty": "Пока нет MCP-серверов",
  "connectors.count.one": "{count} MCP-сервер",
  "connectors.count.other": "{count} MCP-серверов",
  "connectors.add": "Добавить MCP-сервер",
  "connectors.disableAria": "Отключить MCP-сервер",
  "connectors.enableAria": "Включить MCP-сервер",
  "connectors.editAria": "Редактировать MCP-сервер",
  "connectors.removeAria": "Удалить MCP-сервер",
  "connectors.editor.name": "Имя",
  "connectors.editor.namePlaceholder": "напр. GitHub, Filesystem, Linear…",
  "connectors.editor.transport": "Транспорт",
  "connectors.editor.transportDesc":
    "Локальный процесс (stdio) или удалённая конечная точка MCP (HTTP/SSE).",
  "connectors.editor.command": "Команда",
  "connectors.editor.commandPlaceholder": "напр. npx",
  "connectors.editor.args": "Аргументы",
  "connectors.editor.argsHint": "по одному в строке",
  "connectors.editor.env": "Окружение",
  "connectors.editor.envHint": "передаётся процессу",
  "connectors.editor.url": "URL",
  "connectors.editor.headers": "Заголовки",
  "connectors.editor.headersHint": "отправляется с каждым запросом",
  "connectors.test.connected": "Подключено",
  "connectors.test.tools.one": "{count} инструмент: {names}",
  "connectors.test.tools.other": "Инструментов: {count}: {names}",
  "connectors.test.noTools":
    "Рукопожатие успешно — сервер не предоставляет инструментов.",
  "connectors.test.failed": "Не удалось подключиться.",
  "connectors.editor.saving": "Сохранение…",
  "connectors.testing": "Проверка…",
  "connectors.test.button": "Проверить",
  "connectors.editor.envName": "КЛЮЧ",
  "connectors.editor.envValue": "значение",
  "connectors.editor.addEnv": "Добавить переменную",
  "connectors.editor.headerName": "Имя",
  "connectors.editor.headerValue": "Значение",
  "connectors.editor.addHeader": "Добавить заголовок",
  "connectors.editor.removeRow": "Удалить",
  "connectors.details.toggleAria": "Показать инструменты",
  "connectors.details.loading": "Загрузка инструментов…",
  "connectors.details.connected": "Подключено",
  "connectors.details.toolCount.one": "{count} инструмент",
  "connectors.details.toolCount.other": "{count} инструментов",
  "connectors.oauth.auth": "Аутентификация",
  "connectors.oauth.authDesc":
    "Статичные заголовки или OAuth (Cetus выполняет вход).",
  "connectors.oauth.none": "Нет",
  "connectors.oauth.clientId": "Client ID",
  "connectors.oauth.clientIdPlaceholder": "авто (динамическая регистрация)",
  "connectors.oauth.scope": "Scope",
  "connectors.oauth.optional": "необязательно",
  "connectors.oauth.authorize": "Авторизовать",
  "connectors.oauth.authorizing": "Авторизация…",
  "connectors.oauth.authorized": "Авторизовано — токены сохранены.",
  "connectors.oauth.hint": "Откроет браузер для входа.",
  "connectors.oauth.saveHint":
    "Сохраните MCP-сервер, затем разверните его ниже и нажмите «Авторизовать».",
  "discovery.mcp.none": "Серверы не найдены (нет файла конфигурации).",
  "discovery.mcp.title": "Импорт из других приложений",
  "discovery.mcp.description":
    "Также загружать MCP-серверы из этих приложений. Только для новых чатов.",
  "skills.discovered.loadLabel": "Загружать найденные навыки",
  "skills.discovered.loadDesc": "Включать навыки из папки ниже в новые чаты.",
  "skills.discovered.chooseFolder": "Выбрать папку",
};
