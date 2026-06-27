import cron from "node-cron";
import { Markup, Telegraf } from "telegraf";
import type { Context } from "telegraf";
import type { BotCommand } from "telegraf/types";

import { config } from "./config.js";
import { log } from "./logger.js";
import {
  appendErrorReport,
  completeQuizAnswer,
  createQuizSession,
  deleteQuizSession,
  getAnswersForUser,
  getDailyTouchState,
  recordDailyQuestionDelivered,
  recordDailySlotSkipped,
  releaseUserFlow,
  getMarkings,
  getQuestionByKey,
  getQuestionStatesForUser,
  getQuestions,
  getQuizSessionById,
  getQuizSessionsForUser,
  getSigns,
  getTerms,
  getUserFlow,
  getUsers,
  resolveAssetImagePath,
  resolveQuestionImagePath,
  setSubscription,
  setUserFlow,
  setUserLanguage,
  tryTransitionFlowToQuestion,
  updateUser,
  upsertUser,
} from "./storage.js";
import type {
  LanguageCode,
  MarkingRecord,
  QuizMode,
  QuizQuestion,
  QuizSessionRecord,
  QuestionStatus,
  SignRecord,
  TermRecord,
  TopicMeta,
  TopicSlug,
  UserFlowRecord,
  UserQuestionState,
  UserRecord,
} from "./types.js";

let bot: Telegraf | undefined;
let commandsRegistered = false;
let commandsMenuRegistered = false;
let schedulesRegistered = false;
let middlewareRegistered = false;

const DELIVERY_WAIT_MS = 25_000;
const DELIVERY_POLL_MS = 800;

function getBot(): Telegraf {
  bot ??= new Telegraf(config.botToken);
  return bot;
}

const TOPICS: TopicMeta[] = [
  {
    slug: "maneuvers-and-lane-position",
    order: 1,
    title: { ru: "Маневры и расположение на дороге", am: "Մանևրեր և ճանապարհին դիրքավորում" },
  },
  {
    slug: "terms-and-general-rules",
    order: 2,
    title: { ru: "Термины и общие правила", am: "Տերմիններ և ընդհանուր կանոններ" },
  },
  {
    slug: "vehicle-technical-condition",
    order: 3,
    title: { ru: "Техническое состояние ТС", am: "Տրանսպորտային միջոցի տեխնիկական վիճակ" },
  },
  {
    slug: "road-signs",
    order: 4,
    title: { ru: "Дорожные знаки", am: "Ճանապարհային նշաններ" },
  },
  {
    slug: "intersection-priority",
    order: 5,
    title: { ru: "Приоритет на перекрестках", am: "Առաջնահերթություն խաչմերուկներում" },
  },
  {
    slug: "traffic-lights-and-intersections",
    order: 6,
    title: { ru: "Светофоры и перекрестки", am: "Լուսացույցներ և խաչմերուկներ" },
  },
  {
    slug: "stopping-parking-and-markings",
    order: 7,
    title: { ru: "Остановка, стоянка и разметка", am: "Կանգառ, կայանում և գծանշում" },
  },
  {
    slug: "speed-towing-and-passengers",
    order: 8,
    title: { ru: "Скорость, буксировка и пассажиры", am: "Արագություն, քարշակում և ուղևորներ" },
  },
  {
    slug: "overtaking-signals-and-railway-crossings",
    order: 9,
    title: { ru: "Обгон, сигналы и ж/д переезды", am: "Առաջանցում, ազդանշաններ և երկաթուղային անցումներ" },
  },
  {
    slug: "first-aid",
    order: 10,
    title: { ru: "Первая помощь", am: "Առաջին օգնություն" },
  },
];

function t(language: LanguageCode, ru: string, am: string): string {
  return language === "am" ? am : ru;
}

function getTopicMeta(topicSlug: TopicSlug): TopicMeta {
  return TOPICS.find((topic) => topic.slug === topicSlug) ?? TOPICS[0];
}

function getTopicTitle(topicSlug: TopicSlug, language: LanguageCode): string {
  return getTopicMeta(topicSlug).title[language];
}

async function getSubscribedUsers(): Promise<UserRecord[]> {
  return (await getUsers()).filter((user) => user.isSubscribed);
}

function getTextMessage(ctx: Context): string {
  const message = ctx.message;
  if (!message || !("text" in message)) {
    return "";
  }

  return message.text.trim();
}

function getChatId(ctx: Context): number | undefined {
  const directChatId = ctx.chat?.id;
  if (directChatId !== undefined) {
    return directChatId;
  }

  const callbackChatId = (
    ctx.callbackQuery as { message?: { chat?: { id?: number } } } | undefined
  )?.message?.chat?.id;
  if (callbackChatId !== undefined) {
    return callbackChatId;
  }

  const messageChatId = (ctx.message as { chat?: { id?: number } } | undefined)?.chat?.id;
  return messageChatId;
}

function isQuestionDelivered(flow: UserFlowRecord): boolean {
  return flow.state === "question_open" && flow.activeQuestionMessageId !== undefined;
}

