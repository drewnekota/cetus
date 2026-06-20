// Playful, rotating copy for the empty/new-chat hero: the greeting headline and
// the composer placeholder. Instead of one fixed line, each new chat surfaces a
// random phrase so the blank state feels a little more alive. Kept out of the
// typed i18n namespace (which is flat key→string) because these are *arrays* per
// locale; English is the fallback when a locale is missing.
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
  ],
  zh: [
    "我们来做点什么？",
    "从哪里开始呢？",
    "今天想构建点什么？",
    "在想些什么？",
    "准备好了就开始吧。",
    "一起造点东西吧。",
  ],
  ja: [
    "何に取り組みましょうか？",
    "どこから始めましょう？",
    "今日は何を作りましょうか？",
    "何を考えていますか？",
    "準備ができたらどうぞ。",
    "何か作りましょう。",
  ],
  ko: [
    "무엇을 함께 해볼까요?",
    "어디서부터 시작할까요?",
    "오늘은 무엇을 만들어 볼까요?",
    "무슨 생각을 하고 계신가요?",
    "준비되면 시작하세요.",
    "무언가 만들어 봐요.",
  ],
  es: [
    "¿En qué trabajamos?",
    "¿Por dónde empezamos?",
    "¿Qué construimos hoy?",
    "¿Qué tienes en mente?",
    "Cuando quieras, empezamos.",
    "Hagamos algo.",
  ],
  pt: [
    "No que vamos trabalhar?",
    "Por onde começamos?",
    "O que vamos construir hoje?",
    "O que você tem em mente?",
    "Quando quiser, começamos.",
    "Vamos criar algo.",
  ],
  fr: [
    "Sur quoi travaillons-nous ?",
    "Par où commençons-nous ?",
    "Que construisons-nous aujourd'hui ?",
    "À quoi pensez-vous ?",
    "Quand vous voulez, on commence.",
    "Créons quelque chose.",
  ],
  de: [
    "Woran arbeiten wir?",
    "Wo fangen wir an?",
    "Was bauen wir heute?",
    "Woran denkst du?",
    "Leg los, wann du willst.",
    "Lass uns etwas bauen.",
  ],
  it: [
    "A cosa lavoriamo?",
    "Da dove cominciamo?",
    "Cosa costruiamo oggi?",
    "A cosa stai pensando?",
    "Quando vuoi, si parte.",
    "Creiamo qualcosa.",
  ],
  ru: [
    "Над чем поработаем?",
    "С чего начнём?",
    "Что создадим сегодня?",
    "О чём думаете?",
    "Начнём, когда будете готовы.",
    "Давайте что-нибудь создадим.",
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
  ],
  zh: [
    "想做什么都可以",
    "提问、构建、探索……",
    "描述一个任务，或者打个招呼",
    "有什么要做的？",
    "交给我一个任务",
    "先从一句话开始",
  ],
  ja: [
    "何でもどうぞ",
    "質問、開発、探索…",
    "タスクを説明、または挨拶でも",
    "何をしましょうか？",
    "タスクをひとつどうぞ",
    "ひと言から始めましょう",
  ],
  ko: [
    "무엇이든 해보세요",
    "질문하고, 만들고, 탐색하세요…",
    "작업을 설명하거나 인사를 건네세요",
    "무엇을 할까요?",
    "작업을 하나 맡겨 주세요",
    "한 문장으로 시작하세요",
  ],
  es: [
    "Haz cualquier cosa",
    "Pregunta, crea, explora…",
    "Describe una tarea, o solo saluda",
    "¿Qué hay que hacer?",
    "Dame una tarea",
    "Empieza con una frase",
  ],
  pt: [
    "Faça qualquer coisa",
    "Pergunte, crie, explore…",
    "Descreva uma tarefa, ou só diga oi",
    "O que precisa ser feito?",
    "Me dê uma tarefa",
    "Comece com uma frase",
  ],
  fr: [
    "Faites n'importe quoi",
    "Demandez, créez, explorez…",
    "Décrivez une tâche, ou dites bonjour",
    "Que faut-il faire ?",
    "Confiez-moi une tâche",
    "Commencez par une phrase",
  ],
  de: [
    "Mach irgendetwas",
    "Fragen, bauen, erkunden…",
    "Beschreibe eine Aufgabe, oder sag einfach Hallo",
    "Was ist zu tun?",
    "Gib mir eine Aufgabe",
    "Beginn mit einem Satz",
  ],
  it: [
    "Fai qualsiasi cosa",
    "Chiedi, crea, esplora…",
    "Descrivi un'attività, o salutami",
    "Cosa c'è da fare?",
    "Dammi un'attività",
    "Inizia con una frase",
  ],
  ru: [
    "Делайте что угодно",
    "Спросите, создайте, исследуйте…",
    "Опишите задачу или просто поздоровайтесь",
    "Что нужно сделать?",
    "Дайте мне задачу",
    "Начните с одной фразы",
  ],
};

function pickRandom(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)];
}

/** A random greeting headline for the new-chat hero, in the active locale.
 *  Call inside a `useMemo` keyed on the new-chat signal so it stays put across
 *  re-renders but re-rolls when a fresh chat opens. */
export function flavorHeadline(locale: Locale): string {
  return pickRandom(HEADLINES[locale] ?? HEADLINES[DEFAULT_LOCALE]);
}

/** A random composer placeholder for the new-chat hero, in the active locale. */
export function flavorHeroPlaceholder(locale: Locale): string {
  return pickRandom(HERO_PLACEHOLDERS[locale] ?? HERO_PLACEHOLDERS[DEFAULT_LOCALE]);
}
