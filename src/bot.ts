import { existsSync } from "node:fs";
import path from "node:path";

import cron from "node-cron";
import { Markup, Telegraf } from "telegraf";
import type { Context } from "telegraf";

import { config } from "./config.js";
import {
  appendAnswer,
  getAnswers,
  getLearningCards,
  getUsers,
  setSubscription,
  updateUser,
  upsertUser,
} from "./storage.js";
import type { AnswerMode, AnswerRecord, LearningCard, UserRecord } from "./types.js";

const bot = new Telegraf(config.botToken);

function getSubscribedUsers(): UserRecord[] {
  return getUsers().filter((user) => user.isSubscribed);
}

function getVisibleName(user: UserRecord): string {
  return user.firstName ?? user.username ?? "друг";
}

function getNextLessonCards(user: UserRecord): LearningCard[] {
  const cards = getLearningCards();
  if (cards.length === 0) {
    return [];
  }

  const start = user.lessonCursor % cards.length;
  const result: LearningCard[] = [];

  for (let i = 0; i < Math.min(config.lessonSize, cards.length); i += 1) {
    result.push(cards[(start + i) % cards.length]);
  }

  return result;
}

function advanceLessonCursor(user: UserRecord, step: number): void {
  const cards = getLearningCards();
  if (cards.length === 0) {
    return;
  }

  user.lessonCursor = (user.lessonCursor + step) % cards.length;
  user.updatedAt = new Date().toISOString();
  updateUser(user);
}

function getSeenCards(user: UserRecord): LearningCard[] {
  const cards = getLearningCards();
  const seenCount = Math.min(user.lessonCursor, cards.length);
  return cards.slice(0, Math.max(seenCount, 1));
}

function getLatestMistakeCards(user: UserRecord): LearningCard[] {
  const answers = getAnswers()
    .filter((answer) => answer.telegramId === user.telegramId && !answer.isCorrect)
    .sort((left, right) => right.answeredAt.localeCompare(left.answeredAt));

  const cardMap = new Map(getLearningCards().map((card) => [card.id, card]));
  const unique: LearningCard[] = [];
  const seen = new Set<string>();

  for (const answer of answers) {
    if (seen.has(answer.cardId)) {
      continue;
    }

    const card = cardMap.get(answer.cardId);
    if (card) {
      unique.push(card);
      seen.add(answer.cardId);
    }
  }

  return unique;
}

function getWeakTopics(user: UserRecord): string[] {
  const answers = getAnswers().filter((answer) => answer.telegramId === user.telegramId && !answer.isCorrect);
  const cardMap = new Map(getLearningCards().map((card) => [card.id, card]));
  const counters = new Map<string, number>();

  for (const answer of answers) {
    const card = cardMap.get(answer.cardId);
    if (!card) {
      continue;
    }

    counters.set(card.topic, (counters.get(card.topic) ?? 0) + 1);
  }

  return [...counters.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([topic]) => topic);
}

function getProgressText(user: UserRecord): string {
  const answers = getAnswers().filter((answer) => answer.telegramId === user.telegramId);
  const total = answers.length;
  const correct = answers.filter((answer) => answer.isCorrect).length;
  const mistakes = total - correct;
  const learned = Math.min(user.lessonCursor, getLearningCards().length);
  const lastMistakes = getLatestMistakeCards(user).slice(0, 3).map((card) => card.title);
  const weakTopics = getWeakTopics(user);

  const lines = [
    `Прогресс для ${getVisibleName(user)}:`,
    `Изучено карточек: ${learned}`,
    `Всего ответов: ${total}`,
    `Правильных ответов: ${correct}`,
    `Ошибок: ${mistakes}`,
  ];

  if (weakTopics.length > 0) {
    lines.push(`Слабые темы: ${weakTopics.join(", ")}`);
  }

  if (lastMistakes.length > 0) {
    lines.push(`Повторить: ${lastMistakes.join(", ")}`);
  }

  return lines.join("\n");
}

