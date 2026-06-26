export type LanguageCode = "am" | "ru";

export type TopicSlug =
  | "maneuvers-and-lane-position"
  | "terms-and-general-rules"
  | "vehicle-technical-condition"
  | "road-signs"
  | "intersection-priority"
  | "traffic-lights-and-intersections"
  | "stopping-parking-and-markings"
  | "speed-towing-and-passengers"
  | "overtaking-signals-and-railway-crossings"
  | "first-aid";

export type TopicMeta = {
  slug: TopicSlug;
  order: number;
  title: Record<LanguageCode, string>;
};

export type QuestionOption = {
  id: string;
  text: string;
};

export type EntityRef = {
  type: "sign" | "marking" | "term";
  ids: string[];
};

export type QuizQuestion = {
  key: string;
  id: string;
  topicSlug: TopicSlug;
  language: LanguageCode;
  group: string;
  question: string;
  options: QuestionOption[];
  correctOptionId: string;
  image: string;
  entityRefs: EntityRef[];
  explanation: string;
  comment: string;
};

export type SignRecord = {
  id: string;
  type?: string;
  group?: string;
  title_ru: string;
  title_hy: string;
  meaning_ru?: string;
  meaning_hy?: string;
  comment_ru?: string;
  extra_info?: string;
  images: string[];
  atomicIds?: string[];
  relative_marks?: string[];
  relative_signs?: string[];
};

export type MarkingRecord = {
  id: string;
  type?: string;
  group?: string;
  title_ru: string;
  title_hy: string;
  meaning_ru?: string;
  meaning_hy?: string;
  comment_ru?: string;
  extra_info?: string;
  images: string[];
  atomicIds?: string[];
  relative_signs?: string[];
};

export type TermRecord = {
  slug: string;
  term_ru: string;
  term_hy: string;
  definition_ru: string;
  definition_hy: string;
  comment?: string;
};

export type UserRecord = {
  telegramId: number;
  chatId: number;
  firstName?: string;
  username?: string;
  language: LanguageCode;
  isSubscribed: boolean;
  pendingErrorReportQuestionKey?: string;
  createdAt: string;
  updatedAt: string;
};

export type UserFlowState = "idle" | "question_open" | "explanation_shown";

export type UserFlowRecord = {
  telegramId: number;
  state: UserFlowState;
  activeSessionId?: string;
  updatedAt: string;
};

export type QuizMode = "daily" | "manual" | "mistake";

export type QuestionStatus = "new" | "learning" | "mistake" | "repeat" | "mastered";

export type UserQuestionState = {
  telegramId: number;
  questionKey: string;
  language: LanguageCode;
  topicSlug: TopicSlug;
  status: QuestionStatus;
  correctStreak: number;
  mistakeCount: number;
  lastSeenAt?: string;
  nextReviewAt?: string;
  lastAnswerCorrect?: boolean;
  updatedAt: string;
};

export type QuizSessionStatus = "pending" | "answered";

export type QuizSessionRecord = {
  id: string;
  telegramId: number;
  chatId: number;
  questionKey: string;
  questionId: string;
  topicSlug: TopicSlug;
  language: LanguageCode;
  mode: QuizMode;
  status: QuizSessionStatus;
  sentAt: string;
  answeredAt?: string;
  selectedOptionId?: string;
  isCorrect?: boolean;
};

export type AnswerRecord = {
  telegramId: number;
  questionKey: string;
  questionId: string;
  topicSlug: TopicSlug;
  language: LanguageCode;
  mode: QuizMode;
  selectedOptionId: string;
  isCorrect: boolean;
  answeredAt: string;
};

export type ErrorReportRecord = {
  telegramId: number;
  chatId: number;
  language: LanguageCode;
  questionKey: string;
  questionId?: string;
  topicSlug?: TopicSlug;
  text: string;
  createdAt: string;
};

export type AppConfig = {
  botToken: string;
  timezone: string;
  touchCrons: string[];
  lessonSize: number;
};
