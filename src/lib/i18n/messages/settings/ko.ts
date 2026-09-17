export const ko = {
  "models.model.reasoningHint":
    "추론 강도 파라미터가 있는 모델은 '추론'을 켜고 엔드포인트가 지원하는 레벨을 활성화하세요. 각 레벨은 기본적으로 레벨 이름을 그대로 보내며, 토큰을 입력해 재정의할 수 있습니다. '형식'은 공급자가 기대하는 effort 필드 형태를 선택합니다. 비활성 레벨은 가장 가까운 활성 레벨로 조정됩니다.",
  "models.model.format": "형식",
  "models.model.reasoning": "추론",
  "nav.models": "모델",
  "models.title": "모델",
  "models.description":
    "OpenAI 호환 모델 제공자를 직접 추가하세요. Base URL, API 키, 모델 ID를 입력하면 채팅 모델 선택기에 기본 모델과 함께 표시됩니다.",
  "models.empty": "아직 사용자 지정 제공자가 없습니다.",
  "models.add": "제공자 추가",
  "models.noKey": "키 없음",
  "models.footnote":
    "백그라운드 작업(자동 제목, 회의 노트)은 DeepSeek 키가 있으면 DeepSeek을, 없으면 첫 번째 사용자 지정 제공자를 사용합니다.",
  "models.name.label": "이름",
  "models.name.placeholder": "OpenRouter, 내 vLLM 서버 등",
  "models.baseUrl.label": "Base URL",
  "models.baseUrl.hint": "OpenAI 호환 엔드포인트(/chat/completions 제외).",
  "models.key.label": "API 키",
  "models.key.placeholder": "sk-… (로컬 엔드포인트는 비워도 됨)",
  "models.key.keepStored": "•••••••• (저장됨 — 입력하면 교체)",
  "models.models.label": "모델",
  "models.model.idPlaceholder": "모델 ID",
  "models.model.namePlaceholder": "표시 이름(선택)",
  "models.model.vision": "비전",
  "models.model.visionHint":
    "이미지 입력을 지원하는 모델은 비전을 켜세요. 첨부 이미지가 텍스트로 변환되지 않고 모델로 바로 전송됩니다.",
  "models.model.add": "모델 추가",
  "page.title": "설정",

  "group.general": "일반",
  "group.intelligence": "인텔리전스",
  "group.inputCapture": "입력 및 캡처",
  "group.app": "앱",
  "group.data": "데이터",
  "nav.general": "일반",
  "general.title": "일반",
  "general.description": "언어 및 앱 기본 설정.",
  "general.autoSortConversations.label": "활성 채팅을 맨 위로 이동",
  "general.autoSortConversations.description":
    "새 메시지가 오면 채팅 순서를 변경합니다. 끄면 생성 순서를 유지하고 새 채팅이 맨 위에 표시됩니다.",
  "general.autoUpdate.label": "자동 업데이트",
  "general.autoUpdate.description":
    "백그라운드에서 업데이트를 확인하고 설치합니다. 다음에 Cetus를 열 때 적용됩니다.",
  "general.confirmQuit.label": "종료 전 확인",
  "general.confirmQuit.description":
    "Cmd+Q로 Cetus를 종료하기 전에 확인하여 실수로 실행 중인 에이전트를 중단하지 않도록 합니다.",
  "nav.api-keys": "API 키",
  "nav.memory": "메모리",
  "nav.skills": "스킬",
  "nav.slash-commands": "슬래시 명령",
  "nav.connectors": "MCP",
  "nav.launcher": "런처",
  "nav.voice": "음성",
  "nav.screen": "화면 컨텍스트",
  "notifications.event.meeting.label": "회의 기록",
  "notifications.event.meeting.description":
    "전사 시작 시와 회의록 완성 시 알립니다.",
  "nav.meetings": "회의",
  "nav.agent-control": "컴퓨터 및 브라우저",
  "nav.appearance": "모양",
  "nav.notifications": "알림",
  "nav.permissions": "권한",
  "nav.archived": "보관된 대화",

  "providers.deepseek": "DeepSeek",
  "providers.exa": "Exa(웹 검색)",
  "providers.tavily": "Tavily(웹 검색)",
  "providers.doubao": "Doubao(음성)",
  "providers.volcArk": "Volcano Ark(재작성)",
  "apiKeys.title": "API 키",
  "apiKeys.description":
    "키는 OS 키체인에 저장됩니다. 저장하면 pi 하위 프로세스가 재시작되어 새 키가 즉시 적용됩니다.",
  "apiKeys.stored": "● 저장됨",
  "apiKeys.unsaved": "● 저장 안 됨",
  "apiKeys.replace": "교체",

  "notifications.title": "알림",
  "notifications.description":
    "백그라운드 작업이 완료되거나 사용자의 입력이 필요할 때 데스크톱 알림을 받습니다. 장시간 실행되는 보드의 에이전트 작업에 유용합니다.",
  "notifications.enable.label": "알림 사용",
  "notifications.enable.description":
    "모든 데스크톱 알림의 마스터 스위치입니다.",
  "notifications.blocked":
    "시스템에서 알림이 차단되었습니다. OS 설정에서 Cetus의 알림을 허용하세요.",
  "notifications.recheck": "다시 확인",
  "notifications.notifyAbout": "알림 받을 항목",
  "notifications.behavior": "동작",
  "notifications.mute.label": "Cetus가 활성 상태일 때 음소거",
  "notifications.mute.description": "창이 백그라운드에 있을 때만 알립니다.",
  "notifications.event.task_finished.label": "작업 완료",
  "notifications.event.task_finished.description":
    "에이전트 실행이 완료되었습니다 — 대화 답변, 보드 작업 또는 예약된 자동화(성공 또는 오류 여부와 관계없이).",
  "notifications.event.awaiting_input.label": "입력이 필요함",
  "notifications.event.awaiting_input.description":
    "에이전트가 프롬프트에 대한 답변을 기다리고 있습니다.",

  "launcher.title": "빠른 런처",
  "launcher.description":
    "어디서든 플로팅 패널을 불러와 세션을 시작합니다 — 필요하면 화면 스크린샷을 컨텍스트로 첨부할 수 있습니다.",
  "launcher.needAccessibility":
    "런처가 시스템 전체에서 ⌘ 제스처를 감지하려면 손쉬운 사용 권한이 필요합니다.",
  "launcher.grantAccess": "권한 부여",
  "launcher.openSettings": "설정 열기",
  "launcher.accessibilityGranted": "● 손쉬운 사용 권한이 부여됨",
  "launcher.needScreenRecording":
    "스크린샷에는 화면 기록 권한이 필요합니다 — 권한이 없으면 Cetus는 화면의 창이 아닌 배경화면만 캡처할 수 있습니다.",
  "launcher.screenRecordingGranted": "● 화면 기록 권한이 부여됨",
  "launcher.macOnly": "전역 ⌘ 제스처는 macOS에서만 사용할 수 있습니다.",
  "launcher.enable.label": "빠른 런처 사용",
  "launcher.enable.description":
    "트리거: {gesture}. Cetus가 백그라운드에 있어도 작동합니다.",
  "launcher.startup.label": "시작 시 실행",
  "launcher.startup.description":
    "로그인할 때 Cetus를 트레이에서 자동으로 시작합니다.",
  "launcher.gesture.doubleCmd": "⌘ 두 번 누르기",
  "launcher.gesture.bothCmd": "양쪽 ⌘ 키 누르고 있기",
  "launcher.gesture.label": "트리거 제스처",
  "launcher.gesture.description": "어디서든 패널을 불러오는 방법입니다.",
  "launcher.gesture.opt.both": "양쪽 ⌘",
  "launcher.gesture.opt.bothOpt": "양쪽 ⌥",
  "launcher.gesture.opt.double": "⌘ 두 번 누르기",
  "launcher.gesture.opt.off": "끄기",
  "launcher.gesture.opt.doubleOpt": "오른쪽 ⌥ 두 번 누르기",
  "launcher.fn.plain.label": "빠른 실행",
  "launcher.fn.plain.description": "런처를 엽니다(스크린샷 없음).",
  "launcher.fn.shot.label": "빠른 실행 + 스크린샷",
  "launcher.fn.shot.description":
    "화면 영역을 선택해 첨부한 뒤(클릭 = 전체 화면) 런처를 엽니다.",
  "launcher.summon.label": "Cetus 불러오기",
  "launcher.summon.description":
    "Cetus를 앞으로 가져오는 전역 단축키입니다. 다른 데스크톱에 있으면 그쪽으로 전환합니다.",
  "launcher.summon.placeholder": "단축키 설정",
  "launcher.summon.recording": "키를 누르세요…",
  "launcher.summon.clear": "단축키 지우기",
  "launcher.session.label": "기본 세션",
  "launcher.session.description":
    "새 대화를 시작하거나 가장 최근 대화를 이어갑니다.",
  "launcher.session.opt.new": "새로 만들기",
  "launcher.session.opt.last": "최근",
  "launcher.screenshot.label": "기본적으로 스크린샷",
  "launcher.screenshot.description":
    "패널을 열 때마다 화면을 컨텍스트로 캡처합니다. 실행할 때마다 개별적으로 전환할 수도 있습니다.",

  "appearance.title": "모양",
  "appearance.description":
    "Cetus 전체에서 사용하는 테마와 글꼴을 설정합니다. 변경 사항은 즉시 적용됩니다.",
  "appearance.theme.label": "테마",
  "appearance.theme.description":
    "시스템 모양을 따르거나 라이트 또는 다크로 고정합니다.",
  "appearance.permaLayers.label": "부드러운 호버 렌더링",
  "appearance.permaLayers.description":
    "호버 페이드를 전용 합성 레이어에 유지하여 소수 배율에서 행이 흔들리지 않게 합니다. 그래픽 메모리를 추가로 사용하며, 비교를 위해 끌 수 있습니다.",

  "voice.title": "음성 받아쓰기",
  "voice.description":
    "입력 대신 말하세요. 아래에서 인식 엔진을 선택한 다음 푸시 투 토크 키를 누른 채로 포커스된 앱에 받아쓰기하세요.",
  "voice.macOnly": "음성 받아쓰기는 macOS에서만 사용할 수 있습니다.",
  "voice.needPerms": "받아쓰기에는 마이크와 음성 인식 권한이 필요합니다.",
  "voice.grantAccess": "권한 부여",
  "voice.openSettings": "설정 열기",
  "voice.permsGranted": "● 마이크 및 음성 인식 권한이 부여됨",
  "voice.engine.label": "인식 엔진",
  "voice.engine.doubaoDesc":
    "Doubao(Volcano Engine) 실시간 스트리밍 — 가장 빠르고(약 90ms), 말하는 즉시 텍스트로 변환되며, 중영 혼용에 강하고 중국 본토에서도 작동합니다. Doubao API 키(X-Api-Key)가 필요합니다.",
  "voice.engine.appleDesc":
    "Apple 온디바이스 — 즉각적이고 오디오가 Mac을 떠나지 않지만, 중영 코드 전환에는 다소 약합니다.",
  "voice.engine.opt.doubao": "Doubao(클라우드)",
  "voice.engine.opt.apple": "Apple(온디바이스)",
  "voice.gesture.rightOption": "오른쪽 ⌥",
  "voice.gesture.fn": "fn(지구본)",
  "voice.gesture.rightCmd": "오른쪽 ⌘",
  "voice.enable.label": "시스템 전체 받아쓰기",
  "voice.enable.description":
    "어디서든 {gesture}를 누르고 있으면 받아쓰기되고, 놓으면 포커스된 앱에 텍스트가 삽입됩니다.",
  "voice.needAccessibility":
    "다른 앱에 입력하려면 손쉬운 사용 권한이 필요합니다(런처가 사용하는 것과 동일한 권한).",
  "voice.triggerKey.label": "트리거 키",
  "voice.triggerKey.holdDesc":
    "이 보조키를 누르고 있는 동안 말합니다(놓으면 삽입). 두 번 누르면 핸즈프리로 전환되어 한 문장을 마칠 때마다 삽입됩니다 — 다시 두 번 누르면 중지됩니다. 오른쪽 키는 일반 단축키와 충돌하지 않습니다. 핸즈프리에는 Doubao 엔진이 필요합니다.",
  "voice.triggerKey.opt.rightCmd": "오른쪽 ⌘",
  "voice.triggerKey.opt.rightOption": "오른쪽 ⌥",
  "voice.triggerKey.opt.fn": "fn",
  "voice.triggerKey.opt.capsLock": "Caps Lock",
  "voice.triggerKey.capsNote":
    "선택하면 Cetus가 실행되는 동안 Caps Lock을 받아쓰기 전용으로 바꾸고, 종료 시 복원합니다.",
  "voice.insert.label": "삽입 방식",
  "voice.insert.description":
    "‘입력’은 가상 키 입력을 보내고, ‘붙여넣기’는 클립보드 + ⌘V를 사용합니다(일부 앱에서 더 안정적이지만 클립보드를 잠시 대체합니다).",
  "voice.insert.opt.type": "입력",
  "voice.insert.opt.paste": "붙여넣기",
  "voice.cleanup.label": "AI로 정리",
  "voice.cleanup.description":
    "삽입하기 전에 DeepSeek으로 군더더기 표현을 제거하고 문장 부호를 다듬습니다. DeepSeek API 키가 필요합니다. 푸시 투 토크에서만 사용 가능 — 핸즈프리는 각 문장을 실시간으로 삽입합니다.",
  "voice.cleanup.modelLabel": "정리 모델",
  "voice.cleanup.modelHint":
    "리라이트에 사용할 Ark 모델 ID입니다. 비워 두면 기본 모델을 사용하며, 스냅숏이 중단되면 자동으로 이전 모델로 대체됩니다.",
  "voice.history.label": "받아쓰기 기록 저장",
  "voice.history.description":
    "받아쓴 내용을 기록으로 남겨 사용자와 에이전트(recall_dictation 도구를 통해)가 나중에 참고할 수 있게 합니다. 기본값은 꺼짐입니다.",
  "voice.history.empty":
    "아직 받아쓴 내용이 없습니다 — 전사된 내용이 여기에 표시됩니다.",
  "voice.history.clear": "기록 지우기({n})",

  "screen.title": "화면 컨텍스트",
  "screen.description":
    "화면을 주기적으로 캡처하고 온디바이스(Apple Vision OCR)로 읽어, 에이전트가 사용자가 무엇을 작업했는지 떠올릴 수 있게 합니다. 이미지와 텍스트는 Mac에 머물며 업로드되지 않습니다.",
  "screen.macOnly":
    "화면 캡처는 macOS에 맞춰 조정되었습니다. 온디바이스 OCR은 Apple Vision을 사용합니다.",
  "screen.browse": "캡처된 프레임 보기",
  "screen.enable.label": "화면 캡처 사용",
  "screen.enable.description":
    "기본값은 꺼짐입니다. 켜면 Cetus가 백그라운드에서 타이머에 따라 화면을 캡처합니다.",
  "screen.interval.label": "캡처 간격",
  "screen.interval.description":
    "캡처 사이의 초입니다. 거의 동일한 프레임은 자동으로 건너뜁니다.",
  "screen.interval.unit": "초",
  "screen.retention.label": "기록 보관 기간",
  "screen.retention.description":
    "오래된 프레임은 디스크에서 삭제됩니다. 0으로 설정하면 영구 보관됩니다.",
  "screen.retention.unit": "일",
  "screen.ocr.label": "온디바이스로 텍스트 읽기(OCR)",
  "screen.ocr.description":
    "Apple Vision으로 화면의 텍스트를 추출해 에이전트가 검색할 수 있게 합니다. 로컬에서 실행됩니다.",
  "screen.excluded.label": "제외할 앱",
  "screen.excluded.description":
    "쉼표로 구분된 앱 이름 또는 번들 ID입니다. 이 앱들이 맨 앞에 있는 동안에는 캡처를 건너뜁니다(예: 1Password, 메시지).",
  "screen.frames.one":
    "{count}개 프레임 캡처됨 · 캡처가 처음 실행될 때 macOS가 화면 기록 권한을 요청합니다.",
  "screen.frames.other":
    "{count}개 프레임 캡처됨 · 캡처가 처음 실행될 때 macOS가 화면 기록 권한을 요청합니다.",

  "agentControl.title": "컴퓨터 및 브라우저 제어",
  "agentControl.description":
    "에이전트가 브라우저와 Mac 앱을 조작할 수 있게 합니다. 손쉬운 사용 권한(실시간 보기에는 화면 기록 권한)이 필요합니다.",
  "agentControl.browser.label": "브라우저 제어 사용",
  "agentControl.browser.description":
    "웹 브라우저를 조작하기 위한 browser_* 도구와 인덱스 기반 제어 프롬프트를 추가합니다. 에이전트는 중요한 작업을 확인하며 언제든지 중지할 수 있습니다.",
  "agentControl.computer.label": "컴퓨터 제어 사용",
  "agentControl.computer.description":
    "접근성을 통해 이 Mac의 앱을 제어하는 computer_* 도구를 추가합니다. 에이전트는 중요한 작업을 확인하며 언제든지 중지할 수 있습니다.",
  "agentControl.ax.label": "손쉬운 사용 권한",
  "agentControl.ax.notGranted":
    "부여되지 않음 — 에이전트가 앱 UI를 읽거나 인덱스로 클릭/입력할 수 없습니다.",
  "agentControl.ax.granted": "부여됨.",
  "agentControl.checking": "확인 중…",
  "agentControl.enabled": "사용 중",
  "agentControl.grant": "부여",
  "agentControl.openSettings": "설정 열기",
  "agentControl.screen.label": "화면 기록 권한",
  "agentControl.screen.notGranted":
    "부여되지 않음 — 실시간 스크린샷 미리보기가 표시되지 않습니다.",
  "agentControl.screen.granted": "부여됨.",
  "agentControl.footnote":
    "에이전트는 원시 픽셀이 아니라 번호가 매겨진 요소 목록을 통해 작동하며, 중요한 작업(전송, 삭제, 구매, 제출, 인증) 전에 항상 확인합니다. 작동 중에는 대화에 중지 버튼이 표시됩니다.",

  "archived.title": "보관된 대화",
  "archived.description":
    "사이드바에서 보관한 대화입니다. 하나를 복원해 되돌리거나 모두 지워 공간을 확보할 수 있습니다 — 삭제는 영구적입니다.",
  "archived.loading": "불러오는 중…",
  "archived.empty": "보관된 대화가 없습니다.",
  "archived.count.one": "보관된 대화 {count}개",
  "archived.count.other": "보관된 대화 {count}개",
  "archived.deleteAllPrompt": "{count}개를 모두 삭제할까요?",
  "archived.deleting": "삭제 중…",
  "archived.deleteAll": "모두 삭제",
  "archived.untitled": "제목 없음",
  "archived.archivedOn": "{date}에 보관됨",
  "archived.restore": "복원",
  "archived.deleteAria": "대화 삭제",

  "memory.title": "메모리",
  "memory.description":
    "사용자에 관한 지속적인 노트 — 선호, 진행 중인 프로젝트, 결정 — 로, 에이전트가 대화를 넘나들며 가져갑니다. 에이전트는 배우면서 여기에 추가하며, 사용자도 여기서 추가, 편집, 음소거 또는 삭제할 수 있습니다.",
  "memory.enable.label": "메모리 사용",
  "memory.enable.description":
    "켜면 아래의 활성화된 노트가 매 턴마다 에이전트의 컨텍스트에 주입됩니다. 끄면 노트를 잃지 않고 메모리를 일시 중지할 수 있습니다.",
  "memory.add.label": "메모리 추가",
  "memory.add.placeholder":
    "예: npm보다 pnpm을 선호하고, 커밋 메시지는 간결하게.",
  "memory.category.placeholder": "분류(선택)",
  "memory.adding": "추가 중…",
  "memory.add.button": "추가",
  "memory.loading": "불러오는 중…",
  "memory.empty": "아직 메모리가 없습니다",
  "memory.count.one": "메모리 {count}개",
  "memory.count.other": "메모리 {count}개",
  "memory.deleteAllPrompt": "모두 삭제할까요?",
  "memory.clearAll": "모두 지우기",
  "memory.saving": "저장 중…",
  "memory.save": "저장",
  "memory.tag.agent": "에이전트",
  "memory.tag.you": "사용자",
  "memory.editedOn": "{date}에 편집됨",
  "memory.muteAria": "메모리 음소거",
  "memory.enableAria": "메모리 사용",
  "memory.editAria": "메모리 편집",
  "memory.deleteAria": "메모리 삭제",

  "skills.title": "스킬",
  "skills.description":
    "에이전트가 필요할 때 가져올 수 있는 재사용 가능한 지침입니다 — SKILL.md(이름 + 설명 + 단계)를 담은 폴더로, 개방형 Agent Skills 표준을 따릅니다. 폴더에서 설치하거나 직접 작성하세요. 활성화된 스킬은 매 턴마다 에이전트에 제공됩니다.",
  "skills.enable.label": "스킬 사용",
  "skills.enable.description":
    "켜면 아래의 활성화된 스킬이 에이전트에 제공됩니다. 끄면 제거하지 않고 모든 스킬을 일시 중지할 수 있습니다.",
  "skills.importing": "가져오는 중…",
  "skills.import": "폴더 가져오기",
  "skills.write": "직접 작성",
  "skills.learn": "스킬에 대해 알아보기",
  "skills.loading": "불러오는 중…",
  "skills.empty": "설치된 스킬이 없습니다",
  "skills.count.one": "스킬 {count}개",
  "skills.count.other": "스킬 {count}개",
  "skills.source.written": "작성됨",
  "skills.source.imported": "가져옴",
  "skills.source.proposed": "제안됨",
  "skills.source.byAgent": "에이전트 생성",
  "skills.updatedOn": "{date}에 업데이트됨",
  "skills.disableAria": "스킬 비활성화",
  "skills.enableAria": "스킬 활성화",
  "skills.openFolderAria": "스킬 폴더 열기",
  "skills.delete": "삭제",
  "skills.uninstallAria": "스킬 제거",
  "skills.editor.title": "스킬 작성",
  "skills.editor.namePlaceholder": "이름, 예: 커밋 메시지 스타일",
  "skills.editor.descPlaceholder":
    "에이전트가 언제 이것을 사용해야 하나요?(한 줄)",
  "skills.editor.bodyPlaceholder":
    "스킬 본문을 마크다운으로. 단계, 예시, 규칙…",
  "skills.editor.saving": "저장 중…",
  "skills.editor.create": "스킬 만들기",

  "connectors.title": "MCP",
  "connectors.description":
    "MCP(Model Context Protocol) 서버 — 로컬 명령 또는 원격 URL — 를 통해 에이전트를 외부 도구에 연결합니다. 서버를 추가하고 ‘테스트’하면 실제 핸드셰이크를 실행해 제공하는 도구를 확인할 수 있습니다. 활성화된 각 MCP 서버의 도구는 에이전트에 로드되어 내장 도구처럼 호출할 수 있습니다. 변경 사항은 새 대화에서 적용됩니다.",
  "connectors.loading": "불러오는 중…",
  "connectors.empty": "아직 MCP 서버가 없습니다",
  "connectors.count.one": "MCP 서버 {count}개",
  "connectors.count.other": "MCP 서버 {count}개",
  "connectors.add": "MCP 서버 추가",
  "connectors.disableAria": "MCP 서버 비활성화",
  "connectors.enableAria": "MCP 서버 활성화",
  "connectors.editAria": "MCP 서버 편집",
  "connectors.removeAria": "MCP 서버 제거",
  "connectors.editor.name": "이름",
  "connectors.editor.namePlaceholder": "예: GitHub, Filesystem, Linear…",
  "connectors.editor.transport": "전송 방식",
  "connectors.editor.transportDesc":
    "로컬 프로세스(stdio) 또는 원격 MCP 엔드포인트(HTTP/SSE).",
  "connectors.editor.command": "명령",
  "connectors.editor.commandPlaceholder": "예: npx",
  "connectors.editor.args": "인수",
  "connectors.editor.argsHint": "한 줄에 하나",
  "connectors.editor.env": "환경 변수",
  "connectors.editor.envHint": "프로세스에 전달됨",
  "connectors.editor.url": "URL",
  "connectors.editor.headers": "헤더",
  "connectors.editor.headersHint": "요청마다 전송됨",
  "connectors.test.connected": "연결됨",
  "connectors.test.tools.one": "도구 {count}개: {names}",
  "connectors.test.tools.other": "도구 {count}개: {names}",
  "connectors.test.noTools":
    "핸드셰이크 성공 — 서버가 노출하는 도구가 없습니다.",
  "connectors.test.failed": "연결에 실패했습니다.",
  "connectors.editor.saving": "저장 중…",
  "connectors.testing": "테스트 중…",
  "connectors.test.button": "테스트",
  "connectors.editor.envName": "KEY",
  "connectors.editor.envValue": "값",
  "connectors.editor.addEnv": "변수 추가",
  "connectors.editor.headerName": "이름",
  "connectors.editor.headerValue": "값",
  "connectors.editor.addHeader": "헤더 추가",
  "connectors.editor.removeRow": "제거",
  "connectors.details.toggleAria": "도구 정보 토글",
  "connectors.details.loading": "도구 불러오는 중…",
  "connectors.details.connected": "연결됨",
  "connectors.details.toolCount.one": "도구 {count}개",
  "connectors.details.toolCount.other": "도구 {count}개",
  "connectors.oauth.auth": "인증",
  "connectors.oauth.authDesc":
    "정적 헤더 또는 OAuth(Cetus가 로그인 플로우 실행).",
  "connectors.oauth.none": "없음",
  "connectors.oauth.clientId": "클라이언트 ID",
  "connectors.oauth.clientIdPlaceholder": "자동(동적 등록)",
  "connectors.oauth.scope": "범위",
  "connectors.oauth.optional": "선택",
  "connectors.oauth.authorize": "인증",
  "connectors.oauth.authorizing": "인증 중…",
  "connectors.oauth.authorized": "인증됨 — 토큰이 캐시되었습니다.",
  "connectors.oauth.hint": "브라우저를 열어 로그인합니다.",
  "connectors.oauth.saveHint":
    "MCP 서버를 저장한 뒤 아래에서 펼쳐 Authorize를 클릭하세요.",
  "discovery.mcp.none": "서버를 찾을 수 없습니다(설정 파일 없음).",
  "discovery.mcp.title": "다른 앱에서 가져오기",
  "discovery.mcp.description":
    "이 앱들에 설정된 MCP 서버도 불러옵니다. 새 채팅에만 적용됩니다.",
  "skills.discovered.loadLabel": "발견된 스킬 불러오기",
  "skills.discovered.loadDesc": "아래 폴더의 스킬을 새 채팅에 포함합니다.",
  "skills.discovered.chooseFolder": "폴더 선택",
};
