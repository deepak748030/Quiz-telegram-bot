export interface UserAISettings {
  apiKey?: string;
  model?: string;
  /** Most recently fetched model catalogue, used by Telegram button callbacks. */
  availableModels?: string[];
}

// User-provided keys must never be written to logs or source control. Settings
// live only for the lifetime of this bot process. A restart safely falls back
// to the bot owner's key/model.
const settingsByUser = new Map<number, UserAISettings>();

export const getUserAISettings = (userId: number): Readonly<UserAISettings> =>
  settingsByUser.get(userId) ?? {};

export const setUserApiKey = (userId: number, apiKey: string): void => {
  const current = settingsByUser.get(userId) ?? {};
  settingsByUser.set(userId, {
    ...(current.model ? { model: current.model } : {}),
    apiKey,
    // A new key can expose a different model catalogue. The old catalogue is
    // deliberately discarded because key permissions can differ.
  });
};

export const setUserModel = (userId: number, model: string): void => {
  const current = settingsByUser.get(userId) ?? {};
  settingsByUser.set(userId, { ...current, model });
};

export const setAvailableModels = (userId: number, models: string[]): void => {
  const current = settingsByUser.get(userId) ?? {};
  settingsByUser.set(userId, { ...current, availableModels: [...models] });
};

export const resetUserAISettings = (userId: number): void => {
  settingsByUser.delete(userId);
};

export const redactUserApiKeys = (value: string): string => {
  let redacted = value;
  for (const settings of settingsByUser.values()) {
    if (settings.apiKey) redacted = redacted.replaceAll(settings.apiKey, "[REDACTED]");
  }
  return redacted;
};

/** Test helper; intentionally not exposed through the Telegram UI. */
export const clearAllUserAISettings = (): void => {
  settingsByUser.clear();
};
