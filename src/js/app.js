import {
  API_BASE,
  applyTheme,
  clearStoredApiKey,
  escapeHtml,
  extractErrorMessage,
  extractModels,
  getStoredApiKey,
  maskApiKey,
  readJsonOrThrow,
  resolveInitialTheme,
  setStatus,
  setupThemeToggle,
  validateApiKey
} from "./shared.js";

const SESSIONS_STORAGE_KEY = "sub2api-chat-history";
const LAST_MODEL_STORAGE_KEY = "sub2api-chat-last-model";
const DEFAULT_SYSTEM_PROMPT = "你是一个准确、直接、简洁的中文助手。";
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_AUTO_RETRY_COUNT = 5;
const AUTO_RETRY_BASE_DELAY_MS = 700;
const AUTO_RETRY_MAX_DELAY_MS = 3200;
const SUPPORTED_FILE_EXTENSIONS = new Set([
  "pdf", "txt", "md", "csv", "tsv", "json", "jsonl", "xml", "html", "htm",
  "doc", "docx", "odt", "rtf", "ppt", "pptx", "odp", "xls", "xlsx", "xla", "xlb", "xlc", "xlm", "xlt", "xlw", "iif",
  "js", "jsx", "ts", "tsx", "py", "java", "c", "cpp", "cs", "go", "rs", "php", "rb", "swift", "kt", "sql", "sh", "bat", "ps1", "yml", "yaml", "css"
]);
const SUPPORTED_FILE_MIME_TYPES = new Set([
  "application/pdf",
  "application/json",
  "application/rtf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint"
]);

const cachedApiKey = getStoredApiKey();
if (!cachedApiKey) {
  window.location.replace("./login.html");
}

const refs = {
  body: document.body,
  sidebarToggle: document.getElementById("sidebar-toggle"),
  mobileBackdrop: document.getElementById("mobile-sidebar-backdrop"),
  themeToggle: document.getElementById("theme-toggle"),
  logoutButton: document.getElementById("logout-button"),
  tokenValue: document.getElementById("token-value"),
  newSessionButton: document.getElementById("new-session-button"),
  clearSessionsButton: document.getElementById("clear-sessions-button"),
  sessionList: document.getElementById("session-list"),
  sessionEmpty: document.getElementById("session-empty"),
  searchInput: document.getElementById("session-search-input"),
  modelPicker: document.getElementById("model-picker"),
  modelTrigger: document.getElementById("model-trigger"),
  modelTriggerValue: document.getElementById("model-trigger-value"),
  modelMenu: document.getElementById("model-menu"),
  modelUsage: document.getElementById("model-usage"),
  systemPromptInput: document.getElementById("system-prompt-input"),
  messageContextBar: document.getElementById("message-context-bar"),
  messageContextText: document.getElementById("message-context-bar-text"),
  messages: document.getElementById("messages"),
  emptyState: document.getElementById("empty-state"),
  composer: document.getElementById("composer"),
  composerStatus: document.getElementById("composer-status"),
  composerAttachments: document.getElementById("composer-attachments"),
  attachmentPicker: document.getElementById("attachment-picker"),
  attachmentMenu: document.getElementById("attachment-menu"),
  imageInput: document.getElementById("image-input"),
  fileInput: document.getElementById("file-input"),
  imageButton: document.getElementById("image-button"),
  messageInput: document.getElementById("message-input"),
  sendButton: document.getElementById("send-button"),
  suggestionButtons: document.querySelectorAll("[data-suggestion]")
};

const state = {
  apiKey: cachedApiKey,
  models: [],
  selectedModel: "",
  sessions: [],
  currentSessionId: "",
  conversation: [],
  pendingAttachments: [],
  busy: false,
  openSessionMenuId: "",
  activeResponseAnchor: null
};

const customScrollbars = new Map();
let customScrollbarFrame = 0;
let messageContextFrame = 0;

applyTheme(resolveInitialTheme(), { persist: false });
setupThemeToggle(refs.themeToggle);
refs.tokenValue.textContent = maskApiKey(state.apiKey);

function generateId(prefix) {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneAttachments(attachments) {
  return Array.isArray(attachments)
    ? attachments.map(normalizeAttachment).filter(Boolean)
    : [];
}

function getFileExtension(name) {
  const value = typeof name === "string" ? name.trim().toLowerCase() : "";
  const dotIndex = value.lastIndexOf(".");
  return dotIndex >= 0 ? value.slice(dotIndex + 1) : "";
}

function getAttachmentKind(attachment) {
  if (attachment?.kind === "image" || attachment?.kind === "file") {
    return attachment.kind;
  }

  const mimeType = typeof attachment?.mimeType === "string" ? attachment.mimeType : "";
  const dataUrl = typeof attachment?.dataUrl === "string" ? attachment.dataUrl : "";
  return mimeType.startsWith("image/") || dataUrl.startsWith("data:image/") ? "image" : "file";
}

function normalizeAttachment(attachment) {
  if (!attachment || typeof attachment !== "object") {
    return null;
  }

  const dataUrl = typeof attachment.dataUrl === "string" ? attachment.dataUrl : "";
  if (!dataUrl.startsWith("data:")) {
    return null;
  }

  const kind = getAttachmentKind(attachment);
  return {
    id: typeof attachment.id === "string" && attachment.id ? attachment.id : generateId("attachment"),
    kind,
    name: typeof attachment.name === "string" && attachment.name.trim() ? attachment.name.trim() : (kind === "image" ? "图片" : "文件"),
    mimeType: typeof attachment.mimeType === "string" && attachment.mimeType ? attachment.mimeType : (kind === "image" ? "image/png" : "application/octet-stream"),
    size: Number.isFinite(attachment.size) ? attachment.size : 0,
    dataUrl
  };
}

function normalizeMessage(message) {
  if (!message || typeof message !== "object" || typeof message.role !== "string") {
    return null;
  }

  return {
    role: message.role,
    content: typeof message.content === "string" ? message.content : "",
    attachments: cloneAttachments(message.attachments),
    timestamp: typeof message.timestamp === "string" ? message.timestamp : "",
    meta: typeof message.meta === "string" ? message.meta : ""
  };
}

function deriveSessionTitle(conversation) {
  const firstUserMessage = conversation.find((message) => {
    return message.role === "user" && (message.content.trim() || message.attachments?.length);
  });

  if (!firstUserMessage) {
    return "新会话";
  }

  if (!firstUserMessage.content.trim()) {
    const attachments = cloneAttachments(firstUserMessage.attachments);
    const fileCount = attachments.filter((attachment) => attachment.kind === "file").length;
    return fileCount
      ? `文件对话 ${attachments.length || 1} 个`
      : `图片对话 ${attachments.length || 1} 张`;
  }

  return firstUserMessage.content.trim().replace(/\s+/g, " ").slice(0, 28);
}

function buildMessagePreview(text, attachments = []) {
  const normalizedText = typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
  if (normalizedText) {
    return normalizedText;
  }

  const normalizedAttachments = cloneAttachments(attachments);
  if (!normalizedAttachments.length) {
    return "空白消息";
  }

  const imageCount = normalizedAttachments.filter((attachment) => attachment.kind === "image").length;
  const fileCount = normalizedAttachments.length - imageCount;
  const parts = [];

  if (imageCount) {
    parts.push(`${imageCount} 张图片`);
  }

  if (fileCount) {
    parts.push(`${fileCount} 个附件`);
  }

  return parts.join("，");
}

function normalizeSession(session) {
  if (!session || typeof session !== "object") {
    return null;
  }

  const conversation = Array.isArray(session.conversation)
    ? session.conversation.map(normalizeMessage).filter(Boolean)
    : [];
  const createdAt = typeof session.createdAt === "string" && session.createdAt ? session.createdAt : new Date().toISOString();
  const updatedAt = typeof session.updatedAt === "string" && session.updatedAt ? session.updatedAt : createdAt;

  return {
    id: typeof session.id === "string" && session.id ? session.id : generateId("session"),
    title: typeof session.title === "string" && session.title.trim() ? session.title.trim() : deriveSessionTitle(conversation),
    customTitle: typeof session.customTitle === "string" ? session.customTitle.trim() : "",
    createdAt,
    updatedAt,
    selectedModel: typeof session.selectedModel === "string" ? session.selectedModel : "",
    lastTokenUsageText: typeof session.lastTokenUsageText === "string" ? session.lastTokenUsageText : "",
    instructions: typeof session.instructions === "string" && session.instructions.trim() ? session.instructions : DEFAULT_SYSTEM_PROMPT,
    conversation
  };
}

function loadSessionState() {
  try {
    const raw = sessionStorage.getItem(SESSIONS_STORAGE_KEY);
    if (!raw) {
      return { sessions: [], currentSessionId: "" };
    }

    const parsed = JSON.parse(raw);
    return {
      sessions: Array.isArray(parsed?.sessions) ? parsed.sessions.map(normalizeSession).filter(Boolean) : [],
      currentSessionId: typeof parsed?.currentSessionId === "string" ? parsed.currentSessionId : ""
    };
  } catch (error) {
    return { sessions: [], currentSessionId: "" };
  }
}

function storeSessionState() {
  try {
    sessionStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify({
      sessions: state.sessions,
      currentSessionId: state.currentSessionId
    }));
  } catch (error) {
  }
}

