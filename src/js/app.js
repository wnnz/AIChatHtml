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
  openSessionMenuId: ""
};

const customScrollbars = new Map();
let customScrollbarFrame = 0;

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

function renderMarkdown(text) {
  const blocks = [];
  const parts = String(text).split(/```/);

  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      const code = part.replace(/^\w+\n/, "");
      blocks.push(`<pre><code>${escapeHtml(code.trim())}</code></pre>`);
      return;
    }

    const html = escapeHtml(part)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
      .join("");
    blocks.push(html);
  });

  return blocks.join("");
}

function setMessageContent(target, text, role) {
  const value = typeof text === "string" ? text : "";
  target.dataset.rawText = value;

  if (role === "assistant") {
    target.innerHTML = value ? renderMarkdown(value) : "";
    setupCustomScrollbars(target);
    return;
  }

  target.textContent = value;
  scheduleCustomScrollbarRefresh();
}

function isNearMessageBottom(offset = 96) {
  return refs.messages.scrollHeight - refs.messages.scrollTop - refs.messages.clientHeight <= offset;
}

function scrollMessagesToBottom() {
  refs.messages.scrollTop = refs.messages.scrollHeight;
  scheduleCustomScrollbarRefresh();
}

function appendMessage(role, text, options = {}) {
  const {
    attachments = [],
    timestampText = new Date().toLocaleTimeString(),
    metaText = "",
    forceScroll = false
  } = options;

  const shouldAutoScroll = forceScroll || isNearMessageBottom();
  refs.emptyState.hidden = true;
  const item = document.createElement("article");
  item.className = `message ${role}`;

  const head = document.createElement("div");
  head.className = "message-head";
  head.innerHTML = `<span>${role === "user" ? "用户" : role === "assistant" ? "助手" : "系统"}</span><span>${escapeHtml(timestampText)}</span>`;

  const body = document.createElement("div");
  const content = document.createElement("div");
  content.className = role === "assistant" ? "message-markdown" : "whitespace-pre-wrap break-words leading-8";
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

  return timestampText;
}

function appendLoadingMessage() {
  const shouldAutoScroll = isNearMessageBottom();
  refs.emptyState.hidden = true;
  const timestamp = new Date().toLocaleTimeString();
  const item = document.createElement("article");
  item.className = "message assistant";
  item.innerHTML = `
    <div class="message-head"><span>助手</span><span>${escapeHtml(timestamp)}</span></div>
    <div class="message-markdown" hidden></div>
    <div class="flex items-center gap-2" aria-label="正在生成回复">
      <span class="h-2 w-2 animate-pulse-dot rounded-full bg-sky-500"></span>
      <span class="h-2 w-2 animate-pulse-dot rounded-full bg-violet-500 [animation-delay:120ms]"></span>
      <span class="h-2 w-2 animate-pulse-dot rounded-full bg-cyan-500 [animation-delay:240ms]"></span>
    </div>
  `;

  const content = item.querySelector(".message-markdown");
  const loading = item.querySelector("[aria-label]");
  let meta = null;
  refs.messages.append(item);
  setupCustomScrollbars(item);

  if (shouldAutoScroll) {
    scrollMessagesToBottom();
  }

  return {
    timestamp,
    getText() {
      return content.dataset.rawText || "";
    },
    setText(nextText) {
      const shouldAutoScroll = isNearMessageBottom();
      setMessageContent(content, nextText, "assistant");
      content.hidden = !nextText;

      if (nextText && loading?.isConnected) {
        loading.remove();
      }

      if (shouldAutoScroll) {
        scrollMessagesToBottom();
      }
    },
    finalize(options = {}) {
      const shouldAutoScroll = isNearMessageBottom();
      if (Object.prototype.hasOwnProperty.call(options, "text")) {
        this.setText(options.text);
      }

      if (loading?.isConnected) {
        loading.remove();
      }

      const nextMeta = options.metaText || "";
      if (nextMeta) {
        meta = document.createElement("div");
        meta.className = "message-meta";
        meta.textContent = nextMeta;
        item.append(meta);
      }

      if (shouldAutoScroll) {
        scrollMessagesToBottom();
      }
    },
    remove() {
      item.remove();
    }
  };
}

function renderConversation() {
  refs.messages.innerHTML = "";
  refs.messages.append(refs.emptyState);
  refs.emptyState.hidden = state.conversation.length > 0;

  state.conversation.forEach((message) => {
    appendMessage(message.role, message.content, {
      attachments: cloneAttachments(message.attachments),
      timestampText: message.timestamp || new Date().toLocaleTimeString(),
      metaText: message.meta || ""
    });
  });

  setupCustomScrollbars(refs.messages);
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
      dataLines.push(line.slice(5).trimStart());
    }
  });

  return { event: eventName, data: dataLines.join("\n") };
}

function extractStreamTextDelta(payload) {
  if (typeof payload?.delta === "string") {
    return payload.delta;
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

  const startedAt = performance.now();
  const userTimestamp = appendMessage("user", prompt, { attachments, forceScroll: true });
  const assistantMessage = appendLoadingMessage();
  refs.messageInput.value = "";
  clearPendingAttachments();
  state.busy = true;
  syncBusy();
  setStatus(refs.composerStatus, "");

  try {
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

    if (!response.ok && !isEventStream) {
      await readJsonOrThrow(response);
    }

    if (isEventStream) {
      const streamResult = await readResponseStream(response, {
        onText(nextText) {
          assistantMessage.setText(nextText);
        }
      });
      data = streamResult.payload;
      text = streamResult.text;
    } else {
      data = await readJsonOrThrow(response);
      text = extractResponseText(data);
    }

    if (!text) {
      throw new Error("响应成功，但没有解析到文本内容。");
    }

    state.conversation.push({
      role: "user",
      content: prompt,
      attachments,
      timestamp: userTimestamp,
      meta: ""
    });

    const assistantMeta = [formatElapsedTime(performance.now() - startedAt), extractTokenUsage(data)].filter(Boolean).join(" · ");
    assistantMessage.finalize({ text, metaText: assistantMeta });
    state.conversation.push({
      role: "assistant",
      content: text,
      attachments: [],
      timestamp: assistantMessage.timestamp,
      meta: assistantMeta
    });
    saveCurrentSession(true);
  } catch (error) {
    if (assistantMessage.getText()) {
      assistantMessage.finalize({ metaText: "响应中断" });
    } else {
      assistantMessage.remove();
    }
    appendMessage("system", `请求失败：${error.message}`);
    setStatus(refs.composerStatus, `请求失败：${error.message}`, "error");
  } finally {
    state.busy = false;
    syncBusy();
    refs.messageInput.focus();
  }
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
