export const pt = {
  "models.model.reasoningHint":
    "Ative Raciocínio nos modelos com parâmetro de esforço e habilite os níveis que seu endpoint aceita. Cada nível envia o próprio nome por padrão; digite um token para sobrescrever. Em “Formato”, escolha a forma do campo de esforço que seu fornecedor espera; níveis desabilitados são ajustados ao habilitado mais próximo.",
  "models.model.format": "Formato",
  "models.model.reasoning": "Raciocínio",
  "nav.models": "Modelos",
  "models.title": "Modelos",
  "models.description":
    "Adicione seus próprios provedores de modelos compatíveis com OpenAI — uma URL base, uma chave de API e ids de modelo. Os modelos aparecem no seletor do chat junto com os integrados.",
  "models.empty": "Ainda não há provedores personalizados.",
  "models.add": "Adicionar provedor",
  "models.noKey": "Sem chave",
  "models.footnote":
    "Tarefas em segundo plano (títulos automáticos, notas de reunião) usam o DeepSeek quando sua chave está configurada; caso contrário, o primeiro provedor personalizado.",
  "models.name.label": "Nome",
  "models.name.placeholder": "OpenRouter, meu servidor vLLM…",
  "models.baseUrl.label": "URL base",
  "models.baseUrl.hint":
    "Endpoint compatível com OpenAI, sem /chat/completions.",
  "models.key.label": "Chave de API",
  "models.key.placeholder": "sk-… (vazio para endpoints locais)",
  "models.key.keepStored": "•••••••• (salva — digite para substituir)",
  "models.models.label": "Modelos",
  "models.model.idPlaceholder": "id do modelo",
  "models.model.namePlaceholder": "nome de exibição (opcional)",
  "models.model.vision": "Visão",
  "models.model.visionHint":
    "Ative Visão nos modelos que aceitam imagens — os anexos são enviados diretamente ao modelo em vez de transcritos antes.",
  "models.model.add": "Adicionar modelo",
  "page.title": "Configurações",

  "group.general": "Geral",
  "group.intelligence": "Inteligência",
  "group.inputCapture": "Entrada e captura",
  "group.app": "Aplicativo",
  "group.data": "Dados",
  "nav.general": "Geral",
  "general.title": "Geral",
  "general.description": "Idioma e configurações básicas do aplicativo.",
  "general.autoSortConversations.label": "Mover chats ativos para o topo",
  "general.autoSortConversations.description":
    "Reordena os chats ao receber novas mensagens. Desative para manter a ordem de criação, com os novos chats no topo.",
  "general.autoUpdate.label": "Atualizações automáticas",
  "general.autoUpdate.description":
    "Verifica e instala atualizações em segundo plano. Aplicadas na próxima vez que você abrir o Cetus.",
  "general.confirmQuit.label": "Confirmar antes de sair",
  "general.confirmQuit.description":
    "Pergunta antes de o Cmd+Q fechar o Cetus, para que um deslize não interrompa agentes em execução.",
  "general.keepAwake.label": "Manter o Mac acordado enquanto trabalha",
  "general.keepAwake.description":
    "Impede a suspensão do sistema enquanto um turno do agente ou uma gravação de reunião estiver em andamento. A tela continua desligando e bloqueando; fechar a tampa continua suspendendo.",
  "nav.api-keys": "Chaves de API",
  "nav.memory": "Memória",
  "nav.skills": "Habilidades",
  "nav.slash-commands": "Comandos de barra",
  "nav.connectors": "MCP",
  "nav.launcher": "Inicializador",
  "nav.voice": "Voz",
  "nav.screen": "Contexto de tela",
  "notifications.event.meeting.label": "Captura de reunião",
  "notifications.event.meeting.description":
    "A transcrição começou, e a ata fica pronta depois.",
  "nav.meetings": "Reuniões",
  "nav.agent-control": "Computador e navegador",
  "nav.appearance": "Aparência",
  "nav.notifications": "Notificações",
  "nav.permissions": "Permissões",
  "nav.archived": "Conversas arquivadas",

  "providers.deepseek": "DeepSeek",
  "providers.exa": "Exa (busca na web)",
  "providers.tavily": "Tavily (busca na web)",
  "providers.doubao": "Doubao (voz)",
  "providers.volcArk": "Volcano Ark (reescrita)",
  "apiKeys.title": "Chaves de API",
  "apiKeys.description":
    "As chaves ficam armazenadas no chaveiro do seu sistema operacional. Salvar reinicia o subprocesso do pi para que as novas chaves entrem em vigor imediatamente.",
  "apiKeys.stored": "● armazenada",
  "apiKeys.unsaved": "● não salva",
  "apiKeys.replace": "Substituir",

  "notifications.title": "Notificações",
  "notifications.description":
    "Receba uma notificação na área de trabalho quando uma tarefa em segundo plano terminar ou precisar de você — útil para execuções longas de agentes no quadro.",
  "notifications.enable.label": "Ativar notificações",
  "notifications.enable.description":
    "Interruptor principal de todas as notificações da área de trabalho.",
  "notifications.blocked":
    "Seu sistema bloqueia as notificações. Permita-as para o Cetus nas configurações do sistema operacional.",
  "notifications.recheck": "Verificar novamente",
  "notifications.notifyAbout": "Notificar-me sobre",
  "notifications.behavior": "Comportamento",
  "notifications.mute.label": "Silenciar enquanto o Cetus estiver em foco",
  "notifications.mute.description":
    "Notificar somente quando a janela estiver em segundo plano.",
  "notifications.event.task_finished.label": "Tarefa concluída",
  "notifications.event.task_finished.description":
    "Uma execução de agente terminou — uma resposta de conversa, uma tarefa do quadro ou uma automação agendada (tenha tido sucesso ou erro).",
  "notifications.event.awaiting_input.label": "Precisa da sua intervenção",
  "notifications.event.awaiting_input.description":
    "O agente está aguardando que você responda a uma solicitação.",

  "launcher.title": "Inicializador rápido",
  "launcher.description":
    "Invoque um painel flutuante de qualquer lugar para iniciar uma sessão — opcionalmente com uma captura da sua tela como contexto.",
  "launcher.needAccessibility":
    "O inicializador precisa de acesso de Acessibilidade para detectar o gesto ⌘ em todo o sistema.",
  "launcher.grantAccess": "Conceder acesso",
  "launcher.openSettings": "Abrir Configurações",
  "launcher.accessibilityGranted": "● Acesso de Acessibilidade concedido",
  "launcher.needScreenRecording":
    "As capturas precisam de acesso de Gravação de tela — sem ele, o Cetus só consegue capturar seu papel de parede, não as janelas na tela.",
  "launcher.screenRecordingGranted": "● Acesso de Gravação de tela concedido",
  "launcher.macOnly": "O gesto global ⌘ está disponível apenas no macOS.",
  "launcher.enable.label": "Ativar inicializador rápido",
  "launcher.enable.description":
    "Acionador: {gesture}. Funciona mesmo quando o Cetus está em segundo plano.",
  "launcher.startup.label": "Iniciar ao ligar",
  "launcher.startup.description":
    "Inicia o Cetus na bandeja automaticamente ao fazer login.",
  "launcher.gesture.doubleCmd": "Tocar ⌘ duas vezes",
  "launcher.gesture.bothCmd": "Manter ambas as teclas ⌘",
  "launcher.gesture.label": "Gesto de acionamento",
  "launcher.gesture.description":
    "Como você invoca o painel de qualquer lugar.",
  "launcher.gesture.opt.both": "Ambos ⌘",
  "launcher.gesture.opt.bothOpt": "Ambos ⌥",
  "launcher.gesture.opt.double": "Tocar ⌘ duas vezes",
  "launcher.gesture.opt.off": "Desativado",
  "launcher.gesture.opt.doubleOpt": "Tocar ⌥ direito duas vezes",
  "launcher.fn.plain.label": "Início rápido",
  "launcher.fn.plain.description": "Abre o lançador (sem captura).",
  "launcher.fn.shot.label": "Início rápido + captura",
  "launcher.fn.shot.description":
    "Abre o lançador com uma captura da sua tela anexada.",
  "launcher.summon.label": "Invocar o Cetus",
  "launcher.summon.description":
    "Atalho global para trazer o Cetus para a frente, mudando de área de trabalho se estiver em outra.",
  "launcher.summon.placeholder": "Definir atalho",
  "launcher.summon.recording": "Pressione as teclas…",
  "launcher.summon.clear": "Limpar atalho",
  "launcher.session.label": "Sessão padrão",
  "launcher.session.description":
    "Inicie uma conversa nova ou continue a mais recente.",
  "launcher.session.opt.new": "Nova",
  "launcher.session.opt.last": "Última",
  "launcher.screenshot.label": "Captura por padrão",
  "launcher.screenshot.description":
    "Captura a tela como contexto sempre que o painel é aberto. Você ainda pode alternar isso a cada inicialização.",

  "appearance.title": "Aparência",
  "appearance.description":
    "Define o tema e as fontes usadas em todo o cetus. As alterações se aplicam instantaneamente.",
  "appearance.theme.label": "Tema",
  "appearance.theme.description":
    "Acompanhe a aparência do sistema ou fixe em claro ou escuro.",
  "appearance.permaLayers.label": "Renderização suave ao passar o mouse",
  "appearance.permaLayers.description":
    "Mantém os fades de hover em camadas de composição dedicadas para que as linhas não tremam em zoom fracionário. Usa mais memória gráfica; desative para comparar.",

  "voice.title": "Ditado por voz",
  "voice.description":
    "Fale em vez de digitar. Escolha o mecanismo de reconhecimento abaixo e mantenha pressionada a tecla de pressionar para falar para ditar no app em foco.",
  "voice.macOnly": "O ditado por voz está disponível apenas no macOS.",
  "voice.needPerms":
    "O ditado precisa de acesso ao Microfone e ao Reconhecimento de fala.",
  "voice.grantAccess": "Conceder acesso",
  "voice.openSettings": "Abrir Configurações",
  "voice.permsGranted":
    "● Acesso ao Microfone e ao Reconhecimento de fala concedido",
  "voice.engine.label": "Mecanismo de reconhecimento",
  "voice.engine.doubaoDesc":
    "Doubao (Volcano Engine) em streaming em tempo real — o mais rápido (~90 ms), texto ao vivo enquanto você fala, ótimo com mistura de chinês/inglês, funciona na China continental. Precisa de uma chave de API do Doubao (X-Api-Key).",
  "voice.engine.appleDesc":
    "Apple no dispositivo — instantâneo, o áudio nunca sai do seu Mac, mas mais fraco na alternância entre chinês/inglês.",
  "voice.engine.opt.doubao": "Doubao (nuvem)",
  "voice.engine.opt.apple": "Apple (no dispositivo)",
  "voice.gesture.rightOption": "⌥ direita",
  "voice.gesture.fn": "fn (Globo)",
  "voice.gesture.rightCmd": "⌘ direita",
  "voice.enable.label": "Ditado em todo o sistema",
  "voice.enable.description":
    "Mantenha {gesture} pressionada em qualquer lugar para ditar; solte para inserir o texto no app em foco.",
  "voice.needAccessibility":
    "Digitar em outros apps precisa de acesso de Acessibilidade (a mesma permissão que o inicializador usa).",
  "voice.triggerKey.label": "Tecla de acionamento",
  "voice.triggerKey.holdDesc":
    "Mantenha este modificador pressionado para falar (solte para inserir); toque-o duas vezes para o modo mãos livres, em que cada frase é inserida assim que você a termina — toque duas vezes novamente para parar. As teclas da mão direita evitam conflitos com os atalhos comuns. O modo mãos livres precisa do mecanismo Doubao.",
  "voice.triggerKey.opt.rightCmd": "⌘ direita",
  "voice.triggerKey.opt.rightOption": "⌥ direita",
  "voice.triggerKey.opt.fn": "fn",
  "voice.triggerKey.opt.capsLock": "Caps Lock",
  "voice.triggerKey.capsNote":
    "O Cetus reatribui o Caps Lock ao ditado enquanto está em execução e o restaura ao sair.",
  "voice.insert.label": "Inserir com",
  "voice.insert.description":
    "«Digitar» envia pressionamentos de tecla sintéticos; «Colar» usa a área de transferência + ⌘V (mais robusto em alguns apps, substitui brevemente sua área de transferência).",
  "voice.insert.opt.type": "Digitar",
  "voice.insert.opt.paste": "Colar",
  "voice.cleanup.label": "Limpar com IA",
  "voice.cleanup.description":
    "Use o DeepSeek para remover palavras de preenchimento e corrigir a pontuação antes de inserir. Requer uma chave de API do DeepSeek. Apenas no pressionar para falar — o modo mãos livres insere cada frase ao vivo.",
  "voice.history.label": "Salvar histórico de ditado",
  "voice.history.description":
    "Mantenha um registro do que você dita para que você — e o agente (pela ferramenta recall_dictation) — possam consultá-lo depois. Desativado por padrão.",
  "voice.history.empty":
    "Nada ditado ainda — suas transcrições aparecerão aqui.",
  "voice.history.clear": "Limpar histórico ({n})",

  "screen.title": "Contexto de tela",
  "screen.description":
    "Captura sua tela periodicamente e a lê no dispositivo (OCR do Apple Vision) para que o agente possa lembrar no que você estava trabalhando. As imagens e o texto permanecem no seu Mac — nada é enviado.",
  "screen.macOnly":
    "A captura de tela é ajustada para o macOS; o OCR no dispositivo usa o Apple Vision.",
  "screen.browse": "Navegar pelos quadros capturados",
  "screen.enable.label": "Ativar captura de tela",
  "screen.enable.description":
    "Desativado por padrão. Quando ativo, o Cetus captura a tela com um temporizador em segundo plano.",
  "screen.interval.label": "Intervalo de captura",
  "screen.interval.description":
    "Segundos entre capturas. Quadros quase idênticos são ignorados automaticamente.",
  "screen.interval.unit": "s",
  "screen.retention.label": "Manter o histórico por",
  "screen.retention.description":
    "Quadros mais antigos são excluídos do disco. Defina 0 para manter para sempre.",
  "screen.retention.unit": "dias",
  "screen.ocr.label": "Ler texto no dispositivo (OCR)",
  "screen.ocr.description":
    "Use o Apple Vision para extrair o texto na tela para que o agente possa pesquisá-lo. É executado localmente.",
  "screen.excluded.label": "Apps excluídos",
  "screen.excluded.description":
    "Nomes de apps ou bundle ids separados por vírgulas. A captura é ignorada enquanto um destes estiver em primeiro plano (p. ex. 1Password, Mensagens).",
  "screen.frames.one":
    "{count} quadro capturado · o macOS pede permissão de Gravação de tela na primeira vez que a captura é executada.",
  "screen.frames.other":
    "{count} quadros capturados · o macOS pede permissão de Gravação de tela na primeira vez que a captura é executada.",

  "agentControl.title": "Controle de computador e navegador",
  "agentControl.description":
    "Permite que o agente conduza seu navegador e seus apps do Mac. Requer Acessibilidade (e Gravação de tela para a visualização ao vivo).",
  "agentControl.browser.label": "Ativar controle do navegador",
  "agentControl.browser.description":
    "Adiciona as ferramentas browser_* e o prompt de controle baseado em índices para operar um navegador web. O agente confirma ações importantes e você pode interrompê-lo a qualquer momento.",
  "agentControl.computer.label": "Ativar controle do computador",
  "agentControl.computer.description":
    "Adiciona as ferramentas computer_* para controlar os apps deste Mac via acessibilidade. O agente confirma ações importantes e você pode interrompê-lo a qualquer momento.",
  "agentControl.ax.label": "Acesso de Acessibilidade",
  "agentControl.ax.notGranted":
    "Não concedido — o agente não consegue ler as interfaces dos apps nem clicar/digitar por índice.",
  "agentControl.ax.granted": "Concedido.",
  "agentControl.checking": "Verificando…",
  "agentControl.enabled": "Ativado",
  "agentControl.grant": "Conceder",
  "agentControl.openSettings": "Abrir Configurações",
  "agentControl.screen.label": "Acesso de Gravação de tela",
  "agentControl.screen.notGranted":
    "Não concedido — a pré-visualização da captura ao vivo não será exibida.",
  "agentControl.screen.granted": "Concedido.",
  "agentControl.footnote":
    "O agente atua por meio de listas de elementos numerados, nunca pixels brutos, e pergunta antes de qualquer ação importante (enviar, excluir, comprar, submeter, autenticar). Um botão Parar aparece na conversa enquanto ele está ativo.",

  "archived.title": "Conversas arquivadas",
  "archived.description":
    "Conversas que você arquivou da barra lateral. Restaure uma para trazê-la de volta, ou apague todas para liberar espaço — a exclusão é permanente.",
  "archived.loading": "Carregando…",
  "archived.empty": "Nenhuma conversa arquivada.",
  "archived.count.one": "{count} conversa arquivada",
  "archived.count.other": "{count} conversas arquivadas",
  "archived.deleteAllPrompt": "Excluir todas as {count}?",
  "archived.deleting": "Excluindo…",
  "archived.deleteAll": "Excluir todas",
  "archived.untitled": "Sem título",
  "archived.archivedOn": "Arquivada em {date}",
  "archived.restore": "Restaurar",
  "archived.deleteAria": "Excluir conversa",

  "memory.title": "Memória",
  "memory.description":
    "Notas duradouras sobre você — suas preferências, projetos em andamento e decisões — que o agente leva consigo de uma conversa a outra. O agente as amplia à medida que aprende; aqui você pode adicionar, editar, silenciar ou excluir qualquer uma delas.",
  "memory.enable.label": "Ativar memória",
  "memory.enable.description":
    "Quando ativa, as notas habilitadas abaixo são injetadas no contexto do agente a cada turno. Desative para pausar a memória sem perder suas notas.",
  "memory.add.label": "Adicionar uma memória",
  "memory.add.placeholder":
    "p. ex. Prefere pnpm a npm, e mensagens de commit concisas.",
  "memory.category.placeholder": "Categoria (opcional)",
  "memory.adding": "Adicionando…",
  "memory.add.button": "Adicionar",
  "memory.loading": "Carregando…",
  "memory.empty": "Ainda não há memórias",
  "memory.count.one": "{count} memória",
  "memory.count.other": "{count} memórias",
  "memory.deleteAllPrompt": "Excluir todas?",
  "memory.clearAll": "Limpar todas",
  "memory.saving": "Salvando…",
  "memory.save": "Salvar",
  "memory.tag.agent": "Agente",
  "memory.tag.you": "Você",
  "memory.editedOn": "Editada em {date}",
  "memory.muteAria": "Silenciar memória",
  "memory.enableAria": "Ativar memória",
  "memory.editAria": "Editar memória",
  "memory.deleteAria": "Excluir memória",

  "skills.title": "Habilidades",
  "skills.description":
    "Instruções reutilizáveis que o agente pode incorporar sob demanda — uma pasta com um SKILL.md (nome + descrição + passos), seguindo o padrão aberto Agent Skills. Instale uma a partir de uma pasta ou escreva a sua; as habilidades ativadas são oferecidas ao agente a cada turno.",
  "skills.enable.label": "Ativar habilidades",
  "skills.enable.description":
    "Quando ativo, as habilidades habilitadas abaixo são disponibilizadas ao agente. Desative para pausar todas as habilidades sem desinstalá-las.",
  "skills.importing": "Importando…",
  "skills.import": "Importar pasta",
  "skills.write": "Escrever uma",
  "skills.learn": "Saiba mais sobre habilidades",
  "skills.loading": "Carregando…",
  "skills.empty": "Nenhuma habilidade instalada",
  "skills.count.one": "{count} habilidade",
  "skills.count.other": "{count} habilidades",
  "skills.source.written": "Escrita",
  "skills.source.imported": "Importada",
  "skills.source.proposed": "Proposta",
  "skills.source.byAgent": "Pelo agente",
  "skills.updatedOn": "Atualizada em {date}",
  "skills.disableAria": "Desativar habilidade",
  "skills.enableAria": "Ativar habilidade",
  "skills.openFolderAria": "Abrir pasta da habilidade",
  "skills.delete": "Excluir",
  "skills.uninstallAria": "Desinstalar habilidade",
  "skills.editor.title": "Escrever uma habilidade",
  "skills.editor.namePlaceholder": "Nome, p. ex. Estilo de mensagens de commit",
  "skills.editor.descPlaceholder": "Quando o agente deve usá-la? (uma linha)",
  "skills.editor.bodyPlaceholder":
    "A habilidade em si, em markdown. Passos, exemplos, regras…",
  "skills.editor.saving": "Salvando…",
  "skills.editor.create": "Criar habilidade",

  "connectors.title": "MCP",
  "connectors.description":
    "Conecte o agente a ferramentas externas por meio de servidores MCP (Model Context Protocol) — um comando local ou uma URL remota. Adicione um servidor e use Testar para executar um handshake real e ver as ferramentas que ele oferece. As ferramentas de cada servidor MCP ativado são carregadas no agente para que ele possa invocá-las como as integradas; as alterações entram em vigor em conversas novas.",
  "connectors.loading": "Carregando…",
  "connectors.empty": "Ainda não há servidores MCP",
  "connectors.count.one": "{count} servidor MCP",
  "connectors.count.other": "{count} servidores MCP",
  "connectors.add": "Adicionar servidor MCP",
  "connectors.disableAria": "Desativar servidor MCP",
  "connectors.enableAria": "Ativar servidor MCP",
  "connectors.editAria": "Editar servidor MCP",
  "connectors.removeAria": "Remover servidor MCP",
  "connectors.editor.name": "Nome",
  "connectors.editor.namePlaceholder": "p. ex. GitHub, Filesystem, Linear…",
  "connectors.editor.transport": "Transporte",
  "connectors.editor.transportDesc":
    "Um processo local (stdio) ou um endpoint MCP remoto (HTTP/SSE).",
  "connectors.editor.command": "Comando",
  "connectors.editor.commandPlaceholder": "p. ex. npx",
  "connectors.editor.args": "Argumentos",
  "connectors.editor.argsHint": "um por linha",
  "connectors.editor.env": "Ambiente",
  "connectors.editor.envHint": "passado ao processo",
  "connectors.editor.url": "URL",
  "connectors.editor.headers": "Cabeçalhos",
  "connectors.editor.headersHint": "enviado em cada solicitação",
  "connectors.test.connected": "Conectado",
  "connectors.test.tools.one": "{count} ferramenta: {names}",
  "connectors.test.tools.other": "{count} ferramentas: {names}",
  "connectors.test.noTools": "Handshake OK — o servidor não expõe ferramentas.",
  "connectors.test.failed": "A conexão falhou.",
  "connectors.editor.saving": "Salvando…",
  "connectors.testing": "Testando…",
  "connectors.test.button": "Testar",
  "connectors.editor.envName": "CHAVE",
  "connectors.editor.envValue": "valor",
  "connectors.editor.addEnv": "Adicionar variável",
  "connectors.editor.headerName": "Nome",
  "connectors.editor.headerValue": "Valor",
  "connectors.editor.addHeader": "Adicionar cabeçalho",
  "connectors.editor.removeRow": "Remover",
  "connectors.details.toggleAria": "Mostrar ferramentas",
  "connectors.details.loading": "Carregando ferramentas…",
  "connectors.details.connected": "Conectado",
  "connectors.details.toolCount.one": "{count} ferramenta",
  "connectors.details.toolCount.other": "{count} ferramentas",
  "connectors.oauth.auth": "Autenticação",
  "connectors.oauth.authDesc":
    "Cabeçalhos estáticos ou OAuth (o Cetus executa o login).",
  "connectors.oauth.none": "Nenhuma",
  "connectors.oauth.clientId": "Client ID",
  "connectors.oauth.clientIdPlaceholder": "auto (registro dinâmico)",
  "connectors.oauth.scope": "Scope",
  "connectors.oauth.optional": "opcional",
  "connectors.oauth.authorize": "Autorizar",
  "connectors.oauth.authorizing": "Autorizando…",
  "connectors.oauth.authorized": "Autorizado — tokens em cache.",
  "connectors.oauth.hint": "Abre o navegador para entrar.",
  "connectors.oauth.saveHint":
    "Salve o servidor MCP, depois expanda-o abaixo e clique em Autorizar.",
  "discovery.mcp.none": "Nenhum servidor encontrado (sem arquivo de config).",
  "discovery.mcp.title": "Importar de outros apps",
  "discovery.mcp.description":
    "Também carrega servidores MCP configurados nesses apps. Aplica-se só a novos chats.",
  "skills.discovered.loadLabel": "Carregar skills descobertas",
  "skills.discovered.loadDesc":
    "Incluir skills da pasta abaixo em novos chats.",
  "skills.discovered.chooseFolder": "Escolher pasta",
};
