export type SignRecord = {
  id: string;
  title: string;
  images: string[];
  comment: string;
  conceptSlugs?: string[];
  internalRefs: string[];
  relatedIds: string[];
  relatedCards: Array<{ id: string; images: string[] }>;
  atomicIds: string[];
  topicIds?: string[];
};

export type TopicRecord = {
  id: string;
  title: string;
  mainSignIds: string[];
  relatedSignIds: string[];
  conceptSlugs: string[];
  questionTags: string[];
  ruleIds?: string[];
  fineIds?: string[];
  notes: string[];
};

export type TopicSection = {
  id: string;
  title: string;
  text: string;
};

export type TopicSectionsRecord = {
  topicId: string;
  sections: TopicSection[];
};

export type TopicRuleRecord = {
  id: string;
  topicId: string;
  title: string;
  text: string;
  sourceRefs?: Array<{
    source: string;
    point?: string;
    article?: string;
    url?: string;
  }>;
};

export type FineRecord = {
  id: string;
  topicId: string;
  title: string;
  penalty: string;
  summary: string;
  sourceRefs?: Array<{
    source: string;
    point?: string;
    article?: string;
    url?: string;
  }>;
};

export type ConceptRecord = {
  slug: string;
  term: string;
  signRefs: string[];
  definition: string;
  comment?: string;
  linkedSigns?: Array<{
    id: string;
    title: string;
    images: string[];
    groupTitle?: string;
  }>;
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
  touchCrons: string[];
  lessonSize: number;
};