function createSession(options = {}) {
  const createdAt = new Date().toISOString();
  return normalizeSession({
    id: options.id || generateId("session"),
    title: options.title || "新会话",
    createdAt,
    updatedAt: createdAt,
    selectedModel: options.selectedModel || state.selectedModel,
    instructions: options.instructions || DEFAULT_SYSTEM_PROMPT,
    conversation: []
  });
}

function sortSessions() {
  state.sessions.sort((left, right) => {
    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  });
}

function getCurrentSession() {
  return state.sessions.find((session) => session.id === state.currentSessionId) || null;
}

function getStoredLastModel() {
  try {
    return localStorage.getItem(LAST_MODEL_STORAGE_KEY) || "";
  } catch (error) {
    return "";
  }
}

function storeLastModel(model) {
  if (!model) {
    return;
  }

  try {
    localStorage.setItem(LAST_MODEL_STORAGE_KEY, model);
  } catch (error) {
  }
}

function wait(durationMs) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, durationMs);
  });
}

function getAutoRetryDelayMs(retryCount) {
  return Math.min(AUTO_RETRY_MAX_DELAY_MS, AUTO_RETRY_BASE_DELAY_MS * retryCount);
}

function shouldRestoreComposerFocus() {
  return !window.matchMedia("(max-width: 767px), (pointer: coarse)").matches;
}

function getPreferredModel(models) {
  const stored = getStoredLastModel();
  return stored && models.includes(stored) ? stored : models[0] || "";
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  } catch (error) {
    return "";
  }
}

function saveCurrentSession(touchUpdated = false) {
  const session = getCurrentSession();
  if (!session) {
    return;
  }

  session.conversation = state.conversation.map((message) => ({
    role: message.role,
    content: message.content,
    attachments: cloneAttachments(message.attachments),
    timestamp: message.timestamp || "",
    meta: message.meta || ""
  }));
  session.selectedModel = state.selectedModel;
  session.instructions = refs.systemPromptInput.value.trim() || DEFAULT_SYSTEM_PROMPT;
  session.title = session.customTitle || deriveSessionTitle(session.conversation);

  if (touchUpdated) {
    session.updatedAt = new Date().toISOString();
    sortSessions();
  }

  storeSessionState();
  renderSessionList();
}

function activateSession(sessionId, options = {}) {
  const { skipSave = false, focusMessage = false } = options;
  if (!skipSave) {
    saveCurrentSession(false);
  }

  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) {
    return;
  }

  state.currentSessionId = session.id;
  state.conversation = session.conversation.map((message) => ({
    ...message,
    attachments: cloneAttachments(message.attachments)
  }));
  state.selectedModel = session.selectedModel && state.models.includes(session.selectedModel)
    ? session.selectedModel
    : getPreferredModel(state.models);
  refs.systemPromptInput.value = session.instructions || DEFAULT_SYSTEM_PROMPT;
  refs.messageInput.value = "";
  clearPendingAttachments();
  syncModelPicker();
  renderConversation();
  renderSessionList();
  storeSessionState();

  if (focusMessage) {
    refs.messageInput.focus();
  }
}

function createNewSession(options = {}) {
  saveCurrentSession(false);
  const session = createSession();
  state.sessions.unshift(session);
  state.currentSessionId = session.id;
  state.conversation = [];
  refs.systemPromptInput.value = session.instructions;
  clearPendingAttachments();
  renderConversation();
  renderSessionList();
  storeSessionState();
  closeSidebarOnMobile();

  if (options.focusMessage !== false) {
    refs.messageInput.focus();
  }
}

function renderSessionList() {
  const query = refs.searchInput.value.trim().toLowerCase();
  refs.sessionList.innerHTML = "";
  const visibleSessions = state.sessions.filter((session) => {
    return !query || session.title.toLowerCase().includes(query);
  });

  refs.sessionEmpty.hidden = visibleSessions.length > 0;

  visibleSessions.forEach((session) => {
    const wrapper = document.createElement("div");
    wrapper.className = "relative";

    const button = document.createElement("button");
    button.type = "button";
    button.dataset.sessionId = session.id;
    button.className = `session-item group ${session.id === state.currentSessionId ? "is-active" : ""}`;

    const copy = document.createElement("span");
    copy.className = "min-w-0";
    copy.innerHTML = `
      <span class="block truncate text-sm font-semibold">${escapeHtml(session.title)}</span>
      <span class="mt-1 block truncate text-xs text-slate-500 dark:text-slate-400">${escapeHtml(formatDate(session.updatedAt))}</span>
    `;

    const actions = document.createElement("span");
    actions.className = "flex shrink-0 gap-1 opacity-0 transition group-hover:opacity-100";
    actions.innerHTML = `
      <span data-action="rename" data-session-id="${escapeHtml(session.id)}" class="grid h-8 w-8 place-items-center rounded-full bg-white/65 text-xs font-bold text-slate-600 dark:bg-white/10 dark:text-slate-200">改</span>
      <span data-action="delete" data-session-id="${escapeHtml(session.id)}" class="grid h-8 w-8 place-items-center rounded-full bg-white/65 text-xs font-bold text-rose-500 dark:bg-white/10">删</span>
    `;

    button.append(copy, actions);
    wrapper.append(button);
    refs.sessionList.append(wrapper);
  });

  scheduleCustomScrollbarRefresh();
}

function deleteSession(sessionId) {
  const nextSessions = state.sessions.filter((session) => session.id !== sessionId);
  state.sessions = nextSessions;

  if (!state.sessions.length) {
    createNewSession({ focusMessage: false });
    return;
  }

  const nextCurrent = state.currentSessionId === sessionId ? state.sessions[0].id : state.currentSessionId;
  activateSession(nextCurrent, { skipSave: true });
}

function renameSession(sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) {
    return;
  }

  const nextTitle = window.prompt("重命名会话", session.title);
  if (!nextTitle) {
    return;
  }

  session.customTitle = nextTitle.trim();
  session.title = session.customTitle || deriveSessionTitle(session.conversation);
  session.updatedAt = new Date().toISOString();
  sortSessions();
  storeSessionState();
  renderSessionList();
}

function setSidebarOpen(isOpen) {
  refs.body.classList.toggle("sidebar-open", Boolean(isOpen));
  refs.sidebarToggle.setAttribute("aria-expanded", String(Boolean(isOpen)));
}

function closeSidebarOnMobile() {
  if (window.matchMedia("(max-width: 1023px)").matches) {
    setSidebarOpen(false);
  }
}

function syncBusy() {
  const disabled = state.busy;
  refs.logoutButton.disabled = disabled;
  refs.newSessionButton.disabled = disabled;
  refs.clearSessionsButton.disabled = disabled;
  refs.imageButton.disabled = disabled;
  refs.imageInput.disabled = disabled;
  refs.fileInput.disabled = disabled;
  refs.sendButton.disabled = disabled;
  refs.messageInput.disabled = disabled;
  refs.systemPromptInput.disabled = disabled;
  document.querySelectorAll(".message-retry-button").forEach((button) => {
    button.disabled = disabled;
  });

  if (disabled) {
    setAttachmentMenuOpen(false);
  }
}

function syncModelPicker() {
  refs.modelTriggerValue.textContent = state.selectedModel || "暂无可用模型";
  refs.modelTrigger.classList.toggle("opacity-55", !state.selectedModel);
  refs.modelMenu.innerHTML = "";

  if (!state.models.length) {
    const empty = document.createElement("div");
    empty.className = "px-4 py-3 text-sm text-slate-500 dark:text-slate-400";
    empty.textContent = "没有读取到模型。";
    refs.modelMenu.append(empty);
    setupCustomScrollbars(refs.modelMenu);
    return;
  }

  state.models.forEach((model) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = `model-option ${model === state.selectedModel ? "is-selected" : ""}`;
    option.dataset.model = model;
    option.innerHTML = `<span class="truncate">${escapeHtml(model)}</span><span>${model === state.selectedModel ? "✓" : ""}</span>`;
    refs.modelMenu.append(option);
  });

  setupCustomScrollbars(refs.modelMenu);
}

function setModelMenuOpen(isOpen) {
  refs.modelMenu.hidden = !isOpen;
  refs.modelTrigger.setAttribute("aria-expanded", String(isOpen));
  scheduleCustomScrollbarRefresh();
}

function setAttachmentMenuOpen(isOpen) {
  refs.attachmentMenu.hidden = !isOpen;
  refs.imageButton.setAttribute("aria-expanded", String(isOpen));
}

function shouldSendOnEnter(event) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) {
    return false;
  }

  return !window.matchMedia("(max-width: 1023px) and (pointer: coarse)").matches;
}

function getScrollbarTargets(root = document) {
  const selector = ".scrollbar-soft, .model-menu, textarea, .message-markdown pre";
  const targets = new Set();

  if (root instanceof Element && root.matches(selector)) {
    targets.add(root);
  }

  root.querySelectorAll?.(selector).forEach((target) => targets.add(target));
  return Array.from(targets);
}

