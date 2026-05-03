export const API_BASE = window.location.origin;
export const STORAGE_KEY = "sub2api-chat-session-api-key";
export const THEME_STORAGE_KEY = "sub2api-chat-theme";

export function getStoredApiKey() {
  try {
    const persistedApiKey = localStorage.getItem(STORAGE_KEY) || "";
    if (persistedApiKey) {
      return persistedApiKey;
    }

    const sessionApiKey = sessionStorage.getItem(STORAGE_KEY) || "";
    if (sessionApiKey) {
      localStorage.setItem(STORAGE_KEY, sessionApiKey);
      sessionStorage.removeItem(STORAGE_KEY);
    }

    return sessionApiKey;
  } catch (error) {
    return "";
  }
}

export function storeApiKey(apiKey) {
  try {
    localStorage.setItem(STORAGE_KEY, apiKey);
    sessionStorage.removeItem(STORAGE_KEY);
    return true;
  } catch (error) {
    return false;
  }
}

export function clearStoredApiKey() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
  } catch (error) {
  }
}

export function maskApiKey(apiKey) {
  if (!apiKey) {
    return "未验证";
  }

  if (apiKey.length <= 12) {
    return `${apiKey.slice(0, 3)}...`;
  }

  return `${apiKey.slice(0, 7)}...${apiKey.slice(-4)}`;
}

export function getStoredTheme() {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY) || "";
    return value === "light" || value === "dark" ? value : "";
  } catch (error) {
    return "";
  }
}

export function resolveInitialTheme() {
  const storedTheme = getStoredTheme();
  if (storedTheme) {
    return storedTheme;
  }

  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme, options = {}) {
  const { persist = true } = options;
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = nextTheme;
  document.documentElement.classList.toggle("dark", nextTheme === "dark");

  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch (error) {
    }
  }

  return nextTheme;
}

export function setupThemeToggle(button) {
  if (!button) {
    return;
  }

  const sync = () => {
    const isDark = document.documentElement.classList.contains("dark");
    button.setAttribute("aria-label", isDark ? "切换到浅色模式" : "切换到暗色模式");
    button.setAttribute("title", isDark ? "切换到浅色模式" : "切换到暗色模式");
    button.setAttribute("aria-pressed", String(isDark));
  };

  sync();
  button.addEventListener("click", () => {
    applyTheme(document.documentElement.classList.contains("dark") ? "light" : "dark");
    sync();
  });
}

export function setStatus(target, text, tone = "") {
  if (!target) {
    return;
  }

  target.textContent = text;
  target.className = tone ? `status ${tone}` : "status";
}

export function extractErrorMessage(payload, fallbackMessage = "请求失败") {
  if (!payload) {
    return fallbackMessage;
  }

  if (typeof payload?.error?.message === "string") {
    return payload.error.message;
  }

  if (typeof payload?.message === "string") {
    return payload.message;
  }

  if (typeof payload?.raw === "string") {
    return payload.raw;
  }

  return fallbackMessage;
}

export async function readJsonOrThrow(response) {
  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    throw new Error(extractErrorMessage(data, `HTTP ${response.status}`));
  }

  return data;
}

export async function validateApiKey(apiKey) {
  const response = await fetch(`${API_BASE}/v1/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    cache: "no-store"
  });

  return readJsonOrThrow(response);
}

export function extractModels(payload) {
  if (!Array.isArray(payload?.data)) {
    return [];
  }

  return payload.data
    .map((item) => item?.id || item?.name || item?.model)
    .filter((item) => typeof item === "string" && item.trim());
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}
