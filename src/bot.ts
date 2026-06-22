import { existsSync } from "node:fs";
import path from "node:path";

import cron from "node-cron";
import { Markup, Telegraf } from "telegraf";
import type { Context } from "telegraf";

import { config } from "./config.js";
import {
  getConcepts,
  getFines,
  getSigns,
  getTopicRules,
  getTopicSections,
  getTopics,
  getUsers,
  setSubscription,
  updateUser,
  upsertUser,
} from "./storage.js";
import type {
  ConceptRecord,
  FineRecord,
  SignRecord,
  TopicRecord,
  TopicRuleRecord,
  TopicSection,
  UserRecord,
} from "./types.js";

const bot = new Telegraf(config.botToken);

function getSubscribedUsers(): UserRecord[] {
  return getUsers().filter((user) => user.isSubscribed);
}

function getVisibleName(user: UserRecord): string {
  return user.firstName ?? user.username ?? "друг";
}

function pickRandom<T>(items: T[]): T | undefined {
  if (items.length === 0) {
    return undefined;
  }

  return items[Math.floor(Math.random() * items.length)];
}

function incrementDeliveryCounter(user: UserRecord): void {
  user.lessonCursor += 1;
  user.updatedAt = new Date().toISOString();
  updateUser(user);
}

function getPrimaryImagePath(sign: SignRecord): string | undefined {
  const image = sign.images?.[0];
  if (!image) {
    return undefined;
  }

  const imagePath = path.resolve(process.cwd(), image);
  return existsSync(imagePath) ? imagePath : undefined;
}

function getPrimaryTopic(sign: SignRecord): TopicRecord | undefined {
  const topicId = sign.topicIds?.[0];
  if (!topicId) {
    return undefined;
  }

  return getTopics().find((topic) => topic.id === topicId);
}

function getTopicRule(topic: TopicRecord | undefined): TopicRuleRecord | undefined {
  if (!topic?.ruleIds?.length) {
    return undefined;
  }

  const rules = getTopicRules().filter((rule) => topic.ruleIds?.includes(rule.id));
  return pickRandom(rules);
}

function getTopicSection(topic: TopicRecord | undefined): TopicSection | undefined {
  if (!topic) {
    return undefined;
  }

  const record = getTopicSections().find((entry) => entry.topicId === topic.id);
  return pickRandom(record?.sections ?? []);
}

function getTopicFine(topic: TopicRecord | undefined): FineRecord | undefined {
  if (!topic?.fineIds?.length) {
    return undefined;
  }

  const fines = getFines().filter((fine) => topic.fineIds?.includes(fine.id));
  return pickRandom(fines);
}

function buildSignHeader(sign: SignRecord, topic: TopicRecord | undefined): string {
  const lines = [`${sign.id} — ${sign.title}`];

  if (topic) {
    lines.push(`Тема: ${topic.title}`);
  }

  return lines.join("\n");
}

function buildSignExplanation(
  sign: SignRecord,
  topic: TopicRecord | undefined,
  rule: TopicRuleRecord | undefined,
  section: TopicSection | undefined,
  fine: FineRecord | undefined,
): string {
  const lines = [`Что это: ${sign.comment || sign.title}.`];

  if (topic?.notes?.[0]) {
    lines.push(`Зачем это важно: ${topic.notes[0]}`);
  }

  if (rule) {
    lines.push(`Правило: ${rule.title}. ${rule.text}`);
  }

  if (section) {
    lines.push(`Нюанс: ${section.title}. ${section.text}`);
  }

  if (fine) {
    lines.push(`Штраф по теме: ${fine.title}. ${fine.penalty}`);
  }

  if (sign.relatedIds?.length) {
    lines.push(`Связанные знаки: ${sign.relatedIds.join(", ")}.`);
  }

  return lines.join("\n\n");
}

function buildMenuText(): string {
  return [
    "Команды бота:",
    "/signs — случайный знак",
    "/progress — краткий прогресс",
    "/stop — остановить рассылку",
  ].join("\n");
}

function getConceptsBySlugs(slugs: string[]): ConceptRecord[] {
  const concepts = getConcepts();
  return [...new Set(slugs)]
    .map((slug) => concepts.find((concept) => concept.slug === slug))
    .filter((concept): concept is ConceptRecord => Boolean(concept));
}

function getSignAndTopicConcepts(sign: SignRecord, topic: TopicRecord | undefined): ConceptRecord[] {
  const signSlugs = sign.conceptSlugs || [];
  const topicSlugs = topic?.conceptSlugs || [];
  return getConceptsBySlugs([...signSlugs, ...topicSlugs]);
}