function buildLessonText(card: LearningCard, prefix?: string): string {
  const lines = [
    prefix ?? `${card.title}`,
    `Что это значит: ${card.whatItMeans}`,
    `Что делать: ${card.whatDriverMustDo}`,
    `Почему это важно: ${card.why}`,
  ];

  if (card.confusedWith) {
    lines.push(`Частая путаница: ${card.confusedWith}`);
  }

  if (card.difference) {
    lines.push(`Разница: ${card.difference}`);
  }

  if (card.memoryHook) {
    lines.push(`Как запомнить: ${card.memoryHook}`);
  }

  if (card.scenario) {
    lines.push(`На дороге: ${card.scenario}`);
  }

  return lines.join("\n");
}

async function sendCardText(chatId: number, card: LearningCard, text: string): Promise<void> {
  const imagePath = card.image ? path.resolve(process.cwd(), card.image) : "";

  if (imagePath && existsSync(imagePath)) {
    await bot.telegram.sendPhoto(chatId, { source: imagePath }, { caption: text });
    return;
  }

  await bot.telegram.sendMessage(chatId, text);
}

function buildQuizKeyboard(card: LearningCard, mode: AnswerMode) {
  return Markup.inlineKeyboard(
    card.options.map((option, index) =>
      Markup.button.callback(option, `answer|${mode}|${card.id}|${index}`),
    ),
    { columns: 1 },
  );
}

async function sendQuestion(chatId: number, card: LearningCard, mode: AnswerMode): Promise<void> {
  const text = [card.prompt, card.question].filter(Boolean).join("\n\n");
  const imagePath = card.image ? path.resolve(process.cwd(), card.image) : "";

  if (imagePath && existsSync(imagePath)) {
    await bot.telegram.sendPhoto(
      chatId,
      { source: imagePath },
      {
        caption: text,
        ...buildQuizKeyboard(card, mode),
      },
    );
    return;
  }

  await bot.telegram.sendMessage(chatId, text, buildQuizKeyboard(card, mode));
}

function pickDailyCard(user: UserRecord): LearningCard | undefined {
  const mistakeCard = getLatestMistakeCards(user)[0];
  if (mistakeCard) {
    return mistakeCard;
  }

  const seen = getSeenCards(user);
  if (seen.length === 0) {
    return getLearningCards()[0];
  }

  return seen[Math.floor(Math.random() * seen.length)];
}

function buildCorrectReply(card: LearningCard): string {
  const lines = [
    "✅ Верно.",
    `Правильный ответ: ${card.options[card.correctOption]}.`,
    `Что делать водителю: ${card.whatDriverMustDo}`,
    `Почему: ${card.why}`,
  ];

  if (card.memoryHook) {
    lines.push(`Как запомнить: ${card.memoryHook}`);
  }

  return lines.join("\n");
}

function buildWrongReply(card: LearningCard, selectedOption: number): string {
  const selectedText = card.options[selectedOption] ?? "вариант не найден";
  const lines = [
    "❌ Неверно.",
    `Ты выбрал: ${selectedText}.`,
    `Правильно: ${card.options[card.correctOption]}.`,
    `Что это значит: ${card.whatItMeans}`,
    `Что делать: ${card.whatDriverMustDo}`,
    `Почему это важно: ${card.why}`,
  ];

  if (card.confusedWith) {
    lines.push(`С чем путают: ${card.confusedWith}`);
  }

  if (card.difference) {
    lines.push(`Разница: ${card.difference}`);
  }

  if (card.memoryHook) {
    lines.push(`Как запомнить: ${card.memoryHook}`);
  }

  if (card.scenario) {
    lines.push(`Пример на дороге: ${card.scenario}`);
  }

  return lines.join("\n");
}

