/**
 * Dark/light theme manager.
 * Persiste em localStorage; aplica .dark-mode no <body> que ativa overrides
 * de CSS em src/css/styles.css.
 *
 * Usar:
 *   - Botão da UI dispara `toggleTheme()`
 *   - app.js chama `initTheme()` no DOMContentLoaded
 */

const STORAGE_KEY = "namao_theme";
const VALID = new Set(["light", "dark"]);

export function getTheme() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (VALID.has(v)) return v;
  } catch { /* ignore */ }
  // Default: sempre claro. Modo escuro só se o motorista escolher.
  return "light";
}

export function setTheme(theme) {
  if (!VALID.has(theme)) return;
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* ignore */ }
  applyTheme(theme);
}

export function applyTheme(theme) {
  if (theme === "dark") {
    document.body.classList.add("dark-mode");
    document.documentElement.style.colorScheme = "dark";
  } else {
    document.body.classList.remove("dark-mode");
    document.documentElement.style.colorScheme = "light";
  }
  // Atualiza estado visual do toggle se existir
  const toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    toggle.querySelector(".theme-toggle-thumb")?.classList.toggle("on", theme === "dark");
    toggle.querySelector(".theme-toggle-label")?.replaceChildren(
      document.createTextNode(theme === "dark" ? "Modo escuro ativado" : "Modo claro"),
    );
  }
}

export function toggleTheme() {
  const next = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
}

export function initTheme() {
  applyTheme(getTheme());
}

// Disponibiliza no escopo global pra onclick="toggleTheme()" no HTML
if (typeof window !== "undefined") {
  window.toggleTheme = toggleTheme;
}