function buildConceptText(concept: ConceptRecord): string {
  const lines = [concept.term, concept.definition];

  if (concept.comment) {
    lines.push(`Пояснение: ${concept.comment}`);
  }

  return lines.join("\n");
}

function buildConceptKeyboard(concept: ConceptRecord) {
  if ((concept.linkedSigns?.length ?? 0) === 0 || !concept.slug) {
    return undefined;
  }

  return Markup.inlineKeyboard([
    [Markup.button.callback("Показать знаки понятия", `nav|concept-signs|${concept.slug}`)],
  ]);
}

async function sendConceptMessages(chatId: number, concepts: ConceptRecord[], title?: string): Promise<void> {
  if (title) {
    await bot.telegram.sendMessage(chatId, title);
  }

  for (const concept of concepts) {
    const keyboard = buildConceptKeyboard(concept);
    if (keyboard) {
      await bot.telegram.sendMessage(chatId, buildConceptText(concept), keyboard);
      continue;
    }

    await bot.telegram.sendMessage(chatId, buildConceptText(concept));
  }
}

async function sendConceptLinkedSigns(chatId: number, concept: ConceptRecord): Promise<void> {
  const linkedWithImages = (concept.linkedSigns || []).filter((sign) => {
    const firstImage = sign.images?.[0];
    if (!firstImage) {
      return false;
    }

    const imagePath = path.resolve(process.cwd(), firstImage);
    return existsSync(imagePath);
  });

  if (linkedWithImages.length === 0) {
    await bot.telegram.sendMessage(chatId, "У этого понятия пока нет локальных картинок для связанных знаков.");
    return;
  }

  const lines = [`Знаки для понятия: ${concept.term}`];
  linkedWithImages.forEach((sign, index) => {
    lines.push(`${index + 1}. ${sign.id} — ${sign.title}`);
  });
  await bot.telegram.sendMessage(chatId, lines.join("\n"));

  await bot.telegram.sendMediaGroup(
    chatId,
    linkedWithImages.map((sign) => {
      const imagePath = path.resolve(process.cwd(), sign.images[0]);
      return {
        type: "photo" as const,
        media: { source: imagePath },
      };
    }),
  );
}

function buildSignKeyboard(sign: SignRecord, topic: TopicRecord | undefined) {
  const rows = [];

  if ((sign.relatedCards?.length ?? 0) > 0) {
    rows.push([Markup.button.callback("Показать знаки из объяснения", `nav|related|${sign.id}`)]);
  }

  if ((sign.conceptSlugs?.length ?? 0) > 0 || (topic?.conceptSlugs?.length ?? 0) > 0) {
    rows.push([Markup.button.callback("Показать понятия", `nav|concepts|${sign.id}`)]);
  }

  rows.push([
    Markup.button.callback("Меню", "nav|menu"),
    Markup.button.callback("Следующий знак", "nav|next-sign"),
  ]);

  return Markup.inlineKeyboard(rows);
}

function buildRelatedSignsText(sign: SignRecord): string {
  const lines = ["Знаки из объяснения:"];

  sign.relatedCards.forEach((card, index) => {
    lines.push(`${index + 1}. ${card.id}`);
  });

  return lines.join("\n");
}

async function sendRelatedSignsPreview(chatId: number, sign: SignRecord): Promise<void> {
  const relatedWithImages = (sign.relatedCards || []).filter((card) => {
    const firstImage = card.images?.[0];
    if (!firstImage) {
      return false;
    }

    const imagePath = path.resolve(process.cwd(), firstImage);
    return existsSync(imagePath);
  });

  if (relatedWithImages.length === 0) {
    await bot.telegram.sendMessage(chatId, "Для связанных знаков пока нет локальных картинок.");
    return;
  }

  await bot.telegram.sendMessage(chatId, buildRelatedSignsText({ ...sign, relatedCards: relatedWithImages }));

  await bot.telegram.sendMediaGroup(
    chatId,
    relatedWithImages.map((card) => {
      const imagePath = path.resolve(process.cwd(), card.images[0]);
      return {
        type: "photo" as const,
        media: { source: imagePath },
      };
    }),
  );
}

