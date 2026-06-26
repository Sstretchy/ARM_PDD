import cron from "node-cron";
import { Markup, Telegraf } from "telegraf";
import type { Context } from "telegraf";

import { config } from "./config.js";
import { log } from "./logger.js";
import {
  appendErrorReport,
  completeQuizAnswer,
  createQuizSession,
  deleteQuizSession,
  getAnswersForUser,
  releaseProcessingLock,
  releaseUserFlow,
  tryAcquireProcessingLock,
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
  tryStartUserFlow,
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
let schedulesRegistered = false;
let middlewareRegistered = false;
const localProcessingUsers = new Set<number>();

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

async function acquireUserProcessing(telegramId: number, updateId: number): Promise<boolean> {
  if (localProcessingUsers.has(telegramId)) {
    log.debug("bot", "processing_lock_local_busy", { telegramId, updateId });
    return false;
  }

  const acquired = await tryAcquireProcessingLock(telegramId, updateId);
  if (!acquired) {
    return false;
  }

  localProcessingUsers.add(telegramId);
  return true;
}

async function releaseUserProcessing(telegramId: number, updateId: number): Promise<void> {
  localProcessingUsers.delete(telegramId);
  await releaseProcessingLock(telegramId, updateId);
}

async function rejectBusyUpdate(ctx: Context): Promise<void> {
  log.warn("bot", "update_ignored_busy", describeCtx(ctx));

  if (!ctx.callbackQuery) {
    return;
  }

  try {
    await ctx.answerCbQuery(
      t("ru", "Подожди, обрабатываю предыдущее действие…", "Մի վայրկյան սպասիր, նախորդ գործողությունը մշակվում է…"),
    );
  } catch (error) {
    log.warn("bot", "busy_callback_answer_failed", {
      ...describeCtx(ctx),
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
): Promise<void> {
  const targetChatId = resolveDeliveryChatId(ctx, chatId);
  if (ctx) {
    await ctx.telegram.sendMessage(targetChatId, text, extra);
    return;
  }

  await getBot().telegram.sendMessage(targetChatId, text, extra);
}

async function sendPhotoToChat(
  chatId: number,
  photo: { source: string },
  ctx?: Context,
): Promise<void> {
  const targetChatId = resolveDeliveryChatId(ctx, chatId);
  if (ctx) {
    await ctx.telegram.sendPhoto(targetChatId, photo);
    return;
  }

  await getBot().telegram.sendPhoto(targetChatId, photo);
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

function isFlowStale(flow: UserFlowRecord): boolean {
  if (flow.state === "idle") {
    return false;
  }

  const updatedAt = new Date(flow.updatedAt).getTime();
  if (Number.isNaN(updatedAt)) {
    return true;
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

function buildMainMenuText(language: LanguageCode): string {
  return [
    t(language, "Команды:", "Հրամաններ՝"),
    "/quiz",
    `/topics ${t(language, "— 10 групп вопросов", "— 10 հարցաշարային խմբեր")}`,
    `/sign ${t(language, "— случайный знак или разметка", "— նշան ըստ id կամ պատահական")}`,
    `/term ${t(language, "— случайный термин", "— տերմին ըստ slug կամ պատահական")}`,
    `/mistakes ${t(language, "— повтор ошибок", "— սխալների կրկնություն")}`,
    `/progress ${t(language, "— прогресс", "— առաջընթաց")}`,
    `/settings ${t(language, "— язык", "— լեզու")}`,
    "/stop",
  ].join("\n");
}

async function buildDailySummaryText(user: UserRecord): Promise<string> {
  const todayKey = getLocalDateKey(new Date());
  const todayAnswers = (await getAnswersForUser(user.telegramId, user.language)).filter(
    (answer) => getLocalDateKey(new Date(answer.answeredAt)) === todayKey,
  );

  if (todayAnswers.length === 0) {
    return t(
      user.language,
      "Итог дня: сегодня еще нет ответов. Следующий вопрос придет по расписанию или через /quiz.",
      "Օրվա ամփոփում․ այսօր դեռ պատասխաններ չկան։ Հաջորդ հարցը կգա ըստ ժամանակացույցի կամ /quiz-ով։",
    );
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
    `${t(user.language, "Ответов", "Պատասխաններ")}: ${todayAnswers.length}`,
    `${t(user.language, "Верных", "Ճիշտ")}: ${correctCount}`,
    `${t(user.language, "Ошибок", "Սխալ")}: ${mistakeCount}`,
  ];

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

  if (isFlowStale(flow)) {
    log.warn("flow", "normalize_stale_reset", {
      telegramId: user.telegramId,
      state: flow.state,
      activeSessionId: flow.activeSessionId,
      updatedAt: flow.updatedAt,
    });
    await releaseUserFlow(user.telegramId);
    return buildDefaultFlow(user.telegramId);
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

  if (flow.state === "question_open" && session.status === "answered") {
    const normalized: UserFlowRecord = {
      telegramId: user.telegramId,
      state: "explanation_shown",
      activeSessionId: session.id,
      updatedAt: nowIso(),
    };
    log.info("flow", "normalize_question_open_to_explanation", {
      telegramId: user.telegramId,
      sessionId: session.id,
    });
    await setUserFlow(normalized);
    return normalized;
  }

  if (flow.state === "explanation_shown" && session.status === "pending") {
    const normalized: UserFlowRecord = {
      telegramId: user.telegramId,
      state: "question_open",
      activeSessionId: session.id,
      updatedAt: nowIso(),
    };
    log.info("flow", "normalize_explanation_to_question_open", {
      telegramId: user.telegramId,
      sessionId: session.id,
    });
    await setUserFlow(normalized);
    return normalized;
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
): Promise<void> {
  await setUserFlow({
    telegramId: user.telegramId,
    state,
    activeSessionId,
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
): Promise<void> {
  const imagePath = resolveQuestionImagePath(question);
  const keyboard = buildQuestionKeyboard(question, session.id);
  const text = buildQuestionText(question, user.language, mode, topicFilter);
  const chatId = user.chatId;
  const targetChatId = resolveDeliveryChatId(ctx, chatId);
  const deliveryVia = ctx ? "ctx.telegram" : "bot.telegram";

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
  });

  if (imagePath) {
    try {
      log.debug("delivery", "send_photo", { sessionId: session.id, imagePath, deliveryVia, targetChatId });
      await sendPhotoToChat(chatId, { source: imagePath }, ctx);
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

  log.debug("delivery", "send_text", { sessionId: session.id, deliveryVia, targetChatId });
  await sendTextToChat(chatId, text, keyboard, ctx);
  log.info("delivery", "deliver_question_done", { sessionId: session.id, via: deliveryVia, targetChatId });
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
    await deliverQuestionMessage(user, question, session, session.mode, topicFilter, ctx);
    await setUserFlow({
      telegramId: user.telegramId,
      state: "question_open",
      activeSessionId: session.id,
      updatedAt: nowIso(),
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

async function sendQuestion(
  user: UserRecord,
  mode: QuizMode,
  topicFilter?: TopicSlug,
  ctx?: Context,
): Promise<boolean> {
  const startedAt = Date.now();
  log.info("quiz", "send_question_start", {
    telegramId: user.telegramId,
    chatId: user.chatId,
    mode,
    topicFilter,
    ctxChatId: ctx?.chat?.id,
    updateId: ctx?.update.update_id,
  });

  if (!user.chatId) {
    log.error("quiz", "send_question_missing_chat_id", undefined, {
      telegramId: user.telegramId,
    });
    return false;
  }

  const flow = await getFlowForUser(user);
  log.info("quiz", "send_question_flow_loaded", {
    telegramId: user.telegramId,
    state: flow.state,
    activeSessionId: flow.activeSessionId,
  });

  if (flow.state === "question_open" && flow.activeSessionId) {
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
      return true;
    }
    log.warn("quiz", "send_question_resend_failed_continue", {
      telegramId: user.telegramId,
      activeSessionId: flow.activeSessionId,
    });
  }

  if (flow.state === "explanation_shown") {
    if (mode === "daily") {
      log.debug("quiz", "send_question_skip_daily_explanation_pending", {
        telegramId: user.telegramId,
        activeSessionId: flow.activeSessionId,
      });
      return false;
    }

    log.info("quiz", "send_question_auto_release_explanation", {
      telegramId: user.telegramId,
      activeSessionId: flow.activeSessionId,
    });
    await releaseUserFlow(user.telegramId);
  } else if (flow.state === "question_open") {
    log.warn("quiz", "send_question_blocked_open_question", {
      telegramId: user.telegramId,
      activeSessionId: flow.activeSessionId,
      mode,
    });
    if (mode !== "daily") {
      await notifyQuizMessage(user, buildQuestionFlowBlockedText(user, "question_open"), ctx);
    }
    return false;
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
    return false;
  }

  const question = await selectNextQuestion(user, mode, topicFilter);
  if (!question) {
    log.warn("quiz", "send_question_no_question", {
      telegramId: user.telegramId,
      mode,
      topicFilter,
    });
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

  const sessionId = createSessionId();
  const session = createSession(user, question, mode, sessionId);
  let flowClaimed = false;

  log.info("quiz", "send_question_session_prepared", {
    telegramId: user.telegramId,
    sessionId,
    questionKey: question.key,
  });

  try {
    const claimed = await tryStartUserFlow(user.telegramId, sessionId, nowIso());
    if (!claimed) {
      log.warn("quiz", "send_question_flow_claim_failed", {
        telegramId: user.telegramId,
        sessionId,
      });
      const currentFlow = await getFlowForUser(user);
      log.info("quiz", "send_question_flow_after_failed_claim", {
        telegramId: user.telegramId,
        state: currentFlow.state,
        activeSessionId: currentFlow.activeSessionId,
      });
      if (currentFlow.state === "question_open" && currentFlow.activeSessionId) {
        return resendPendingQuestion(
          user,
          currentFlow.activeSessionId,
          mode,
          topicFilter,
          ctx,
        );
      }

      if (mode !== "daily") {
        await notifyQuizMessage(
          user,
          buildQuestionFlowBlockedText(user, currentFlow.state),
          ctx,
        );
      }
      return false;
    }

    flowClaimed = true;
    log.info("quiz", "send_question_flow_claimed", { telegramId: user.telegramId, sessionId });

    await createQuizSession(session);
    log.info("quiz", "send_question_session_created", { telegramId: user.telegramId, sessionId });

    await deliverQuestionMessage(user, question, session, mode, topicFilter, ctx);
    log.info("quiz", "send_question_success", {
      telegramId: user.telegramId,
      sessionId,
      questionKey: question.key,
      durationMs: Date.now() - startedAt,
    });
    return true;
  } catch (error) {
    log.error("quiz", "send_question_failed", error, {
      telegramId: user.telegramId,
      sessionId,
      flowClaimed,
      durationMs: Date.now() - startedAt,
    });
    await deleteQuizSession(sessionId).catch((cleanupError) => {
      log.error("quiz", "send_question_cleanup_session_failed", cleanupError, { sessionId });
    });

    if (flowClaimed) {
      await releaseUserFlow(user.telegramId);
      log.info("quiz", "send_question_flow_released_after_error", {
        telegramId: user.telegramId,
        sessionId,
      });
    }

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

  const text = [
    `${record.id} — ${getLocalizedSignTitle(record, language)}`,
    getLocalizedSignMeaning(record, language),
    record.extra_info ? `${t(language, "Дополнительно", "Լրացուցիչ")}: ${record.extra_info}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const imagePath = resolveAssetImagePath(record.images?.[0]);
  const keyboard = buildRelatedEntityKeyboard(record, language);
  if (imagePath) {
    await getBot().telegram.sendPhoto(chatId, { source: imagePath }, { caption: text, ...keyboard });
    return;
  }

  await getBot().telegram.sendMessage(chatId, text, keyboard);
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

  await ctx.reply(
    t(
      user.language,
      "Репорт сохранен. Спасибо, это поможет исправить вопрос.",
      "Ռեպորտը պահպանվեց։ Շնորհակալություն, սա կօգնի շտկել հարցը։",
    ),
  );

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
  const session = await getQuizSessionById(sessionId);
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
    });
    await ctx.answerCbQuery(t(user.language, "Ответ уже принят", "Պատասխանն արդեն ընդունված է"));
    return;
  }

  log.info("answer", "answer_question_stored", {
    telegramId: user.telegramId,
    sessionId,
    isCorrect,
  });

  const explanationText = buildAnswerExplanation(user, question, optionId);
  const followupKeyboard = buildFollowupKeyboard(user.language, question);

  await ctx.answerCbQuery(
    isCorrect
      ? t(user.language, "Верно", "Ճիշտ է")
      : t(user.language, "Неверно", "Սխալ է"),
  );

  try {
    log.info("answer", "answer_question_send_explanation", {
      telegramId: user.telegramId,
      chatId,
      targetChatId: resolveDeliveryChatId(ctx, chatId),
      sessionId,
    });
    await sendTextToChat(chatId, explanationText, followupKeyboard, ctx);
    log.info("answer", "answer_question_explanation_sent", {
      telegramId: user.telegramId,
      sessionId,
      isCorrect,
    });
  } catch (error) {
    log.error("answer", "answer_question_explanation_failed", error, {
      telegramId: user.telegramId,
      sessionId,
      chatId,
    });
  }

  void ctx
    .editMessageReplyMarkup(undefined)
    .then(() => {
      log.debug("answer", "answer_question_markup_cleared", { sessionId });
    })
    .catch((error: unknown) => {
      log.warn("answer", "answer_question_markup_clear_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

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
      ].join("\n\n"),
      buildStartKeyboard(user.language),
    );
    await ctx.reply(
      t(user.language, "Можно сразу выбрать язык.", "Կարող ես անմիջապես ընտրել լեզուն։"),
      buildLanguageKeyboard(),
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
    const sent = await sendQuestion(user, "manual", undefined, ctx);
    log.info("handler", "command_quiz_done", { telegramId: user.telegramId, sent });
  });

  getBot().command("mistakes", async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = await upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    await sendQuestion(user, "mistake", undefined, ctx);
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
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = await upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    const lines = TOPICS.map(
      (topic) => `${topic.order}. ${topic.title[user.language]}`,
    );
    await ctx.reply(lines.join("\n"), buildTopicsKeyboard());
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
    const sent = await sendQuestion(user, "manual", undefined, ctx);
    await ctx.answerCbQuery();
    log.info("handler", "menu_quiz_done", {
      telegramId: user.telegramId,
      sent,
    });
  });

  getBot().action("menu|topics", async (ctx) => {
    const from = ctx.from;
    const chatId = getChatId(ctx);
    if (!from || !chatId) {
      await ctx.answerCbQuery();
      return;
    }

    const user = await upsertUser(from.id, chatId, from.first_name, from.username);
    await ctx.answerCbQuery(t(user.language, "Показываю темы", "Ցույց եմ տալիս թեմաները"));
    const lines = TOPICS.map((topic) => `${topic.order}. ${topic.title[user.language]}`);
    await ctx.reply(lines.join("\n"), buildTopicsKeyboard());
  });

  getBot().action("menu|mistakes", async (ctx) => {
    const from = ctx.from;
    const chatId = getChatId(ctx);
    if (!from || !chatId) {
      await ctx.answerCbQuery();
      return;
    }

    const user = await upsertUser(from.id, chatId, from.first_name, from.username);
    await sendQuestion(user, "mistake", undefined, ctx);
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
    const from = ctx.from;
    const chatId = getChatId(ctx);
    if (!from || !chatId) {
      log.warn("handler", "nav_next_quiz_missing_from_or_chat", describeCtx(ctx));
      await ctx.answerCbQuery();
      return;
    }

    const user = await upsertUser(from.id, chatId, from.first_name, from.username);
    const flow = await getFlowForUser(user);
    log.info("handler", "nav_next_quiz_flow", {
      telegramId: user.telegramId,
      state: flow.state,
      activeSessionId: flow.activeSessionId,
    });
    if (flow.state === "question_open") {
      log.warn("handler", "nav_next_quiz_blocked", {
        telegramId: user.telegramId,
        state: flow.state,
      });
      await ctx.answerCbQuery(buildQuestionFlowBlockedText(user, flow.state));
      return;
    }

    await releaseUserFlow(user.telegramId);
    const sent = await sendQuestion(user, "manual", undefined, ctx);
    await ctx.answerCbQuery();
    log.info("handler", "nav_next_quiz_done", { telegramId: user.telegramId, sent });
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
      await ctx.answerCbQuery("Topic not found");
      return;
    }

    const user = await upsertUser(from.id, chatId, from.first_name, from.username);
    await ctx.answerCbQuery(topic.title[user.language]);
    await ctx.reply(buildTopicOverview(topic.slug, user.language), Markup.inlineKeyboard([
      [Markup.button.callback(t(user.language, "Вопрос по теме", "Հարց թեմայից"), `topicquiz|${topic.slug}`)],
    ]));
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
      await ctx.answerCbQuery("Topic not found");
      return;
    }

    const user = await upsertUser(from.id, chatId, from.first_name, from.username);
    await sendQuestion(user, "manual", topic.slug, ctx);
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
      const telegramId = ctx.from?.id;
      if (telegramId === undefined) {
        return next();
      }

      const updateId = ctx.update.update_id;
      const acquired = await acquireUserProcessing(telegramId, updateId);
      if (!acquired) {
        await rejectBusyUpdate(ctx);
        return;
      }

      try {
        await next();
      } finally {
        await releaseUserProcessing(telegramId, updateId);
      }
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
  if (options?.enableSchedules) {
    registerSchedules();
  }

  instance.catch((error: unknown, ctx: Context) => {
    log.error("bot", "unhandled_error", error, describeCtx(ctx));
  });
  return instance;
}
