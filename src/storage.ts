import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

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

function ensureDataDir(): void {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  ensureDataDir();

  if (!existsSync(filePath)) {
    writeJsonFile(filePath, fallback);
    return fallback;
  }

  const raw = readFileSync(filePath, "utf-8").trim();
  if (!raw) {
    writeJsonFile(filePath, fallback);
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    console.error(`Failed to parse JSON file ${filePath}, resetting to fallback:`, error);
    writeJsonFile(filePath, fallback);
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

export function getUsers(): UserRecord[] {
  return readJsonFile<LegacyUserRecord[]>(usersPath, []).map(normalizeUser);
}

export function saveUsers(users: UserRecord[]): void {
  writeJsonFile(usersPath, users);
}

export function upsertUser(
  telegramId: number,
  chatId: number,
  firstName?: string,
  username?: string,
): UserRecord {
  const users = getUsers();
  const existing = users.find((user) => user.telegramId === telegramId);
  const now = new Date().toISOString();

  if (existing) {
    existing.chatId = chatId;
    existing.firstName = firstName;
    existing.username = username;
    existing.isSubscribed = true;
    existing.updatedAt = now;
    saveUsers(users);
    return existing;
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

  users.push(created);
  saveUsers(users);
  return created;
}

export function updateUser(user: UserRecord): void {
  const users = getUsers();
  const index = users.findIndex((entry) => entry.telegramId === user.telegramId);

  if (index === -1) {
    users.push(user);
  } else {
    users[index] = user;
  }

  saveUsers(users);
}

export function setSubscription(
  telegramId: number,
  isSubscribed: boolean,
): UserRecord | undefined {
  const users = getUsers();
  const user = users.find((entry) => entry.telegramId === telegramId);
  if (!user) {
    return undefined;
  }

  user.isSubscribed = isSubscribed;
  user.updatedAt = new Date().toISOString();
  saveUsers(users);
  return user;
}

export function setUserLanguage(
  telegramId: number,
  language: LanguageCode,
): UserRecord | undefined {
  const users = getUsers();
  const user = users.find((entry) => entry.telegramId === telegramId);
  if (!user) {
    return undefined;
  }

  user.language = language;
  user.updatedAt = new Date().toISOString();
  saveUsers(users);
  return user;
}

export function getAnswers(): AnswerRecord[] {
  return readJsonFile<AnswerRecord[]>(answersPath, []);
}

export function appendAnswer(answer: AnswerRecord): void {
  const answers = getAnswers();
  answers.push(answer);
  writeJsonFile(answersPath, answers);
}

export function getErrorReports(): ErrorReportRecord[] {
  return readJsonFile<ErrorReportRecord[]>(errorReportsPath, []);
}

export function appendErrorReport(report: ErrorReportRecord): void {
  const reports = getErrorReports();
  reports.push(report);
  writeJsonFile(errorReportsPath, reports);
}

export function getQuestionStates(): UserQuestionState[] {
  return readJsonFile<UserQuestionState[]>(questionStatesPath, []);
}

export function saveQuestionStates(states: UserQuestionState[]): void {
  writeJsonFile(questionStatesPath, states);
}

export function upsertQuestionState(state: UserQuestionState): void {
  const states = getQuestionStates();
  const index = states.findIndex(
    (entry) =>
      entry.telegramId === state.telegramId && entry.questionKey === state.questionKey,
  );

  if (index === -1) {
    states.push(state);
  } else {
    states[index] = state;
  }

  saveQuestionStates(states);
}

export function getQuizSessions(): QuizSessionRecord[] {
  return readJsonFile<QuizSessionRecord[]>(quizSessionsPath, []);
}

export function saveQuizSessions(sessions: QuizSessionRecord[]): void {
  writeJsonFile(quizSessionsPath, sessions);
}

export function createQuizSession(session: QuizSessionRecord): void {
  const sessions = getQuizSessions();
  sessions.push(session);
  saveQuizSessions(sessions);
}

export function updateQuizSession(session: QuizSessionRecord): void {
  const sessions = getQuizSessions();
  const index = sessions.findIndex((entry) => entry.id === session.id);

  if (index === -1) {
    sessions.push(session);
  } else {
    sessions[index] = session;
  }

  saveQuizSessions(sessions);
}

export function getQuizSessionById(sessionId: string): QuizSessionRecord | undefined {
  return getQuizSessions().find((session) => session.id === sessionId);
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