async function sendRandomSign(user: UserRecord): Promise<void> {
  const signs = getSigns();
  const sign = pickRandom(signs);

  if (!sign) {
    await bot.telegram.sendMessage(user.chatId, "В базе пока нет знаков.");
    return;
  }

  const topic = getPrimaryTopic(sign);
  const rule = getTopicRule(topic);
  const section = getTopicSection(topic);
  const fine = getTopicFine(topic);
  const header = buildSignHeader(sign, topic);
  const explanation = buildSignExplanation(sign, topic, rule, section, fine);
  const imagePath = getPrimaryImagePath(sign);

  if (imagePath) {
    await bot.telegram.sendPhoto(user.chatId, { source: imagePath }, { caption: header });
    await bot.telegram.sendMessage(user.chatId, explanation, buildSignKeyboard(sign, topic));
  } else {
    await bot.telegram.sendMessage(user.chatId, `${header}\n\n${explanation}`, buildSignKeyboard(sign, topic));
  }

  incrementDeliveryCounter(user);
}

function getProgressText(user: UserRecord): string {
  const topics = getTopics();
  const signs = getSigns();
  const lines = [
    `Прогресс для ${getVisibleName(user)}:`,
    `Отправлено карточек: ${user.lessonCursor}`,
    `Знаков в базе: ${signs.length}`,
    `Тем в базе: ${topics.length}`,
  ];

  const railwayTopic = topics.find((topic) => topic.id === "railway-crossings");
  if (railwayTopic) {
    lines.push(`Эталонная тема готова: ${railwayTopic.title}`);
  }

  return lines.join("\n");
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
        "Это MVP-бот по ПДД Армении.",
        "Сейчас он присылает случайный знак с кратким объяснением, темой и правилом.",
        "Команды: /signs, /progress, /stop.",
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
      await ctx.reply("Сначала запусти бота через /start.");
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
    await sendRandomSign(user);
  });

  bot.command("mistakes", async (ctx) => {
    await ctx.reply("Повтор ошибок пока не включен в этом MVP. Сейчас бот просто выдает случайные знаки с объяснениями.");
  });

  bot.command("progress", async (ctx) => {
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = upsertUser(from.id, ctx.chat.id, from.first_name, from.username);
    await ctx.reply(getProgressText(user));
  });

  bot.action("nav|menu", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(buildMenuText());
  });

  bot.action("nav|next-sign", async (ctx) => {
    const from = ctx.from;
    const chatId = ctx.chat?.id;
    if (!from || !chatId) {
      await ctx.answerCbQuery();
      return;
    }

    await ctx.answerCbQuery("Следующий знак");
    const user = upsertUser(from.id, chatId, from.first_name, from.username);
    await sendRandomSign(user);
  });

  bot.action(/nav\|related\|(.+)/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCbQuery();
      return;
    }

    const [, signId] = ctx.match;
    const sign = getSigns().find((entry) => entry.id === signId);
    if (!sign) {
      await ctx.answerCbQuery("Знак не найден");
      return;
    }

    await ctx.answerCbQuery("Показываю связанные знаки");
    await sendRelatedSignsPreview(chatId, sign);
  });

  bot.action(/nav\|concepts\|(.+)/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCbQuery();
      return;
    }

    const [, signId] = ctx.match;
    const sign = getSigns().find((entry) => entry.id === signId);
    if (!sign) {
      await ctx.answerCbQuery("Знак не найден");
      return;
    }

    const topic = getPrimaryTopic(sign);
    const concepts = getSignAndTopicConcepts(sign, topic);
    if (concepts.length === 0) {
      await ctx.answerCbQuery("Для этого знака понятия пока не заполнены");
      return;
    }

    await ctx.answerCbQuery("Показываю понятия");
    if (topic) {
      await sendConceptMessages(chatId, concepts, `Понятия темы: ${topic.title}`);
      return;
    }

    await sendConceptMessages(chatId, concepts, "Понятия для этого знака:");
  });

  bot.action(/nav\|concept-signs\|(.+)/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      await ctx.answerCbQuery();
      return;
    }

    const [, slug] = ctx.match;
    const concept = getConcepts().find((entry) => entry.slug === slug);
    if (!concept) {
      await ctx.answerCbQuery("Понятие не найдено");
      return;
    }

    await ctx.answerCbQuery("Показываю знаки понятия");
    await sendConceptLinkedSigns(chatId, concept);
  });
}

function registerSchedules(): void {
  for (const cronExpression of config.touchCrons) {
    cron.schedule(
      cronExpression,
      async () => {
      for (const user of getSubscribedUsers()) {
        await sendRandomSign(user);
      }
      },
      { timezone: config.timezone },
    );
  }
}

bot.catch((error: unknown, ctx: Context) => {
  console.error(`Bot error on update ${ctx.update.update_id}:`, error);
});

export function createBot(): Telegraf {
  registerCommands();
  registerSchedules();
  return bot;
}
