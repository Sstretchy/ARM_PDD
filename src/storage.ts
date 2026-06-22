import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AnswerRecord, LearningCard, UserRecord } from "./types.js";

const dataDir = path.resolve(process.cwd(), "data");
const cardsPath = path.join(dataDir, "signs.json");
const usersPath = path.join(dataDir, "users.json");
const answersPath = path.join(dataDir, "answers.json");

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

  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

function writeJsonFile<T>(filePath: string, data: T): void {
  ensureDataDir();
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function getLearningCards(): LearningCard[] {
  return readJsonFile<LearningCard[]>(cardsPath, []);
}

export function getUsers(): UserRecord[] {
  return readJsonFile<UserRecord[]>(usersPath, []);
}

export function saveUsers(users: UserRecord[]): void {
  writeJsonFile(usersPath, users);
}

export function getAnswers(): AnswerRecord[] {
  return readJsonFile<AnswerRecord[]>(answersPath, []);
}

export function saveAnswers(answers: AnswerRecord[]): void {
  writeJsonFile(answersPath, answers);
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
    isSubscribed: true,
    lessonCursor: 0,
    createdAt: now,
    updatedAt: now,
  };

  users.push(created);
  saveUsers(users);
  return created;
}

export function setSubscription(telegramId: number, isSubscribed: boolean): UserRecord | undefined {
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

export function appendAnswer(answer: AnswerRecord): void {
  const answers = getAnswers();
  answers.push(answer);
  saveAnswers(answers);
}
