export const defaultSettings = {
  sourceMode: "github",
  githubOwner: "legalize-kr",
  githubRef: "main",
  bridgeUrl: "http://127.0.0.1:8765",
  theme: "system",
  fontSize: 16,
  leftPanelFontSize: 16,
  rightPanelFontSize: 16,
  localFolderName: ""
};

const settingsKey = "legalize.viewer.plugins.settings";
const tokenKey = "legalize.viewer.plugins.githubToken";

function storageArea(areaName) {
  return globalThis.chrome?.storage?.[areaName];
}

function chromeGet(area, key) {
  return new Promise((resolve, reject) => {
    area.get(key, (items) => {
      const error = globalThis.chrome?.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(items ?? {});
    });
  });
}

function chromeSet(area, items) {
  return new Promise((resolve, reject) => {
    area.set(items, () => {
      const error = globalThis.chrome?.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function chromeRemove(area, key) {
  return new Promise((resolve, reject) => {
    area.remove(key, () => {
      const error = globalThis.chrome?.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

export async function loadSettings() {
  const area = storageArea("local");
  let savedSettings = {};
  if (!area) {
    const saved = globalThis.localStorage?.getItem(settingsKey);
    savedSettings = saved ? JSON.parse(saved) : {};
  } else {
    const items = await chromeGet(area, settingsKey);
    savedSettings = items[settingsKey] ?? {};
  }
  return {
    ...defaultSettings,
    ...savedSettings,
    githubOwner: defaultSettings.githubOwner,
    githubRef: defaultSettings.githubRef,
    tokenStorage: "local",
    githubToken: ""
  };
}

export async function saveSettings(settings) {
  const safe = { ...settings };
  delete safe.githubToken;
  delete safe.tokenStorage;
  safe.githubOwner = defaultSettings.githubOwner;
  safe.githubRef = defaultSettings.githubRef;
  const area = storageArea("local");
  if (!area) {
    globalThis.localStorage?.setItem(settingsKey, JSON.stringify(safe));
    return;
  }
  await chromeSet(area, { [settingsKey]: safe });
}

export function normalizeTokenStorage(value) {
  return "local";
}

export function normalizeTheme(value) {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

export function normalizeFontSize(value, fallback = defaultSettings.fontSize) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(22, Math.max(14, Math.round(parsed)));
}

export async function loadToken() {
  const stored = globalThis.localStorage?.getItem(tokenKey);
  if (stored) {
    return stored;
  }
  const area = storageArea("local");
  if (!area) return "";
  const items = await chromeGet(area, tokenKey);
  return typeof items[tokenKey] === "string" ? items[tokenKey] : "";
}

export async function saveToken(token) {
  const trimmed = token.trim();
  if (trimmed) {
    globalThis.localStorage?.setItem(tokenKey, trimmed);
  } else {
    globalThis.localStorage?.removeItem(tokenKey);
  }
  const local = storageArea("local");
  const session = storageArea("session");
  if (local) {
    await chromeRemove(local, tokenKey);
  }
  if (session) {
    await chromeRemove(session, tokenKey);
  }
}

export async function clearToken() {
  globalThis.localStorage?.removeItem(tokenKey);
  const local = storageArea("local");
  const session = storageArea("session");
  await Promise.all([
    local ? chromeRemove(local, tokenKey) : Promise.resolve(),
    session ? chromeRemove(session, tokenKey) : Promise.resolve()
  ]);
}
