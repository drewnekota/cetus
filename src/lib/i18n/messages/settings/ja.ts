export const ja = {
  "models.model.reasoningHint":
    "推論の強度パラメーターを持つモデルでは「推論」をオンにし、エンドポイントが対応するレベルを有効にしてください。各レベルは既定でレベル名をそのまま送信し、トークンを入力すると上書きできます。「形式」はベンダーが期待する effort フィールドの形を選択します。無効なレベルは最も近い有効レベルに丸められます。",
  "models.model.format": "形式",
  "models.model.reasoning": "推論",
  "nav.models": "モデル",
  "models.title": "モデル",
  "models.description":
    "OpenAI 互換のモデルプロバイダーを追加できます。Base URL、API キー、モデル ID を設定すると、チャットのモデルピッカーに内蔵モデルと並んで表示されます。",
  "models.empty": "カスタムプロバイダーはまだありません。",
  "models.add": "プロバイダーを追加",
  "models.noKey": "キー未設定",
  "models.footnote":
    "バックグラウンドタスク（自動タイトル、会議メモ)は DeepSeek キーがあれば DeepSeek を、なければ最初のカスタムプロバイダーを使います。",
  "models.name.label": "名前",
  "models.name.placeholder": "OpenRouter、自前の vLLM など",
  "models.baseUrl.label": "Base URL",
  "models.baseUrl.hint":
    "OpenAI 互換エンドポイント（/chat/completions は不要)。",
  "models.key.label": "API キー",
  "models.key.placeholder": "sk-…（ローカルエンドポイントは空欄可）",
  "models.key.keepStored": "••••••••（保存済み — 入力で置き換え）",
  "models.models.label": "モデル",
  "models.model.idPlaceholder": "モデル ID",
  "models.model.namePlaceholder": "表示名（任意）",
  "models.model.vision": "ビジョン",
  "models.model.visionHint":
    "画像入力に対応するモデルではビジョンをオンにしてください。添付画像が文字起こしされずに直接モデルへ送られます。",
  "models.model.add": "モデルを追加",
  "page.title": "設定",

  "group.general": "一般",
  "group.intelligence": "インテリジェンス",
  "group.inputCapture": "入力とキャプチャ",
  "group.app": "アプリ",
  "group.data": "データ",
  "nav.general": "一般",
  "general.title": "一般",
  "general.description": "言語とアプリの基本設定。",
  "general.autoSortConversations.label": "更新されたチャットを上に移動",
  "general.autoSortConversations.description":
    "新しいメッセージが届くとチャットを並べ替えます。オフにすると作成順を維持し、新しいチャットが上に表示されます。",
  "general.autoUpdate.label": "自動アップデート",
  "general.autoUpdate.description":
    "バックグラウンドで更新を確認・インストールします。次回 Cetus 起動時に適用されます。",
  "general.confirmQuit.label": "終了前に確認",
  "general.confirmQuit.description":
    "Cmd+Q で Cetus を終了する前に確認し、誤操作で実行中のエージェントを中断しないようにします。",
  "nav.api-keys": "API キー",
  "nav.memory": "メモリ",
  "nav.skills": "スキル",
  "nav.slash-commands": "スラッシュコマンド",
  "nav.connectors": "MCP",
  "nav.launcher": "ランチャー",
  "nav.voice": "音声",
  "nav.screen": "画面コンテキスト",
  "notifications.event.meeting.label": "ミーティング記録",
  "notifications.event.meeting.description":
    "文字起こしの開始時と、議事録の完成時に通知します。",
  "nav.meetings": "ミーティング",
  "nav.agent-control": "コンピュータとブラウザ",
  "nav.appearance": "外観",
  "nav.notifications": "通知",
  "nav.permissions": "権限",
  "nav.archived": "アーカイブ済みチャット",

  "providers.deepseek": "DeepSeek",
  "providers.exa": "Exa（ウェブ検索）",
  "providers.tavily": "Tavily（ウェブ検索）",
  "providers.doubao": "Doubao（音声）",
  "providers.volcArk": "Volcano Ark（書き換え）",
  "apiKeys.title": "API キー",
  "apiKeys.description":
    "キーは OS のキーチェーンに保存されます。保存すると pi サブプロセスが再起動し、新しいキーがすぐに反映されます。",
  "apiKeys.stored": "● 保存済み",
  "apiKeys.unsaved": "● 未保存",
  "apiKeys.replace": "差し替え",
  "apiKeys.deepseekUrl.label": "DeepSeek API URL",
  "apiKeys.deepseekUrl.hint":
    "任意。すべての DeepSeek 通信（エージェント本体に加え、タイトル生成・議事録）を、カスタムの OpenAI 互換ベース URL（プロキシ／セルフホスト）経由にします。空欄ならデフォルトの api.deepseek.com を使用します。",

  "notifications.title": "通知",
  "notifications.description":
    "バックグラウンドのタスクが完了したり対応が必要になったときにデスクトップ通知を受け取れます。長時間のエージェント実行に便利です。",
  "notifications.enable.label": "通知を有効にする",
  "notifications.enable.description":
    "すべてのデスクトップ通知のマスタースイッチ。",
  "notifications.blocked":
    "システムによって通知がブロックされています。OS の設定で Cetus の通知を許可してください。",
  "notifications.recheck": "再確認",
  "notifications.notifyAbout": "通知するイベント",
  "notifications.behavior": "動作",
  "notifications.mute.label": "Cetus がアクティブな間はミュート",
  "notifications.mute.description":
    "ウィンドウがバックグラウンドのときのみ通知します。",
  "notifications.event.task_finished.label": "タスク完了",
  "notifications.event.task_finished.description":
    "エージェントの実行が完了しました（チャットの返信、ボードのタスク、または定期実行の自動化のいずれか。成功・失敗を問わず）。",
  "notifications.event.awaiting_input.label": "入力が必要です",
  "notifications.event.awaiting_input.description":
    "エージェントがプロンプトへの回答を待っています。",

  "launcher.title": "クイックランチャー",
  "launcher.description":
    "どこからでもフローティングパネルを呼び出してセッションを開始できます。必要に応じて画面のスクリーンショットをコンテキストとして添付できます。",
  "launcher.needAccessibility":
    "ランチャーがシステム全体で ⌘ ジェスチャーを検出するには、アクセシビリティ権限が必要です。",
  "launcher.grantAccess": "権限を付与",
  "launcher.openSettings": "システム設定を開く",
  "launcher.accessibilityGranted": "● アクセシビリティ権限を付与済み",
  "launcher.needScreenRecording":
    "スクリーンショットには画面収録の権限が必要です。権限がないと Cetus は壁紙しかキャプチャできず、画面上のウィンドウは取得できません。",
  "launcher.screenRecordingGranted": "● 画面収録の権限を付与済み",
  "launcher.macOnly":
    "グローバルな ⌘ ジェスチャーは macOS でのみ利用できます。",
  "launcher.enable.label": "クイックランチャーを有効にする",
  "launcher.enable.description":
    "トリガー：{gesture}。Cetus がバックグラウンドにあっても動作します。",
  "launcher.startup.label": "起動時に開始",
  "launcher.startup.description":
    "ログイン時に Cetus をトレイで自動的に起動します。",
  "launcher.gesture.doubleCmd": "⌘ をダブルタップ",
  "launcher.gesture.bothCmd": "両方の ⌘ キーを押し続ける",
  "launcher.gesture.label": "トリガージェスチャー",
  "launcher.gesture.description": "どこからパネルを呼び出すかの方法。",
  "launcher.gesture.opt.both": "両方の ⌘",
  "launcher.gesture.opt.bothOpt": "両方の ⌥",
  "launcher.gesture.opt.double": "⌘ をダブルタップ",
  "launcher.gesture.opt.off": "オフ",
  "launcher.gesture.opt.doubleOpt": "右 ⌥ をダブルタップ",
  "launcher.fn.plain.label": "クイック起動",
  "launcher.fn.plain.description":
    "ランチャーを開きます（スクリーンショットなし）。",
  "launcher.fn.shot.label": "クイック起動 + スクリーンショット",
  "launcher.fn.shot.description":
    "画面の範囲を選択して添付（クリックで全画面）し、ランチャーを開きます。",
  "launcher.summon.label": "Cetus を呼び出す",
  "launcher.summon.description":
    "Cetus を最前面に表示するグローバルショートカット。別のデスクトップにある場合はそちらに切り替えます。",
  "launcher.summon.placeholder": "ショートカットを設定",
  "launcher.summon.recording": "キーを押してください…",
  "launcher.summon.clear": "ショートカットをクリア",
  "launcher.session.label": "デフォルトのセッション",
  "launcher.session.description":
    "新しいチャットを始めるか、直近のチャットを続けます。",
  "launcher.session.opt.new": "新規",
  "launcher.session.opt.last": "直近",
  "launcher.screenshot.label": "デフォルトでスクリーンショット",
  "launcher.screenshot.description":
    "パネルを開くたびに画面をコンテキストとしてキャプチャします。起動ごとに個別に切り替えることもできます。",

  "appearance.title": "外観",
  "appearance.description":
    "Cetus 全体で使用するテーマとフォントを設定します。変更はすぐに反映されます。",
  "appearance.theme.label": "テーマ",
  "appearance.theme.description":
    "システムの外観に従うか、ライトまたはダークに固定します。",
  "appearance.permaLayers.label": "ホバー描画の平滑化",
  "appearance.permaLayers.description":
    "ホバーのフェードを専用の合成レイヤーに保持し、小数ズームでの行の揺れを防ぎます。グラフィックスメモリを余分に使用します。比較のためにオフにできます。",

  "voice.title": "音声入力",
  "voice.description":
    "入力する代わりに話しかけます。下で認識エンジンを選び、プッシュトゥトークキーを押している間、フォーカス中のアプリに音声入力できます。",
  "voice.macOnly": "音声入力は macOS でのみ利用できます。",
  "voice.needPerms": "音声入力にはマイクと音声認識の権限が必要です。",
  "voice.grantAccess": "権限を付与",
  "voice.openSettings": "システム設定を開く",
  "voice.permsGranted": "● マイクと音声認識の権限を付与済み",
  "voice.engine.label": "認識エンジン",
  "voice.engine.doubaoDesc":
    "Doubao（Volcano Engine）リアルタイムストリーミング — 最速（約 90ms）、話すそばからテキスト化、中英混在に強く、中国本土でも動作します。Doubao の API キー（X-Api-Key）が必要です。",
  "voice.engine.appleDesc":
    "Apple オンデバイス — 即時で、音声が Mac の外に出ることはありませんが、中英の切り替えにはやや弱めです。",
  "voice.engine.opt.doubao": "Doubao（クラウド）",
  "voice.engine.opt.apple": "Apple（オンデバイス）",
  "voice.gesture.rightOption": "右 ⌥",
  "voice.gesture.fn": "fn（地球儀）",
  "voice.gesture.rightCmd": "右 ⌘",
  "voice.enable.label": "システム全体の音声入力",
  "voice.enable.description":
    "どこでも {gesture} を押している間に音声入力し、離すとフォーカス中のアプリにテキストが挿入されます。",
  "voice.needAccessibility":
    "他のアプリへの入力にはアクセシビリティ権限が必要です（ランチャーと同じ権限）。",
  "voice.triggerKey.label": "トリガーキー",
  "voice.triggerKey.holdDesc":
    "この修飾キーを押している間は音声入力（離すと挿入）。ダブルタップでハンズフリーになり、一文ごとに挿入されます — もう一度ダブルタップで停止。右側のキーは通常のショートカットと競合しにくくなっています。ハンズフリーは Doubao エンジンが必要です。",
  "voice.triggerKey.opt.rightCmd": "右 ⌘",
  "voice.triggerKey.opt.rightOption": "右 ⌥",
  "voice.triggerKey.opt.fn": "fn",
  "voice.triggerKey.opt.capsLock": "Caps Lock",
  "voice.triggerKey.capsNote":
    "選択中、Cetus は起動している間 Caps Lock を音声入力に割り当て、終了時に元へ戻します。",
  "voice.insert.label": "挿入方法",
  "voice.insert.description":
    "「入力」は擬似キーストロークを送信し、「貼り付け」はクリップボード + ⌘V を使います（一部のアプリでより確実ですが、クリップボードを一時的に置き換えます）。",
  "voice.insert.opt.type": "入力",
  "voice.insert.opt.paste": "貼り付け",
  "voice.cleanup.label": "AI でクリーンアップ",
  "voice.cleanup.description":
    "挿入前に DeepSeek でフィラーを除去し、句読点を整えます。DeepSeek の API キーが必要です。プッシュトゥトークのみ — ハンズフリーは一文ごとにそのまま挿入します。",
  "voice.cleanup.modelLabel": "クリーンアップモデル",
  "voice.cleanup.modelHint":
    "リライトに使う Ark モデル ID。空欄で内蔵のデフォルトを使用します。スナップショットが廃止された場合は自動的に前のモデルへフォールバックします。",
  "voice.history.label": "音声入力の履歴を保存",
  "voice.history.description":
    "音声入力した内容を記録し、あなたとエージェント（recall_dictation ツール経由）が後から参照できるようにします。既定ではオフです。",
  "voice.history.empty":
    "まだ音声入力がありません — 文字起こしはここに表示されます。",
  "voice.history.clear": "履歴を消去（{n}）",

  "screen.title": "画面コンテキスト",
  "screen.description":
    "画面を定期的にキャプチャし、オンデバイス（Apple Vision OCR）で読み取って、エージェントが作業内容を思い出せるようにします。画像とテキストは Mac 内にとどまり、アップロードされません。",
  "screen.macOnly":
    "画面キャプチャは macOS 向けに調整されています。オンデバイス OCR は Apple Vision を使用します。",
  "screen.browse": "キャプチャしたフレームを閲覧",
  "screen.enable.label": "画面キャプチャを有効にする",
  "screen.enable.description":
    "既定ではオフです。オンにすると、Cetus はバックグラウンドでタイマーに従って画面をキャプチャします。",
  "screen.interval.label": "キャプチャ間隔",
  "screen.interval.description":
    "キャプチャの間隔（秒）。ほぼ同じフレームは自動的にスキップされます。",
  "screen.interval.unit": "秒",
  "screen.retention.label": "履歴の保持期間",
  "screen.retention.description":
    "古いフレームはディスクから削除されます。0 にすると永久に保持します。",
  "screen.retention.unit": "日",
  "screen.ocr.label": "オンデバイスで文字を読み取る（OCR）",
  "screen.ocr.description":
    "Apple Vision で画面上の文字を抽出し、エージェントが検索できるようにします。ローカルで実行されます。",
  "screen.excluded.label": "除外するアプリ",
  "screen.excluded.description":
    "アプリ名またはバンドル ID をカンマ区切りで指定します。これらが最前面にある間はキャプチャがスキップされます（例：1Password、メッセージ）。",
  "screen.frames.one":
    "{count} フレームをキャプチャ済み · 初回キャプチャ時に macOS が画面収録の権限を求めます。",
  "screen.frames.other":
    "{count} フレームをキャプチャ済み · 初回キャプチャ時に macOS が画面収録の権限を求めます。",

  "agentControl.title": "コンピュータとブラウザの操作",
  "agentControl.description":
    "エージェントがブラウザや Mac アプリを操作できるようにします。アクセシビリティ（ライブビューには画面収録も）が必要です。",
  "agentControl.browser.label": "ブラウザ操作を有効にする",
  "agentControl.browser.description":
    "ウェブブラウザを操作するための browser_* ツールとインデックスベースの操作プロンプトを追加します。エージェントは重要な操作の前に確認し、いつでも停止できます。",
  "agentControl.computer.label": "コンピュータ操作を有効にする",
  "agentControl.computer.description":
    "アクセシビリティ経由でこの Mac のアプリを操作する computer_* ツールを追加します。エージェントは重要な操作の前に確認し、いつでも停止できます。",
  "agentControl.ax.label": "アクセシビリティ権限",
  "agentControl.ax.notGranted":
    "未付与 — エージェントはアプリの UI を読み取ったり、インデックスでクリック／入力したりできません。",
  "agentControl.ax.granted": "付与済み。",
  "agentControl.checking": "確認中…",
  "agentControl.enabled": "有効",
  "agentControl.grant": "付与",
  "agentControl.openSettings": "システム設定を開く",
  "agentControl.screen.label": "画面収録の権限",
  "agentControl.screen.notGranted":
    "未付与 — ライブのスクリーンショットプレビューが表示されません。",
  "agentControl.screen.granted": "付与済み。",
  "agentControl.footnote":
    "エージェントは番号付きの要素リストを介して操作し、生のピクセルは扱いません。また、重要な操作（送信、削除、購入、提出、認証）の前には必ず確認します。動作中はチャットに停止ボタンが表示されます。",

  "archived.title": "アーカイブ済みチャット",
  "archived.description":
    "サイドバーからアーカイブした会話です。1 つを復元して戻すか、すべて消去して容量を空けられます。削除は元に戻せません。",
  "archived.loading": "読み込み中…",
  "archived.empty": "アーカイブ済みチャットはありません。",
  "archived.count.one": "{count} 件のアーカイブ済みチャット",
  "archived.count.other": "{count} 件のアーカイブ済みチャット",
  "archived.deleteAllPrompt": "{count} 件すべて削除しますか？",
  "archived.deleting": "削除中…",
  "archived.deleteAll": "すべて削除",
  "archived.untitled": "無題",
  "archived.archivedOn": "{date} にアーカイブ",
  "archived.restore": "復元",
  "archived.deleteAria": "チャットを削除",

  "memory.title": "メモリ",
  "memory.description":
    "あなたに関する持続的なノート — 好み、進行中のプロジェクト、決定事項 — で、エージェントが会話をまたいで引き継ぎます。学習に応じてエージェントが追記し、ここで追加・編集・ミュート・削除できます。",
  "memory.enable.label": "メモリを有効にする",
  "memory.enable.description":
    "オンにすると、下の有効なノートが毎ターン、エージェントのコンテキストに注入されます。オフにすると、ノートを失わずにメモリを一時停止できます。",
  "memory.add.label": "メモリを追加",
  "memory.add.placeholder":
    "例：npm より pnpm を好み、コミットメッセージは簡潔に。",
  "memory.category.placeholder": "カテゴリ（任意）",
  "memory.adding": "追加中…",
  "memory.add.button": "追加",
  "memory.loading": "読み込み中…",
  "memory.empty": "まだメモリはありません",
  "memory.count.one": "{count} 件のメモリ",
  "memory.count.other": "{count} 件のメモリ",
  "memory.deleteAllPrompt": "すべて削除しますか？",
  "memory.clearAll": "すべて消去",
  "memory.saving": "保存中…",
  "memory.save": "保存",
  "memory.tag.agent": "エージェント",
  "memory.tag.you": "あなた",
  "memory.editedOn": "{date} に編集",
  "memory.muteAria": "メモリをミュート",
  "memory.enableAria": "メモリを有効化",
  "memory.editAria": "メモリを編集",
  "memory.deleteAria": "メモリを削除",

  "skills.title": "スキル",
  "skills.description":
    "エージェントが必要に応じて取り込める再利用可能な指示です。SKILL.md（名前＋説明＋手順）を含むフォルダで、オープンな Agent Skills 標準に準拠します。フォルダからインストールするか自分で作成でき、有効なスキルは毎ターン、エージェントに提供されます。",
  "skills.enable.label": "スキルを有効にする",
  "skills.enable.description":
    "オンにすると、下の有効なスキルがエージェントに提供されます。オフにすると、アンインストールせずにすべてのスキルを一時停止できます。",
  "skills.importing": "インポート中…",
  "skills.import": "フォルダをインポート",
  "skills.write": "自分で作成",
  "skills.learn": "スキルについて学ぶ",
  "skills.loading": "読み込み中…",
  "skills.empty": "インストール済みのスキルはありません",
  "skills.count.one": "{count} 個のスキル",
  "skills.count.other": "{count} 個のスキル",
  "skills.source.written": "作成",
  "skills.source.imported": "インポート",
  "skills.source.proposed": "提案",
  "skills.source.byAgent": "エージェント作成",
  "skills.updatedOn": "{date} に更新",
  "skills.disableAria": "スキルを無効化",
  "skills.enableAria": "スキルを有効化",
  "skills.openFolderAria": "スキルのフォルダを開く",
  "skills.delete": "削除",
  "skills.uninstallAria": "スキルをアンインストール",
  "skills.editor.title": "スキルを作成",
  "skills.editor.namePlaceholder": "名前（例：コミットメッセージのスタイル）",
  "skills.editor.descPlaceholder":
    "エージェントはどんなときにこれを使うべき？（1 行）",
  "skills.editor.bodyPlaceholder":
    "スキル本体を Markdown で。手順、例、ルールなど…",
  "skills.editor.saving": "保存中…",
  "skills.editor.create": "スキルを作成",

  "connectors.title": "MCP",
  "connectors.description":
    "MCP（Model Context Protocol）サーバー — ローカルコマンドまたはリモート URL — を通じて、エージェントを外部ツールに接続します。サーバーを追加して「テスト」すると、実際のハンドシェイクを実行し、提供されるツールを確認できます。有効な各 MCP サーバーのツールはエージェントに読み込まれ、組み込みツールのように呼び出せます。変更は新しい会話から有効になります。",
  "connectors.loading": "読み込み中…",
  "connectors.empty": "まだ MCP サーバーはありません",
  "connectors.count.one": "{count} 個の MCP サーバー",
  "connectors.count.other": "{count} 個の MCP サーバー",
  "connectors.add": "MCP サーバーを追加",
  "connectors.disableAria": "MCP サーバーを無効化",
  "connectors.enableAria": "MCP サーバーを有効化",
  "connectors.editAria": "MCP サーバーを編集",
  "connectors.removeAria": "MCP サーバーを削除",
  "connectors.editor.name": "名前",
  "connectors.editor.namePlaceholder": "例：GitHub、Filesystem、Linear…",
  "connectors.editor.transport": "トランスポート",
  "connectors.editor.transportDesc":
    "ローカルプロセス（stdio）またはリモートの MCP エンドポイント（HTTP/SSE）。",
  "connectors.editor.command": "コマンド",
  "connectors.editor.commandPlaceholder": "例：npx",
  "connectors.editor.args": "引数",
  "connectors.editor.argsHint": "1 行に 1 つ",
  "connectors.editor.env": "環境変数",
  "connectors.editor.envHint": "プロセスに渡されます",
  "connectors.editor.url": "URL",
  "connectors.editor.headers": "ヘッダー",
  "connectors.editor.headersHint": "各リクエストで送信されます",
  "connectors.test.connected": "接続しました",
  "connectors.test.tools.one": "{count} 個のツール：{names}",
  "connectors.test.tools.other": "{count} 個のツール：{names}",
  "connectors.test.noTools":
    "ハンドシェイク成功 — サーバーはツールを公開していません。",
  "connectors.test.failed": "接続に失敗しました。",
  "connectors.editor.saving": "保存中…",
  "connectors.testing": "テスト中…",
  "connectors.test.button": "テスト",
  "connectors.editor.envName": "KEY",
  "connectors.editor.envValue": "値",
  "connectors.editor.addEnv": "変数を追加",
  "connectors.editor.headerName": "名前",
  "connectors.editor.headerValue": "値",
  "connectors.editor.addHeader": "ヘッダーを追加",
  "connectors.editor.removeRow": "削除",
  "connectors.details.toggleAria": "ツールの詳細を切り替え",
  "connectors.details.loading": "ツールを読み込み中…",
  "connectors.details.connected": "接続済み",
  "connectors.details.toolCount.one": "{count} 個のツール",
  "connectors.details.toolCount.other": "{count} 個のツール",
  "connectors.oauth.auth": "認証",
  "connectors.oauth.authDesc":
    "静的ヘッダー、または OAuth（Cetus がサインインを実行）。",
  "connectors.oauth.none": "なし",
  "connectors.oauth.clientId": "クライアント ID",
  "connectors.oauth.clientIdPlaceholder": "自動（動的登録）",
  "connectors.oauth.scope": "スコープ",
  "connectors.oauth.optional": "任意",
  "connectors.oauth.authorize": "認証する",
  "connectors.oauth.authorizing": "認証中…",
  "connectors.oauth.authorized": "認証済み — トークンを保存しました。",
  "connectors.oauth.hint": "ブラウザを開いてサインインします。",
  "connectors.oauth.saveHint":
    "MCP サーバーを保存し、下で展開して Authorize をクリックします。",
  "discovery.mcp.none": "サーバーが見つかりません（設定ファイルなし）。",
  "discovery.mcp.title": "他のアプリから読み込む",
  "discovery.mcp.description":
    "これらのアプリで設定された MCP サーバーも読み込みます。新しいチャットにのみ適用。",
  "skills.discovered.loadLabel": "発見したスキルを読み込む",
  "skills.discovered.loadDesc":
    "下のフォルダのスキルを新しいチャットに含めます。",
  "skills.discovered.chooseFolder": "フォルダを選択",
};