function getScrollbarAxis(target) {
  return target.matches(".message-markdown pre") ? "x" : "y";
}

function getScrollbarMetrics(target, axis) {
  const scrollSize = axis === "y" ? target.scrollHeight : target.scrollWidth;
  const clientSize = axis === "y" ? target.clientHeight : target.clientWidth;
  const scrollPosition = axis === "y" ? target.scrollTop : target.scrollLeft;
  return {
    scrollSize,
    clientSize,
    scrollPosition,
    maxScroll: Math.max(0, scrollSize - clientSize)
  };
}

function setScrollbarPosition(target, axis, value) {
  if (axis === "y") {
    target.scrollTop = value;
    return;
  }

  target.scrollLeft = value;
}

function refreshCustomScrollbar(entry) {
  const { target, parent, bar, thumb, axis } = entry;
  if (!target.isConnected || !bar.isConnected) {
    entry.resizeObserver?.disconnect();
    bar.remove();
    customScrollbars.delete(target);
    return;
  }

  const targetRect = target.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  const metrics = getScrollbarMetrics(target, axis);
  const isVisible = metrics.maxScroll > 1 && targetRect.width > 0 && targetRect.height > 0;
  bar.classList.toggle("is-visible", isVisible);

  if (!isVisible) {
    return;
  }

  if (axis === "y") {
    const inset = Math.min(14, Math.max(8, targetRect.height * 0.06));
    const barLength = Math.max(36, targetRect.height - inset * 2);
    const thumbLength = Math.min(barLength, Math.max(30, barLength * (metrics.clientSize / metrics.scrollSize)));
    const travel = Math.max(0, barLength - thumbLength);
    const offset = metrics.maxScroll ? (metrics.scrollPosition / metrics.maxScroll) * travel : 0;
    const outsideOffset = target.classList.contains("session-scroll") ? 4 : -10;

    bar.style.left = `${targetRect.right - parentRect.left + outsideOffset}px`;
    bar.style.top = `${targetRect.top - parentRect.top + inset}px`;
    bar.style.width = "";
    bar.style.height = `${barLength}px`;
    thumb.style.width = "";
    thumb.style.height = `${thumbLength}px`;
    thumb.style.transform = `translate3d(0, ${offset}px, 0)`;
    return;
  }

  const inset = Math.min(14, Math.max(8, targetRect.width * 0.04));
  const barLength = Math.max(36, targetRect.width - inset * 2);
  const thumbLength = Math.min(barLength, Math.max(30, barLength * (metrics.clientSize / metrics.scrollSize)));
  const travel = Math.max(0, barLength - thumbLength);
  const offset = metrics.maxScroll ? (metrics.scrollPosition / metrics.maxScroll) * travel : 0;

  bar.style.left = `${targetRect.left - parentRect.left + inset}px`;
  bar.style.top = `${targetRect.bottom - parentRect.top - 10}px`;
  bar.style.width = `${barLength}px`;
  bar.style.height = "";
  thumb.style.width = `${thumbLength}px`;
  thumb.style.height = "";
  thumb.style.transform = `translate3d(${offset}px, 0, 0)`;
}

function refreshCustomScrollbars() {
  customScrollbarFrame = 0;
  customScrollbars.forEach(refreshCustomScrollbar);
}

function scheduleCustomScrollbarRefresh() {
  if (customScrollbarFrame) {
    return;
  }

  customScrollbarFrame = requestAnimationFrame(refreshCustomScrollbars);
}

function bindCustomScrollbarDrag(entry) {
  const { target, thumb, axis } = entry;
  thumb.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const startPointer = axis === "y" ? event.clientY : event.clientX;
    const startScroll = axis === "y" ? target.scrollTop : target.scrollLeft;
    const startMetrics = getScrollbarMetrics(target, axis);
    const barLength = axis === "y" ? entry.bar.clientHeight : entry.bar.clientWidth;
    const thumbLength = axis === "y" ? thumb.offsetHeight : thumb.offsetWidth;
    const travel = Math.max(1, barLength - thumbLength);

    const handlePointerMove = (moveEvent) => {
      const nextPointer = axis === "y" ? moveEvent.clientY : moveEvent.clientX;
      const pointerDelta = nextPointer - startPointer;
      const scrollDelta = (pointerDelta / travel) * startMetrics.maxScroll;
      setScrollbarPosition(target, axis, startScroll + scrollDelta);
    };

    const handlePointerUp = () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp, { once: true });
  });
}

function ensureCustomScrollbar(target) {
  if (!target?.parentElement || customScrollbars.has(target)) {
    return;
  }

  const axis = getScrollbarAxis(target);
  const parent = target.parentElement;
  parent.classList.add("custom-scrollbar-owner");
  const bar = document.createElement("div");
  bar.className = axis === "y" ? "custom-scrollbar custom-scrollbar-y" : "custom-scrollbar custom-scrollbar-x";
  const thumb = document.createElement("div");
  thumb.className = "custom-scrollbar-thumb";
  bar.append(thumb);
  parent.append(bar);

  const entry = { target, parent, bar, thumb, axis };
  customScrollbars.set(target, entry);
  target.addEventListener("scroll", scheduleCustomScrollbarRefresh, { passive: true });
  target.addEventListener("input", scheduleCustomScrollbarRefresh);
  bindCustomScrollbarDrag(entry);

  if (window.ResizeObserver) {
    entry.resizeObserver = new ResizeObserver(scheduleCustomScrollbarRefresh);
    entry.resizeObserver.observe(target);
    entry.resizeObserver.observe(parent);
  }
}

function setupCustomScrollbars(root = document) {
  getScrollbarTargets(root).forEach(ensureCustomScrollbar);
  scheduleCustomScrollbarRefresh();
}

function selectModel(model) {
  if (!state.models.includes(model)) {
    return;
  }

  state.selectedModel = model;
  storeLastModel(model);
  saveCurrentSession(false);
  syncModelPicker();
  setModelMenuOpen(false);
}

