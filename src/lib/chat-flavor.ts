// Playful, rotating copy for the empty/new-chat hero: the greeting headline and
// the composer placeholder. Instead of one fixed line, each new chat surfaces a
// random phrase so the blank state feels a little more alive. Kept out of the
// typed i18n namespace (which is flat key→string) because these are *arrays* per
// locale; English is the fallback when a locale is missing.
//
// The picker also avoids repeating the immediately-previous phrase (tracked at
// module scope, per category), so opening a few new chats in a row always reads
// differently rather than occasionally landing on the same line twice.
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n";

/** Greeting shown above the hero composer (serif italic). */
const HEADLINES: Record<Locale, string[]> = {
  en: [
    "What should we work on?",
    "Where shall we begin?",
    "What are we building today?",
    "What's on your mind?",
    "Ready when you are.",
    "Let's make something.",
    "What can I help you ship?",
    "Got something in mind?",
    "What's the plan?",
    "Let's dig in.",
    "What are we tackling?",
    "Point me at something.",
  ],
  zh: [
    "我们来做点什么？",
    "从哪里开始呢？",
    "今天想构建点什么？",
    "在想些什么？",
    "准备好了就开始吧。",
    "一起造点东西吧。",
    "想让我帮你做点什么？",
    "有什么想法了吗？",
    "今天的计划是什么？",
    "我们开始吧。",
    "我们来攻克点什么？",
    "给我指个方向。",
  ],
  ja: [
    "何に取り組みましょうか？",
    "どこから始めましょう？",
    "今日は何を作りましょうか？",
    "何を考えていますか？",
    "準備ができたらどうぞ。",
    "何か作りましょう。",
    "何をお手伝いしましょう？",
    "何か思いついた？",
    "今日の計画は？",
    "さあ、始めましょう。",
    "何に取り組みますか？",
    "方向を教えてください。",
  ],
  ko: [
    "무엇을 함께 해볼까요?",
    "어디서부터 시작할까요?",
    "오늘은 무엇을 만들어 볼까요?",
    "무슨 생각을 하고 계신가요?",
    "준비되면 시작하세요.",
    "무언가 만들어 봐요.",
    "무엇을 도와드릴까요?",
    "떠오른 게 있나요?",
    "오늘의 계획은요?",
    "자, 시작해요.",
    "무엇을 해결해 볼까요?",
    "방향을 알려 주세요.",
  ],
  es: [
    "¿En qué trabajamos?",
    "¿Por dónde empezamos?",
    "¿Qué construimos hoy?",
    "¿Qué tienes en mente?",
    "Cuando quieras, empezamos.",
    "Hagamos algo.",
    "¿En qué te ayudo?",
    "¿Tienes algo en mente?",
    "¿Cuál es el plan?",
    "Manos a la obra.",
    "¿Qué resolvemos?",
    "Dame una dirección.",
  ],
  pt: [
    "No que vamos trabalhar?",
    "Por onde começamos?",
    "O que vamos construir hoje?",
    "O que você tem em mente?",
    "Quando quiser, começamos.",
    "Vamos criar algo.",
    "Em que posso ajudar?",
    "Tem algo em mente?",
    "Qual é o plano?",
    "Mãos à obra.",
    "O que vamos resolver?",
    "Me dê uma direção.",
  ],
  fr: [
    "Sur quoi travaillons-nous ?",
    "Par où commençons-nous ?",
    "Que construisons-nous aujourd'hui ?",
    "À quoi pensez-vous ?",
    "Quand vous voulez, on commence.",
    "Créons quelque chose.",
    "Comment puis-je vous aider ?",
    "Une idée en tête ?",
    "Quel est le plan ?",
    "Au travail.",
    "Que résout-on ?",
    "Donnez-moi une direction.",
  ],
  de: [
    "Woran arbeiten wir?",
    "Wo fangen wir an?",
    "Was bauen wir heute?",
    "Woran denkst du?",
    "Leg los, wann du willst.",
    "Lass uns etwas bauen.",
    "Womit kann ich helfen?",
    "Schon eine Idee?",
    "Was ist der Plan?",
    "Ran an die Arbeit.",
    "Was lösen wir?",
    "Gib mir eine Richtung.",
  ],
  it: [
    "A cosa lavoriamo?",
    "Da dove cominciamo?",
    "Cosa costruiamo oggi?",
    "A cosa stai pensando?",
    "Quando vuoi, si parte.",
    "Creiamo qualcosa.",
    "Come posso aiutarti?",
    "Hai qualcosa in mente?",
    "Qual è il piano?",
    "Mettiamoci al lavoro.",
    "Cosa risolviamo?",
    "Dammi una direzione.",
  ],
  ru: [
    "Над чем поработаем?",
    "С чего начнём?",
    "Что создадим сегодня?",
    "О чём думаете?",
    "Начнём, когда будете готовы.",
    "Давайте что-нибудь создадим.",
    "Чем могу помочь?",
    "Есть идея?",
    "Какой план?",
    "За дело.",
    "Что будем решать?",
    "Задайте направление.",
  ],
};

