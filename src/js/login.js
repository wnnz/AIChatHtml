import {
  applyTheme,
  extractModels,
  getStoredApiKey,
  resolveInitialTheme,
  setStatus,
  setupThemeToggle,
  storeApiKey,
  validateApiKey
} from "./shared.js";

const refs = {
  form: document.getElementById("login-form"),
  apiKeyInput: document.getElementById("api-key-input"),
  submitButton: document.getElementById("login-button"),
  status: document.getElementById("auth-status"),
  themeToggle: document.getElementById("theme-toggle")
};

applyTheme(resolveInitialTheme(), { persist: false });
setupThemeToggle(refs.themeToggle);

if (getStoredApiKey()) {
  window.location.replace("./index.html");
}

const params = new URLSearchParams(window.location.search);
if (params.get("reason") === "expired") {
  setStatus(refs.status, "登录状态已失效，请重新输入访问密钥。", "error");
}

refs.form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const apiKey = refs.apiKeyInput.value.trim();
  if (!apiKey) {
    setStatus(refs.status, "请先输入访问密钥。", "error");
    refs.apiKeyInput.focus();
    return;
  }

  refs.submitButton.disabled = true;
  refs.apiKeyInput.disabled = true;
  setStatus(refs.status, "正在校验访问密钥并拉取模型列表...");

  try {
    const payload = await validateApiKey(apiKey);
    const models = extractModels(payload);
    storeApiKey(apiKey);
    setStatus(refs.status, models.length ? `校验成功，已发现 ${models.length} 个模型。` : "校验成功，正在进入主页面。", "success");
    window.location.replace("./index.html");
  } catch (error) {
    setStatus(refs.status, `校验失败：${error.message}`, "error");
    refs.submitButton.disabled = false;
    refs.apiKeyInput.disabled = false;
    refs.apiKeyInput.focus();
  }
});
