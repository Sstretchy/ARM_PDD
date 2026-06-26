import cron from "node-cron";
import { Markup, Telegraf } from "telegraf";
import type { Context } from "telegraf";

import { config } from "./config.js";
import {
  appendAnswer,
  appendErrorReport,
  createQuizSession,
  getAnswers,
  getMarkings,
  getQuestionByKey,
  getQuestionStates,
  getQuestions,
  getQuizSessionById,
  getQuizSessions,
  getSigns,
  getTerms,
  getUsers,
  resolveAssetImagePath,
  resolveQuestionImagePath,
  setSubscription,
  setUserLanguage,
  updateUser,
  updateQuizSession,
  upsertQuestionState,
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
  UserQuestionState,
  UserRecord,
} from "./types.js";

let bot: Telegraf | undefined;
let commandsRegistered = false;
let schedulesRegistered = false;

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
  const todayAnswers = (await getAnswers()).filter(
    (answer) =>
      answer.telegramId === user.telegramId &&
      answer.language === user.language &&
      getLocalDateKey(new Date(answer.answeredAt)) === todayKey,
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

async function getQuestionStatesForUser(user: UserRecord): Promise<Map<string, UserQuestionState>> {
  return new Map(
    (await getQuestionStates())
      .filter((state) => state.telegramId === user.telegramId)
      .map((state) => [state.questionKey, state]),
  );
}

async function getSessionsForUser(user: UserRecord): Promise<QuizSessionRecord[]> {
  return (await getQuizSessions()).filter((session) => session.telegramId === user.telegramId);
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
  const allQuestions = getQuestions(user.language).filter((question) =>
    topicFilter ? question.topicSlug === topicFilter : true,
  );
  if (allQuestions.length === 0) {
    return undefined;
  }

  const states = await getQuestionStatesForUser(user);
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

    return pickRandom(dueMistakes);
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
    return pickRandom(dueMistakes);
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
    return pickRandom(dueLearning);
  }

  const freshQuestions = available.filter((question) => !states.has(question.key) && !sentTodayKeys.has(question.key));
  if (freshQuestions.length > 0) {
    return pickRandom(freshQuestions);
  }

  const unsentToday = available.filter((question) => !sentTodayKeys.has(question.key));
  if (unsentToday.length > 0) {
    return pickRandom(unsentToday);
  }

  return pickRandom(available);
}

