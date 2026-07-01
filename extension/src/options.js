import {
  clearToken,
  loadSettings,
  loadToken,
  normalizeTheme,
  saveSettings,
  saveToken
} from "./storage.js";

const $ = (id) => document.getElementById(id);

function applyTheme(theme) {
  const preferred = normalizeTheme(theme);
  const effective =
    preferred === "system"
      ? globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : preferred;
  document.documentElement.dataset.theme = effective;
  document.documentElement.style.colorScheme = effective;
}

async function init() {
  const settings = await loadSettings();
  const token = await loadToken();
  applyTheme(settings.theme);
  $("optionsTheme").value = normalizeTheme(settings.theme);
  $("optionsToken").value = token;
  $("optionsSave").addEventListener("click", async () => {
    const next = {
      ...settings,
      theme: normalizeTheme($("optionsTheme").value)
    };
    await saveSettings(next);
    await saveToken($("optionsToken").value);
    applyTheme(next.theme);
    $("optionsStatus").textContent = "저장했습니다.";
  });
  $("optionsClear").addEventListener("click", async () => {
    $("optionsToken").value = "";
    await clearToken();
    $("optionsStatus").textContent = "삭제했습니다.";
  });
}

init().catch((error) => {
  $("optionsStatus").textContent = error.message;
});