/** Placeholder inside the hero composer textarea. */
const HERO_PLACEHOLDERS: Record<Locale, string[]> = {
  en: [
    "Do anything",
    "Ask, build, explore…",
    "Describe a task, or just say hi",
    "What needs doing?",
    "Give me a task",
    "Start with a sentence",
    "Type a task, a question, anything",
    "What's on the docket?",
    "Tell me what to build",
    "Drop an idea here",
    "Ask me something",
    "Let's get into it",
  ],
  zh: [
    "想做什么都可以",
    "提问、构建、探索……",
    "描述一个任务，或者打个招呼",
    "有什么要做的？",
    "交给我一个任务",
    "先从一句话开始",
    "任务、问题，什么都行",
    "今天有什么安排？",
    "告诉我要构建什么",
    "在这里写下你的想法",
    "问我点什么",
    "我们开始吧",
  ],
  ja: [
    "何でもどうぞ",
    "質問、開発、探索…",
    "タスクを説明、または挨拶でも",
    "何をしましょうか？",
    "タスクをひとつどうぞ",
    "ひと言から始めましょう",
    "タスクでも質問でも、何でも",
    "今日の予定は？",
    "何を作るか教えて",
    "アイデアをここに",
    "何か聞いてみて",
    "さあ、始めよう",
  ],
  ko: [
    "무엇이든 해보세요",
    "질문하고, 만들고, 탐색하세요…",
    "작업을 설명하거나 인사를 건네세요",
    "무엇을 할까요?",
    "작업을 하나 맡겨 주세요",
    "한 문장으로 시작하세요",
    "작업이든 질문이든, 무엇이든",
    "오늘 할 일은요?",
    "무엇을 만들지 알려 주세요",
    "여기에 아이디어를 적어 보세요",
    "무엇이든 물어보세요",
    "자, 시작해 봐요",
  ],
  es: [
    "Haz cualquier cosa",
    "Pregunta, crea, explora…",
    "Describe una tarea, o solo saluda",
    "¿Qué hay que hacer?",
    "Dame una tarea",
    "Empieza con una frase",
    "Una tarea, una pregunta, lo que sea",
    "¿Qué tenemos para hoy?",
    "Dime qué construir",
    "Escribe una idea aquí",
    "Pregúntame algo",
    "Vamos a ello",
  ],
  pt: [
    "Faça qualquer coisa",
    "Pergunte, crie, explore…",
    "Descreva uma tarefa, ou só diga oi",
    "O que precisa ser feito?",
    "Me dê uma tarefa",
    "Comece com uma frase",
    "Uma tarefa, uma pergunta, qualquer coisa",
    "O que temos para hoje?",
    "Diga o que construir",
    "Escreva uma ideia aqui",
    "Pergunte-me algo",
    "Vamos nessa",
  ],
  fr: [
    "Faites n'importe quoi",
    "Demandez, créez, explorez…",
    "Décrivez une tâche, ou dites bonjour",
    "Que faut-il faire ?",
    "Confiez-moi une tâche",
    "Commencez par une phrase",
    "Une tâche, une question, n'importe quoi",
    "Au programme aujourd'hui ?",
    "Dites-moi quoi construire",
    "Notez une idée ici",
    "Posez-moi une question",
    "C'est parti",
  ],
  de: [
    "Mach irgendetwas",
    "Fragen, bauen, erkunden…",
    "Beschreibe eine Aufgabe, oder sag einfach Hallo",
    "Was ist zu tun?",
    "Gib mir eine Aufgabe",
    "Beginn mit einem Satz",
    "Eine Aufgabe, eine Frage, irgendwas",
    "Was steht heute an?",
    "Sag mir, was ich bauen soll",
    "Schreib hier eine Idee",
    "Frag mich etwas",
    "Auf geht's",
  ],
  it: [
    "Fai qualsiasi cosa",
    "Chiedi, crea, esplora…",
    "Descrivi un'attività, o salutami",
    "Cosa c'è da fare?",
    "Dammi un'attività",
    "Inizia con una frase",
    "Un'attività, una domanda, qualsiasi cosa",
    "Cosa c'è in programma oggi?",
    "Dimmi cosa costruire",
    "Scrivi un'idea qui",
    "Chiedimi qualcosa",
    "Diamoci dentro",
  ],
  ru: [
    "Делайте что угодно",
    "Спросите, создайте, исследуйте…",
    "Опишите задачу или просто поздоровайтесь",
    "Что нужно сделать?",
    "Дайте мне задачу",
    "Начните с одной фразы",
    "Задача, вопрос — что угодно",
    "Что в планах на сегодня?",
    "Скажите, что построить",
    "Запишите идею здесь",
    "Спросите меня о чём-нибудь",
    "Приступим",
  ],
};

/** Pick a random entry, never the immediately-previous one (`last`). With a
 *  list of ≥2 the result always differs from `last`; with 0–1 it degrades
 *  gracefully. */
function pickDistinct(list: string[], last: string | null): string {
  if (list.length <= 1) return list[0] ?? "";
  const pool = last === null ? list : list.filter((s) => s !== last);
  return pool[Math.floor(Math.random() * pool.length)];
}

// Last phrase handed out per category, so the next pick can skip it. Module
// scope: shared across the landing hero and the in-pane empty state (never
// shown at once), which is exactly the "don't repeat what I just saw" intent.
let lastHeadline: string | null = null;
let lastHeroPlaceholder: string | null = null;

/** A random greeting headline for the new-chat hero, in the active locale.
 *  Call inside a `useMemo` keyed on the new-chat signal so it stays put across
 *  re-renders but re-rolls when a fresh chat opens. Never repeats the previous. */
export function flavorHeadline(locale: Locale): string {
  const list = HEADLINES[locale] ?? HEADLINES[DEFAULT_LOCALE];
  const pick = pickDistinct(list, lastHeadline);
  lastHeadline = pick;
  return pick;
}

/** A random composer placeholder for the new-chat hero, in the active locale.
 *  Never repeats the previous pick. */
export function flavorHeroPlaceholder(locale: Locale): string {
  const list = HERO_PLACEHOLDERS[locale] ?? HERO_PLACEHOLDERS[DEFAULT_LOCALE];
  const pick = pickDistinct(list, lastHeroPlaceholder);
  lastHeroPlaceholder = pick;
  return pick;
}