function renderInlineMarkdown(text) {
  const replacements = [];
  const stashHtml = (html) => {
    const token = `__MARKDOWN_TOKEN_${replacements.length}__`;
    replacements.push({ token, html });
    return token;
  };

  let html = String(text || "")
    .replace(/`([^`]+)`/g, (_, code) => stashHtml(`<code>${escapeHtml(code)}</code>`))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => {
      return stashHtml(`<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`);
    })
  html = escapeHtml(html)
    .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+?)__/g, "<strong>$1</strong>")
    .replace(/~~([^~]+?)~~/g, "<del>$1</del>")
    .replace(/(^|[\s(>])\*([^*\n][^*\n]*?)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>")
    .replace(/(^|[\s(>])_([^_\n][^_\n]*?)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");

  replacements.forEach(({ token, html: tokenHtml }) => {
    html = html.split(token).join(tokenHtml);
  });

  return html;
}

function parseMarkdownFence(line) {
  const match = String(line || "").match(/^(`{3,}|~{3,})([^\s`~]*)\s*$/);
  if (!match) {
    return null;
  }

  return {
    marker: match[1],
    language: match[2] || ""
  };
}

function isMarkdownFence(line) {
  return Boolean(parseMarkdownFence(line));
}

function isMarkdownFenceClose(line, openingMarker) {
  if (!openingMarker) {
    return false;
  }

  const closePattern = new RegExp(`^${openingMarker[0]}{${openingMarker.length},}\\s*$`);
  return closePattern.test(String(line || ""));
}

function isMarkdownHeading(line) {
  return /^(#{1,6})\s+/.test(line);
}

function isMarkdownQuote(line) {
  return /^>\s?/.test(line);
}

function isMarkdownUnorderedItem(line) {
  return /^[-*+]\s+/.test(line.trim());
}

function isMarkdownOrderedItem(line) {
  return /^\d+\.\s+/.test(line.trim());
}

function isMarkdownRule(line) {
  return /^([-*_])(?:\s*\1){2,}\s*$/.test(line.trim());
}

function renderMarkdownParagraph(lines) {
  return `<p>${lines.map((line) => renderInlineMarkdown(line)).join("<br>")}</p>`;
}

function renderMarkdownList(lines, ordered = false) {
  const tag = ordered ? "ol" : "ul";
  const pattern = ordered ? /^\d+\.\s+/ : /^[-*+]\s+/;
  const items = lines
    .map((line) => line.trim().replace(pattern, ""))
    .filter(Boolean)
    .map((line) => `<li>${renderInlineMarkdown(line)}</li>`)
    .join("");
  return `<${tag}>${items}</${tag}>`;
}

const CODE_LANGUAGE_ALIASES = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  html: "markup",
  xml: "markup",
  svg: "markup",
  md: "markdown",
  csharp: "csharp",
  cs: "csharp"
};

const COMMON_CODE_KEYWORDS = [
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "return",
  "try", "catch", "finally", "throw", "new", "class", "extends", "static", "function",
  "const", "let", "var", "async", "await", "import", "export", "from", "default",
  "true", "false", "null", "undefined"
];

const LANGUAGE_CODE_KEYWORDS = {
  javascript: ["typeof", "instanceof", "delete", "yield"],
  typescript: ["type", "interface", "implements", "public", "private", "protected", "readonly", "enum", "as"],
  python: ["def", "elif", "lambda", "pass", "raise", "None", "True", "False", "in", "is", "and", "or", "not", "with", "from", "import", "class", "global", "nonlocal", "assert"],
  bash: ["then", "fi", "elif", "done", "esac", "function", "local", "export", "readonly", "case", "in"],
  java: ["package", "public", "private", "protected", "interface", "implements", "throws", "this", "super", "final"],
  go: ["func", "package", "defer", "go", "select", "chan", "map", "range", "struct", "interface", "fallthrough"],
  csharp: ["namespace", "using", "public", "private", "protected", "internal", "sealed", "partial", "record", "var", "nameof"],
  sql: ["select", "from", "where", "join", "left", "right", "inner", "outer", "group", "order", "by", "having", "limit", "insert", "into", "values", "update", "set", "delete", "create", "table", "and", "or", "not", "as", "on", "union", "distinct"],
  css: ["important", "inherit", "initial", "unset"],
  json: [],
  yaml: []
};

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCodeLanguage(language) {
  const normalized = String(language || "").trim().toLowerCase();
  return CODE_LANGUAGE_ALIASES[normalized] || normalized;
}

function highlightCodeWithLibrary(code, language = "") {
  const hljs = window.hljs;
  if (!hljs?.highlight) {
    return null;
  }

  const normalizedLanguage = normalizeCodeLanguage(language);

  try {
    if (normalizedLanguage && hljs.getLanguage?.(normalizedLanguage)) {
      const result = hljs.highlight(code, {
        language: normalizedLanguage,
        ignoreIllegals: true
      });
      return {
        html: result.value,
        language: result.language || normalizedLanguage
      };
    }

    const result = hljs.highlightAuto(code);
    return {
      html: result.value,
      language: result.language || normalizedLanguage || ""
    };
  } catch {
    return null;
  }
}

function buildKeywordMatcher(keywords) {
  if (!keywords.length) {
    return null;
  }

  return new RegExp(`^(?:${keywords.map(escapeRegExp).join("|")})\\b`, "i");
}

function getCodeTokenMatchers(language) {
  const normalizedLanguage = normalizeCodeLanguage(language);
  const keywords = [...COMMON_CODE_KEYWORDS, ...(LANGUAGE_CODE_KEYWORDS[normalizedLanguage] || [])];
  const matchers = [];

  if (["javascript", "typescript", "java", "csharp", "go", "css"].includes(normalizedLanguage)) {
    matchers.push({ type: "comment", pattern: /^\/\*[\s\S]*?(?:\*\/|$)/ });
  }

  if (["javascript", "typescript", "java", "csharp", "go"].includes(normalizedLanguage)) {
    matchers.push({ type: "comment", pattern: /^\/\/.*(?:\n|$)/ });
  }

  if (["python", "bash", "yaml", "ruby", "markdown"].includes(normalizedLanguage)) {
    matchers.push({ type: "comment", pattern: /^#.*(?:\n|$)/ });
  }

  if (normalizedLanguage === "sql") {
    matchers.push({ type: "comment", pattern: /^--.*(?:\n|$)/ });
  }

  if (normalizedLanguage === "markup") {
    matchers.push(
      { type: "comment", pattern: /^<!--[\s\S]*?(?:-->|$)/ },
      { type: "tag", pattern: /^<\/?[A-Za-z][A-Za-z0-9:-]*/ },
      { type: "attr", pattern: /^[A-Za-z_:][A-Za-z0-9:._-]*(?=\=)/ }
    );
  }

  if (normalizedLanguage === "css") {
    matchers.push(
      { type: "decorator", pattern: /^@[A-Za-z-]+/ },
      { type: "property", pattern: /^[A-Za-z-]+(?=\s*:)/ }
    );
  }

  if (["json", "yaml"].includes(normalizedLanguage)) {
    matchers.push({ type: "property", pattern: /^"(?:\\.|[^"\\])*"(?=\s*:)/ });
  }

  matchers.push(
    { type: "decorator", pattern: /^@[A-Za-z_][\w.]*/ },
    { type: "property", pattern: /^[A-Za-z_$][\w$-]*(?=\s*:)/ },
    { type: "variable", pattern: /^\$[{(]?[A-Za-z_][\w]*[})]?/ },
    { type: "string", pattern: /^`(?:\\.|[^`\\])*`?/ },
    { type: "string", pattern: /^"(?:\\.|[^"\\])*"?/ },
    { type: "string", pattern: /^'(?:\\.|[^'\\])*'?/ },
    { type: "number", pattern: /^-?(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i }
  );

  const keywordMatcher = buildKeywordMatcher(keywords);
  if (keywordMatcher) {
    matchers.push({ type: "keyword", pattern: keywordMatcher });
  }

  matchers.push(
    { type: "function", pattern: /^[A-Za-z_$][\w$]*(?=\()/ },
    { type: "tag", pattern: /^<\/?|^\/>|^>/ },
    { type: "operator", pattern: /^(?:===|!==|==|!=|<=|>=|=>|&&|\|\||\+\+|--|[-+*/%<>!=&|^~?:]+)/ }
  );

  return matchers;
}

function highlightCodeSyntax(code, language = "") {
  const source = String(code || "");
  if (!source) {
    return "";
  }

  const matchers = getCodeTokenMatchers(language);
  let index = 0;
  let html = "";

  while (index < source.length) {
    const segment = source.slice(index);
    let matchedToken = null;

    for (const matcher of matchers) {
      const match = segment.match(matcher.pattern);
      if (match?.[0]) {
        matchedToken = {
          type: matcher.type,
          value: match[0]
        };
        break;
      }
    }

    if (!matchedToken) {
      html += escapeHtml(source[index]);
      index += 1;
      continue;
    }

    html += `<span class="token-${matchedToken.type}">${escapeHtml(matchedToken.value)}</span>`;
    index += matchedToken.value.length;
  }

  return html;
}

function renderMarkdownCodeBlock(lines, language = "") {
  const code = lines.join("\n").replace(/\n$/, "");
  const highlighted = highlightCodeWithLibrary(code, language);
  const resolvedLanguage = highlighted?.language || normalizeCodeLanguage(language);
  const classes = ["hljs"];

  if (resolvedLanguage) {
    classes.push(`language-${escapeHtml(resolvedLanguage)}`);
  }

  const html = highlighted?.html || highlightCodeSyntax(code, language);
  return `<pre><code class="${classes.join(" ")}">${html}</code></pre>`;
}

function renderMarkdown(text) {
  const source = String(text || "").replace(/\r\n?/g, "\n");
  if (!source.trim()) {
    return "";
  }

  const lines = source.split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const fenceMatch = parseMarkdownFence(line);
    if (fenceMatch) {
      index += 1;
      const codeLines = [];
      while (index < lines.length && !isMarkdownFenceClose(lines[index], fenceMatch.marker)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push(renderMarkdownCodeBlock(codeLines, fenceMatch.language));
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(headingMatch[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    if (isMarkdownRule(line)) {
      blocks.push("<hr>");
      index += 1;
      continue;
    }

    if (isMarkdownQuote(line)) {
      const quoteLines = [];
      while (index < lines.length && isMarkdownQuote(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${renderMarkdownParagraph(quoteLines)}</blockquote>`);
      continue;
    }

    if (isMarkdownUnorderedItem(line)) {
      const listLines = [];
      while (index < lines.length && isMarkdownUnorderedItem(lines[index])) {
        listLines.push(lines[index]);
        index += 1;
      }
      blocks.push(renderMarkdownList(listLines, false));
      continue;
    }

    if (isMarkdownOrderedItem(line)) {
      const listLines = [];
      while (index < lines.length && isMarkdownOrderedItem(lines[index])) {
        listLines.push(lines[index]);
        index += 1;
      }
      blocks.push(renderMarkdownList(listLines, true));
      continue;
    }

    const paragraphLines = [];
    while (index < lines.length) {
      const currentLine = lines[index];
      if (!currentLine.trim()) {
        break;
      }
      if (
        isMarkdownFence(currentLine)
        || isMarkdownHeading(currentLine)
        || isMarkdownQuote(currentLine)
        || isMarkdownUnorderedItem(currentLine)
        || isMarkdownOrderedItem(currentLine)
        || isMarkdownRule(currentLine)
      ) {
        break;
      }
      paragraphLines.push(currentLine);
      index += 1;
    }
    if (!paragraphLines.length) {
      blocks.push(renderMarkdownParagraph([line]));
      index += 1;
      continue;
    }

    blocks.push(renderMarkdownParagraph(paragraphLines));
  }

  return blocks.join("");
}

function setMessageContent(target, text, role, options = {}) {
  const value = typeof text === "string" ? text : "";
  const { renderAsMarkdown = role !== "system", isStreaming = false } = options;
  target.dataset.rawText = value;

  if (role !== "system") {
    target.classList.toggle("is-streaming", isStreaming);

    if (renderAsMarkdown) {
      target.innerHTML = value ? renderMarkdown(value) : "";
      setupCustomScrollbars(target);
    } else {
      target.textContent = value;
      scheduleCustomScrollbarRefresh();
    }

    return;
  }

  target.textContent = value;
  scheduleCustomScrollbarRefresh();
}

function isNearMessageBottom(offset = 96) {
  return refs.messages.scrollHeight - refs.messages.scrollTop - refs.messages.clientHeight <= offset;
}

function scrollMessagesToBottom() {
  const nextScrollTop = Math.max(0, refs.messages.scrollHeight - refs.messages.clientHeight);
  if (state.activeResponseAnchor) {
    state.activeResponseAnchor.pendingScrollTop = nextScrollTop;
  }

  refs.messages.scrollTop = nextScrollTop;
  scheduleCustomScrollbarRefresh();
  scheduleMessageContextBarUpdate();
}

function scrollMessageToTop(messageItem, offset = 12) {
  if (!messageItem?.isConnected) {
    return;
  }

  const maxScrollTop = Math.max(0, refs.messages.scrollHeight - refs.messages.clientHeight);
  const nextScrollTop = Math.min(maxScrollTop, Math.max(0, messageItem.offsetTop - offset));
  if (state.activeResponseAnchor) {
    state.activeResponseAnchor.pendingScrollTop = nextScrollTop;
  }

  refs.messages.scrollTop = nextScrollTop;
  scheduleCustomScrollbarRefresh();
  scheduleMessageContextBarUpdate();
}

function jumpToMessageItem(messageItem, offset = 12) {
  if (!messageItem?.isConnected) {
    return;
  }

  messageItem.scrollIntoView({ block: "start", inline: "nearest" });
  const nextScrollTop = Math.max(0, refs.messages.scrollTop - offset);
  if (state.activeResponseAnchor) {
    state.activeResponseAnchor.pendingScrollTop = nextScrollTop;
  }

  refs.messages.scrollTop = nextScrollTop;
  scheduleCustomScrollbarRefresh();
  scheduleMessageContextBarUpdate();
}

function reinforceActiveResponseAnchor(userItem) {
  if (state.activeResponseAnchor?.userItem !== userItem) {
    return;
  }

  const currentAnchor = state.activeResponseAnchor;
  currentAnchor.ignoreUserScrollUntil = performance.now() + 500;
  scrollMessageToTop(userItem);

  window.setTimeout(() => {
    if (state.activeResponseAnchor?.userItem === userItem && !state.activeResponseAnchor.userScrolled) {
      scrollMessageToTop(userItem);
    }
  }, 60);

  window.setTimeout(() => {
    if (state.activeResponseAnchor?.userItem === userItem && !state.activeResponseAnchor.userScrolled) {
      scrollMessageToTop(userItem);
    }
  }, 180);
}

function findMessageItemById(messageId) {
  if (!messageId) {
    return null;
  }

  return Array.from(refs.messages.querySelectorAll(".message[data-message-id]"))
    .find((item) => item.dataset.messageId === messageId) || null;
}

function getTopAssistantMessage() {
  const thresholdTop = refs.messages.getBoundingClientRect().top + 8;
  const assistantItems = refs.messages.querySelectorAll(".message.assistant[data-user-message-id]");

  for (const item of assistantItems) {
    if (item.getBoundingClientRect().bottom > thresholdTop) {
      return item;
    }
  }

  return state.activeResponseAnchor?.assistantItem?.isConnected ? state.activeResponseAnchor.assistantItem : null;
}

function isMessageItemVisible(messageItem, threshold = 12) {
  if (!messageItem?.isConnected) {
    return false;
  }

  const containerRect = refs.messages.getBoundingClientRect();
  const messageRect = messageItem.getBoundingClientRect();
  return messageRect.bottom > containerRect.top + threshold && messageRect.top < containerRect.bottom - threshold;
}

function updateMessageContextBar() {
  const assistantItem = getTopAssistantMessage();
  const preview = assistantItem?.dataset.userMessagePreview || "";
  const messageId = assistantItem?.dataset.userMessageId || "";
  const userItem = findMessageItemById(messageId);

  if (!preview || !messageId || !userItem || isMessageItemVisible(userItem)) {
    refs.messageContextBar.hidden = true;
    refs.messageContextBar.dataset.userMessageId = "";
    refs.messageContextText.textContent = "";
    return;
  }

  refs.messageContextBar.hidden = false;
  refs.messageContextBar.dataset.userMessageId = messageId;
  refs.messageContextText.textContent = preview;
}

function scheduleMessageContextBarUpdate() {
  if (messageContextFrame) {
    return;
  }

  messageContextFrame = requestAnimationFrame(() => {
    messageContextFrame = 0;
    updateMessageContextBar();
  });
}

function syncActiveResponseAnchor() {
  const currentAnchor = state.activeResponseAnchor;
  if (!currentAnchor || currentAnchor.userScrolled) {
    return;
  }

  scrollMessageToTop(currentAnchor.userItem);
}

function clearActiveResponseAnchor() {
  const currentAnchor = state.activeResponseAnchor;
  if (!currentAnchor) {
    return;
  }

  currentAnchor.userItem?.classList.remove("is-stream-anchor");
  currentAnchor.assistantItem?.classList.remove("is-stream-response");
  refs.messages.classList.remove("has-stream-anchor");
  state.activeResponseAnchor = null;
  scheduleCustomScrollbarRefresh();
  scheduleMessageContextBarUpdate();
}

function activateResponseAnchor(userItem, assistantItem) {
  clearActiveResponseAnchor();
  if (!userItem?.isConnected || !assistantItem?.isConnected) {
    return;
  }

  userItem.classList.add("is-stream-anchor");
  assistantItem.classList.add("is-stream-response");
  refs.messages.classList.add("has-stream-anchor");
  state.activeResponseAnchor = {
    userItem,
    assistantItem,
    userScrolled: false,
    pendingScrollTop: null,
    ignoreUserScrollUntil: 0
  };
  scrollMessageToTop(userItem);
}

function appendMessage(role, text, options = {}) {
  const {
    attachments = [],
    timestampText = new Date().toLocaleTimeString(),
    metaText = "",
    forceScroll = false,
    allowAutoScroll = true,
    messageId = generateId("message"),
    linkedUserMessageId = "",
    linkedUserMessagePreview = ""
  } = options;

  const shouldAutoScroll = forceScroll || (allowAutoScroll && isNearMessageBottom());
  refs.emptyState.hidden = true;
  const item = document.createElement("article");
  item.className = `message ${role}`;
  item.dataset.messageId = messageId;
  item.dataset.role = role;

  if (role === "user") {
    item.dataset.messagePreview = buildMessagePreview(text, attachments);
  }

  if (role === "assistant" && linkedUserMessageId) {
    item.dataset.userMessageId = linkedUserMessageId;
    item.dataset.userMessagePreview = linkedUserMessagePreview;
  }

  const head = document.createElement("div");
  head.className = "message-head";
  head.innerHTML = `<span>${role === "user" ? "用户" : role === "assistant" ? "助手" : "系统"}</span><span>${escapeHtml(timestampText)}</span>`;

  const body = document.createElement("div");
  const content = document.createElement("div");
  content.className = role === "system" ? "whitespace-pre-wrap break-words leading-8" : "message-markdown";
  setMessageContent(content, text, role);
  body.append(content);

  if (attachments.length) {
    const attachmentList = document.createElement("div");
    attachmentList.className = "message-attachments";
    attachments.forEach((attachment) => {
      const link = document.createElement("a");
      link.href = attachment.dataUrl;
      link.target = "_blank";
      link.rel = "noreferrer";

      if (attachment.kind === "image") {
        const image = document.createElement("img");
        image.className = "message-image";
        image.src = attachment.dataUrl;
        image.alt = attachment.name || "聊天图片";
        link.append(image);
      } else {
        link.className = "message-file";
        link.download = attachment.name || "附件";
        link.innerHTML = `
          <span class="message-file-icon">文</span>
          <span class="message-file-copy">
            <span class="message-file-name">${escapeHtml(attachment.name || "文件")}</span>
            <span class="message-file-size">${escapeHtml(formatFileSize(attachment.size) || attachment.mimeType || "文件")}</span>
          </span>
        `;
      }

      attachmentList.append(link);
    });
    body.append(attachmentList);
  }

  item.append(head, body);

  if (metaText) {
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = metaText;
    item.append(meta);
  }

  refs.messages.append(item);
  setupCustomScrollbars(item);

  if (shouldAutoScroll) {
    scrollMessagesToBottom();
  }

  return {
    item,
    timestamp: timestampText,
    id: messageId,
    preview: item.dataset.messagePreview || linkedUserMessagePreview || ""
  };
}

function appendLoadingMessage(options = {}) {
  const {
    linkedUserMessageId = "",
    linkedUserMessagePreview = ""
  } = options;
  refs.emptyState.hidden = true;
  const timestamp = new Date().toLocaleTimeString();
  const item = document.createElement("article");
  item.className = "message assistant";
  item.dataset.messageId = generateId("message");
  item.dataset.role = "assistant";

  if (linkedUserMessageId) {
    item.dataset.userMessageId = linkedUserMessageId;
    item.dataset.userMessagePreview = linkedUserMessagePreview;
  }

  item.innerHTML = `
    <div class="message-head"><span>助手</span><span>${escapeHtml(timestamp)}</span></div>
    <div class="message-markdown" hidden></div>
    <div class="message-inline-status" hidden></div>
    <div class="message-loading" aria-live="polite">
      <span class="h-2 w-2 animate-pulse-dot rounded-full bg-sky-500"></span>
      <span class="h-2 w-2 animate-pulse-dot rounded-full bg-violet-500 [animation-delay:120ms]"></span>
      <span class="h-2 w-2 animate-pulse-dot rounded-full bg-cyan-500 [animation-delay:240ms]"></span>
      <span class="message-loading-label">正在生成回复...</span>
    </div>
  `;

  const content = item.querySelector(".message-markdown");
  const status = item.querySelector(".message-inline-status");
  const loading = item.querySelector(".message-loading");
  const loadingLabel = item.querySelector(".message-loading-label");
  let meta = null;
  let pendingText = "";
  let renderedText = "";
  let renderedMode = "streaming-markdown";
  let pendingFrame = 0;

  const getRenderMode = (renderAsMarkdown, isStreaming) => {
    if (!renderAsMarkdown) {
      return "plain";
    }

    return isStreaming ? "streaming-markdown" : "markdown";
  };

  const syncMeta = (nextMeta = "") => {
    if (!nextMeta) {
      if (meta) {
        meta.textContent = "";
        meta.hidden = true;
      }
      return;
    }

    if (!meta) {
      meta = document.createElement("div");
      meta.className = "message-meta";
      item.append(meta);
    }

    meta.hidden = false;
    meta.textContent = nextMeta;
  };

  const clearStatus = () => {
    status.hidden = true;
    status.className = "message-inline-status";
    status.textContent = "";
    status.innerHTML = "";
  };

  const syncText = (nextText, options = {}) => {
    const { renderAsMarkdown = true, isStreaming = false } = options;
    renderedText = nextText;
    renderedMode = getRenderMode(renderAsMarkdown, isStreaming);
    setMessageContent(content, nextText, "assistant", { renderAsMarkdown, isStreaming });
    content.hidden = !nextText;
    loading.hidden = Boolean(nextText);
    syncActiveResponseAnchor();
  };

  const flushQueuedText = () => {
    pendingFrame = 0;
    if (renderedText === pendingText && renderedMode === "streaming-markdown") {
      return;
    }

    syncText(pendingText, { renderAsMarkdown: true, isStreaming: true });
  };

  const commitText = (nextText, options = {}) => {
    const { renderAsMarkdown = true, isStreaming = false } = options;
    pendingText = typeof nextText === "string" ? nextText : "";
    if (pendingFrame) {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = 0;
    }

    const nextMode = getRenderMode(renderAsMarkdown, isStreaming);
    if (renderedText === pendingText && content.hidden === !pendingText && renderedMode === nextMode) {
      return;
    }

    syncText(pendingText, { renderAsMarkdown, isStreaming });
  };

  const setLoadingState = (label = "正在生成回复...") => {
    clearStatus();
    syncMeta("");
    loading.hidden = false;
    loadingLabel.textContent = label;

    if (!renderedText) {
      content.hidden = true;
    }

    scheduleCustomScrollbarRefresh();
    syncActiveResponseAnchor();
  };

  const showRetryState = ({ message = "请求失败", onRetry } = {}) => {
    if (pendingFrame) {
      cancelAnimationFrame(pendingFrame);
      pendingFrame = 0;
    }

    loading.hidden = true;
    syncMeta("");
    status.hidden = false;
    status.className = "message-inline-status is-error";
    status.innerHTML = "";

    const copy = document.createElement("span");
    copy.className = "message-inline-copy";
    copy.textContent = message;
    status.append(copy);

    if (typeof onRetry === "function") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "message-retry-button";
      button.setAttribute("aria-label", "重试生成回复");
      button.setAttribute("title", "重试");
      button.disabled = state.busy;
      button.innerHTML = `
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
          <path d="M20 11a8 8 0 1 0 2.1 5.4" />
          <path d="M20 4v7h-7" />
        </svg>
      `;
      button.addEventListener("click", () => {
        if (state.busy) {
          return;
        }

        onRetry();
      });
      status.append(button);
    }

    scheduleCustomScrollbarRefresh();
  };

  refs.messages.append(item);
  setupCustomScrollbars(item);
  scheduleMessageContextBarUpdate();

  return {
    element: item,
    timestamp,
    getText() {
      return pendingText || content.dataset.rawText || "";
    },
    setText(nextText) {
      pendingText = typeof nextText === "string" ? nextText : "";
      if (pendingFrame) {
        return;
      }

      pendingFrame = requestAnimationFrame(flushQueuedText);
    },
    beginRequest(label = "正在生成回复...") {
      commitText("", { renderAsMarkdown: true, isStreaming: true });
      setLoadingState(label);
    },
    finalize(options = {}) {
      if (Object.prototype.hasOwnProperty.call(options, "text")) {
        commitText(options.text, { renderAsMarkdown: true, isStreaming: false });
      } else {
        commitText(pendingText, { renderAsMarkdown: true, isStreaming: false });
      }

      loading.hidden = true;
      clearStatus();
      syncMeta(options.metaText || "");
      syncActiveResponseAnchor();
      clearActiveResponseAnchor();
    },
    showRetry(options = {}) {
      showRetryState(options);
    },
    remove() {
      if (pendingFrame) {
        cancelAnimationFrame(pendingFrame);
      }

      if (state.activeResponseAnchor?.assistantItem === item || state.activeResponseAnchor?.userItem === item) {
        clearActiveResponseAnchor();
      }

      item.remove();
    }
  };
}

function renderConversation() {
  clearActiveResponseAnchor();
  refs.messages.innerHTML = "";
  refs.messages.append(refs.emptyState);
  refs.emptyState.hidden = state.conversation.length > 0;

  let lastUserMessageLink = null;

  state.conversation.forEach((message) => {
    const appendedMessage = appendMessage(message.role, message.content, {
      attachments: cloneAttachments(message.attachments),
      timestampText: message.timestamp || new Date().toLocaleTimeString(),
      metaText: message.meta || "",
      linkedUserMessageId: message.role === "assistant" ? lastUserMessageLink?.id || "" : "",
      linkedUserMessagePreview: message.role === "assistant" ? lastUserMessageLink?.preview || "" : ""
    });

    if (message.role === "user") {
      lastUserMessageLink = {
        id: appendedMessage.id,
        preview: appendedMessage.preview
      };
    }
  });

  setupCustomScrollbars(refs.messages);
  scheduleMessageContextBarUpdate();
}

function formatFileSize(size) {
  if (!Number.isFinite(size) || size <= 0) {
    return "";
  }

  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function renderComposerAttachments() {
  refs.composerAttachments.innerHTML = "";

  if (!state.pendingAttachments.length) {
    refs.composerAttachments.hidden = true;
    scheduleCustomScrollbarRefresh();
    return;
  }

  state.pendingAttachments.forEach((attachment) => {
    const chip = document.createElement("div");
    if (attachment.kind === "image") {
      chip.className = "attachment-chip";
      chip.innerHTML = `
        <img src="${escapeHtml(attachment.dataUrl)}" alt="${escapeHtml(attachment.name)}">
        <button type="button" data-attachment-id="${escapeHtml(attachment.id)}" aria-label="移除附件">×</button>
        <div class="attachment-chip-meta" title="${escapeHtml(attachment.name)}">${escapeHtml(attachment.name || formatFileSize(attachment.size) || "图片")}</div>
      `;
    } else {
      chip.className = "attachment-chip attachment-file-chip";
      chip.innerHTML = `
        <span class="attachment-file-icon">文</span>
        <span class="attachment-file-copy">
          <span class="attachment-file-name" title="${escapeHtml(attachment.name)}">${escapeHtml(attachment.name || "文件")}</span>
          <span class="attachment-file-size">${escapeHtml(formatFileSize(attachment.size) || attachment.mimeType || "文件")}</span>
        </span>
        <button type="button" data-attachment-id="${escapeHtml(attachment.id)}" aria-label="移除附件">×</button>
      `;
    }
    refs.composerAttachments.append(chip);
  });

  refs.composerAttachments.hidden = false;
  scheduleCustomScrollbarRefresh();
}

function clearPendingAttachments() {
  state.pendingAttachments = [];
  refs.imageInput.value = "";
  refs.fileInput.value = "";
  renderComposerAttachments();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name || "未命名文件"}`));
    reader.readAsDataURL(file);
  });
}

function isSupportedFile(file, kind) {
  if (!file) {
    return false;
  }

  if (kind === "image") {
    return file.type?.startsWith("image/");
  }

  return !file.type?.startsWith("image/")
    && (SUPPORTED_FILE_EXTENSIONS.has(getFileExtension(file.name))
      || file.type?.startsWith("text/")
      || SUPPORTED_FILE_MIME_TYPES.has(file.type));
}

function getPendingAttachmentBytes() {
  return state.pendingAttachments.reduce((total, attachment) => total + (attachment.size || 0), 0);
}

async function addAttachmentsFromFiles(files, kind = "image") {
  const selectedFiles = Array.from(files || []);
  const acceptedFiles = selectedFiles.filter((file) => isSupportedFile(file, kind));
  if (!acceptedFiles.length) {
    setStatus(refs.composerStatus, kind === "image" ? "请选择图片文件。" : "请选择支持的文件格式。", "error");
    return;
  }

  const remaining = MAX_ATTACHMENTS - state.pendingAttachments.length;
  if (remaining <= 0) {
    setStatus(refs.composerStatus, `最多支持 ${MAX_ATTACHMENTS} 个附件。`, "error");
    return;
  }

  const attachments = [];
  let totalBytes = getPendingAttachmentBytes();
  for (const file of acceptedFiles.slice(0, remaining)) {
    if (file.size > MAX_ATTACHMENT_BYTES || totalBytes + file.size > MAX_ATTACHMENT_BYTES) {
      continue;
    }

    const dataUrl = await readFileAsDataUrl(file);
    attachments.push(normalizeAttachment({
      id: generateId("attachment"),
      kind,
      name: file.name || (kind === "image" ? "图片" : "文件"),
      mimeType: file.type || (kind === "image" ? "image/png" : "application/octet-stream"),
      size: file.size || 0,
      dataUrl
    }));
    totalBytes += file.size || 0;
  }

  const validAttachments = attachments.filter(Boolean);
  if (!validAttachments.length) {
    setStatus(refs.composerStatus, `附件总大小不能超过 ${formatFileSize(MAX_ATTACHMENT_BYTES)}。`, "error");
    return;
  }

  state.pendingAttachments.push(...validAttachments);
  renderComposerAttachments();
  setStatus(refs.composerStatus, "");
}

function buildMessageContent(text, attachments = []) {
  const trimmedText = typeof text === "string" ? text.trim() : "";
  const content = [];

  if (trimmedText) {
    content.push({ type: "input_text", text: trimmedText });
  }

  attachments.forEach((attachment) => {
    if (!attachment?.dataUrl) {
      return;
    }

    if (attachment.kind === "image") {
      content.push({ type: "input_image", image_url: attachment.dataUrl });
      return;
    }

    content.push({
      type: "input_file",
      filename: attachment.name || "attachment",
      file_data: attachment.dataUrl
    });
  });

  if (!content.length) {
    return "";
  }

  return content.length === 1 && content[0].type === "input_text" ? content[0].text : content;
}

function buildConversationInput(prompt, attachments) {
  const items = state.conversation
    .map((message) => ({
      role: message.role,
      content: buildMessageContent(message.content, cloneAttachments(message.attachments))
    }))
    .filter((message) => Array.isArray(message.content) ? message.content.length > 0 : Boolean(message.content));

  items.push({
    role: "user",
    content: buildMessageContent(prompt, attachments)
  });

  return items;
}

function parseSseEventBlock(block) {
  const lines = block.replace(/\r/g, "").split("\n");
  let eventName = "";
  const dataLines = [];

  lines.forEach((line) => {
    if (!line || line.startsWith(":")) {
      return;
    }

    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      return;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^\s?/, ""));
    }
  });

  return { event: eventName, data: dataLines.join("\n") };
}

function extractStreamTextDelta(payload) {
  if (typeof payload?.delta === "string") {
    return payload.delta;
  }

  if (typeof payload?.delta?.text === "string") {
    return payload.delta.text;
  }

  if (Array.isArray(payload?.delta)) {
    return payload.delta
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        return item?.text || item?.delta || "";
      })
      .join("");
  }

  if (typeof payload?.text === "string" && payload.type === "response.output_text.delta") {
    return payload.text;
  }

  const choiceDelta = payload?.choices?.[0]?.delta?.content;
  if (typeof choiceDelta === "string") {
    return choiceDelta;
  }

  if (Array.isArray(choiceDelta)) {
    return choiceDelta.map((item) => typeof item === "string" ? item : item?.text || "").join("");
  }

  return "";
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const fragments = [];
  const collectText = (value) => {
    if (!value) {
      return;
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        fragments.push(trimmed);
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(collectText);
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    collectText(value.text);
    collectText(value.output_text);
    collectText(value.content);
  };

  collectText(payload?.output);
  collectText(payload?.choices?.[0]?.message?.content);
  collectText(payload?.choices?.[0]?.text);
  return fragments.join("\n\n").trim();
}