function isDeliveryClaimed(flow: UserFlowRecord): boolean {
  if (flow.state !== "question_open" || !flow.activeSessionId) {
    return false;
  }

  if (flow.activeQuestionMessageId !== undefined) {
    return false;
  }

  const ageMs = Date.now() - new Date(flow.updatedAt).getTime();
  return ageMs >= 0 && ageMs < DELIVERY_WAIT_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForQuestionDelivery(
  telegramId: number,
  expectedSessionId?: string,
): Promise<UserFlowRecord | undefined> {
  const deadline = Date.now() + DELIVERY_WAIT_MS;

  while (Date.now() < deadline) {
    const flow = await getUserFlow(telegramId);
    if (isQuestionDelivered(flow)) {
      if (!expectedSessionId || flow.activeSessionId === expectedSessionId) {
        return flow;
      }
    }

    if (!isDeliveryClaimed(flow)) {
      return undefined;
    }

    await sleep(DELIVERY_POLL_MS);
  }

  return undefined;
}

function describeCtx(ctx: Context): Record<string, unknown> {
  const callbackQuery = ctx.callbackQuery;
  const callbackData =
    callbackQuery && "data" in callbackQuery ? callbackQuery.data : undefined;

  return {
    updateId: ctx.update.update_id,
    fromId: ctx.from?.id,
    chatId: getChatId(ctx),
    ctxChatId: ctx.chat?.id,
    callbackData,
    text: getTextMessage(ctx).slice(0, 120) || undefined,
  };
}

function resolveDeliveryChatId(ctx: Context | undefined, fallbackChatId: number): number {
  if (!ctx) {
    return fallbackChatId;
  }

  return getChatId(ctx) ?? fallbackChatId;
}

async function sendTextToChat(
  chatId: number,
  text: string,
  extra: object | undefined,
  ctx?: Context,
): Promise<number> {
  const targetChatId = resolveDeliveryChatId(ctx, chatId);
  const message = await getBot().telegram.sendMessage(targetChatId, text, extra);
  return message.message_id;
}

const TELEGRAM_CAPTION_LIMIT = 1024;

async function sendPhotoToChat(
  chatId: number,
  photo: { source: string },
  extra?: object,
  ctx?: Context,
): Promise<number> {
  const targetChatId = resolveDeliveryChatId(ctx, chatId);
  const message = await getBot().telegram.sendPhoto(targetChatId, photo, extra);
  return message.message_id;
}

async function sendAnimationToChat(
  chatId: number,
  animation: { source: string },
  extra?: object,
  ctx?: Context,
): Promise<number> {
  const targetChatId = resolveDeliveryChatId(ctx, chatId);
  const message = await getBot().telegram.sendAnimation(targetChatId, animation, extra);
  return message.message_id;
}

async function sendSignImageToChat(
  chatId: number,
  imagePath: string,
  extra?: object,
  ctx?: Context,
): Promise<void> {
  const source = { source: imagePath };
  const isGif = imagePath.toLowerCase().endsWith(".gif");

  if (isGif) {
    await sendAnimationToChat(chatId, source, extra, ctx);
    return;
  }

  await sendPhotoToChat(chatId, source, extra, ctx);
}

function getCallbackMessageId(ctx: Context): number | undefined {
  const message = (
    ctx.callbackQuery as { message?: { message_id?: number } } | undefined
  )?.message;
  return message?.message_id;
}

function isMenuCallback(callbackData: string): boolean {
  return (
    callbackData.startsWith("menu|") ||
    callbackData.startsWith("settings|lang|") ||
    callbackData.startsWith("topic|") ||
    callbackData.startsWith("topicquiz|")
  );
}

type CallbackRejectReason = "stale_answer" | "stale_followup" | "flow_not_ready";

function buildCallbackRejectText(language: LanguageCode, reason: CallbackRejectReason): string {
  if (reason === "flow_not_ready") {
    return t(
      language,
      "Секунду — ответ ещё сохраняется. Потом нажми «Следующий вопрос».",
      "Մի վայրկյան — պատասխանը դեռ պահպանվում է։ Հետո սեղմիր «Հաջորդ հարց»։",
    );
  }

  if (reason === "stale_followup") {
    return t(
      language,
      "Это старое объяснение — используй кнопки под последним сообщением или меню.",
      "Սա հին բացատրություն է — օգտագործիր վերջին հաղորդագրության կոճակները կամ մենյուն։",
    );
  }

  return t(
    language,
    "Это старый вопрос — используй меню (/) или «Начать квиз».",
    "Սա հին հարց է — օգտագործիր մենյուն (/) կամ «Սկսել քուիզը»։",
  );
}

type PreviousQuizMessageIds = {
  question?: number;
  explanation?: number;
};

type SendQuestionOptions = {
  /** Menu/commands: abandon the current round and start fresh. */
  overrideFlow?: boolean;
  /** Catch-up delivery from the daily backlog queue. */
  fromDailyBacklog?: boolean;
};

async function abandonActiveRound(
  user: UserRecord,
  flow: UserFlowRecord,
  ctx?: Context,
): Promise<void> {
  if (flow.state === "idle") {
    return;
  }

  log.info("flow", "abandon_active_round", {
    telegramId: user.telegramId,
    state: flow.state,
    activeSessionId: flow.activeSessionId,
    activeQuestionMessageId: flow.activeQuestionMessageId,
    activeExplanationMessageId: flow.activeExplanationMessageId,
  });

  if (flow.activeSessionId) {
    const session = await getQuizSessionById(flow.activeSessionId);
    if (session?.status === "pending") {
      await deleteQuizSession(flow.activeSessionId);
      log.info("flow", "abandon_deleted_pending_session", {
        telegramId: user.telegramId,
        sessionId: flow.activeSessionId,
      });
    }
  }

  await stripPreviousQuizMessages(
    user.chatId,
    {
      question: flow.activeQuestionMessageId,
      explanation: flow.activeExplanationMessageId,
    },
    ctx,
  );
  await releaseUserFlow(user.telegramId);
}

async function stripPreviousQuizMessages(
  chatId: number,
  previousMessageIds: PreviousQuizMessageIds | undefined,
  ctx?: Context,
  excludeMessageIds?: number[],
): Promise<void> {
  if (!previousMessageIds) {
    return;
  }

  const excluded = new Set(excludeMessageIds ?? []);
  if (previousMessageIds.question !== undefined && !excluded.has(previousMessageIds.question)) {
    await stripMessageKeyboard(chatId, previousMessageIds.question, ctx);
  }
  if (
    previousMessageIds.explanation !== undefined &&
    !excluded.has(previousMessageIds.explanation)
  ) {
    await stripMessageKeyboard(chatId, previousMessageIds.explanation, ctx);
  }
}

async function stripMessageKeyboard(
  chatId: number,
  messageId: number | undefined,
  ctx?: Context,
): Promise<void> {
  if (!messageId) {
    return;
  }

  try {
    await getBot().telegram.editMessageReplyMarkup(chatId, messageId, undefined, {
      inline_keyboard: [],
    });
  } catch (error) {
    log.debug("bot", "strip_message_keyboard_failed", {
      chatId,
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function clearQuestionAnswerKeyboard(
  ctx: Context,
  chatId: number,
  questionMessageId: number | undefined,
): Promise<void> {
  const callbackMessageId = getCallbackMessageId(ctx);

  if (
    callbackMessageId !== undefined &&
    (questionMessageId === undefined || questionMessageId === callbackMessageId)
  ) {
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      return;
    } catch (error) {
      log.warn("bot", "clear_question_keyboard_callback_failed", {
        chatId,
        callbackMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await stripMessageKeyboard(chatId, questionMessageId ?? callbackMessageId, ctx);
}

async function rejectStaleCallback(
  ctx: Context,
  language: LanguageCode,
  callbackData: string | undefined,
  reason: CallbackRejectReason,
): Promise<void> {
  const text = buildCallbackRejectText(language, reason);

  try {
    await ctx.answerCbQuery(text);
  } catch (error) {
    log.warn("bot", "stale_callback_answer_failed", {
      ...describeCtx(ctx),
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (reason !== "stale_answer") {
    log.debug("bot", "stale_callback_reject_no_strip", {
      ...describeCtx(ctx),
      callbackData,
      reason,
    });
    return;
  }

  const chatId = getChatId(ctx);
  const messageId = getCallbackMessageId(ctx);
  if (chatId !== undefined) {
    await stripMessageKeyboard(chatId, messageId, ctx);
  }
}

async function validateQuizCallback(
  ctx: Context,
  callbackData: string,
): Promise<{ allowed: boolean; language: LanguageCode; rejectReason?: CallbackRejectReason }> {
  const from = ctx.from;
  if (!from) {
    return { allowed: true, language: "ru" };
  }

  if (isMenuCallback(callbackData)) {
    return { allowed: true, language: "ru" };
  }

  const user = await upsertUser(
    from.id,
    getChatId(ctx) ?? from.id,
    from.first_name,
    from.username,
  );
  const flow = await getFlowForUser(user);
  const callbackMessageId = getCallbackMessageId(ctx);

  const answerMatch = callbackData.match(/^answer\|([^|]+)\|([^|]+)$/);
  if (answerMatch) {
    const [, sessionId] = answerMatch;
    const session = await getQuizSessionById(sessionId);
    const messageMatches =
      flow.activeQuestionMessageId === undefined ||
      callbackMessageId === flow.activeQuestionMessageId;

    const allowed =
      flow.state === "question_open" &&
      flow.activeSessionId === sessionId &&
      session?.telegramId === user.telegramId &&
      session.status === "pending" &&
      messageMatches;

    if (!allowed) {
      log.info("bot", "stale_callback_answer", {
        telegramId: user.telegramId,
        callbackData,
        flowState: flow.state,
        activeSessionId: flow.activeSessionId,
        activeQuestionMessageId: flow.activeQuestionMessageId,
        callbackMessageId,
        sessionStatus: session?.status,
      });
    }

    return {
      allowed,
      language: user.language,
      rejectReason: allowed ? undefined : "stale_answer",
    };
  }

  if (callbackData === "nav|next-quiz") {
    const messageMatches =
      flow.activeExplanationMessageId !== undefined &&
      callbackMessageId === flow.activeExplanationMessageId;

    if (flow.state === "explanation_shown" && messageMatches) {
      return { allowed: true, language: user.language };
    }

    if (
      flow.state === "explanation_shown" &&
      flow.activeExplanationMessageId !== undefined &&
      callbackMessageId !== flow.activeExplanationMessageId
    ) {
      log.info("bot", "stale_callback_next_quiz", {
        telegramId: user.telegramId,
        flowState: flow.state,
        activeExplanationMessageId: flow.activeExplanationMessageId,
        callbackMessageId,
      });
      return { allowed: false, language: user.language, rejectReason: "stale_followup" };
    }

    if (
      flow.state === "question_open" &&
      flow.activeExplanationMessageId !== undefined &&
      callbackMessageId === flow.activeExplanationMessageId
    ) {
      return { allowed: true, language: user.language };
    }

    if (flow.state === "question_open" && isQuestionDelivered(flow)) {
      return { allowed: true, language: user.language };
    }

    if (flow.state === "question_open" && isDeliveryClaimed(flow)) {
      log.info("bot", "nav_while_delivery_claimed", {
        telegramId: user.telegramId,
        activeSessionId: flow.activeSessionId,
        callbackMessageId,
      });
      return { allowed: true, language: user.language };
    }

    log.info("bot", "stale_callback_next_quiz", {
      telegramId: user.telegramId,
      flowState: flow.state,
      activeExplanationMessageId: flow.activeExplanationMessageId,
      callbackMessageId,
    });
    return {
      allowed: false,
      language: user.language,
      rejectReason: flow.state === "question_open" ? "flow_not_ready" : "stale_followup",
    };
  }

  const reportMatch = callbackData.match(/^report\|(.+)$/);
  if (reportMatch) {
    const [, questionKey] = reportMatch;
    const session = flow.activeSessionId
      ? await getQuizSessionById(flow.activeSessionId)
      : undefined;
    const messageMatches =
      flow.activeExplanationMessageId !== undefined &&
      callbackMessageId === flow.activeExplanationMessageId;
    const allowed =
      flow.state === "explanation_shown" &&
      session?.questionKey === questionKey &&
      messageMatches;

    if (!allowed) {
      log.info("bot", "stale_callback_report", {
        telegramId: user.telegramId,
        questionKey,
        flowState: flow.state,
        activeSessionId: flow.activeSessionId,
        callbackMessageId,
      });
    }

    return {
      allowed,
      language: user.language,
      rejectReason: allowed ? undefined : "stale_followup",
    };
  }

  const refMatch = callbackData.match(/^ref\|(sign|term)\|(.+)$/);
  if (refMatch) {
    if (
      flow.activeExplanationMessageId !== undefined &&
      callbackMessageId === flow.activeExplanationMessageId
    ) {
      const allowed = flow.state === "explanation_shown";
      if (!allowed) {
        log.info("bot", "stale_callback_ref_from_explanation", {
          telegramId: user.telegramId,
          callbackData,
          flowState: flow.state,
        });
      }
      return { allowed, language: user.language };
    }

    return { allowed: true, language: user.language };
  }

  return { allowed: true, language: user.language };
}

function getCommandArg(ctx: Context): string {
  const text = getTextMessage(ctx);
  const [, ...rest] = text.split(/\s+/);
  return rest.join(" ").trim();
}

function pickRandom<T>(items: T[]): T | undefined {
  if (items.length === 0) {
    return undefined;
  }

  return items[Math.floor(Math.random() * items.length)];
}

function nowIso(): string {
  return new Date().toISOString();
}

const STALE_FLOW_MS = 15 * 60 * 1000;

function createSessionId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function isActiveLearningRound(
  flow: UserFlowRecord,
  session: QuizSessionRecord,
): boolean {
  return (
    (flow.state === "question_open" && session.status === "pending") ||
    (flow.state === "explanation_shown" && session.status === "answered")
  );
}

function isActiveRoundPastLocalDay(flow: UserFlowRecord): boolean {
  const updatedAt = new Date(flow.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) {
    return true;
  }

  return getLocalDateKey(updatedAt) !== getLocalDateKey(new Date());
}

function isFlowStale(flow: UserFlowRecord, session?: QuizSessionRecord): boolean {
  if (flow.state === "idle") {
    return false;
  }

  const updatedAt = new Date(flow.updatedAt).getTime();
  if (Number.isNaN(updatedAt)) {
    return true;
  }

  if (session && isActiveLearningRound(flow, session)) {
    return isActiveRoundPastLocalDay(flow);
  }

  return Date.now() - updatedAt > STALE_FLOW_MS;
}

function addHours(date: Date, hours: number): string {
  return new Date(date.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function addDays(date: Date, days: number): string {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function getLocalDateKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getMaxDailyTouches(): number {
  return config.touchCrons.length;
}

async function markDailySlotSkipped(user: UserRecord): Promise<void> {
  await recordDailySlotSkipped(
    user.telegramId,
    getLocalDateKey(new Date()),
    getMaxDailyTouches(),
  );
}

async function finishDailySendAttempt(
  user: UserRecord,
  mode: QuizMode,
  result: boolean,
  skipped: boolean,
): Promise<boolean> {
  if (mode === "daily" && skipped) {
    await markDailySlotSkipped(user);
  }

  return result;
}

type DailyCatchupResult = "sent" | "empty" | "quota_full" | "delivery_failed";

async function sendDailyCatchup(
  user: UserRecord,
  ctx?: Context,
): Promise<DailyCatchupResult> {
  const dailyState = await getDailyTouchState(
    user.telegramId,
    getLocalDateKey(new Date()),
  );
  const maxDaily = getMaxDailyTouches();

  if (dailyState.backlog <= 0) {
    return "empty";
  }

  if (dailyState.sentCount >= maxDaily) {
    return "quota_full";
  }

  const sent = await sendQuestion(user, "daily", undefined, ctx, {
    overrideFlow: true,
    fromDailyBacklog: true,
  });

  return sent ? "sent" : "delivery_failed";
}

async function replyDailyCatchupResult(
  user: UserRecord,
  result: DailyCatchupResult,
  ctx?: Context,
): Promise<void> {
  const maxDaily = getMaxDailyTouches();
  const dailyState = await getDailyTouchState(
    user.telegramId,
    getLocalDateKey(new Date()),
  );

  let text: string;
  switch (result) {
    case "sent":
      text = t(
        user.language,
        `Отправляю пропущенный вопрос дня. В очереди ещё ${dailyState.backlog}. После объяснения жми «Следующий вопрос», чтобы взять следующий.`,
        `Ուղարկում եմ բաց թողնված օրվա հարցը։ Հերթում էլի կա ${dailyState.backlog}։ Բացատրությունից հետո սեղմիր «Հաջորդ հարց»՝ հաջորդը ստանալու համար։`,
      );
      break;
    case "empty":
      text = t(
        user.language,
        "Сегодня нет пропущенных вопросов дня в очереди.",
        "Այսօր հերթում բաց թողնված օրվա հարցեր չկան։",
      );
      break;
    case "quota_full":
      text = t(
        user.language,
        `Сегодня уже получено максимум вопросов дня (${maxDaily}/${maxDaily}).`,
        `Այսօր արդեն ստացվել է օրվա հարցերի առավելագույնը (${maxDaily}/${maxDaily})։`,
      );
      break;
    case "delivery_failed":
      text = t(
        user.language,
        "Не удалось отправить пропущенный вопрос. Попробуй ещё раз через минуту.",
        "Չհաջողվեց ուղարկել բաց թողնված հարցը։ Փորձիր կրկին մեկ րոպեից։",
      );
      break;
  }

  if (ctx) {
    await ctx.reply(text);
    return;
  }

  await getBot().telegram.sendMessage(user.chatId, text);
}

function isDue(nextReviewAt: string | undefined, now: Date): boolean {
  if (!nextReviewAt) {
    return true;
  }

  return new Date(nextReviewAt).getTime() <= now.getTime();
}

function buildLanguageKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("Русский", "settings|lang|ru"),
      Markup.button.callback("Հայերեն", "settings|lang|am"),
    ],
  ]);
}

function buildStartKeyboard(language: LanguageCode) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(t(language, "Начать квиз", "Սկսել քուիզը"), "menu|quiz"),
      Markup.button.callback(t(language, "Темы", "Թեմաներ"), "menu|topics"),
    ],
    [
      Markup.button.callback(t(language, "Ошибки", "Սխալներ"), "menu|mistakes"),
      Markup.button.callback(t(language, "Настройки", "Կարգավորումներ"), "menu|settings"),
    ],
    [
      Markup.button.callback(t(language, "Случайный знак", "Պատահական նշան"), "menu|sign"),
      Markup.button.callback(t(language, "Случайный термин", "Պատահական տերմին"), "menu|term"),
    ],
  ]);
}

const BOT_COMMANDS_RU: BotCommand[] = [
  { command: "start", description: "Главное меню" },
  { command: "quiz", description: "Начать квиз" },
  { command: "topics", description: "10 групп вопросов" },
  { command: "mistakes", description: "Повтор ошибок" },
  { command: "catchup", description: "Догнать пропущенные вопросы дня" },
  { command: "progress", description: "Прогресс обучения" },
  { command: "settings", description: "Язык и настройки" },
  { command: "sign", description: "Случайный знак или разметка" },
  { command: "term", description: "Случайный термин" },
  { command: "stop", description: "Остановить ежедневные вопросы" },
];

const BOT_COMMANDS_AM: BotCommand[] = [
  { command: "start", description: "Գլխավոր մենյու" },
  { command: "quiz", description: "Սկսել քուիզը" },
  { command: "topics", description: "10 հարցաշարային խմբեր" },
  { command: "mistakes", description: "Սխալների կրկնություն" },
  { command: "catchup", description: "Բաց թողնված օրվա հարցերը" },
  { command: "progress", description: "Ուսուցման առաջընթաց" },
  { command: "settings", description: "Լեզու և կարգավորումներ" },
  { command: "sign", description: "Պատահական նշան կամ գծանշում" },
  { command: "term", description: "Պատահական տերմին" },
  { command: "stop", description: "Դադարեցնել ամենօրյա հարցերը" },
];

async function registerBotCommandsMenu(): Promise<void> {
  if (commandsMenuRegistered) {
    return;
  }

  commandsMenuRegistered = true;

  try {
    await getBot().telegram.setMyCommands(BOT_COMMANDS_RU);
    await getBot().telegram.setMyCommands(BOT_COMMANDS_AM, { language_code: "hy" });
    log.info("bot", "commands_menu_registered", {
      ruCount: BOT_COMMANDS_RU.length,
      amCount: BOT_COMMANDS_AM.length,
    });
  } catch (error) {
    commandsMenuRegistered = false;
    log.error("bot", "commands_menu_register_failed", error);
  }
}

function buildMainMenuText(language: LanguageCode): string {
  return [
    t(language, "Команды:", "Հրամաններ՝"),
    "/quiz",
    `/topics ${t(language, "— 10 групп вопросов", "— 10 հարցաշարային խմբեր")}`,
    `/sign ${t(language, "— случайный знак или разметка", "— նշան ըստ id կամ պատահական")}`,
    `/term ${t(language, "— случайный термин", "— տերմին ըստ slug կամ պատահական")}`,
    `/mistakes ${t(language, "— повтор ошибок", "— սխալների կրկնություն")}`,
    `/catchup ${t(language, "— догнать пропущенные вопросы дня", "— բաց թողնված օրվա հարցերը")}`,
    `/progress ${t(language, "— прогресс", "— առաջընթաց")}`,
    `/settings ${t(language, "— язык", "— լեզու")}`,
    "/stop",
  ].join("\n");
}

async function buildDailySummaryText(user: UserRecord): Promise<string> {
  const todayKey = getLocalDateKey(new Date());
  const dailyState = await getDailyTouchState(user.telegramId, todayKey);
  const maxDaily = getMaxDailyTouches();
  const todayAnswers = (await getAnswersForUser(user.telegramId, user.language)).filter(
    (answer) => getLocalDateKey(new Date(answer.answeredAt)) === todayKey,
  );

  if (todayAnswers.length === 0) {
    const backlogLine =
      dailyState.backlog > 0
        ? t(
            user.language,
            `В очереди ещё ${dailyState.backlog} пропущенных вопросов дня — ответь на текущий и жми «Следующий вопрос».`,
            `Հերթում էլի կա ${dailyState.backlog} բաց թողնված օրվա հարց — պատասխանիր ընթացիկին և սեղմիր «Հաջորդ հարց»։`,
          )
        : "";
    return [
      t(
        user.language,
        "Итог дня: сегодня еще нет ответов. Следующий вопрос придет по расписанию или через /quiz.",
        "Օրվա ամփոփում․ այսօր դեռ պատասխաններ չկան։ Հաջորդ հարցը կգա ըստ ժամանակացույցի կամ /quiz-ով։",
      ),
      backlogLine,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  const correctCount = todayAnswers.filter((answer) => answer.isCorrect).length;
  const mistakeCount = todayAnswers.length - correctCount;
  const byTopic = new Map<TopicSlug, { total: number; mistakes: number }>();

  for (const answer of todayAnswers) {
    const stats = byTopic.get(answer.topicSlug) ?? { total: 0, mistakes: 0 };
    stats.total += 1;
    if (!answer.isCorrect) {
      stats.mistakes += 1;
    }
    byTopic.set(answer.topicSlug, stats);
  }

  const weakTopics = [...byTopic.entries()]
    .filter(([, stats]) => stats.mistakes > 0)
    .sort((a, b) => b[1].mistakes - a[1].mistakes || b[1].total - a[1].total)
    .slice(0, 3)
    .map(
      ([slug, stats]) =>
        `${getTopicMeta(slug).order}. ${getTopicTitle(slug, user.language)}: ${stats.mistakes}`,
    );

  const lines = [
    t(user.language, "Итог дня", "Օրվա ամփոփում"),
    `${t(user.language, "Вопросов дня получено", "Օրվա հարցեր ստացվել է")}: ${dailyState.sentCount}/${maxDaily}`,
    `${t(user.language, "Ответов", "Պատասխաններ")}: ${todayAnswers.length}`,
    `${t(user.language, "Верных", "Ճիշտ")}: ${correctCount}`,
    `${t(user.language, "Ошибок", "Սխալ")}: ${mistakeCount}`,
  ];

  if (dailyState.backlog > 0) {
    lines.push(
      t(
        user.language,
        `В очереди ещё ${dailyState.backlog} пропущенных — жми «Следующий вопрос» после объяснения.`,
        `Հերթում էլի կա ${dailyState.backlog} բաց թողնված — բացատրությունից հետո սեղմիր «Հաջորդ հարց»։`,
      ),
    );
  }

  if (weakTopics.length > 0) {
    lines.push(
      `${t(user.language, "Слабые темы сегодня", "Այսօրվա թույլ թեմաները")}:\n${weakTopics.join("\n")}`,
    );
  } else {
    lines.push(
      t(
        user.language,
        "Сегодня без ошибок или ошибки не выделяются по темам.",
        "Այսօր կամ սխալ չի եղել, կամ թեմաներով թույլ տեղ չի առանձնացել։",
      ),
    );
  }

  return lines.join("\n\n");
}

function buildTopicsKeyboard(): ReturnType<typeof Markup.inlineKeyboard> {
  const rows = TOPICS.map((topic) => [
    Markup.button.callback(`${topic.order}`, `topic|${topic.slug}`),
  ]);
  return Markup.inlineKeyboard(rows);
}

async function sendTopicsList(ctx: Context, user: UserRecord): Promise<void> {
  const lines = TOPICS.map((topic) => `${topic.order}. ${getTopicTitle(topic.slug, user.language)}`);
  const text = [
    t(user.language, "Темы:", "Թեմաներ՝"),
    "",
    ...lines,
    "",
    t(user.language, "Нажми номер темы ниже.", "Սեղմիր ներքևի թեմայի համարը։"),
  ].join("\n");

  log.info("handler", "topics_list_send", {
    telegramId: user.telegramId,
    language: user.language,
    topicCount: TOPICS.length,
  });

  await sendTextToChat(user.chatId, text, buildTopicsKeyboard(), ctx);
}

function buildQuestionKeyboard(question: QuizQuestion, sessionId: string) {
  const rows = question.options.map((option) => [
    Markup.button.callback(option.text, `answer|${sessionId}|${option.id}`),
  ]);
  return Markup.inlineKeyboard(rows);
}

function buildQuestionOptionsText(question: QuizQuestion): string {
  return question.options
    .map((option) => `${option.id}) ${option.text}`)
    .join("\n");
}

function buildFollowupKeyboard(language: LanguageCode, question: QuizQuestion) {
  const rows = [];
  const firstSignId = question.entityRefs.find((entry) => entry.type === "sign")?.ids[0];
  const firstTermSlug = question.entityRefs.find((entry) => entry.type === "term")?.ids[0];

  if (firstSignId) {
    rows.push([
      Markup.button.callback(
        t(language, `О знаке ${firstSignId}`, `Նշանի մասին ${firstSignId}`),
        `ref|sign|${firstSignId}`,
      ),
    ]);
  }

  if (firstTermSlug) {
    rows.push([
      Markup.button.callback(
        t(language, "О термине", "Տերմինի մասին"),
        `ref|term|${firstTermSlug}`,
      ),
    ]);
  }

  rows.push([
    Markup.button.callback(
      t(language, "Отметить ошибку", "Նշել սխալը"),
      `report|${question.key}`,
    ),
  ]);

  rows.push([
    Markup.button.callback(t(language, "Следующий вопрос", "Հաջորդ հարց"), "nav|next-quiz"),
  ]);

  return Markup.inlineKeyboard(rows);
}

function buildNextQuizKeyboard(language: LanguageCode) {
  return Markup.inlineKeyboard([
    Markup.button.callback(t(language, "Следующий вопрос", "Հաջորդ հարց"), "nav|next-quiz"),
  ]);
}

async function sendExplanationMessage(
  user: UserRecord,
  text: string,
  keyboard: ReturnType<typeof buildFollowupKeyboard>,
  ctx?: Context,
): Promise<number> {
  const replyMarkup = keyboard.reply_markup;
  log.info("answer", "send_explanation_keyboard", {
    telegramId: user.telegramId,
    rowCount: replyMarkup.inline_keyboard.length,
    buttonCount: replyMarkup.inline_keyboard.reduce((count, row) => count + row.length, 0),
  });
  return sendTextToChat(user.chatId, text, { reply_markup: replyMarkup }, ctx);
}

async function getQuestionStateMapForUser(user: UserRecord): Promise<Map<string, UserQuestionState>> {
  return new Map(
    (await getQuestionStatesForUser(user.telegramId)).map((state) => [state.questionKey, state]),
  );
}

async function getSessionsForUser(user: UserRecord): Promise<QuizSessionRecord[]> {
  return getQuizSessionsForUser(user.telegramId);
}

function buildDefaultFlow(telegramId: number): UserFlowRecord {
  return {
    telegramId,
    state: "idle",
    activeSessionId: undefined,
    activeQuestionMessageId: undefined,
    activeExplanationMessageId: undefined,
    updatedAt: nowIso(),
  };
}

async function normalizeUserFlow(user: UserRecord, flow: UserFlowRecord): Promise<UserFlowRecord> {
  log.debug("flow", "normalize_start", {
    telegramId: user.telegramId,
    state: flow.state,
    activeSessionId: flow.activeSessionId,
    updatedAt: flow.updatedAt,
  });

  if (flow.state === "idle") {
    log.debug("flow", "normalize_idle", { telegramId: user.telegramId });
    return flow;
  }

  if (!flow.activeSessionId) {
    log.warn("flow", "normalize_missing_session_reset", {
      telegramId: user.telegramId,
      state: flow.state,
    });
    await releaseUserFlow(user.telegramId);
    return buildDefaultFlow(user.telegramId);
  }

  const session = await getQuizSessionById(flow.activeSessionId);
  if (!session || session.telegramId !== user.telegramId) {
    log.warn("flow", "normalize_orphan_session_reset", {
      telegramId: user.telegramId,
      activeSessionId: flow.activeSessionId,
      sessionFound: Boolean(session),
      sessionTelegramId: session?.telegramId,
    });
    await releaseUserFlow(user.telegramId);
    return buildDefaultFlow(user.telegramId);
  }

  if (isFlowStale(flow, session)) {
    log.warn("flow", "normalize_stale_reset", {
      telegramId: user.telegramId,
      state: flow.state,
      activeSessionId: flow.activeSessionId,
      sessionStatus: session.status,
      updatedAt: flow.updatedAt,
      activeRound: isActiveLearningRound(flow, session),
    });
    await releaseUserFlow(user.telegramId);
    return buildDefaultFlow(user.telegramId);
  }

  if (flow.state === "question_open" && session.status === "answered") {
    if (flow.activeExplanationMessageId !== undefined) {
      const normalized: UserFlowRecord = {
        telegramId: user.telegramId,
        state: "explanation_shown",
        activeSessionId: session.id,
        activeQuestionMessageId: flow.activeQuestionMessageId,
        activeExplanationMessageId: flow.activeExplanationMessageId,
        updatedAt: nowIso(),
      };
      log.info("flow", "normalize_question_open_to_explanation", {
        telegramId: user.telegramId,
        sessionId: session.id,
        activeExplanationMessageId: flow.activeExplanationMessageId,
      });
      await setUserFlow(normalized);
      return normalized;
    }

    log.warn("flow", "normalize_answered_session_without_explanation_id", {
      telegramId: user.telegramId,
      sessionId: session.id,
      activeQuestionMessageId: flow.activeQuestionMessageId,
    });
    return flow;
  }

  log.debug("flow", "normalize_unchanged", {
    telegramId: user.telegramId,
    state: flow.state,
    sessionStatus: session.status,
  });
  return flow;
}

async function getFlowForUser(user: UserRecord): Promise<UserFlowRecord> {
  const flow = await getUserFlow(user.telegramId);
  return normalizeUserFlow(user, flow);
}

async function setFlowForUser(
  user: UserRecord,
  state: UserFlowRecord["state"],
  activeSessionId?: string,
  messageIds?: Pick<UserFlowRecord, "activeQuestionMessageId" | "activeExplanationMessageId">,
): Promise<void> {
  const current = await getUserFlow(user.telegramId);
  await setUserFlow({
    telegramId: user.telegramId,
    state,
    activeSessionId,
    activeQuestionMessageId: messageIds?.activeQuestionMessageId ?? current.activeQuestionMessageId,
    activeExplanationMessageId:
      messageIds?.activeExplanationMessageId ?? current.activeExplanationMessageId,
    updatedAt: nowIso(),
  });
}

function buildQuestionFlowBlockedText(user: UserRecord, state: UserFlowRecord["state"]): string {
  if (state === "question_open") {
    return t(
      user.language,
      "Сначала ответь на текущий вопрос.",
      "Սկզբում պատասխանիր ընթացիկ հարցին։",
    );
  }

  return t(
    user.language,
    "Сначала прочитай объяснение и потом нажми «Следующий вопрос».",
    "Սկզբում կարդա բացատրությունը, հետո սեղմիր «Հաջորդ հարց»։",
  );
}

function buildQuestionState(
  user: UserRecord,
  question: QuizQuestion,
  current: UserQuestionState | undefined,
  isCorrect: boolean,
): UserQuestionState {
  const now = new Date();
  const mistakeCount = isCorrect ? current?.mistakeCount ?? 0 : (current?.mistakeCount ?? 0) + 1;
  const correctStreak = isCorrect ? (current?.correctStreak ?? 0) + 1 : 0;

  let status: QuestionStatus;
  let nextReviewAt: string;

  if (!isCorrect) {
    status = "mistake";
    nextReviewAt = addHours(now, 6);
  } else if (correctStreak >= 3) {
    status = "mastered";
    nextReviewAt = addDays(now, 7);
  } else if ((current?.status ?? "new") === "new") {
    status = "learning";
    nextReviewAt = addDays(now, 1);
  } else {
    status = "repeat";
    nextReviewAt = addDays(now, 1);
  }

  return {
    telegramId: user.telegramId,
    questionKey: question.key,
    language: question.language,
    topicSlug: question.topicSlug,
    status,
    correctStreak,
    mistakeCount,
    lastSeenAt: nowIso(),
    nextReviewAt,
    lastAnswerCorrect: isCorrect,
    updatedAt: nowIso(),
  };
}

async function selectNextQuestion(
  user: UserRecord,
  mode: QuizMode,
  topicFilter?: TopicSlug,
): Promise<QuizQuestion | undefined> {
  log.info("quiz", "select_next_question_start", {
    telegramId: user.telegramId,
    language: user.language,
    mode,
    topicFilter,
  });

  const allQuestions = getQuestions(user.language).filter((question) =>
    topicFilter ? question.topicSlug === topicFilter : true,
  );
  if (allQuestions.length === 0) {
    log.warn("quiz", "select_next_question_empty_pool", {
      telegramId: user.telegramId,
      language: user.language,
      topicFilter,
    });
    return undefined;
  }

  const states = await getQuestionStateMapForUser(user);
  const sessions = await getSessionsForUser(user);
  const pendingKeys = new Set(
    sessions.filter((session) => session.status === "pending").map((session) => session.questionKey),
  );
  const todayKey = getLocalDateKey(new Date());
  const sentTodayKeys = new Set(
    sessions
      .filter((session) => getLocalDateKey(new Date(session.sentAt)) === todayKey)
      .map((session) => session.questionKey),
  );
  const now = new Date();

  const available = allQuestions.filter((question) => !pendingKeys.has(question.key));

  if (mode === "mistake") {
    const dueMistakes = available.filter((question) => {
      const state = states.get(question.key);
      return (
        state &&
        (state.status === "mistake" || state.status === "repeat" || state.status === "learning") &&
        isDue(state.nextReviewAt, now)
      );
    });

    const picked = pickRandom(dueMistakes);
    log.info("quiz", "select_next_question_mistake_mode", {
      telegramId: user.telegramId,
      dueMistakes: dueMistakes.length,
      pickedKey: picked?.key,
    });
    return picked;
  }

  const dueMistakes = available.filter((question) => {
    const state = states.get(question.key);
    return (
      state &&
      (state.status === "mistake" || state.status === "repeat") &&
      isDue(state.nextReviewAt, now) &&
      !sentTodayKeys.has(question.key)
    );
  });
  if (dueMistakes.length > 0) {
    const picked = pickRandom(dueMistakes);
    log.info("quiz", "select_next_question_due_mistakes", {
      telegramId: user.telegramId,
      count: dueMistakes.length,
      pickedKey: picked?.key,
    });
    return picked;
  }

  const dueLearning = available.filter((question) => {
    const state = states.get(question.key);
    return (
      state &&
      state.status === "learning" &&
      isDue(state.nextReviewAt, now) &&
      !sentTodayKeys.has(question.key)
    );
  });
  if (dueLearning.length > 0) {
    const picked = pickRandom(dueLearning);
    log.info("quiz", "select_next_question_due_learning", {
      telegramId: user.telegramId,
      count: dueLearning.length,
      pickedKey: picked?.key,
    });
    return picked;
  }

  const freshQuestions = available.filter((question) => !states.has(question.key) && !sentTodayKeys.has(question.key));
  if (freshQuestions.length > 0) {
    const picked = pickRandom(freshQuestions);
    log.info("quiz", "select_next_question_fresh", {
      telegramId: user.telegramId,
      count: freshQuestions.length,
      pickedKey: picked?.key,
    });
    return picked;
  }

  const unsentToday = available.filter((question) => !sentTodayKeys.has(question.key));
  if (unsentToday.length > 0) {
    const picked = pickRandom(unsentToday);
    log.info("quiz", "select_next_question_unsent_today", {
      telegramId: user.telegramId,
      count: unsentToday.length,
      pickedKey: picked?.key,
    });
    return picked;
  }

  const picked = pickRandom(available);
  log.info("quiz", "select_next_question_fallback", {
    telegramId: user.telegramId,
    available: available.length,
    pickedKey: picked?.key,
  });
  return picked;
}

function createSession(
  user: UserRecord,
  question: QuizQuestion,
  mode: QuizMode,
  sessionId?: string,
): QuizSessionRecord {
  return {
    id: sessionId ?? createSessionId(),
    telegramId: user.telegramId,
    chatId: user.chatId,
    questionKey: question.key,
    questionId: question.id,
    topicSlug: question.topicSlug,
    language: question.language,
    mode,
    status: "pending",
    sentAt: nowIso(),
  };
}

function buildQuestionText(
  question: QuizQuestion,
  language: LanguageCode,
  mode: QuizMode,
  topicFilter?: TopicSlug,
): string {
  const topicTitle = getTopicTitle(question.topicSlug, language);
  const prefix =
    mode === "mistake"
      ? t(language, "Повтор ошибки", "Սխալի կրկնություն")
      : mode === "daily"
        ? t(language, "Вопрос дня", "Օրվա հարց")
        : topicFilter
          ? t(language, "Вопрос по теме", "Հարց թեմայից")
          : t(language, "Вопрос", "Հարց");

  return [
    `${prefix}`,
    `${t(language, "Группа", "Խումբ")} ${getTopicMeta(question.topicSlug).order}: ${topicTitle}`,
    "",
    question.question,
    "",
    `${t(language, "Варианты", "Տարբերակներ")}:`,
    buildQuestionOptionsText(question),
  ].join("\n");
}

async function deliverQuestionMessage(
  user: UserRecord,
  question: QuizQuestion,
  session: QuizSessionRecord,
  mode: QuizMode,
  topicFilter?: TopicSlug,
  ctx?: Context,
  previousMessageIds?: PreviousQuizMessageIds,
): Promise<void> {
  const imagePath = resolveQuestionImagePath(question);
  const keyboard = buildQuestionKeyboard(question, session.id);
  const text = buildQuestionText(question, user.language, mode, topicFilter);
  const chatId = user.chatId;
  const targetChatId = resolveDeliveryChatId(ctx, chatId);
  const deliveryVia = "bot.telegram";

  log.info("delivery", "deliver_question_start", {
    telegramId: user.telegramId,
    chatId,
    targetChatId,
    sessionId: session.id,
    questionKey: question.key,
    hasImage: Boolean(imagePath),
    imagePath,
    deliveryVia,
    ctxChatId: ctx?.chat?.id,
    resolvedCtxChatId: ctx ? getChatId(ctx) : undefined,
    mode,
    topicFilter,
    textLength: text.length,
    previousQuestionMessageId: previousMessageIds?.question,
    previousExplanationMessageId: previousMessageIds?.explanation,
  });

  let questionMessageId: number | undefined;

  if (imagePath && text.length <= TELEGRAM_CAPTION_LIMIT) {
    try {
      log.debug("delivery", "send_photo_with_caption", {
        sessionId: session.id,
        imagePath,
        deliveryVia,
        targetChatId,
        textLength: text.length,
      });
      questionMessageId = await sendPhotoToChat(
        chatId,
        { source: imagePath },
        { caption: text, ...keyboard },
        ctx,
      );
      log.info("delivery", "deliver_question_done", {
        sessionId: session.id,
        via: `${deliveryVia}.sendPhoto+caption`,
        targetChatId,
        questionMessageId,
      });
    } catch (error) {
      log.error("delivery", "send_photo_with_caption_failed", error, {
        sessionId: session.id,
        questionKey: question.key,
        imagePath,
        targetChatId,
        textLength: text.length,
      });
    }
  } else if (imagePath) {
    log.warn("delivery", "caption_too_long_fallback_split", {
      sessionId: session.id,
      textLength: text.length,
      captionLimit: TELEGRAM_CAPTION_LIMIT,
    });
    try {
      await sendPhotoToChat(chatId, { source: imagePath }, undefined, ctx);
      log.info("delivery", "send_photo_done", { sessionId: session.id });
    } catch (error) {
      log.error("delivery", "send_photo_failed", error, {
        sessionId: session.id,
        questionKey: question.key,
        imagePath,
        targetChatId,
      });
    }
  } else {
    log.debug("delivery", "no_image", { sessionId: session.id, questionKey: question.key });
  }

  if (questionMessageId === undefined) {
    log.debug("delivery", "send_text", { sessionId: session.id, deliveryVia, targetChatId });
    try {
      questionMessageId = await sendTextToChat(chatId, text, keyboard, ctx);
      log.info("delivery", "deliver_question_done", {
        sessionId: session.id,
        via: `${deliveryVia}.sendMessage`,
        targetChatId,
        questionMessageId,
      });
    } catch (error) {
      log.error("delivery", "send_text_failed", error, {
        sessionId: session.id,
        questionKey: question.key,
        targetChatId,
      });
    }
  }

  if (questionMessageId === undefined) {
    throw new Error(`Failed to deliver question for session ${session.id}`);
  }

  await setUserFlow({
    telegramId: user.telegramId,
    state: "question_open",
    activeSessionId: session.id,
    activeQuestionMessageId: questionMessageId,
    activeExplanationMessageId: undefined,
    updatedAt: nowIso(),
  });

  await stripPreviousQuizMessages(chatId, previousMessageIds, ctx);
}

async function notifyQuizMessage(
  user: UserRecord,
  text: string,
  ctx?: Context,
): Promise<void> {
  const targetChatId = resolveDeliveryChatId(ctx, user.chatId);
  log.info("quiz", "notify_message", {
    telegramId: user.telegramId,
    chatId: user.chatId,
    targetChatId,
    deliveryVia: ctx ? "ctx.telegram" : "bot.telegram",
    textPreview: text.slice(0, 80),
  });

  await sendTextToChat(user.chatId, text, undefined, ctx);
}

async function resendPendingQuestion(
  user: UserRecord,
  sessionId: string,
  mode: QuizMode,
  topicFilter?: TopicSlug,
  ctx?: Context,
): Promise<boolean> {
  log.info("quiz", "resend_pending_start", {
    telegramId: user.telegramId,
    sessionId,
    mode,
    topicFilter,
    ctxChatId: ctx?.chat?.id,
  });

  const session = await getQuizSessionById(sessionId);
  if (!session || session.telegramId !== user.telegramId || session.status !== "pending") {
    log.warn("quiz", "resend_pending_skip", {
      telegramId: user.telegramId,
      sessionId,
      sessionFound: Boolean(session),
      sessionTelegramId: session?.telegramId,
      sessionStatus: session?.status,
    });
    return false;
  }

  const question = getQuestionByKey(session.questionKey);
  if (!question) {
    log.warn("quiz", "resend_pending_question_missing", {
      telegramId: user.telegramId,
      sessionId,
      questionKey: session.questionKey,
    });
    await deleteQuizSession(session.id);
    await releaseUserFlow(user.telegramId);
    return false;
  }

  try {
    const currentFlow = await getUserFlow(user.telegramId);
    await deliverQuestionMessage(user, question, session, session.mode, topicFilter, ctx, {
      question: currentFlow.activeQuestionMessageId,
      explanation: currentFlow.activeExplanationMessageId,
    });
    log.info("quiz", "resend_pending_done", { telegramId: user.telegramId, sessionId });
    return true;
  } catch (error) {
    log.error("quiz", "resend_pending_failed", error, {
      telegramId: user.telegramId,
      sessionId,
    });
    return false;
  }
}

async function handleDuplicateQuestionDelivery(
  user: UserRecord,
  mode: QuizMode,
  topicFilter: TopicSlug | undefined,
  ctx: Context | undefined,
): Promise<boolean> {
  const currentFlow = await getFlowForUser(user);
  if (currentFlow.state !== "question_open" || !currentFlow.activeSessionId) {
    return false;
  }

  if (isQuestionDelivered(currentFlow)) {
    log.info("quiz", "send_question_already_delivered", {
      telegramId: user.telegramId,
      activeSessionId: currentFlow.activeSessionId,
      questionMessageId: currentFlow.activeQuestionMessageId,
    });
    return true;
  }

  if (isDeliveryClaimed(currentFlow)) {
    const delivered = await waitForQuestionDelivery(
      user.telegramId,
      currentFlow.activeSessionId,
    );
    if (delivered) {
      log.info("quiz", "send_question_delivery_completed_while_waiting", {
        telegramId: user.telegramId,
        activeSessionId: delivered.activeSessionId,
        questionMessageId: delivered.activeQuestionMessageId,
      });
      return true;
    }
  }

  return resendPendingQuestion(user, currentFlow.activeSessionId, mode, topicFilter, ctx);
}

async function deliverClaimedQuestion(
  user: UserRecord,
  mode: QuizMode,
  topicFilter: TopicSlug | undefined,
  sessionId: string,
  ctx: Context | undefined,
  previousMessageIds: PreviousQuizMessageIds | undefined,
  startedAt: number,
  fromDailyBacklog = false,
): Promise<boolean> {
  try {
    const question = await selectNextQuestion(user, mode, topicFilter);
    if (!question) {
      log.warn("quiz", "send_question_no_question", {
        telegramId: user.telegramId,
        mode,
        topicFilter,
        sessionId,
      });
      await releaseUserFlow(user.telegramId);
      if (mode !== "daily") {
        await notifyQuizMessage(
          user,
          t(
            user.language,
            "Сейчас нет подходящих вопросов для отправки.",
            "Այս պահին ուղարկելու հարմար հարց չկա։",
          ),
          ctx,
        );
      }
      return false;
    }

    const session = createSession(user, question, mode, sessionId);
    log.info("quiz", "send_question_session_prepared", {
      telegramId: user.telegramId,
      sessionId,
      questionKey: question.key,
    });

    await createQuizSession(session);
    log.info("quiz", "send_question_session_created", { telegramId: user.telegramId, sessionId });

    await deliverQuestionMessage(
      user,
      question,
      session,
      mode,
      topicFilter,
      ctx,
      previousMessageIds,
    );
    log.info("quiz", "send_question_success", {
      telegramId: user.telegramId,
      sessionId,
      questionKey: question.key,
      durationMs: Date.now() - startedAt,
      fromDailyBacklog,
    });
    if (mode === "daily") {
      await recordDailyQuestionDelivered(
        user.telegramId,
        getLocalDateKey(new Date()),
        getMaxDailyTouches(),
        fromDailyBacklog,
      );
    }
    return true;
  } catch (error) {
    log.error("quiz", "send_question_failed", error, {
      telegramId: user.telegramId,
      sessionId,
      durationMs: Date.now() - startedAt,
    });
    await deleteQuizSession(sessionId).catch((cleanupError) => {
      log.error("quiz", "send_question_cleanup_session_failed", cleanupError, { sessionId });
    });
    await releaseUserFlow(user.telegramId);
    log.info("quiz", "send_question_flow_released_after_error", {
      telegramId: user.telegramId,
      sessionId,
    });

    if (mode !== "daily") {
      await notifyQuizMessage(
        user,
        t(
          user.language,
          "Не удалось отправить вопрос. Попробуй еще раз через /quiz.",
          "Չհաջողվեց ուղարկել հարցը։ Փորձիր կրկին /quiz հրամանով։",
        ),
        ctx,
      ).catch((notifyError) => {
        log.error("quiz", "send_question_notify_failure_failed", notifyError, {
          telegramId: user.telegramId,
        });
      });
    }

    return false;
  }
}

async function sendQuestion(
  user: UserRecord,
  mode: QuizMode,
  topicFilter?: TopicSlug,
  ctx?: Context,
  options?: SendQuestionOptions,
): Promise<boolean> {
  const startedAt = Date.now();
  log.info("quiz", "send_question_start", {
    telegramId: user.telegramId,
    chatId: user.chatId,
    mode,
    topicFilter,
    overrideFlow: options?.overrideFlow ?? false,
    ctxChatId: ctx?.chat?.id,
    updateId: ctx?.update.update_id,
  });

  if (!user.chatId) {
    log.error("quiz", "send_question_missing_chat_id", undefined, {
      telegramId: user.telegramId,
    });
    return false;
  }

  if (mode === "daily") {
    const dailyState = await getDailyTouchState(
      user.telegramId,
      getLocalDateKey(new Date()),
    );
    if (dailyState.sentCount >= getMaxDailyTouches()) {
      log.info("quiz", "send_question_daily_quota_full", {
        telegramId: user.telegramId,
        sentCount: dailyState.sentCount,
        maxDaily: getMaxDailyTouches(),
      });
      return false;
    }
  }

  let flow = await getFlowForUser(user);
  log.info("quiz", "send_question_flow_loaded", {
    telegramId: user.telegramId,
    state: flow.state,
    activeSessionId: flow.activeSessionId,
  });

  if (options?.overrideFlow && flow.state !== "idle") {
    await abandonActiveRound(user, flow, ctx);
    flow = await getFlowForUser(user);
    log.info("quiz", "send_question_flow_after_override", {
      telegramId: user.telegramId,
      state: flow.state,
    });
  }

  if (!options?.overrideFlow && flow.state === "question_open" && flow.activeSessionId) {
    if (isQuestionDelivered(flow)) {
      log.info("quiz", "send_question_skip_already_delivered", {
        telegramId: user.telegramId,
        activeSessionId: flow.activeSessionId,
        questionMessageId: flow.activeQuestionMessageId,
      });
      return finishDailySendAttempt(user, mode, true, true);
    }

    if (isDeliveryClaimed(flow)) {
      const delivered = await waitForQuestionDelivery(user.telegramId, flow.activeSessionId);
      if (delivered) {
        log.info("quiz", "send_question_waited_for_delivery", {
          telegramId: user.telegramId,
          activeSessionId: delivered.activeSessionId,
          questionMessageId: delivered.activeQuestionMessageId,
        });
        return finishDailySendAttempt(user, mode, true, true);
      }
    }

    log.info("quiz", "send_question_try_resend", {
      telegramId: user.telegramId,
      activeSessionId: flow.activeSessionId,
    });
    const resent = await resendPendingQuestion(
      user,
      flow.activeSessionId,
      mode,
      topicFilter,
      ctx,
    );
    if (resent) {
      log.info("quiz", "send_question_resend_success", {
        telegramId: user.telegramId,
        durationMs: Date.now() - startedAt,
      });
      return finishDailySendAttempt(user, mode, true, true);
    }
    log.warn("quiz", "send_question_resend_failed_continue", {
      telegramId: user.telegramId,
      activeSessionId: flow.activeSessionId,
    });
  }

  const previousMessageIds: PreviousQuizMessageIds | undefined =
    flow.state === "explanation_shown"
      ? {
          question: flow.activeQuestionMessageId,
          explanation: flow.activeExplanationMessageId,
        }
      : undefined;

  if (flow.state === "explanation_shown") {
    if (mode === "daily") {
      log.debug("quiz", "send_question_skip_daily_explanation_pending", {
        telegramId: user.telegramId,
        activeSessionId: flow.activeSessionId,
      });
      return finishDailySendAttempt(user, mode, false, true);
    }

    log.info("quiz", "send_question_from_explanation", {
      telegramId: user.telegramId,
      activeSessionId: flow.activeSessionId,
      previousQuestionMessageId: previousMessageIds?.question,
      previousExplanationMessageId: previousMessageIds?.explanation,
    });
  } else if (flow.state === "question_open") {
    log.warn("quiz", "send_question_blocked_open_question", {
      telegramId: user.telegramId,
      activeSessionId: flow.activeSessionId,
      mode,
    });
    if (mode !== "daily") {
      await notifyQuizMessage(user, buildQuestionFlowBlockedText(user, "question_open"), ctx);
    }
    return finishDailySendAttempt(user, mode, false, mode === "daily");
  } else if (flow.state !== "idle") {
    log.warn("quiz", "send_question_blocked_by_flow", {
      telegramId: user.telegramId,
      state: flow.state,
      activeSessionId: flow.activeSessionId,
      mode,
    });
    if (mode !== "daily") {
      await notifyQuizMessage(user, buildQuestionFlowBlockedText(user, flow.state), ctx);
    }
    return finishDailySendAttempt(user, mode, false, mode === "daily");
  }

  const sessionId = createSessionId();
  const claimed = await tryTransitionFlowToQuestion(user.telegramId, sessionId, nowIso());
  if (!claimed) {
    log.warn("quiz", "send_question_flow_claim_failed", {
      telegramId: user.telegramId,
      sessionId,
    });
    const duplicateHandled = await handleDuplicateQuestionDelivery(user, mode, topicFilter, ctx);
    if (duplicateHandled) {
      return finishDailySendAttempt(user, mode, true, true);
    }

    const currentFlow = await getFlowForUser(user);
    if (mode !== "daily") {
      await notifyQuizMessage(
        user,
        buildQuestionFlowBlockedText(user, currentFlow.state),
        ctx,
      );
    }
    return finishDailySendAttempt(user, mode, false, mode === "daily");
  }

  log.info("quiz", "send_question_flow_claimed", { telegramId: user.telegramId, sessionId });
  return deliverClaimedQuestion(
    user,
    mode,
    topicFilter,
    sessionId,
    ctx,
    previousMessageIds,
    startedAt,
    options?.fromDailyBacklog ?? false,
  );
}

function getOptionText(question: QuizQuestion, optionId: string | undefined): string {
  if (!optionId) {
    return "—";
  }

  return question.options.find((option) => option.id === optionId)?.text ?? optionId;
}

function buildAnswerExplanation(user: UserRecord, question: QuizQuestion, selectedOptionId: string): string {
  const isCorrect = selectedOptionId === question.correctOptionId;
  const lines = [
    isCorrect
      ? t(user.language, "Ответ верный.", "Պատասխանը ճիշտ է։")
      : t(user.language, "Ответ неверный.", "Պատասխանը սխալ է։"),
    `${t(user.language, "Выбрано", "Ընտրված է")}: ${getOptionText(question, selectedOptionId)}`,
    `${t(user.language, "Правильный ответ", "Ճիշտ պատասխանը")}: ${getOptionText(question, question.correctOptionId)}`,
  ];

  if (question.explanation.trim()) {
    lines.push(`${t(user.language, "Объяснение", "Բացատրություն")}: ${question.explanation.trim()}`);
  }

  if (question.comment.trim()) {
    lines.push(`${t(user.language, "Комментарий", "Մեկնաբանություն")}: ${question.comment.trim()}`);
  }

  return lines.join("\n\n");
}

async function buildProgressText(user: UserRecord): Promise<string> {
  const states = (await getQuestionStatesForUser(user.telegramId)).filter(
    (state) => state.language === user.language,
  );
  const answers = await getAnswersForUser(user.telegramId, user.language);
  const counts: Record<QuestionStatus, number> = {
    new: 0,
    learning: 0,
    mistake: 0,
    repeat: 0,
    mastered: 0,
  };

  for (const state of states) {
    counts[state.status] += 1;
  }

  const topicMistakes = new Map<TopicSlug, number>();
  for (const state of states) {
    if (state.mistakeCount > 0) {
      topicMistakes.set(state.topicSlug, (topicMistakes.get(state.topicSlug) ?? 0) + state.mistakeCount);
    }
  }

  const weakest = [...topicMistakes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([slug, count]) => `${getTopicMeta(slug).order}. ${getTopicTitle(slug, user.language)} (${count})`);

  return [
    `${t(user.language, "Язык", "Լեզու")}: ${user.language === "am" ? "Հայերեն" : "Русский"}`,
    `${t(user.language, "Всего ответов", "Պատասխանների ընդհանուր քանակ")}: ${answers.length}`,
    `${t(user.language, "Изучается", "Սովորում է")}: ${counts.learning}`,
    `${t(user.language, "На повторе", "Կրկնության մեջ")}: ${counts.repeat}`,
    `${t(user.language, "Ошибки", "Սխալներ")}: ${counts.mistake}`,
    `${t(user.language, "Освоено", "Յուրացված")}: ${counts.mastered}`,
    weakest.length > 0
      ? `${t(user.language, "Слабые темы", "Թույլ թեմաներ")}:\n${weakest.join("\n")}`
      : t(user.language, "Слабые темы пока не выделились.", "Թույլ թեմաներ դեռ չեն առանձնացել։"),
  ].join("\n\n");
}

function buildTopicOverview(topicSlug: TopicSlug, language: LanguageCode): string {
  const meta = getTopicMeta(topicSlug);
  const count = getQuestions(language).filter((question) => question.topicSlug === topicSlug).length;
  return [
    `${t(language, "Группа", "Խումբ")} ${meta.order}: ${meta.title[language]}`,
    `${t(language, "Вопросов", "Հարցերի քանակ")}: ${count}`,
  ].join("\n");
}

function getLocalizedSignTitle(sign: SignRecord | MarkingRecord, language: LanguageCode): string {
  return language === "am" ? sign.title_hy : sign.title_ru;
}

function getLocalizedSignMeaning(sign: SignRecord | MarkingRecord, language: LanguageCode): string {
  return language === "am" ? sign.meaning_hy ?? "" : sign.meaning_ru ?? "";
}

function isSignRecord(record: SignRecord | MarkingRecord): record is SignRecord {
  return record.type !== "marking";
}

function buildRelatedEntityKeyboard(
  record: SignRecord | MarkingRecord,
  language: LanguageCode,
) {
  const buttons = [];

  if (isSignRecord(record)) {
    for (const relatedId of record.relative_signs ?? []) {
      buttons.push([
        Markup.button.callback(
          t(language, `Связанный знак ${relatedId}`, `Կապված նշան ${relatedId}`),
          `ref|sign|${relatedId}`,
        ),
      ]);
    }

    for (const relatedId of record.relative_marks ?? []) {
      buttons.push([
        Markup.button.callback(
          t(language, `Связанная разметка ${relatedId}`, `Կապված գծանշում ${relatedId}`),
          `ref|sign|${relatedId}`,
        ),
      ]);
    }
  } else {
    for (const relatedId of record.relative_signs ?? []) {
      buttons.push([
        Markup.button.callback(
          t(language, `Связанный знак ${relatedId}`, `Կապված նշան ${relatedId}`),
          `ref|sign|${relatedId}`,
        ),
      ]);
    }
  }

  return buttons.length > 0 ? Markup.inlineKeyboard(buttons) : undefined;
}

function getLocalizedTermTitle(term: TermRecord, language: LanguageCode): string {
  return language === "am" ? term.term_hy : term.term_ru;
}

function getLocalizedTermDefinition(term: TermRecord, language: LanguageCode): string {
  return language === "am" ? term.definition_hy : term.definition_ru;
}

async function sendSignInfo(chatId: number, language: LanguageCode, query?: string): Promise<void> {
  const signs = getSigns();
  const markings = getMarkings();
  const pool = [...signs, ...markings];
  const normalized = query?.trim().toLowerCase();

  const record =
    (normalized &&
      pool.find(
        (item) =>
          item.id.toLowerCase() === normalized ||
          getLocalizedSignTitle(item, language).toLowerCase().includes(normalized),
      )) ||
    pickRandom(pool);

  if (!record) {
    await getBot().telegram.sendMessage(
      chatId,
      t(language, "Знаки пока не загружены.", "Նշանները դեռ բեռնված չեն։"),
    );
    return;
  }

  const titleLine = `${record.id} — ${getLocalizedSignTitle(record, language)}`;
  const text = [
    titleLine,
    getLocalizedSignMeaning(record, language),
    record.extra_info ? `${t(language, "Дополнительно", "Լրացուցիչ")}: ${record.extra_info}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const imagePath = resolveAssetImagePath(record.images?.[0]);
  const keyboard = buildRelatedEntityKeyboard(record, language);
  const keyboardExtra = keyboard ? { reply_markup: keyboard.reply_markup } : undefined;

  log.info("sign", "send_sign_info", {
    chatId,
    signId: record.id,
    hasImage: Boolean(imagePath),
    imagePath,
    textLength: text.length,
  });

  if (!imagePath) {
    log.warn("sign", "send_sign_info_image_missing", {
      chatId,
      signId: record.id,
      imageRef: record.images?.[0],
      cwd: process.cwd(),
    });
    await sendTextToChat(chatId, text, keyboardExtra);
    return;
  }

  try {
    await sendSignImageToChat(chatId, imagePath);
    await sendTextToChat(chatId, text, keyboardExtra);
  } catch (error) {
    log.error("sign", "send_sign_info_photo_failed", error, {
      chatId,
      signId: record.id,
      imagePath,
      cwd: process.cwd(),
    });
    await sendTextToChat(chatId, text, keyboardExtra);
  }
}

async function sendTermInfo(chatId: number, language: LanguageCode, query?: string): Promise<void> {
  const terms = getTerms();
  const normalized = query?.trim().toLowerCase();

  const term =
    (normalized &&
      terms.find(
        (item) =>
          item.slug.toLowerCase() === normalized ||
          getLocalizedTermTitle(item, language).toLowerCase().includes(normalized),
      )) ||
    pickRandom(terms);

  if (!term) {
    await getBot().telegram.sendMessage(
      chatId,
      t(language, "Термины пока не загружены.", "Տերմինները դեռ բեռնված չեն։"),
    );
    return;
  }

  const text = [
    getLocalizedTermTitle(term, language),
    getLocalizedTermDefinition(term, language),
    term.comment ? `${t(language, "Комментарий", "Մեկնաբանություն")}: ${term.comment}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  await getBot().telegram.sendMessage(chatId, text);
}

async function sendDailySummary(user: UserRecord): Promise<void> {
  await getBot().telegram.sendMessage(user.chatId, await buildDailySummaryText(user));
}

async function startErrorReportFlow(ctx: Context, questionKey: string): Promise<void> {
  const from = ctx.from;
  const chatId = getChatId(ctx);
  if (!from || !chatId) {
    await ctx.answerCbQuery();
    return;
  }

  const user = await upsertUser(from.id, chatId, from.first_name, from.username);
  user.pendingErrorReportQuestionKey = questionKey;
  user.updatedAt = nowIso();
  await updateUser(user);

  await ctx.answerCbQuery(
    t(user.language, "Жду описание ошибки", "Սպասում եմ սխալի նկարագրությանը"),
  );
  await ctx.reply(
    t(
      user.language,
      "Следующее сообщение я сохраню как репорт ошибки по этому вопросу.",
      "Հաջորդ հաղորդագրությունը կպահեմ որպես այս հարցի սխալի ռեպորտ։",
    ),
  );
}

async function maybeCaptureErrorReport(ctx: Context): Promise<boolean> {
  const from = ctx.from;
  const chatId = getChatId(ctx);
  const text = getTextMessage(ctx);
  if (!from || !chatId || !text) {
    return false;
  }

  const user = await upsertUser(from.id, chatId, from.first_name, from.username);
  if (!user.pendingErrorReportQuestionKey) {
    return false;
  }

  if (text.startsWith("/")) {
    return false;
  }

  const question = getQuestionByKey(user.pendingErrorReportQuestionKey);
  await appendErrorReport({
    telegramId: user.telegramId,
    chatId: user.chatId,
    language: user.language,
    questionKey: user.pendingErrorReportQuestionKey,
    questionId: question?.id,
    topicSlug: question?.topicSlug,
    text,
    createdAt: nowIso(),
  });

  user.pendingErrorReportQuestionKey = undefined;
  user.updatedAt = nowIso();
  await updateUser(user);

  const flow = await getFlowForUser(user);
  if (flow.activeExplanationMessageId !== undefined) {
    await stripMessageKeyboard(chatId, flow.activeExplanationMessageId, ctx);
  }

  const confirmationText = t(
    user.language,
    "Репорт сохранен. Спасибо, это поможет исправить вопрос.",
    "Ռեպորտը պահպանվեց։ Շնորհակալություն, սա կօգնի շտկել հարցը։",
  );
  const confirmationMessageId = await sendTextToChat(
    chatId,
    confirmationText,
    { reply_markup: buildNextQuizKeyboard(user.language).reply_markup },
    ctx,
  );

  if (flow.state === "explanation_shown" && flow.activeSessionId) {
    await setUserFlow({
      telegramId: user.telegramId,
      state: "explanation_shown",
      activeSessionId: flow.activeSessionId,
      activeQuestionMessageId: flow.activeQuestionMessageId,
      activeExplanationMessageId: confirmationMessageId,
      updatedAt: nowIso(),
    });
    log.info("report", "error_report_flow_handoff", {
      telegramId: user.telegramId,
      sessionId: flow.activeSessionId,
      previousExplanationMessageId: flow.activeExplanationMessageId,
      confirmationMessageId,
    });
  }

  return true;
}

async function answerQuestion(ctx: Context, sessionId: string, optionId: string): Promise<void> {
  log.info("answer", "answer_question_start", {
    ...describeCtx(ctx),
    sessionId,
    optionId,
  });

  const from = ctx.from;
  const chatId = getChatId(ctx);
  if (!from || !chatId) {
    log.warn("answer", "answer_question_missing_from_or_chat", describeCtx(ctx));
    await ctx.answerCbQuery();
    return;
  }

  const user = await upsertUser(from.id, chatId, from.first_name, from.username);
  const flow = await getFlowForUser(user);
  const session = await getQuizSessionById(sessionId);
  const callbackMessageId = getCallbackMessageId(ctx);
  const messageMatches =
    flow.activeQuestionMessageId === undefined ||
    callbackMessageId === flow.activeQuestionMessageId;

  if (
    flow.state !== "question_open" ||
    flow.activeSessionId !== sessionId ||
    !messageMatches
  ) {
    log.warn("answer", "answer_question_stale_flow", {
      telegramId: user.telegramId,
      sessionId,
      flowState: flow.state,
      activeSessionId: flow.activeSessionId,
      activeQuestionMessageId: flow.activeQuestionMessageId,
      callbackMessageId,
    });
    await rejectStaleCallback(ctx, user.language, `answer|${sessionId}|${optionId}`, "stale_answer");
    return;
  }

  if (!session || session.telegramId !== user.telegramId) {
    log.warn("answer", "answer_question_session_not_found", {
      telegramId: user.telegramId,
      sessionId,
      sessionFound: Boolean(session),
      sessionTelegramId: session?.telegramId,
    });
    await ctx.answerCbQuery(t(user.language, "Сессия не найдена", "Սեսիան չի գտնվել"));
    return;
  }

  if (session.status === "answered") {
    log.warn("answer", "answer_question_already_answered", {
      telegramId: user.telegramId,
      sessionId,
    });
    await ctx.answerCbQuery(t(user.language, "Ответ уже принят", "Պատասխանն արդեն ընդունված է"));
    return;
  }

  const question = getQuestionByKey(session.questionKey);
  if (!question) {
    log.warn("answer", "answer_question_not_found", {
      telegramId: user.telegramId,
      sessionId,
      questionKey: session.questionKey,
    });
    await ctx.answerCbQuery(t(user.language, "Вопрос не найден", "Հարցը չի գտնվել"));
    return;
  }

  const answeredAt = nowIso();
  const isCorrect = optionId === question.correctOptionId;
  const states = await getQuestionStateMapForUser(user);
  const nextState = buildQuestionState(user, question, states.get(question.key), isCorrect);
  const explanationText = buildAnswerExplanation(user, question, optionId);
  const followupKeyboard = buildFollowupKeyboard(user.language, question);

  await ctx.answerCbQuery(
    isCorrect
      ? t(user.language, "Верно", "Ճիշտ է")
      : t(user.language, "Неверно", "Սխալ է"),
  );

  let explanationMessageId: number;
  try {
    log.info("answer", "answer_question_send_explanation", {
      telegramId: user.telegramId,
      chatId: user.chatId,
      sessionId,
      questionMessageId: flow.activeQuestionMessageId,
      callbackMessageId,
      explanationLength: explanationText.length,
    });
    explanationMessageId = await sendExplanationMessage(
      user,
      explanationText,
      followupKeyboard,
      ctx,
    );
    log.info("answer", "answer_question_explanation_sent", {
      telegramId: user.telegramId,
      sessionId,
      isCorrect,
      explanationMessageId,
    });
  } catch (error) {
    log.error("answer", "answer_question_explanation_failed", error, {
      telegramId: user.telegramId,
      sessionId,
      chatId: user.chatId,
    });
    await notifyQuizMessage(
      user,
      t(
        user.language,
        "Не удалось отправить объяснение. Нажми на ответ ещё раз.",
        "Չհաջողվեց ուղարկել բացատրությունը։ Կրկին սեղմիր պատասխանը։",
      ),
      ctx,
    );
    return;
  }

  const flowUpdatedAt = nowIso();
  await setUserFlow({
    telegramId: user.telegramId,
    state: "explanation_shown",
    activeSessionId: sessionId,
    activeQuestionMessageId: flow.activeQuestionMessageId ?? callbackMessageId,
    activeExplanationMessageId: explanationMessageId,
    updatedAt: flowUpdatedAt,
  });
  log.info("answer", "answer_question_flow_updated", {
    telegramId: user.telegramId,
    sessionId,
    explanationMessageId,
  });

  log.info("answer", "answer_question_store_start", {
    telegramId: user.telegramId,
    sessionId,
    optionId,
    isCorrect,
    questionKey: question.key,
  });

  const stored = await completeQuizAnswer({
    answer: {
      telegramId: user.telegramId,
      questionKey: question.key,
      questionId: question.id,
      topicSlug: question.topicSlug,
      language: question.language,
      mode: session.mode,
      selectedOptionId: optionId,
      isCorrect,
      answeredAt,
    },
    nextState,
    selectedOptionId: optionId,
    answeredAt,
    isCorrect,
    sessionId: session.id,
    telegramId: user.telegramId,
  });

  if (!stored) {
    log.warn("answer", "answer_question_store_rejected", {
      telegramId: user.telegramId,
      sessionId,
      explanationMessageId,
    });
    return;
  }

  await clearQuestionAnswerKeyboard(ctx, chatId, flow.activeQuestionMessageId);

  log.info("answer", "answer_question_done", { telegramId: user.telegramId, sessionId, isCorrect });
}

function registerCommands(): void {
  if (commandsRegistered) {
    return;
  }

  commandsRegistered = true;

  getBot().on("text", async (ctx, next) => {
    const captured = await maybeCaptureErrorReport(ctx);
    if (captured) {
      return;
    }

    return next();
  });

  getBot().start(async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = await upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    await ctx.reply(
      [
        t(user.language, "Это новый бот-репетитор по ПДД Армении.", "Սա նոր ՊԴԴ ուսուցիչ-բոտն է Հայաստանի համար։"),
        t(
          user.language,
          "Он шлет 7 вопросов в день, дает объяснение и потом возвращает ошибки на повтор.",
          "Այն օրական ուղարկում է 7 հարց, տալիս է բացատրություն և հետո կրկին վերադարձնում է սխալները։",
        ),
        buildMainMenuText(user.language),
        "",
        t(user.language, "Можно сразу выбрать язык:", "Կարող ես անմիջապես ընտրել լեզուն՝"),
      ].join("\n\n"),
      Markup.inlineKeyboard([
        ...buildStartKeyboard(user.language).reply_markup.inline_keyboard,
        ...buildLanguageKeyboard().reply_markup.inline_keyboard,
      ]),
    );
  });

  getBot().command("settings", async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = await upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    await ctx.reply(
      t(user.language, "Выбери язык интерфейса и вопросов.", "Ընտրիր ինտերֆեյսի և հարցերի լեզուն։"),
      buildLanguageKeyboard(),
    );
  });

  getBot().command("language", async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = await upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    await ctx.reply(
      t(user.language, "Выбери язык.", "Ընտրիր լեզուն։"),
      buildLanguageKeyboard(),
    );
  });

  getBot().command("quiz", async (ctx) => {
    log.info("handler", "command_quiz_start", describeCtx(ctx));
    const from = ctx.from;
    if (!from) {
      log.warn("handler", "command_quiz_no_from", describeCtx(ctx));
      return;
    }

    const user = await upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    const sent = await sendQuestion(user, "manual", undefined, ctx, { overrideFlow: true });
    log.info("handler", "command_quiz_done", { telegramId: user.telegramId, sent });
  });

  getBot().command("mistakes", async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = await upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    await sendQuestion(user, "mistake", undefined, ctx, { overrideFlow: true });
  });

  getBot().command("catchup", async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = await upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    log.info("handler", "command_catchup_start", {
      telegramId: user.telegramId,
      chatId: user.chatId,
    });
    const result = await sendDailyCatchup(user, ctx);
    await replyDailyCatchupResult(user, result, ctx);
    log.info("handler", "command_catchup_done", {
      telegramId: user.telegramId,
      result,
    });
  });

  getBot().command("progress", async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = await upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    await ctx.reply(await buildProgressText(user));
  });

  getBot().command("topics", async (ctx) => {
    log.info("handler", "command_topics_start", describeCtx(ctx));
    const from = ctx.from;
    if (!from) {
      log.warn("handler", "command_topics_no_from", describeCtx(ctx));
      return;
    }

    const user = await upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    try {
      await sendTopicsList(ctx, user);
      log.info("handler", "command_topics_done", {
        telegramId: user.telegramId,
        language: user.language,
      });
    } catch (error) {
      log.error("handler", "command_topics_failed", error, {
        telegramId: user.telegramId,
        language: user.language,
      });
      await sendTextToChat(
        user.chatId,
        t(user.language, "Не удалось показать темы. Попробуй ещё раз.", "Չհաջողվեց ցույց տալ թեմաները։ Փորձիր կրկին։"),
        undefined,
        ctx,
      );
    }
  });

  getBot().command("sign", async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = await upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    await sendSignInfo(user.chatId, user.language, getCommandArg(ctx));
  });

  getBot().command("signs", async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = await upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    await sendSignInfo(user.chatId, user.language, getCommandArg(ctx));
  });

  getBot().command("term", async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = await upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    await sendTermInfo(user.chatId, user.language, getCommandArg(ctx));
  });

  getBot().command("stop", async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = await setSubscription(from.id, false);
    if (!user) {
      await ctx.reply("Use /start first.");
      return;
    }

    await ctx.reply(
      t(
        user.language,
        "Ежедневные вопросы остановлены. Вернуться можно через /start.",
        "Ամենօրյա հարցերը դադարեցված են։ Վերադառնալ կարելի է /start-ով։",
      ),
    );
  });

  getBot().action(/settings\|lang\|(am|ru)/, async (ctx) => {
    const from = ctx.from;
    const chatId = getChatId(ctx);
    if (!from || !chatId) {
      await ctx.answerCbQuery();
      return;
    }

    const [, language] = ctx.match;
    await upsertUser(from.id, chatId, from.first_name, from.username);
    await setUserLanguage(from.id, language as LanguageCode);
    await ctx.answerCbQuery(language === "am" ? "Լեզուն փոխվեց" : "Язык изменен");
    await ctx.reply(
      buildMainMenuText(language as LanguageCode),
      buildStartKeyboard(language as LanguageCode),
    );
  });

  getBot().action(/report\|(.+)/, async (ctx) => {
    const [, questionKey] = ctx.match;
    await startErrorReportFlow(ctx, questionKey);
  });

  getBot().action("menu|quiz", async (ctx) => {
    log.info("handler", "menu_quiz_start", describeCtx(ctx));
    const from = ctx.from;
    const chatId = getChatId(ctx);
    if (!from || !chatId) {
      log.warn("handler", "menu_quiz_missing_from_or_chat", describeCtx(ctx));
      await ctx.answerCbQuery();
      return;
    }

    const user = await upsertUser(from.id, chatId, from.first_name, from.username);
    log.info("handler", "menu_quiz_user_ready", {
      telegramId: user.telegramId,
      chatId: user.chatId,
      language: user.language,
    });
    const sent = await sendQuestion(user, "manual", undefined, ctx, { overrideFlow: true });
    await ctx.answerCbQuery();
    log.info("handler", "menu_quiz_done", {
      telegramId: user.telegramId,
      sent,
    });
  });

  getBot().action("menu|topics", async (ctx) => {
    log.info("handler", "menu_topics_start", describeCtx(ctx));
    const from = ctx.from;
    const chatId = getChatId(ctx);
    if (!from || !chatId) {
      await ctx.answerCbQuery();
      return;
    }

    const user = await upsertUser(from.id, chatId, from.first_name, from.username);
    try {
      await sendTopicsList(ctx, user);
      await ctx.answerCbQuery(t(user.language, "Показываю темы", "Ցույց եմ տալիս թեմաները"));
      log.info("handler", "menu_topics_done", {
        telegramId: user.telegramId,
        language: user.language,
      });
    } catch (error) {
      log.error("handler", "menu_topics_failed", error, {
        telegramId: user.telegramId,
        language: user.language,
      });
      await ctx.answerCbQuery(
        t(user.language, "Не удалось показать темы", "Չհաջողվեց ցույց տալ թեմաները"),
      );
    }
  });

  getBot().action("menu|mistakes", async (ctx) => {
    const from = ctx.from;
    const chatId = getChatId(ctx);
    if (!from || !chatId) {
      await ctx.answerCbQuery();
      return;
    }

    const user = await upsertUser(from.id, chatId, from.first_name, from.username);
    await sendQuestion(user, "mistake", undefined, ctx, { overrideFlow: true });
    await ctx.answerCbQuery();
  });

  getBot().action("menu|settings", async (ctx) => {
    const from = ctx.from;
    const chatId = getChatId(ctx);
    if (!from || !chatId) {
      await ctx.answerCbQuery();
      return;
    }

    const user = await upsertUser(from.id, chatId, from.first_name, from.username);
    await ctx.answerCbQuery(t(user.language, "Настройки", "Կարգավորումներ"));
    await ctx.reply(
      t(user.language, "Выбери язык интерфейса и вопросов.", "Ընտրիր ինտերֆեյսի և հարցերի լեզուն։"),
      buildLanguageKeyboard(),
    );
  });

  getBot().action("menu|sign", async (ctx) => {
    const from = ctx.from;
    const chatId = getChatId(ctx);
    if (!from || !chatId) {
      await ctx.answerCbQuery();
      return;
    }

    const user = await upsertUser(from.id, chatId, from.first_name, from.username);
    await ctx.answerCbQuery(t(user.language, "Показываю знак", "Ցույց եմ տալիս նշանը"));
    await sendSignInfo(chatId, user.language);
  });

  getBot().action("menu|term", async (ctx) => {
    const from = ctx.from;
    const chatId = getChatId(ctx);
    if (!from || !chatId) {
      await ctx.answerCbQuery();
      return;
    }

    const user = await upsertUser(from.id, chatId, from.first_name, from.username);
    await ctx.answerCbQuery(t(user.language, "Показываю термин", "Ցույց եմ տալիս տերմինը"));
    await sendTermInfo(chatId, user.language);
  });

  getBot().action(/answer\|([^|]+)\|([^|]+)/, async (ctx) => {
    const [, sessionId, optionId] = ctx.match;
    await answerQuestion(ctx, sessionId, optionId);
  });

  getBot().action("nav|next-quiz", async (ctx) => {
    log.info("handler", "nav_next_quiz_start", describeCtx(ctx));

    try {
      await ctx.answerCbQuery();
    } catch (error) {
      log.warn("handler", "nav_next_quiz_ack_failed", {
        ...describeCtx(ctx),
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const from = ctx.from;
    const chatId = getChatId(ctx);
    const callbackMessageId = getCallbackMessageId(ctx);
    if (!from || !chatId) {
      log.warn("handler", "nav_next_quiz_missing_from_or_chat", describeCtx(ctx));
      return;
    }

    const user = await upsertUser(from.id, chatId, from.first_name, from.username);
    if (user.pendingErrorReportQuestionKey) {
      user.pendingErrorReportQuestionKey = undefined;
      user.updatedAt = nowIso();
      await updateUser(user);
      log.info("handler", "nav_next_quiz_clear_pending_report", {
        telegramId: user.telegramId,
      });
    }

    let flow = await getFlowForUser(user);
    log.info("handler", "nav_next_quiz_flow", {
      telegramId: user.telegramId,
      state: flow.state,
      activeSessionId: flow.activeSessionId,
      activeQuestionMessageId: flow.activeQuestionMessageId,
      activeExplanationMessageId: flow.activeExplanationMessageId,
      callbackMessageId,
    });

    if (
      flow.activeExplanationMessageId !== undefined &&
      callbackMessageId !== undefined &&
      callbackMessageId !== flow.activeExplanationMessageId
    ) {
      log.info("handler", "nav_next_quiz_stale_explanation", {
        telegramId: user.telegramId,
        callbackMessageId,
        activeExplanationMessageId: flow.activeExplanationMessageId,
      });
      await notifyQuizMessage(
        user,
        buildCallbackRejectText(user.language, "stale_followup"),
        ctx,
      );
      return;
    }

    if (isQuestionDelivered(flow)) {
      log.info("handler", "nav_next_quiz_already_delivered", {
        telegramId: user.telegramId,
        questionMessageId: flow.activeQuestionMessageId,
      });
      return;
    }

    if (isDeliveryClaimed(flow) && flow.activeSessionId) {
      log.info("handler", "nav_next_quiz_wait_delivery", {
        telegramId: user.telegramId,
        activeSessionId: flow.activeSessionId,
      });
      const delivered = await waitForQuestionDelivery(user.telegramId, flow.activeSessionId);
      if (delivered) {
        log.info("handler", "nav_next_quiz_delivery_completed_while_waiting", {
          telegramId: user.telegramId,
          questionMessageId: delivered.activeQuestionMessageId,
        });
        return;
      }

      log.warn("handler", "nav_next_quiz_stuck_delivery_resend", {
        telegramId: user.telegramId,
        activeSessionId: flow.activeSessionId,
      });
      const resent = await resendPendingQuestion(
        user,
        flow.activeSessionId,
        "manual",
        undefined,
        ctx,
      );
      log.info("handler", "nav_next_quiz_resend_after_stuck", {
        telegramId: user.telegramId,
        resent,
      });
      if (!resent) {
        await notifyQuizMessage(
          user,
          t(
            user.language,
            "Не получилось отправить вопрос. Нажми «Следующий вопрос» ещё раз.",
            "Չհաջողվեց ուղարկել հարցը։ Սեղմիր «Հաջորդ հարց» կրկին։",
          ),
          ctx,
        );
      }
      return;
    }

    if (flow.state !== "explanation_shown") {
      log.warn("handler", "nav_next_quiz_wrong_flow_state", {
        telegramId: user.telegramId,
        state: flow.state,
      });
      await notifyQuizMessage(
        user,
        buildCallbackRejectText(
          user.language,
          flow.state === "question_open" ? "flow_not_ready" : "stale_followup",
        ),
        ctx,
      );
      return;
    }

    const completedSession = flow.activeSessionId
      ? await getQuizSessionById(flow.activeSessionId)
      : undefined;
    const dailyState = await getDailyTouchState(
      user.telegramId,
      getLocalDateKey(new Date()),
    );
    const catchUpDaily =
      completedSession?.mode === "daily" &&
      dailyState.backlog > 0 &&
      dailyState.sentCount < getMaxDailyTouches();

    log.info("handler", "nav_next_quiz_mode", {
      telegramId: user.telegramId,
      completedSessionMode: completedSession?.mode,
      catchUpDaily,
      dailyBacklog: dailyState.backlog,
      dailySentCount: dailyState.sentCount,
    });

    const sent = await sendQuestion(
      user,
      catchUpDaily ? "daily" : "manual",
      undefined,
      ctx,
      catchUpDaily ? { fromDailyBacklog: true } : undefined,
    );
    if (!sent) {
      await notifyQuizMessage(
        user,
        t(
          user.language,
          "Не получилось отправить вопрос. Нажми «Следующий вопрос» ещё раз.",
          "Չհաջողվեց ուղարկել հարցը։ Սեղմիր «Հաջորդ հարց» կրկին։",
        ),
        ctx,
      );
    }
    log.info("handler", "nav_next_quiz_done", { telegramId: user.telegramId, sent, catchUpDaily });
  });

  getBot().action(/topic\|(.+)/, async (ctx) => {
    const from = ctx.from;
    const chatId = getChatId(ctx);
    if (!from || !chatId) {
      await ctx.answerCbQuery();
      return;
    }

    const [, slug] = ctx.match;
    const topic = TOPICS.find((entry) => entry.slug === slug);
    if (!topic) {
      await ctx.answerCbQuery(t("ru", "Тема не найдена", "Թեման չի գտնվել"));
      return;
    }

    const user = await upsertUser(from.id, chatId, from.first_name, from.username);
    await ctx.answerCbQuery(getTopicTitle(topic.slug, user.language));
    await sendTextToChat(
      user.chatId,
      buildTopicOverview(topic.slug, user.language),
      Markup.inlineKeyboard([
        [Markup.button.callback(t(user.language, "Вопрос по теме", "Հարց թեմայից"), `topicquiz|${topic.slug}`)],
      ]),
      ctx,
    );
  });

  getBot().action(/topicquiz\|(.+)/, async (ctx) => {
    const from = ctx.from;
    const chatId = getChatId(ctx);
    if (!from || !chatId) {
      await ctx.answerCbQuery();
      return;
    }

    const [, slug] = ctx.match;
    const topic = TOPICS.find((entry) => entry.slug === slug);
    if (!topic) {
      await ctx.answerCbQuery(t("ru", "Тема не найдена", "Թեման չի գտնվել"));
      return;
    }

    const user = await upsertUser(from.id, chatId, from.first_name, from.username);
    await sendQuestion(user, "manual", topic.slug, ctx, { overrideFlow: true });
    await ctx.answerCbQuery();
  });

  getBot().action(/ref\|sign\|(.+)/, async (ctx) => {
    const from = ctx.from;
    const chatId = getChatId(ctx);
    if (!from || !chatId) {
      await ctx.answerCbQuery();
      return;
    }

    const [, signId] = ctx.match;
    const user = await upsertUser(from.id, chatId, from.first_name, from.username);
    await ctx.answerCbQuery();
    await sendSignInfo(chatId, user.language, signId);
  });

  getBot().action(/ref\|term\|(.+)/, async (ctx) => {
    const from = ctx.from;
    const chatId = getChatId(ctx);
    if (!from || !chatId) {
      await ctx.answerCbQuery();
      return;
    }

    const [, termSlug] = ctx.match;
    const user = await upsertUser(from.id, chatId, from.first_name, from.username);
    await ctx.answerCbQuery();
    await sendTermInfo(chatId, user.language, termSlug);
  });
}

function registerSchedules(): void {
  if (schedulesRegistered) {
    return;
  }

  schedulesRegistered = true;
  const lastScheduleIndex = Math.max(config.touchCrons.length - 1, 0);

  for (const [index, cronExpression] of config.touchCrons.entries()) {
    cron.schedule(
      cronExpression,
      async () => {
        for (const user of await getSubscribedUsers()) {
          try {
            await sendQuestion(user, "daily");
            if (index === lastScheduleIndex) {
              await sendDailySummary(user);
            }
          } catch (error) {
            log.error("cron", "local_schedule_user_failed", error, {
              telegramId: user.telegramId,
              scheduleIndex: index,
            });
          }
        }
      },
      { timezone: config.timezone },
    );
  }
}

export async function runScheduledTouch(slotIndex: number): Promise<void> {
  const lastScheduleIndex = Math.max(config.touchCrons.length - 1, 0);
  const users = await getSubscribedUsers();
  log.info("cron", "scheduled_touch_users", {
    slotIndex,
    userCount: users.length,
    isSummarySlot: slotIndex === lastScheduleIndex,
  });

  for (const user of users) {
    try {
      log.info("cron", "scheduled_touch_user_start", {
        slotIndex,
        telegramId: user.telegramId,
        chatId: user.chatId,
      });
      const sent = await sendQuestion(user, "daily");
      log.info("cron", "scheduled_touch_question_done", {
        slotIndex,
        telegramId: user.telegramId,
        sent,
      });
      if (slotIndex === lastScheduleIndex) {
        await sendDailySummary(user);
        log.info("cron", "scheduled_touch_summary_done", {
          slotIndex,
          telegramId: user.telegramId,
        });
      }
    } catch (error) {
      log.error("cron", "scheduled_touch_user_failed", error, {
        slotIndex,
        telegramId: user.telegramId,
      });
    }
  }
}

export function createBot(options?: { enableSchedules?: boolean }): Telegraf {
  const instance = getBot();

  if (!middlewareRegistered) {
    middlewareRegistered = true;

    instance.use(async (ctx, next) => {
      const callbackQuery = ctx.callbackQuery;
      const callbackData =
        callbackQuery && "data" in callbackQuery ? callbackQuery.data : undefined;

      if (callbackData && callbackData !== "nav|next-quiz") {
        const validation = await validateQuizCallback(ctx, callbackData);
        if (!validation.allowed) {
          await rejectStaleCallback(
            ctx,
            validation.language,
            callbackData,
            validation.rejectReason ?? "stale_followup",
          );
          return;
        }
      }

      return next();
    });

    instance.use(async (ctx, next) => {
      const startedAt = Date.now();
      const meta = describeCtx(ctx);
      log.info("bot", "update_enter", meta);
      try {
        await next();
        log.info("bot", "update_exit", {
          ...meta,
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        log.error("bot", "update_failed", error, {
          ...meta,
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    });
  }

  registerCommands();
  void registerBotCommandsMenu();
  if (options?.enableSchedules) {
    registerSchedules();
  }

  instance.catch((error: unknown, ctx: Context) => {
    log.error("bot", "unhandled_error", error, describeCtx(ctx));
  });

  // Direct Bot API calls — do not bundle sends into the webhook HTTP response (unreliable on Vercel).
  instance.telegram.webhookReply = false;

  return instance;
}
