import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { InArgs } from "@libsql/client/node";

import { db } from "./db.js";
import { log } from "./logger.js";
import type {
  AnswerRecord,
  ErrorReportRecord,
  LanguageCode,
  MarkingRecord,
  QuizQuestion,
  QuizSessionRecord,
  SignRecord,
  TermRecord,
  TopicSlug,
  UserFlowRecord,
  UserQuestionState,
  UserRecord,
} from "./types.js";

const dataDir = path.resolve(process.cwd(), "data");
const usersPath = path.join(dataDir, "users.json");
const answersPath = path.join(dataDir, "answers.json");
const errorReportsPath = path.join(dataDir, "error-reports.json");
const questionStatesPath = path.join(dataDir, "question-progress.json");
const quizSessionsPath = path.join(dataDir, "quiz-sessions.json");
const signsPath = path.join(dataDir, "signs.json");
const termsPath = path.join(dataDir, "terms.json");
const markingPath = path.join(dataDir, "marking.json");
const drvTopicsRoot = path.join(dataDir, "drv-topics");

type LegacyUserRecord = UserRecord & {
  lessonCursor?: number;
};

type RowValue = string | number | bigint | Uint8Array | null;
type RowMap = Record<string, RowValue>;

let initPromise: Promise<void> | undefined;

function ensureDataDir(): void {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) {
    return fallback;
  }

  const raw = readFileSync(filePath, "utf-8").trim();
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.error(`Failed to parse JSON file ${filePath}, using fallback:`, error);
    return fallback;
  }
}