async function readResponseStream(response, options = {}) {
  if (!response.body) {
    throw new Error("当前响应不支持流式读取。");
  }

  const { onText } = options;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let completedPayload = null;

  const applyEvent = (block) => {
    const parsedEvent = parseSseEventBlock(block);
    if (!parsedEvent.data || parsedEvent.data === "[DONE]") {
      return;
    }

    let payload = null;
    try {
      payload = JSON.parse(parsedEvent.data);
    } catch (error) {
      return;
    }

    const eventType = payload?.type || parsedEvent.event || "";
    if (eventType === "error" || eventType === "response.failed") {
      throw new Error(extractErrorMessage(payload?.response || payload, "流式响应失败。"));
    }

    const delta = extractStreamTextDelta(payload);
    if (delta && (!eventType || eventType.includes("delta"))) {
      text += delta;
      onText?.(text, payload);
    }

    if (eventType === "response.output_text.done" && typeof payload.text === "string" && payload.text) {
      text = payload.text;
      onText?.(text, payload);
    }

    if (eventType === "response.completed") {
      completedPayload = payload?.response || payload?.data || payload;
      if (!text) {
        text = extractResponseText(completedPayload);
        if (text) {
          onText?.(text, payload);
        }
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let boundaryMatch = buffer.match(/\r?\n\r?\n/);
    while (boundaryMatch) {
      const boundaryIndex = boundaryMatch.index ?? -1;
      if (boundaryIndex < 0) {
        break;
      }

      const block = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + boundaryMatch[0].length);
      applyEvent(block);
      boundaryMatch = buffer.match(/\r?\n\r?\n/);
    }

    if (done) {
      const tail = buffer.trim();
      if (tail) {
        applyEvent(tail);
      }
      break;
    }
  }

  return { text, payload: completedPayload };
}

function extractTokenUsage(payload) {
  const usage = payload?.usage || payload?.response?.usage;
  if (!usage) {
    return "";
  }

  const total = usage.total_tokens ?? usage.totalTokens;
  return Number.isFinite(total) ? `${total} tokens` : "";
}

function formatElapsedTime(durationMs) {
  if (!Number.isFinite(durationMs)) {
    return "";
  }

  return durationMs < 1000 ? `${Math.round(durationMs)} 毫秒` : `${(durationMs / 1000).toFixed(1)} 秒`;
}

async function performResponseRequest(payload, assistantMessage) {
  const response = await fetch(`${API_BASE}/v1/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
      Authorization: `Bearer ${state.apiKey}`
    },
    body: JSON.stringify(payload)
  });

  const contentType = response.headers.get("content-type") || "";
  const isEventStream = contentType.includes("text/event-stream");
  let data = null;
  let text = "";
  let firstTextAt = null;

  if (!response.ok && !isEventStream) {
    await readJsonOrThrow(response);
  }

  if (isEventStream) {
    const streamResult = await readResponseStream(response, {
      onText(nextText) {
        if (!firstTextAt && nextText) {
          firstTextAt = performance.now();
        }
        assistantMessage.setText(nextText);
      }
    });
    data = streamResult.payload;
    text = streamResult.text;
  } else {
    data = await readJsonOrThrow(response);
    text = extractResponseText(data);
    if (text) {
      firstTextAt = performance.now();
    }
  }

  if (!text) {
    throw new Error("响应成功，但没有解析到文本内容。");
  }

  return { data, text, firstTextAt };
}

async function runRequestWithRetries(requestContext, assistantMessage) {
  if (state.busy) {
    return;
  }

  state.busy = true;
  syncBusy();
  setStatus(refs.composerStatus, "");
  assistantMessage.beginRequest();
  const startedAt = performance.now();

  try {
    let lastError = null;

    for (let retryCount = 0; retryCount <= MAX_AUTO_RETRY_COUNT; retryCount += 1) {
      try {
        const { data, text, firstTextAt } = await performResponseRequest(requestContext.payload, assistantMessage);
        const assistantMeta = [
          firstTextAt ? `首字 ${formatElapsedTime(firstTextAt - startedAt)}` : "",
          `总耗时 ${formatElapsedTime(performance.now() - startedAt)}`,
          extractTokenUsage(data)
        ].filter(Boolean).join(" · ");

        assistantMessage.finalize({ text, metaText: assistantMeta });
        state.conversation.push({
          role: "user",
          content: requestContext.prompt,
          attachments: cloneAttachments(requestContext.attachments),
          timestamp: requestContext.userTimestamp,
          meta: ""
        });
        state.conversation.push({
          role: "assistant",
          content: text,
          attachments: [],
          timestamp: assistantMessage.timestamp,
          meta: assistantMeta
        });
        saveCurrentSession(true);
        setStatus(refs.composerStatus, "");
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error("请求失败");
        if (retryCount === MAX_AUTO_RETRY_COUNT) {
          assistantMessage.showRetry({
            message: `请求失败：${lastError.message}`,
            onRetry: () => {
              void runRequestWithRetries(requestContext, assistantMessage);
            }
          });
          setStatus(refs.composerStatus, `请求失败：${lastError.message}`, "error");
          return;
        }

        const retryIndex = retryCount + 1;
        const retryText = `请求失败，正在重试 (${retryIndex}/${MAX_AUTO_RETRY_COUNT})...`;
        assistantMessage.beginRequest(retryText);
        setStatus(refs.composerStatus, retryText);
        await wait(getAutoRetryDelayMs(retryIndex));
      }
    }
  } finally {
    state.busy = false;
    syncBusy();
    if (shouldRestoreComposerFocus()) {
      refs.messageInput.focus();
    }
  }
}

async function sendMessage() {
  if (state.busy) {
    return;
  }

  const model = state.selectedModel.trim();
  const prompt = refs.messageInput.value.trim();
  const attachments = cloneAttachments(state.pendingAttachments);
  const instructions = refs.systemPromptInput.value.trim();

  if (!model) {
    setStatus(refs.composerStatus, "请先选择模型。", "error");
    return;
  }

  if (!prompt && !attachments.length) {
    setStatus(refs.composerStatus, "请输入消息或添加附件。", "error");
    refs.messageInput.focus();
    return;
  }

  const payload = {
    model,
    input: buildConversationInput(prompt, attachments),
    stream: true
  };

  if (instructions) {
    payload.instructions = instructions;
  }

  const userMessage = appendMessage("user", prompt, {
    attachments,
    allowAutoScroll: false
  });
  const assistantMessage = appendLoadingMessage({
    linkedUserMessageId: userMessage.id,
    linkedUserMessagePreview: userMessage.preview
  });
  activateResponseAnchor(userMessage.item, assistantMessage.element);
  const requestContext = {
    model,
    prompt,
    attachments: cloneAttachments(attachments),
    instructions,
    payload,
    userTimestamp: userMessage.timestamp
  };

  refs.messageInput.value = "";
  clearPendingAttachments();
  await runRequestWithRetries(requestContext, assistantMessage);
}

async function bootstrap() {
  const restored = loadSessionState();
  state.sessions = restored.sessions;
  state.currentSessionId = restored.currentSessionId;

  if (!state.sessions.length) {
    const session = createSession({ selectedModel: "" });
    state.sessions = [session];
    state.currentSessionId = session.id;
  }

  renderSessionList();
  renderConversation();
  syncBusy();

  try {
    setStatus(refs.composerStatus, "正在校验登录状态并拉取模型...");
    const payload = await validateApiKey(state.apiKey);
    state.models = extractModels(payload);
    state.selectedModel = getPreferredModel(state.models);
    const currentSession = getCurrentSession();
    if (currentSession?.selectedModel && state.models.includes(currentSession.selectedModel)) {
      state.selectedModel = currentSession.selectedModel;
    }

    activateSession(state.currentSessionId || state.sessions[0].id, { skipSave: true });
    setStatus(refs.composerStatus, state.models.length ? "" : "登录成功，但没有读取到模型。", state.models.length ? "" : "error");
  } catch (error) {
    clearStoredApiKey();
    window.location.replace("./login.html?reason=expired");
  }
}

refs.sidebarToggle.addEventListener("click", () => {
  setSidebarOpen(!refs.body.classList.contains("sidebar-open"));
});

refs.mobileBackdrop.addEventListener("click", () => setSidebarOpen(false));
refs.newSessionButton.addEventListener("click", () => createNewSession());
refs.clearSessionsButton.addEventListener("click", () => {
  if (!window.confirm("确认清空全部会话吗？")) {
    return;
  }

  state.sessions = [];
  createNewSession({ focusMessage: false });
});

refs.logoutButton.addEventListener("click", () => {
  saveCurrentSession(false);
  clearStoredApiKey();
  window.location.replace("./login.html");
});

refs.searchInput.addEventListener("input", renderSessionList);

refs.sessionList.addEventListener("click", (event) => {
  const actionTarget = event.target.closest("[data-action][data-session-id]");
  if (actionTarget) {
    event.stopPropagation();
    const { action, sessionId } = actionTarget.dataset;
    if (action === "rename") {
      renameSession(sessionId);
    }
    if (action === "delete") {
      deleteSession(sessionId);
    }
    return;
  }

  const item = event.target.closest("button[data-session-id]");
  if (!item || item.dataset.sessionId === state.currentSessionId) {
    return;
  }

  activateSession(item.dataset.sessionId, { focusMessage: true });
  closeSidebarOnMobile();
});

refs.modelTrigger.addEventListener("click", () => {
  setAttachmentMenuOpen(false);
  setModelMenuOpen(refs.modelMenu.hidden);
});
refs.modelMenu.addEventListener("click", (event) => {
  const option = event.target.closest("[data-model]");
  if (option) {
    selectModel(option.dataset.model);
  }
});

document.addEventListener("click", (event) => {
  if (!refs.modelPicker.contains(event.target)) {
    setModelMenuOpen(false);
  }

  if (!refs.attachmentPicker.contains(event.target)) {
    setAttachmentMenuOpen(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setModelMenuOpen(false);
    setAttachmentMenuOpen(false);
    setSidebarOpen(false);
  }
});

refs.systemPromptInput.addEventListener("input", () => saveCurrentSession(false));
refs.messages.addEventListener("scroll", () => {
  const currentAnchor = state.activeResponseAnchor;
  if (!currentAnchor) {
    scheduleMessageContextBarUpdate();
    return;
  }

  if (currentAnchor.ignoreUserScrollUntil > performance.now()) {
    scheduleMessageContextBarUpdate();
    return;
  }

  if (
    Number.isFinite(currentAnchor.pendingScrollTop) &&
    Math.abs(refs.messages.scrollTop - currentAnchor.pendingScrollTop) <= 1
  ) {
    currentAnchor.pendingScrollTop = null;
    scheduleMessageContextBarUpdate();
    return;
  }

  currentAnchor.pendingScrollTop = null;
  currentAnchor.userScrolled = true;
  scheduleMessageContextBarUpdate();
});
function jumpToCurrentContextMessage() {
  const messageId = refs.messageContextBar.dataset.userMessageId || "";
  const messageItem = findMessageItemById(messageId);
  if (!messageItem) {
    return;
  }

  if (state.activeResponseAnchor?.userItem === messageItem) {
    state.activeResponseAnchor.userScrolled = false;
    reinforceActiveResponseAnchor(messageItem);
    return;
  }

  jumpToMessageItem(messageItem);
}

refs.messageContextBar.addEventListener("pointerdown", (event) => {
  event.preventDefault();
});
refs.messageContextBar.addEventListener("click", () => {
  jumpToCurrentContextMessage();
});
window.addEventListener("resize", scheduleMessageContextBarUpdate);
refs.messageInput.addEventListener("keydown", (event) => {
  if (shouldSendOnEnter(event)) {
    event.preventDefault();
    sendMessage();
  }
});
refs.sendButton.addEventListener("click", sendMessage);
refs.imageButton.addEventListener("click", () => {
  setModelMenuOpen(false);
  setAttachmentMenuOpen(refs.attachmentMenu.hidden);
});
refs.attachmentMenu.addEventListener("click", (event) => {
  const option = event.target.closest("[data-upload-kind]");
  if (!option) {
    return;
  }

  setAttachmentMenuOpen(false);
  if (option.dataset.uploadKind === "image") {
    refs.imageInput.click();
    return;
  }

  refs.fileInput.click();
});
refs.imageInput.addEventListener("change", async () => {
  await addAttachmentsFromFiles(refs.imageInput.files, "image");
  refs.imageInput.value = "";
});
refs.fileInput.addEventListener("change", async () => {
  await addAttachmentsFromFiles(refs.fileInput.files, "file");
  refs.fileInput.value = "";
});
refs.messageInput.addEventListener("paste", async (event) => {
  const files = Array.from(event.clipboardData?.items || [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);

  if (files.length) {
    await addAttachmentsFromFiles(files, "image");
  }
});
refs.composerAttachments.addEventListener("click", (event) => {
  const removeButton = event.target.closest("[data-attachment-id]");
  if (!removeButton) {
    return;
  }

  state.pendingAttachments = state.pendingAttachments.filter((attachment) => attachment.id !== removeButton.dataset.attachmentId);
  renderComposerAttachments();
});
refs.suggestionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    refs.messageInput.value = button.dataset.suggestion || "";
    refs.messageInput.focus();
    scheduleCustomScrollbarRefresh();
  });
});

setupCustomScrollbars();

if (cachedApiKey) {
  bootstrap();
}
