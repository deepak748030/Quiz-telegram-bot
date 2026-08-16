export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  document?: TelegramDocument;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: {
    retry_after?: number;
    migrate_to_chat_id?: number;
  };
}

export interface TelegramSentMessage {
  message_id: number;
  chat: TelegramChat;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export type Difficulty = "easy" | "medium" | "hard" | "mixed";

export interface QuizRequestOptions {
  /** Fixed count, or the fallback count when autoCount is enabled. */
  count: number;
  difficulty: Difficulty;
  language: string;
  /** Preserve every question found in an uploaded question set. */
  autoCount?: boolean;
  /** Upper bound used by autoCount. */
  maxCount?: number;
}

export interface RawQuiz {
  question?: unknown;
  options?: unknown;
  correctOption?: unknown;
  explanation?: unknown;
}

export interface RawQuizSet {
  title?: unknown;
  language?: unknown;
  quizzes?: unknown;
}

export interface Quiz {
  question: string;
  options: [string, string, string, string];
  correctOption: number;
  explanation: string;
}

export interface QuizSet {
  title: string;
  language: string;
  quizzes: Quiz[];
}

export type QuizSource =
  | { kind: "text"; text: string }
  | { kind: "pdf"; data: Uint8Array };
