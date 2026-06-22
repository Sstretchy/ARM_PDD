export type ContentType = "sign" | "rule" | "situation" | "comparison" | "exam";

export type LearningCard = {
  id: string;
  topic: string;
  type: ContentType;
  title: string;
  prompt: string;
  question: string;
  options: string[];
  correctOption: number;
  image?: string;
  images?: string[];
  scenario?: string;
  explanation: string;
  whatItMeans: string;
  whatDriverMustDo: string;
  why: string;
  commonMistake: string;
  confusedWith?: string;
  difference?: string;
  memoryHook?: string;
  tags: string[];
};

export type UserRecord = {
  telegramId: number;
  chatId: number;
  firstName?: string;
  username?: string;
  isSubscribed: boolean;
  lessonCursor: number;
  createdAt: string;
  updatedAt: string;
};

export type AnswerMode = "daily" | "mistake-review" | "manual" | "lesson-check";

export type AnswerRecord = {
  telegramId: number;
  cardId: string;
  isCorrect: boolean;
  selectedOption: number;
  mode: AnswerMode;
  answeredAt: string;
};

export type AppConfig = {
  botToken: string;
  timezone: string;
  morningCron: string;
  dayCron: string;
  eveningCron: string;
  lessonSize: number;
};