async function sendLesson(user: UserRecord): Promise<void> {
  const cards = getNextLessonCards(user);
  if (cards.length === 0) {
    await bot.telegram.sendMessage(user.chatId, "В базе пока нет учебных карточек. Заполните data/signs.json.");
    return;
  }

  await bot.telegram.sendMessage(
    user.chatId,
    `Урок дня: ${cards.length} новых карточки(ек).`,
  );

  for (const card of cards) {
    await sendCardText(user.chatId, card, buildLessonText(card, `Карточка ${card.id} — ${card.title}`));
  }

  advanceLessonCursor(user, cards.length);
}

async function sendDailyQuestion(user: UserRecord): Promise<void> {
  const card = pickDailyCard(user);
  if (!card) {
    await bot.telegram.sendMessage(user.chatId, "Пока нечего спрашивать: база карточек пуста.");
    return;
  }

  await sendQuestion(user.chatId, card, "daily");
}

async function sendMistakeReview(user: UserRecord): Promise<void> {
  const card = getLatestMistakeCards(user)[0];
  if (!card) {
    await bot.telegram.sendMessage(user.chatId, "Сегодня ошибок для повтора нет.");
    return;
  }

  await bot.telegram.sendMessage(user.chatId, "Повторим ошибку:");
  await sendQuestion(user.chatId, card, "mistake-review");
}

function registerCommands(): void {
  bot.start(async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    upsertUser(from.id, ctx.chat.id, from.first_name, from.username);

    await ctx.reply(
      [
        `Привет, ${from.first_name ?? "друг"}.`,
        "Это бот-репетитор по дорожным знакам Армении.",
        "Команды: /signs, /quiz, /mistakes, /progress, /stop.",
      ].join("\n"),
    );
  });

  bot.command("stop", async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = setSubscription(from.id, false);
    if (!user) {
      await ctx.reply("Сначала запустите бота через /start.");
      return;
    }

    await ctx.reply("Рассылка остановлена. Вернуться можно через /start.");
  });

  bot.command("signs", async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    await sendLesson(user);
  });

  bot.command("quiz", async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    await sendDailyQuestion(user);
  });

  bot.command("mistakes", async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    await sendMistakeReview(user);
  });

  bot.command("progress", async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    await ctx.reply(getProgressText(user));
  });

  bot.action(/answer\|(daily|mistake-review|manual|lesson-check)\|([^|]+)\|(\d+)/, async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    const [, mode, cardId, selected] = ctx.match;
    const selectedOption = Number(selected);
    const card = getLearningCards().find((entry) => entry.id === cardId);

    if (!card) {
      await ctx.answerCbQuery("Карточка не найдена.");
      return;
    }

    const isCorrect = selectedOption === card.correctOption;
    const answer: AnswerRecord = {
      telegramId: from.id,
      cardId: card.id,
      isCorrect,
      selectedOption,
      mode: mode as AnswerMode,
      answeredAt: new Date().toISOString(),
    };

    appendAnswer(answer);

    await ctx.answerCbQuery(isCorrect ? "Верно" : "Неверно");
    await ctx.editMessageReplyMarkup(undefined);
    await ctx.reply(isCorrect ? buildCorrectReply(card) : buildWrongReply(card, selectedOption));
  });
}

function registerSchedules(): void {
  cron.schedule(
    config.morningCron,
    async () => {
      for (const user of getSubscribedUsers()) {
        await sendLesson(user);
      }
    },
    { timezone: config.timezone },
  );

  cron.schedule(
    config.dayCron,
    async () => {
      for (const user of getSubscribedUsers()) {
        await sendDailyQuestion(user);
      }
    },
    { timezone: config.timezone },
  );

  cron.schedule(
    config.eveningCron,
    async () => {
      for (const user of getSubscribedUsers()) {
        await sendMistakeReview(user);
      }
    },
    { timezone: config.timezone },
  );
}

bot.catch((error: unknown, ctx: Context) => {
  console.error(`Bot error on update ${ctx.update.update_id}:`, error);
});

export function createBot(): Telegraf {
  registerCommands();
  registerSchedules();
  return bot;
}