function writeJsonFile<T>(filePath: string, data: T): void {
  ensureDataDir();
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function normalizeUser(user: LegacyUserRecord): UserRecord {
  return {
    telegramId: user.telegramId,
    chatId: user.chatId,
    firstName: user.firstName,
    username: user.username,
    language: user.language ?? "ru",
    isSubscribed: user.isSubscribed ?? true,
    pendingErrorReportQuestionKey: user.pendingErrorReportQuestionKey,
    createdAt: user.createdAt ?? new Date().toISOString(),
    updatedAt: user.updatedAt ?? new Date().toISOString(),
  };
}

function getRowNumber(row: RowMap, key: string): number {
  const value = row[key];
  if (typeof value === "bigint") {
    return Number(value);
  }

  return Number(value ?? 0);
}

function getRowString(row: RowMap, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  return Buffer.from(value).toString("utf-8");
}

function getRowBoolean(row: RowMap, key: string): boolean {
  return getRowNumber(row, key) === 1;
}

function mapUser(row: RowMap): UserRecord {
  return {
    telegramId: getRowNumber(row, "telegram_id"),
    chatId: getRowNumber(row, "chat_id"),
    firstName: getRowString(row, "first_name"),
    username: getRowString(row, "username"),
    language: (getRowString(row, "language") as LanguageCode | undefined) ?? "ru",
    isSubscribed: getRowBoolean(row, "is_subscribed"),
    pendingErrorReportQuestionKey: getRowString(row, "pending_error_report_question_key"),
    createdAt: getRowString(row, "created_at") ?? new Date().toISOString(),
    updatedAt: getRowString(row, "updated_at") ?? new Date().toISOString(),
  };
}

function mapAnswer(row: RowMap): AnswerRecord {
  return {
    telegramId: getRowNumber(row, "telegram_id"),
    questionKey: getRowString(row, "question_key") ?? "",
    questionId: getRowString(row, "question_id") ?? "",
    topicSlug: (getRowString(row, "topic_slug") as TopicSlug | undefined) ?? "road-signs",
    language: (getRowString(row, "language") as LanguageCode | undefined) ?? "ru",
    mode: (getRowString(row, "mode") as AnswerRecord["mode"] | undefined) ?? "manual",
    selectedOptionId: getRowString(row, "selected_option_id") ?? "",
    isCorrect: getRowBoolean(row, "is_correct"),
    answeredAt: getRowString(row, "answered_at") ?? new Date().toISOString(),
  };
}

function mapErrorReport(row: RowMap): ErrorReportRecord {
  return {
    telegramId: getRowNumber(row, "telegram_id"),
    chatId: getRowNumber(row, "chat_id"),
    language: (getRowString(row, "language") as LanguageCode | undefined) ?? "ru",
    questionKey: getRowString(row, "question_key") ?? "",
    questionId: getRowString(row, "question_id"),
    topicSlug: getRowString(row, "topic_slug") as TopicSlug | undefined,
    text: getRowString(row, "text") ?? "",
    createdAt: getRowString(row, "created_at") ?? new Date().toISOString(),
  };
}

function mapQuestionState(row: RowMap): UserQuestionState {
  return {
    telegramId: getRowNumber(row, "telegram_id"),
    questionKey: getRowString(row, "question_key") ?? "",
    language: (getRowString(row, "language") as LanguageCode | undefined) ?? "ru",
    topicSlug: (getRowString(row, "topic_slug") as TopicSlug | undefined) ?? "road-signs",
    status: (getRowString(row, "status") as UserQuestionState["status"] | undefined) ?? "new",
    correctStreak: getRowNumber(row, "correct_streak"),
    mistakeCount: getRowNumber(row, "mistake_count"),
    lastSeenAt: getRowString(row, "last_seen_at"),
    nextReviewAt: getRowString(row, "next_review_at"),
    lastAnswerCorrect:
      getRowString(row, "last_answer_correct") === undefined
        ? undefined
        : getRowBoolean(row, "last_answer_correct"),
    updatedAt: getRowString(row, "updated_at") ?? new Date().toISOString(),
  };
}

function mapQuizSession(row: RowMap): QuizSessionRecord {
  return {
    id: getRowString(row, "id") ?? "",
    telegramId: getRowNumber(row, "telegram_id"),
    chatId: getRowNumber(row, "chat_id"),
    questionKey: getRowString(row, "question_key") ?? "",
    questionId: getRowString(row, "question_id") ?? "",
    topicSlug: (getRowString(row, "topic_slug") as TopicSlug | undefined) ?? "road-signs",
    language: (getRowString(row, "language") as LanguageCode | undefined) ?? "ru",
    mode: (getRowString(row, "mode") as QuizSessionRecord["mode"] | undefined) ?? "manual",
    status: (getRowString(row, "status") as QuizSessionRecord["status"] | undefined) ?? "pending",
    sentAt: getRowString(row, "sent_at") ?? new Date().toISOString(),
    answeredAt: getRowString(row, "answered_at"),
    selectedOptionId: getRowString(row, "selected_option_id"),
    isCorrect:
      getRowString(row, "is_correct") === undefined
        ? undefined
        : getRowBoolean(row, "is_correct"),
  };
}

function mapUserFlow(row: RowMap): UserFlowRecord {
  return {
    telegramId: getRowNumber(row, "telegram_id"),
    state: (getRowString(row, "state") as UserFlowRecord["state"] | undefined) ?? "idle",
    activeSessionId: getRowString(row, "active_session_id"),
    updatedAt: getRowString(row, "updated_at") ?? new Date().toISOString(),
  };
}

async function getCount(tableName: string): Promise<number> {
  const result = await db.execute(`SELECT COUNT(*) AS count FROM ${tableName}`);
  const firstRow = result.rows[0] as RowMap | undefined;
  return firstRow ? getRowNumber(firstRow, "count") : 0;
}

async function importLegacyUsers(): Promise<void> {
  const users = readJsonFile<LegacyUserRecord[]>(usersPath, []).map(normalizeUser);
  if (users.length === 0) {
    return;
  }

  await db.batch(
    users.map((user) => ({
      sql: `
        INSERT INTO users (
          telegram_id, chat_id, first_name, username, language, is_subscribed,
          pending_error_report_question_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        user.telegramId,
        user.chatId,
        user.firstName ?? null,
        user.username ?? null,
        user.language,
        user.isSubscribed ? 1 : 0,
        user.pendingErrorReportQuestionKey ?? null,
        user.createdAt,
        user.updatedAt,
      ],
    })),
    "write",
  );
}

async function importLegacyAnswers(): Promise<void> {
  const answers = readJsonFile<AnswerRecord[]>(answersPath, []);
  if (answers.length === 0) {
    return;
  }

  await db.batch(
    answers.map((answer) => ({
      sql: `
        INSERT INTO answers (
          telegram_id, question_key, question_id, topic_slug, language, mode,
          selected_option_id, is_correct, answered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        answer.telegramId,
        answer.questionKey,
        answer.questionId,
        answer.topicSlug,
        answer.language,
        answer.mode,
        answer.selectedOptionId,
        answer.isCorrect ? 1 : 0,
        answer.answeredAt,
      ],
    })),
    "write",
  );
}

async function importLegacyQuestionStates(): Promise<void> {
  const states = readJsonFile<UserQuestionState[]>(questionStatesPath, []);
  if (states.length === 0) {
    return;
  }

  await db.batch(
    states.map((state) => ({
      sql: `
        INSERT INTO question_states (
          telegram_id, question_key, language, topic_slug, status, correct_streak,
          mistake_count, last_seen_at, next_review_at, last_answer_correct, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        state.telegramId,
        state.questionKey,
        state.language,
        state.topicSlug,
        state.status,
        state.correctStreak,
        state.mistakeCount,
        state.lastSeenAt ?? null,
        state.nextReviewAt ?? null,
        state.lastAnswerCorrect === undefined ? null : state.lastAnswerCorrect ? 1 : 0,
        state.updatedAt,
      ],
    })),
    "write",
  );
}

async function importLegacyQuizSessions(): Promise<void> {
  const sessions = readJsonFile<QuizSessionRecord[]>(quizSessionsPath, []);
  if (sessions.length === 0) {
    return;
  }

  await db.batch(
    sessions.map((session) => ({
      sql: `
        INSERT INTO quiz_sessions (
          id, telegram_id, chat_id, question_key, question_id, topic_slug, language,
          mode, status, sent_at, answered_at, selected_option_id, is_correct
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        session.id,
        session.telegramId,
        session.chatId,
        session.questionKey,
        session.questionId,
        session.topicSlug,
        session.language,
        session.mode,
        session.status,
        session.sentAt,
        session.answeredAt ?? null,
        session.selectedOptionId ?? null,
        session.isCorrect === undefined ? null : session.isCorrect ? 1 : 0,
      ],
    })),
    "write",
  );
}

async function importLegacyErrorReports(): Promise<void> {
  const reports = readJsonFile<ErrorReportRecord[]>(errorReportsPath, []);
  if (reports.length === 0) {
    return;
  }

  await db.batch(
    reports.map((report) => ({
      sql: `
        INSERT INTO error_reports (
          telegram_id, chat_id, language, question_key, question_id, topic_slug, text, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        report.telegramId,
        report.chatId,
        report.language,
        report.questionKey,
        report.questionId ?? null,
        report.topicSlug ?? null,
        report.text,
        report.createdAt,
      ],
    })),
    "write",
  );
}

async function initializeDatabase(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = (async () => {
    await db.executeMultiple(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        chat_id INTEGER NOT NULL,
        first_name TEXT,
        username TEXT,
        language TEXT NOT NULL,
        is_subscribed INTEGER NOT NULL DEFAULT 1,
        pending_error_report_question_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        question_key TEXT NOT NULL,
        question_id TEXT NOT NULL,
        topic_slug TEXT NOT NULL,
        language TEXT NOT NULL,
        mode TEXT NOT NULL,
        selected_option_id TEXT NOT NULL,
        is_correct INTEGER NOT NULL,
        answered_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS question_states (
        telegram_id INTEGER NOT NULL,
        question_key TEXT NOT NULL,
        language TEXT NOT NULL,
        topic_slug TEXT NOT NULL,
        status TEXT NOT NULL,
        correct_streak INTEGER NOT NULL,
        mistake_count INTEGER NOT NULL,
        last_seen_at TEXT,
        next_review_at TEXT,
        last_answer_correct INTEGER,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (telegram_id, question_key)
      );

      CREATE TABLE IF NOT EXISTS quiz_sessions (
        id TEXT PRIMARY KEY,
        telegram_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        question_key TEXT NOT NULL,
        question_id TEXT NOT NULL,
        topic_slug TEXT NOT NULL,
        language TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        answered_at TEXT,
        selected_option_id TEXT,
        is_correct INTEGER
      );

      CREATE TABLE IF NOT EXISTS user_flows (
        telegram_id INTEGER PRIMARY KEY,
        state TEXT NOT NULL,
        active_session_id TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_processing_locks (
        telegram_id INTEGER PRIMARY KEY,
        locked_at TEXT NOT NULL,
        update_id INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS error_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER NOT NULL,
        chat_id INTEGER NOT NULL,
        language TEXT NOT NULL,
        question_key TEXT NOT NULL,
        question_id TEXT,
        topic_slug TEXT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_answers_telegram_language_answered_at
      ON answers (telegram_id, language, answered_at);

      CREATE INDEX IF NOT EXISTS idx_question_states_telegram_language_status
      ON question_states (telegram_id, language, status);

      CREATE INDEX IF NOT EXISTS idx_quiz_sessions_telegram_status_sent_at
      ON quiz_sessions (telegram_id, status, sent_at);

      CREATE INDEX IF NOT EXISTS idx_user_flows_state_updated_at
      ON user_flows (state, updated_at);
    `);

    if ((await getCount("users")) === 0) {
      await importLegacyUsers();
    }

    if ((await getCount("answers")) === 0) {
      await importLegacyAnswers();
    }

    if ((await getCount("question_states")) === 0) {
      await importLegacyQuestionStates();
    }

    if ((await getCount("quiz_sessions")) === 0) {
      await importLegacyQuizSessions();
    }

    if ((await getCount("error_reports")) === 0) {
      await importLegacyErrorReports();
    }
  })();

  return initPromise;
}

async function execute(sql: string, args?: InArgs) {
  await initializeDatabase();
  return db.execute({ sql, args });
}

function buildDefaultUserFlow(telegramId: number): UserFlowRecord {
  return {
    telegramId,
    state: "idle",
    activeSessionId: undefined,
    updatedAt: new Date().toISOString(),
  };
}

export async function getUserFlow(telegramId: number): Promise<UserFlowRecord> {
  log.debug("storage", "get_user_flow_start", { telegramId });
  const result = await execute(
    "SELECT * FROM user_flows WHERE telegram_id = ? LIMIT 1",
    [telegramId],
  );
  const row = result.rows[0] as RowMap | undefined;
  const flow = row ? mapUserFlow(row) : buildDefaultUserFlow(telegramId);
  log.debug("storage", "get_user_flow_done", {
    telegramId,
    state: flow.state,
    activeSessionId: flow.activeSessionId,
    found: Boolean(row),
  });
  return flow;
}

export async function setUserFlow(flow: UserFlowRecord): Promise<void> {
  log.info("storage", "set_user_flow", {
    telegramId: flow.telegramId,
    state: flow.state,
    activeSessionId: flow.activeSessionId,
    updatedAt: flow.updatedAt,
  });
  await execute(
    `
      INSERT INTO user_flows (
        telegram_id, state, active_session_id, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        state = excluded.state,
        active_session_id = excluded.active_session_id,
        updated_at = excluded.updated_at
    `,
    [
      flow.telegramId,
      flow.state,
      flow.activeSessionId ?? null,
      flow.updatedAt,
    ],
  );
}

export async function tryStartUserFlow(
  telegramId: number,
  activeSessionId: string,
  updatedAt: string,
): Promise<boolean> {
  log.info("storage", "try_start_user_flow_start", { telegramId, activeSessionId, updatedAt });
  const result = await execute(
    `
      INSERT INTO user_flows (
        telegram_id, state, active_session_id, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        state = excluded.state,
        active_session_id = excluded.active_session_id,
        updated_at = excluded.updated_at
      WHERE user_flows.state = 'idle'
    `,
    [telegramId, "question_open", activeSessionId, updatedAt],
  );

  const claimed = result.rowsAffected > 0;
  log.info("storage", "try_start_user_flow_done", {
    telegramId,
    activeSessionId,
    claimed,
    rowsAffected: result.rowsAffected,
  });
  return claimed;
}

const PROCESSING_LOCK_STALE_MS = 30_000;

export async function tryAcquireProcessingLock(
  telegramId: number,
  updateId: number,
): Promise<boolean> {
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - PROCESSING_LOCK_STALE_MS).toISOString();
  log.debug("storage", "try_acquire_processing_lock", { telegramId, updateId });

  const result = await execute(
    `
      INSERT INTO user_processing_locks (telegram_id, locked_at, update_id)
      VALUES (?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        locked_at = excluded.locked_at,
        update_id = excluded.update_id
      WHERE user_processing_locks.locked_at <= ?
    `,
    [telegramId, now, updateId, staleBefore],
  );

  const acquired = result.rowsAffected > 0;
  log.info("storage", "try_acquire_processing_lock_done", { telegramId, updateId, acquired });
  return acquired;
}

export async function forceReleaseStaleProcessingLock(telegramId: number): Promise<boolean> {
  const staleBefore = new Date(Date.now() - PROCESSING_LOCK_STALE_MS).toISOString();
  const result = await execute(
    "DELETE FROM user_processing_locks WHERE telegram_id = ? AND locked_at <= ?",
    [telegramId, staleBefore],
  );
  const cleared = (result.rowsAffected ?? 0) > 0;
  if (cleared) {
    log.warn("storage", "force_release_stale_processing_lock", { telegramId, staleBefore });
  }
  return cleared;
}

export async function releaseProcessingLock(
  telegramId: number,
  updateId: number,
): Promise<void> {
  log.debug("storage", "release_processing_lock", { telegramId, updateId });
  await execute("DELETE FROM user_processing_locks WHERE telegram_id = ?", [telegramId]);
}

export async function clearProcessingLock(telegramId: number): Promise<void> {
  log.debug("storage", "clear_processing_lock", { telegramId });
  await execute("DELETE FROM user_processing_locks WHERE telegram_id = ?", [telegramId]);
}

export async function releaseUserFlow(telegramId: number, updatedAt?: string): Promise<void> {
  log.info("storage", "release_user_flow", { telegramId, updatedAt });
  await setUserFlow({
    telegramId,
    state: "idle",
    activeSessionId: undefined,
    updatedAt: updatedAt ?? new Date().toISOString(),
  });
}

export async function getUsers(): Promise<UserRecord[]> {
  const result = await execute("SELECT * FROM users ORDER BY telegram_id ASC");
  return result.rows.map((row: unknown) => mapUser(row as RowMap));
}

export async function upsertUser(
  telegramId: number,
  chatId: number,
  firstName?: string,
  username?: string,
): Promise<UserRecord> {
  log.debug("storage", "upsert_user_start", { telegramId, chatId, firstName, username });
  const existingResult = await execute(
    "SELECT * FROM users WHERE telegram_id = ? LIMIT 1",
    [telegramId],
  );
  const existing = existingResult.rows[0] as RowMap | undefined;
  const now = new Date().toISOString();

  if (existing) {
    await execute(
      `
        UPDATE users
        SET chat_id = ?, first_name = ?, username = ?, is_subscribed = 1, updated_at = ?
        WHERE telegram_id = ?
      `,
      [chatId, firstName ?? null, username ?? null, now, telegramId],
    );

    const updated = {
      ...mapUser(existing),
      chatId,
      firstName,
      username,
      isSubscribed: true,
      updatedAt: now,
    };
    log.debug("storage", "upsert_user_updated", {
      telegramId,
      chatId: updated.chatId,
      language: updated.language,
    });
    return updated;
  }

  const created: UserRecord = {
    telegramId,
    chatId,
    firstName,
    username,
    language: "ru",
    isSubscribed: true,
    pendingErrorReportQuestionKey: undefined,
    createdAt: now,
    updatedAt: now,
  };

  await execute(
    `
      INSERT INTO users (
        telegram_id, chat_id, first_name, username, language, is_subscribed,
        pending_error_report_question_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      created.telegramId,
      created.chatId,
      created.firstName ?? null,
      created.username ?? null,
      created.language,
      1,
      null,
      created.createdAt,
      created.updatedAt,
    ],
  );

  log.info("storage", "upsert_user_created", {
    telegramId: created.telegramId,
    chatId: created.chatId,
    language: created.language,
  });
  return created;
}

export async function updateUser(user: UserRecord): Promise<void> {
  await execute(
    `
      INSERT INTO users (
        telegram_id, chat_id, first_name, username, language, is_subscribed,
        pending_error_report_question_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        first_name = excluded.first_name,
        username = excluded.username,
        language = excluded.language,
        is_subscribed = excluded.is_subscribed,
        pending_error_report_question_key = excluded.pending_error_report_question_key,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
    [
      user.telegramId,
      user.chatId,
      user.firstName ?? null,
      user.username ?? null,
      user.language,
      user.isSubscribed ? 1 : 0,
      user.pendingErrorReportQuestionKey ?? null,
      user.createdAt,
      user.updatedAt,
    ],
  );
}

export async function setSubscription(
  telegramId: number,
  isSubscribed: boolean,
): Promise<UserRecord | undefined> {
  const existingResult = await execute(
    "SELECT * FROM users WHERE telegram_id = ? LIMIT 1",
    [telegramId],
  );
  const existing = existingResult.rows[0] as RowMap | undefined;
  if (!existing) {
    return undefined;
  }

  const updated = mapUser(existing);
  updated.isSubscribed = isSubscribed;
  updated.updatedAt = new Date().toISOString();
  await updateUser(updated);
  return updated;
}

export async function setUserLanguage(
  telegramId: number,
  language: LanguageCode,
): Promise<UserRecord | undefined> {
  const existingResult = await execute(
    "SELECT * FROM users WHERE telegram_id = ? LIMIT 1",
    [telegramId],
  );
  const existing = existingResult.rows[0] as RowMap | undefined;
  if (!existing) {
    return undefined;
  }

  const updated = mapUser(existing);
  updated.language = language;
  updated.updatedAt = new Date().toISOString();
  await updateUser(updated);
  return updated;
}

export async function getAnswers(): Promise<AnswerRecord[]> {
  const result = await execute("SELECT * FROM answers ORDER BY answered_at ASC, id ASC");
  return result.rows.map((row: unknown) => mapAnswer(row as RowMap));
}

export async function getAnswersForUser(
  telegramId: number,
  language?: LanguageCode,
): Promise<AnswerRecord[]> {
  const result = language
    ? await execute(
        "SELECT * FROM answers WHERE telegram_id = ? AND language = ? ORDER BY answered_at ASC, id ASC",
        [telegramId, language],
      )
    : await execute(
        "SELECT * FROM answers WHERE telegram_id = ? ORDER BY answered_at ASC, id ASC",
        [telegramId],
      );
  return result.rows.map((row: unknown) => mapAnswer(row as RowMap));
}

export async function appendAnswer(answer: AnswerRecord): Promise<void> {
  await execute(
    `
      INSERT INTO answers (
        telegram_id, question_key, question_id, topic_slug, language, mode,
        selected_option_id, is_correct, answered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      answer.telegramId,
      answer.questionKey,
      answer.questionId,
      answer.topicSlug,
      answer.language,
      answer.mode,
      answer.selectedOptionId,
      answer.isCorrect ? 1 : 0,
      answer.answeredAt,
    ],
  );
}

export async function getErrorReports(): Promise<ErrorReportRecord[]> {
  const result = await execute("SELECT * FROM error_reports ORDER BY created_at ASC, id ASC");
  return result.rows.map((row: unknown) => mapErrorReport(row as RowMap));
}

export async function appendErrorReport(report: ErrorReportRecord): Promise<void> {
  await execute(
    `
      INSERT INTO error_reports (
        telegram_id, chat_id, language, question_key, question_id, topic_slug, text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      report.telegramId,
      report.chatId,
      report.language,
      report.questionKey,
      report.questionId ?? null,
      report.topicSlug ?? null,
      report.text,
      report.createdAt,
    ],
  );
}

export async function getQuestionStates(): Promise<UserQuestionState[]> {
  const result = await execute("SELECT * FROM question_states ORDER BY updated_at ASC");
  return result.rows.map((row: unknown) => mapQuestionState(row as RowMap));
}

export async function getQuestionStatesForUser(telegramId: number): Promise<UserQuestionState[]> {
  const result = await execute(
    "SELECT * FROM question_states WHERE telegram_id = ? ORDER BY updated_at ASC",
    [telegramId],
  );
  return result.rows.map((row: unknown) => mapQuestionState(row as RowMap));
}

export async function upsertQuestionState(state: UserQuestionState): Promise<void> {
  await execute(
    `
      INSERT INTO question_states (
        telegram_id, question_key, language, topic_slug, status, correct_streak,
        mistake_count, last_seen_at, next_review_at, last_answer_correct, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telegram_id, question_key) DO UPDATE SET
        language = excluded.language,
        topic_slug = excluded.topic_slug,
        status = excluded.status,
        correct_streak = excluded.correct_streak,
        mistake_count = excluded.mistake_count,
        last_seen_at = excluded.last_seen_at,
        next_review_at = excluded.next_review_at,
        last_answer_correct = excluded.last_answer_correct,
        updated_at = excluded.updated_at
    `,
    [
      state.telegramId,
      state.questionKey,
      state.language,
      state.topicSlug,
      state.status,
      state.correctStreak,
      state.mistakeCount,
      state.lastSeenAt ?? null,
      state.nextReviewAt ?? null,
      state.lastAnswerCorrect === undefined ? null : state.lastAnswerCorrect ? 1 : 0,
      state.updatedAt,
    ],
  );
}

export async function getQuizSessions(): Promise<QuizSessionRecord[]> {
  const result = await execute("SELECT * FROM quiz_sessions ORDER BY sent_at ASC, id ASC");
  return result.rows.map((row: unknown) => mapQuizSession(row as RowMap));
}

export async function getQuizSessionsForUser(telegramId: number): Promise<QuizSessionRecord[]> {
  const result = await execute(
    "SELECT * FROM quiz_sessions WHERE telegram_id = ? ORDER BY sent_at ASC, id ASC",
    [telegramId],
  );
  return result.rows.map((row: unknown) => mapQuizSession(row as RowMap));
}

export async function createQuizSession(session: QuizSessionRecord): Promise<void> {
  log.info("storage", "create_quiz_session", {
    sessionId: session.id,
    telegramId: session.telegramId,
    chatId: session.chatId,
    questionKey: session.questionKey,
    mode: session.mode,
    status: session.status,
  });
  await execute(
    `
      INSERT INTO quiz_sessions (
        id, telegram_id, chat_id, question_key, question_id, topic_slug, language,
        mode, status, sent_at, answered_at, selected_option_id, is_correct
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      session.id,
      session.telegramId,
      session.chatId,
      session.questionKey,
      session.questionId,
      session.topicSlug,
      session.language,
      session.mode,
      session.status,
      session.sentAt,
      session.answeredAt ?? null,
      session.selectedOptionId ?? null,
      session.isCorrect === undefined ? null : session.isCorrect ? 1 : 0,
    ],
  );
}

export async function updateQuizSession(session: QuizSessionRecord): Promise<void> {
  await execute(
    `
      INSERT INTO quiz_sessions (
        id, telegram_id, chat_id, question_key, question_id, topic_slug, language,
        mode, status, sent_at, answered_at, selected_option_id, is_correct
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        telegram_id = excluded.telegram_id,
        chat_id = excluded.chat_id,
        question_key = excluded.question_key,
        question_id = excluded.question_id,
        topic_slug = excluded.topic_slug,
        language = excluded.language,
        mode = excluded.mode,
        status = excluded.status,
        sent_at = excluded.sent_at,
        answered_at = excluded.answered_at,
        selected_option_id = excluded.selected_option_id,
        is_correct = excluded.is_correct
    `,
    [
      session.id,
      session.telegramId,
      session.chatId,
      session.questionKey,
      session.questionId,
      session.topicSlug,
      session.language,
      session.mode,
      session.status,
      session.sentAt,
      session.answeredAt ?? null,
      session.selectedOptionId ?? null,
      session.isCorrect === undefined ? null : session.isCorrect ? 1 : 0,
    ],
  );
}

export async function deleteQuizSession(sessionId: string): Promise<void> {
  log.info("storage", "delete_quiz_session", { sessionId });
  await execute("DELETE FROM quiz_sessions WHERE id = ?", [sessionId]);
}

export async function getQuizSessionById(sessionId: string): Promise<QuizSessionRecord | undefined> {
  log.debug("storage", "get_quiz_session_start", { sessionId });
  const result = await execute(
    "SELECT * FROM quiz_sessions WHERE id = ? LIMIT 1",
    [sessionId],
  );
  const row = result.rows[0] as RowMap | undefined;
  const session = row ? mapQuizSession(row) : undefined;
  log.debug("storage", "get_quiz_session_done", {
    sessionId,
    found: Boolean(session),
    status: session?.status,
    telegramId: session?.telegramId,
    questionKey: session?.questionKey,
  });
  return session;
}

export async function completeQuizAnswer(params: {
  answer: AnswerRecord;
  nextState: UserQuestionState;
  selectedOptionId: string;
  answeredAt: string;
  isCorrect: boolean;
  sessionId: string;
  telegramId: number;
}): Promise<boolean> {
  log.info("storage", "complete_quiz_answer_start", {
    sessionId: params.sessionId,
    telegramId: params.telegramId,
    questionKey: params.answer.questionKey,
    selectedOptionId: params.selectedOptionId,
    isCorrect: params.isCorrect,
  });
  await initializeDatabase();

  const transaction = await db.transaction("write");

  try {
    const sessionUpdate = await transaction.execute({
      sql: `
        UPDATE quiz_sessions
        SET status = 'answered', answered_at = ?, selected_option_id = ?, is_correct = ?
        WHERE id = ? AND telegram_id = ? AND status = 'pending'
      `,
      args: [
        params.answeredAt,
        params.selectedOptionId,
        params.isCorrect ? 1 : 0,
        params.sessionId,
        params.telegramId,
      ],
    });

    if (sessionUpdate.rowsAffected === 0) {
      log.warn("storage", "complete_quiz_answer_session_not_pending", {
        sessionId: params.sessionId,
        telegramId: params.telegramId,
        rowsAffected: sessionUpdate.rowsAffected,
      });
      await transaction.rollback();
      return false;
    }

    await transaction.execute({
      sql: `
        INSERT INTO answers (
          telegram_id, question_key, question_id, topic_slug, language, mode,
          selected_option_id, is_correct, answered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        params.answer.telegramId,
        params.answer.questionKey,
        params.answer.questionId,
        params.answer.topicSlug,
        params.answer.language,
        params.answer.mode,
        params.answer.selectedOptionId,
        params.answer.isCorrect ? 1 : 0,
        params.answer.answeredAt,
      ],
    });

    await transaction.execute({
      sql: `
        INSERT INTO question_states (
          telegram_id, question_key, language, topic_slug, status, correct_streak,
          mistake_count, last_seen_at, next_review_at, last_answer_correct, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(telegram_id, question_key) DO UPDATE SET
          language = excluded.language,
          topic_slug = excluded.topic_slug,
          status = excluded.status,
          correct_streak = excluded.correct_streak,
          mistake_count = excluded.mistake_count,
          last_seen_at = excluded.last_seen_at,
          next_review_at = excluded.next_review_at,
          last_answer_correct = excluded.last_answer_correct,
          updated_at = excluded.updated_at
      `,
      args: [
        params.nextState.telegramId,
        params.nextState.questionKey,
        params.nextState.language,
        params.nextState.topicSlug,
        params.nextState.status,
        params.nextState.correctStreak,
        params.nextState.mistakeCount,
        params.nextState.lastSeenAt ?? null,
        params.nextState.nextReviewAt ?? null,
        params.nextState.lastAnswerCorrect === undefined ? null : params.nextState.lastAnswerCorrect ? 1 : 0,
        params.nextState.updatedAt,
      ],
    });

    await transaction.execute({
      sql: `
        INSERT INTO user_flows (
          telegram_id, state, active_session_id, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(telegram_id) DO UPDATE SET
          state = excluded.state,
          active_session_id = excluded.active_session_id,
          updated_at = excluded.updated_at
      `,
      args: [
        params.telegramId,
        "explanation_shown",
        params.sessionId,
        params.answeredAt,
      ],
    });

    await transaction.commit();
    log.info("storage", "complete_quiz_answer_done", {
      sessionId: params.sessionId,
      telegramId: params.telegramId,
      isCorrect: params.isCorrect,
      nextStatus: params.nextState.status,
    });
    return true;
  } catch (error) {
    log.error("storage", "complete_quiz_answer_failed", error, {
      sessionId: params.sessionId,
      telegramId: params.telegramId,
    });
    if (!transaction.closed) {
      await transaction.rollback();
    }
    throw error;
  } finally {
    transaction.close();
  }
}

export function getSigns(): SignRecord[] {
  return readJsonFile<SignRecord[]>(signsPath, []);
}

export function getTerms(): TermRecord[] {
  return readJsonFile<TermRecord[]>(termsPath, []);
}

export function getMarkings(): MarkingRecord[] {
  return readJsonFile<MarkingRecord[]>(markingPath, []);
}

function readQuestionFile(language: LanguageCode, topicSlug: TopicSlug): QuizQuestion[] {
  const questionsPath = path.join(drvTopicsRoot, language, topicSlug, "questions.json");
  const rawItems = readJsonFile<
    Array<{
      id: string;
      group: string;
      question: string;
      options: Array<{ id: string; text: string }>;
      correctOptionId: string;
      image: string;
      entityRefs?: Array<{ type: "sign" | "marking" | "term"; ids: string[] }>;
      explanation?: string;
      comment?: string;
    }>
  >(questionsPath, []);

  return rawItems.map((item) => ({
    key: `${language}:${topicSlug}:${item.id}`,
    id: item.id,
    topicSlug,
    language,
    group: item.group,
    question: item.question,
    options: item.options ?? [],
    correctOptionId: item.correctOptionId,
    image: item.image ?? "",
    entityRefs: item.entityRefs ?? [],
    explanation: item.explanation ?? "",
    comment: item.comment ?? "",
  }));
}

const questionsCache = new Map<LanguageCode, QuizQuestion[]>();

const knownTopicSlugs: TopicSlug[] = [
  "maneuvers-and-lane-position",
  "terms-and-general-rules",
  "vehicle-technical-condition",
  "road-signs",
  "intersection-priority",
  "traffic-lights-and-intersections",
  "stopping-parking-and-markings",
  "speed-towing-and-passengers",
  "overtaking-signals-and-railway-crossings",
  "first-aid",
];

export function getQuestions(language: LanguageCode): QuizQuestion[] {
  const cached = questionsCache.get(language);
  if (cached) {
    return cached;
  }

  const questions = knownTopicSlugs.flatMap((topicSlug) =>
    readQuestionFile(language, topicSlug),
  );

  questionsCache.set(language, questions);
  return questions;
}

export function getQuestionByKey(questionKey: string): QuizQuestion | undefined {
  const [language] = questionKey.split(":");
  if (language !== "am" && language !== "ru") {
    return undefined;
  }

  return getQuestions(language).find((question) => question.key === questionKey);
}

export function resolveQuestionImagePath(question: QuizQuestion): string | undefined {
  if (!question.image) {
    return undefined;
  }

  const imagePath = path.resolve(
    process.cwd(),
    "data",
    "drv-topics",
    question.language,
    question.topicSlug,
    question.image,
  );

  return existsSync(imagePath) ? imagePath : undefined;
}

export function resolveAssetImagePath(relativePath: string | undefined): string | undefined {
  if (!relativePath) {
    return undefined;
  }

  const assetPath = path.resolve(process.cwd(), relativePath);
  return existsSync(assetPath) ? assetPath : undefined;
}