function createSession(user: UserRecord, question: QuizQuestion, mode: QuizMode): QuizSessionRecord {
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
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

function buildQuestionText(question: QuizQuestion, language: LanguageCode, mode: QuizMode): string {
  const topicTitle = getTopicTitle(question.topicSlug, language);
  const prefix =
    mode === "mistake"
      ? t(language, "Повтор ошибки", "Սխալի կրկնություն")
      : t(language, "Вопрос дня", "Օրվա հարց");

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

async function sendQuestion(user: UserRecord, mode: QuizMode, topicFilter?: TopicSlug): Promise<boolean> {
  const question = await selectNextQuestion(user, mode, topicFilter);
  if (!question) {
    await getBot().telegram.sendMessage(
      user.chatId,
      t(
        user.language,
        "Сейчас нет подходящих вопросов для отправки.",
        "Այս պահին ուղարկելու հարմար հարց չկա։",
      ),
    );
    return false;
  }

  const session = createSession(user, question, mode);
  await createQuizSession(session);

  const imagePath = resolveQuestionImagePath(question);
  const keyboard = buildQuestionKeyboard(question, session.id);
  const text = buildQuestionText(question, user.language, mode);

  if (imagePath) {
    await getBot().telegram.sendPhoto(user.chatId, { source: imagePath }, { caption: text, ...keyboard });
  } else {
    await getBot().telegram.sendMessage(user.chatId, text, keyboard);
  }

  return true;
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
  const states = (await getQuestionStates())
    .filter((state) => state.telegramId === user.telegramId && state.language === user.language);
  const answers = (await getAnswers()).filter((answer) => answer.telegramId === user.telegramId && answer.language === user.language);
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
    `${getLocalizedTermTitle(term, language)} (${term.slug})`,
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
  const chatId = ctx.chat?.id;
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
  const chatId = ctx.chat?.id;
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
  const from = ctx.from;
  const chatId = ctx.chat?.id;
  if (!from || !chatId) {
    await ctx.answerCbQuery();
    return;
  }

  const user = await upsertUser(from.id, chatId, from.first_name, from.username);
  const session = await getQuizSessionById(sessionId);
  if (!session || session.telegramId !== user.telegramId) {
    await ctx.answerCbQuery(t(user.language, "Сессия не найдена", "Սեսիան չի գտնվել"));
    return;
  }

  if (session.status === "answered") {
    await ctx.answerCbQuery(t(user.language, "Ответ уже принят", "Պատասխանը արդեն ընդունված է"));
    return;
  }

  const question = getQuestionByKey(session.questionKey);
  if (!question) {
    await ctx.answerCbQuery(t(user.language, "Вопрос не найден", "Հարցը չի գտնվել"));
    return;
  }

  session.status = "answered";
  session.answeredAt = nowIso();
  session.selectedOptionId = optionId;
  session.isCorrect = optionId === question.correctOptionId;
  await updateQuizSession(session);

  await appendAnswer({
    telegramId: user.telegramId,
    questionKey: question.key,
    questionId: question.id,
    topicSlug: question.topicSlug,
    language: question.language,
    mode: session.mode,
    selectedOptionId: optionId,
    isCorrect: session.isCorrect,
    answeredAt: session.answeredAt,
  });

  const states = await getQuestionStatesForUser(user);
  const nextState = buildQuestionState(user, question, states.get(question.key), session.isCorrect);
  await upsertQuestionState(nextState);

  await ctx.answerCbQuery(
    session.isCorrect
      ? t(user.language, "Верно", "Ճիշտ է")
      : t(user.language, "Неверно", "Սխալ է"),
  );

  try {
    await ctx.editMessageReplyMarkup(undefined);
  } catch {
    // Ignore markup edit failures for old messages.
  }

  await getBot().telegram.sendMessage(
    chatId,
    buildAnswerExplanation(user, question, optionId),
    buildFollowupKeyboard(user.language, question),
  );
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
          "Он шлет 7 вопросов в день, принимает ответы кнопками, дает объяснение и потом возвращает ошибки на повтор.",
          "Այն օրական ուղարկում է 7 հարց, ընդունում է պատասխանները կոճակներով, տալիս է բացատրություն և հետո կրկին վերադարձնում է սխալները։",
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
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = await upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    await sendQuestion(user, "manual");
  });

  getBot().command("mistakes", async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = await upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    await sendQuestion(user, "mistake");
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
    const chatId = ctx.chat?.id;
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
    const from = ctx.from;
    const chatId = ctx.chat?.id;
    if (!from || !chatId) {
      await ctx.answerCbQuery();
      return;
    }

    const user = await upsertUser(from.id, chatId, from.first_name, from.username);
    await ctx.answerCbQuery(t(user.language, "Открываю квиз", "Բացում եմ քուիզը"));
    await sendQuestion(user, "manual");
  });

  getBot().action("menu|topics", async (ctx) => {
    const from = ctx.from;
    const chatId = ctx.chat?.id;
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
    const chatId = ctx.chat?.id;
    if (!from || !chatId) {
      await ctx.answerCbQuery();
      return;
    }

    const user = await upsertUser(from.id, chatId, from.first_name, from.username);
    await ctx.answerCbQuery(t(user.language, "Проверяю ошибки", "Ստուգում եմ սխալները"));
    await sendQuestion(user, "mistake");
  });

  getBot().action("menu|settings", async (ctx) => {
    const from = ctx.from;
    const chatId = ctx.chat?.id;
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
    const chatId = ctx.chat?.id;
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
    const chatId = ctx.chat?.id;
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
    const from = ctx.from;
    const chatId = ctx.chat?.id;
    if (!from || !chatId) {
      await ctx.answerCbQuery();
      return;
    }

    const user = await upsertUser(from.id, chatId, from.first_name, from.username);
    await ctx.answerCbQuery(
      t(user.language, "Следующий вопрос", "Հաջորդ հարց"),
    );
    await sendQuestion(user, "manual");
  });

  getBot().action(/topic\|(.+)/, async (ctx) => {
    const from = ctx.from;
    const chatId = ctx.chat?.id;
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
    const chatId = ctx.chat?.id;
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
    await ctx.answerCbQuery(
      t(user.language, "Отправляю вопрос", "Ուղարկում եմ հարց"),
    );
    await sendQuestion(user, "manual", topic.slug);
  });

  getBot().action(/ref\|sign\|(.+)/, async (ctx) => {
    const from = ctx.from;
    const chatId = ctx.chat?.id;
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
    const chatId = ctx.chat?.id;
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
            console.error(`Failed to send scheduled question to ${user.telegramId}:`, error);
          }
        }
      },
      { timezone: config.timezone },
    );
  }
}

export async function runScheduledTouch(slotIndex: number): Promise<void> {
  const lastScheduleIndex = Math.max(config.touchCrons.length - 1, 0);

  for (const user of await getSubscribedUsers()) {
    try {
      await sendQuestion(user, "daily");
      if (slotIndex === lastScheduleIndex) {
        await sendDailySummary(user);
      }
    } catch (error) {
      console.error(`Failed to send scheduled question to ${user.telegramId}:`, error);
    }
  }
}

export function createBot(options?: { enableSchedules?: boolean }): Telegraf {
  registerCommands();
  if (options?.enableSchedules) {
    registerSchedules();
  }
  const instance = getBot();
  instance.catch((error: unknown, ctx: Context) => {
    console.error(`Bot error on update ${ctx.update.update_id}:`, error);
  });
  return instance;
}
