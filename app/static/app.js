/* Manet — quod manet, manet. */
"use strict";
window.onerror = (msg, src, line, col) => {
  const el = document.getElementById("toast");
  el.className = "toast err";
  el.textContent = `JS错误: ${msg} (第${line}行)`;
  el.hidden = false; setTimeout(() => (el.hidden = true), 12000);
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
/* Manet 图标系统:统一从 sprite 取用 */
const icon = (id, cls = "") => `<svg class="icon ${cls}"><use href="#${id}"/></svg>`;

const state = {
  tasks: [], view: "home", taskId: null, task: null,
  sentences: [], paras: [], analysis: null, editing: false, search: "",
  pollTimer: null, polishPoll: null, analysisPoll: null,
  chatMessages: [], chatBusy: false, notesTimer: null,
  translation: null, displayMode: localStorage.getItem("tw_display_mode") || "orig",
  folders: [], folderFilter: null, translatePoll: null, burnPoll: null,
  derivPoll: null, seenMindmap: false, seenEssay: false,
  homeAnim: false,   // 目录行入场动画开关:仅显式渲染(进首页/切文件夹)触发
  reading: localStorage.getItem("tw_reading") === "1",
  marks: [], comments: [], pendingRange: null, lastSel: null,
  visuals: [], seenVisual: false,
  history: [], histFilter: "全部",
};
const MODE_NAMES = { orig: "原文", zh: "中文", both: "双语" };
const VIDEO_EXT = ["mp4", "mov", "mkv", "avi", "webm", "flv", "wmv", "ts"];
const AUDIO_EXT = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma", "amr"];
const LANG_NAMES = { zh: "中文", en: "英文", ja: "日文", ko: "韩文", yue: "粤语" };

/* ================= 工具 ================= */
function toast(msg, ms = 2600, type) {
  const el = $("#toast");
  // 语义:显式指定优先;否则按文案轻量判定(失败类/完成类/中性)
  const t = type || (/失败|错误|不可|拒绝|不存在/.test(msg) ? "err"
    : /已完成|已保存|已更新|已导出|已开始|已清除|已暂停|已继续|成功|已入库/.test(msg) ? "ok" : "info");
  el.className = "toast " + t;
  el.innerHTML = icon(t === "err" ? "i-error" : t === "ok" ? "i-done" : "i-mark")
    + `<span>${escapeHtml(msg)}</span>`;
  el.hidden = false;
  clearTimeout(el._t); el._t = setTimeout(() => (el.hidden = true), ms);
}
function fmtTs(sec, fh = false) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
  return h || fh ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function fmtDur(sec) {
  if (sec == null) return "";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m >= 60 ? `${Math.floor(m / 60)}小时${m % 60}分` : m ? `${m}分${s}秒` : `${s}秒`;
}
function fmtDate(ts) {
  return ts ? new Date(ts * 1000).toLocaleString("zh-CN",
    { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}
async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let d = r.statusText;
    try { d = (await r.json()).detail || d; } catch {
      try { d = (await r.text()).slice(0, 200) || d; } catch {}
    }
    throw new Error(d);
  }
  return r.json();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fileExt(n) { return (n.split(".").pop() || "").toLowerCase(); }
function statusOf(t) {
  if (t.status === "error") return { dot: "error", text: "失败" };
  if (t.status === "cancelled") return { dot: "queued", text: "已终止" };
  if (t.status === "queued") return { dot: "queued", text: "排队中" };
  if (t.status === "transcribing") return { dot: "running", text: t.stage || "转写中" };
  if (t.polish_status === "running") return { dot: "running", text: t.stage || "AI 标点恢复" };
  if (t.analysis_status === "running") return { dot: "running", text: "AI 解读生成中" };
  return { dot: "done", text: "完成" };
}
function titleOf(t) { return t.display_title || t.filename; }

/* ================= 任务列表 ================= */
async function fetchTasks() {
  try { state.tasks = await api("/api/tasks"); } catch { return; }
  renderSidebar(); renderHome(); updateFab();
}
function filteredTasks() {
  const q = state.search.trim().toLowerCase();
  return q ? state.tasks.filter(t => (titleOf(t) + " " + t.filename).toLowerCase().includes(q)) : state.tasks;
}
function renderSidebar() {
  const box = $("#side-list"); box.innerHTML = "";
  for (const t of filteredTasks()) {
    const st = statusOf(t);
    const el = document.createElement("div");
    el.className = "side-item" + (state.view === "detail" && t.id === state.taskId ? " active" : "");
    el.innerHTML = `<span class="status-dot ${st.dot}"></span><span class="s-title">${escapeHtml(titleOf(t))}</span><span class="s-dur">${fmtDur(t.duration)}</span>`;
    el.addEventListener("click", () => openDetail(t.id));
    box.appendChild(el);
  }
  if (!box.children.length) box.innerHTML = '<div class="empty-hint" style="padding:20px 8px">暂无录音</div>';
}
function homeTasks() {
  let list = filteredTasks();
  if (state.folderFilter) list = list.filter(t => (t.folder || null) === state.folderFilter);
  return list;
}
function renderFolderBar() {
  const bar = $("#folder-bar"); bar.innerHTML = "";
  const counts = {};
  state.tasks.forEach(t => { const k = t.folder || ""; counts[k] = (counts[k] || 0) + 1; });
  const mk = (id, label) => {
    const c = document.createElement("button");
    c.className = "f-chip" + ((state.folderFilter || null) === id ? " active" : "");
    c.innerHTML = label;
    c.addEventListener("click", () => { state.folderFilter = id; state.homeAnim = true; renderFolderBar(); renderHome(); });
    bar.appendChild(c);
  };
  mk(null, `全部 ${state.tasks.length}`);
  for (const f of state.folders) mk(f.id, `${icon("i-folder", "icon-14")} ${escapeHtml(f.name)} ${counts[f.id] || 0}`);
  if (state.folderFilter) {
    const mkAct = (txt, fn) => { const s = document.createElement("span"); s.className = "f-act"; s.textContent = txt; s.addEventListener("click", fn); bar.appendChild(s); };
    mkAct("重命名", async () => {
      const f = state.folders.find(x => x.id === state.folderFilter);
      const n = prompt("文件夹新名称:", f.name);
      if (!n?.trim()) return;
      await api(`/api/folders/${f.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) });
      fetchFolders();
    });
    mkAct("删除", async () => {
      const f = state.folders.find(x => x.id === state.folderFilter);
      if (!confirm(`删除文件夹「${f.name}」?夹内录音回到根目录。`)) return;
      await api(`/api/folders/${f.id}`, { method: "DELETE" });
      state.folderFilter = null; fetchFolders();
    });
  }
}
function renderHome() {
  const grid = $("#home-grid"), list = homeTasks();
  $("#home-count").textContent = list.length ? `${list.length} 条` : "";
  grid.innerHTML = "";
  let ci = 0;
  for (const t of list) {
    const st = statusOf(t), card = document.createElement("div");
    card.className = "task-card";
    if (state.homeAnim && ci < 10) {          // 入场 stagger;轮询刷新不带
      card.classList.add("anim");
      card.style.animationDelay = (ci * 30) + "ms";
    }
    ci++;
    const badges = [];
    if (t.status === "error") badges.push('<span class="badge warn">转写失败</span>');
    else if (st.dot === "running" || st.dot === "queued") badges.push(`<span class="badge run">${escapeHtml(st.text)}</span>`);
    if (t.polish_status === "done" || t.polished) badges.push('<span class="badge ai">已标点恢复</span>');
    if (t.analyzed) badges.push('<span class="badge ai">已解读</span>');
    if (t.translation_status === "done") badges.push('<span class="badge ai">已翻译</span>');
    if (t.burn_status === "done") badges.push('<span class="badge ai">字幕视频</span>');
    card.innerHTML = `<div class="c-top"><span class="status-dot ${st.dot}"></span><span class="c-title">${escapeHtml(titleOf(t))}</span><button class="card-menu-btn" title="管理">${icon("i-more", "icon-14")}</button></div><div class="c-meta">${fmtDate(t.created_at)}${t.duration ? " · " + fmtDur(t.duration) : ""}${t.language ? " · " + (LANG_NAMES[t.language] || t.language) : ""}</div><div class="c-badges">${badges.join("")}</div>`;
    card.addEventListener("click", () => openDetail(t.id));
    card.querySelector(".card-menu-btn").addEventListener("click", e => { e.stopPropagation(); openCardMenu(t, e.clientX, e.clientY); });
    grid.appendChild(card);
  }
  if (!list.length && state.tasks.length) grid.innerHTML = '<div class="empty-hint">没有匹配的录音</div>';
  else if (!state.tasks.length) grid.innerHTML = '<div class="empty-hint">还没有录音,上传第一个文件开始吧</div>';
  state.homeAnim = false;
}
function openCardMenu(t, x, y) {
  const menu = $("#card-menu");
  const items = ['<div class="cm-head">移动到</div><a data-move="">根目录</a>'];
  for (const f of state.folders) if (f.id !== t.folder) items.push(`<a data-move="${f.id}">${escapeHtml(f.name)}</a>`);
  items.push('<div class="cm-sep"></div><a class="danger" data-del="1">删除录音…</a>');
  menu.innerHTML = items.join("");
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 10) + "px";
  menu.style.top = Math.min(y, window.innerHeight - r.height - 10) + "px";
  menu.onclick = async e => {
    const a = e.target.closest("a"); if (!a) return;
    menu.hidden = true;
    if (a.dataset.move !== undefined) {
      await api(`/api/tasks/${t.id}/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder_id: a.dataset.move || null }) });
      fetchTasks();
    } else if (a.dataset.del) {
      if (!confirm(`删除「${titleOf(t)}」?所有相关文件会被删除,不可恢复。`)) return;
      await api(`/api/tasks/${t.id}`, { method: "DELETE" });
      if (state.view === "detail" && state.taskId === t.id) showHome();
      fetchTasks();
    }
  };
}
document.addEventListener("click", e => { if (!e.target.closest("#card-menu")) $("#card-menu").hidden = true; });
$("#btn-new-folder").addEventListener("click", async () => {
  const n = prompt("新文件夹名称:"); if (!n?.trim()) return;
  const f = await api("/api/folders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) });
  state.folderFilter = f.id; fetchFolders(); toast("文件夹已创建");
});
async function fetchFolders() {
  try { state.folders = await api("/api/folders"); } catch { return; }
  renderFolderBar(); renderHome();
}
let _homePoller = null;
function _startHomePoll() {
  if (_homePoller) return;
  _homePoller = setInterval(async () => {
    await fetchTasks();
    // 没有活跃任务了就停掉轮询
    const busy = state.tasks.some(t =>
      t.status === "queued" || t.status === "transcribing"
      || t.polish_status === "running" || t.analysis_status === "running"
      || t.translation_status === "running" || t.burn_status === "running");
    if (!busy) { clearInterval(_homePoller); _homePoller = null; }
  }, 3000);
}
// fetchTasks 返回后检查是否有活跃任务,有则启动轮询
const _origFetchTasks = fetchTasks;
fetchTasks = async () => { await _origFetchTasks(); _startHomePoll(); };

/* ================= 视图切换 ================= */
function showHome() {
  state.view = "home"; state.homeAnim = true; stopAllPolling(); $("#player").pause();
  $("#view-detail").hidden = true; $("#view-home").hidden = false;
  renderSidebar(); fetchTasks(); fetchFolders();
}
function openDetail(taskId) {
  state.view = "detail"; state.taskId = taskId;
  state.analysis = null; state.sentences = []; state.paras = [];
  state.chatMessages = []; state.translation = null;
  state.seenMindmap = false; state.seenEssay = false;
  state.marks = []; state.comments = []; state.pendingRange = null;
  state.visuals = []; state.seenVisual = false;
  activeParaIdx = -1; playerReadyFor = null; exitEditMode();
  $("#view-home").hidden = true; $("#view-detail").hidden = false;
  $("#chat-messages").innerHTML = '<div class="empty-hint">就这段录音提问…</div>';
  $("#transcript").innerHTML = '<div class="empty-hint"><span class="spinner"></span>加载中…</div>';
  $("#ai-content").innerHTML = '<div class="empty-hint">点击右上角「AI 解读」,<br>生成摘要、章节速览、待办与关键词。</div>';
  $("#ai-status").hidden = true; switchTab("ai");
  $("#btn-analyze").disabled = true; $("#btn-mindmap").disabled = true; $("#btn-translate").disabled = true; $("#btn-essay").disabled = true; $("#btn-aititle").disabled = true;
  renderSidebar(); pollTask(); loadNotes(); loadHighlights(); loadVisuals();
}
$("#nav-home").addEventListener("click", showHome);
$("#btn-back").addEventListener("click", showHome);
function stopAllPolling() {
  for (const k of ["pollTimer", "polishPoll", "analysisPoll", "translatePoll", "burnPoll", "derivPoll"])
    if (state[k]) { clearInterval(state[k]); state[k] = null; }
}

/* ================= 上传 ================= */
const dropzone = $("#dropzone"), fileInput = $("#file-input");
dropzone.addEventListener("click", () => fileInput.click());
$("#btn-side-upload").addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", e => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", e => { e.preventDefault(); dropzone.classList.remove("dragover"); if (e.dataTransfer.files.length) openNewModal(e.dataTransfer.files[0]); });
fileInput.addEventListener("change", () => { if (fileInput.files.length) openNewModal(fileInput.files[0]); fileInput.value = ""; });

const NEW_PREFS_KEY = "tw_new_prefs";
function loadNewPrefs() { try { return JSON.parse(localStorage.getItem(NEW_PREFS_KEY)) || {}; } catch { return {}; } }
function saveNewPrefs(p) { localStorage.setItem(NEW_PREFS_KEY, JSON.stringify(p)); }
let newCtx = null;
function openNewModal(arg) {
  const prefs = loadNewPrefs();
  const isRt = arg && arg.id && arg.filename;
  if (isRt) {
    newCtx = { mode: "retranscribe", task: arg };
    $("#new-title").textContent = "重新转写";
    $("#new-file").textContent = arg.filename;
    $("#new-engine").value = arg.engine || prefs.engine || "whisper";
    $("#new-language").value = arg.language || "";
    $("#new-hotwords").value = arg.hotwords || "";
    $("#new-translate").checked = !!arg.auto_translate;
  } else {
    const file = arg, ext = fileExt(file.name);
    if (!VIDEO_EXT.includes(ext) && !AUDIO_EXT.includes(ext)) { toast("不支持的文件格式:" + ext); return; }
    newCtx = { mode: "upload", file };
    $("#new-title").textContent = "留下这段声音";
    $("#new-file").textContent = `${file.name}(${(file.size / 1048576).toFixed(1)} MB)`;
    $("#new-engine").value = prefs.engine || "whisper";
    $("#new-language").value = prefs.language || "";
    $("#new-hotwords").value = prefs.hotwords || "";
    $("#new-translate").checked = !!prefs.translate;
  }
  $("#new-overlay").hidden = false;
}
function closeNewModal() { $("#new-overlay").hidden = true; newCtx = null; }
$("#new-close").addEventListener("click", closeNewModal);
$("#new-cancel").addEventListener("click", closeNewModal);
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !$("#new-overlay").hidden) closeNewModal();
  if (e.key === "Escape" && !$("#settings-overlay").hidden) $("#settings-overlay").hidden = true;
  if (e.key === "Escape" && !$("#mm-overlay").hidden) $("#mm-overlay").hidden = true;
  if (e.key === "Escape" && !$("#jobs-overlay").hidden) $("#jobs-overlay").hidden = true;
});
$("#new-start").addEventListener("click", async () => {
  if (!newCtx) return;
  const prefs = { engine: $("#new-engine").value, language: $("#new-language").value, translate: $("#new-translate").checked, hotwords: $("#new-hotwords").value.trim() };
  saveNewPrefs(prefs);
  const ctx = newCtx; closeNewModal();
  try {
    if (ctx.mode === "upload") {
      const fd = new FormData();
      fd.append("file", ctx.file); fd.append("language", prefs.language);
      fd.append("hotwords", prefs.hotwords); fd.append("engine", prefs.engine);
      fd.append("auto_translate", prefs.translate ? "true" : "false");
      toast(`正在上传 ${ctx.file.name} …`);
      const { task_id } = await api("/api/upload", { method: "POST", body: fd });
      await fetchTasks(); openDetail(task_id);
    } else {
      const t = ctx.task;
      const willLose = [
        t.analyzed && "AI 解读(摘要/章节/待办)",
        t.translation_status === "done" && "翻译",
        t.polished && "AI 标点恢复",
        t.burn_status === "done" && "字幕视频",
      ].filter(Boolean);
      const msg = "重新转写将覆盖当前转写稿" + (willLose.length
        ? ",\n同时清除以下 AI 产出:\n• " + willLose.join("\n• ") : "")
        + "\n\n确定继续?";
      if (!confirm(msg)) return;
      await api(`/api/tasks/${t.id}/retranscribe`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: prefs.language, hotwords: prefs.hotwords, engine: prefs.engine, auto_translate: prefs.translate }) });
      toast("已加入重新转写队列"); exitEditMode();
      $("#transcript").innerHTML = '<div class="empty-hint"><span class="spinner"></span>重新转写中…</div>';
      $("#ai-content").innerHTML = '<div class="empty-hint">转写完成后可生成 AI 解读。</div>';
      $("#btn-analyze").disabled = true; pollTask();
    }
  } catch (e) { toast("操作失败:" + e.message); }
});

/* ================= 底部播放器控制 ================= */
const player = $("#player");
function setupPlayer(t) {
  if (playerReadyFor === t.id && player.src) return;
  playerReadyFor = t.id;
  const isVideo = VIDEO_EXT.includes(fileExt(t.filename));
  player.classList.toggle("audio-only", !isVideo);
  player.src = `/media/${t.id}`;
}
let playerReadyFor = null;

$("#pb-play").addEventListener("click", () => { player.paused ? player.play() : player.pause(); });
player.addEventListener("play", () => { $("#pb-play").innerHTML = icon("i-pause", "icon-18"); });
player.addEventListener("pause", () => { $("#pb-play").innerHTML = icon("i-play", "icon-18"); });
player.addEventListener("loadedmetadata", () => {
  $("#pb-seek").max = Math.floor(player.duration * 10);
  $("#pb-dur").textContent = fmtTs(player.duration);
});
player.addEventListener("timeupdate", () => {
  if (!state.editing && !pbDragging) $("#pb-seek").value = Math.floor(player.currentTime * 10);
  $("#pb-cur").textContent = fmtTs(player.currentTime);
  if (!state.editing) highlightAt(player.currentTime);
});
let pbDragging = false;
$("#pb-seek").addEventListener("input", () => { pbDragging = true; });
$("#pb-seek").addEventListener("change", e => { player.currentTime = e.target.value / 10; pbDragging = false; });
$("#pb-speed").addEventListener("change", e => { player.playbackRate = parseFloat(e.target.value); });
$("#pb-mute").addEventListener("click", () => { player.muted = !player.muted; $("#pb-mute").innerHTML = icon(player.muted ? "i-mute" : "i-volume", "icon-18"); });
document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
  if (e.code === "Space" && state.view === "detail") { e.preventDefault(); player.paused ? player.play() : player.pause(); }
});

/* ================= 转写稿 ================= */
async function loadTranscript() {
  const data = await api(`/api/tasks/${state.taskId}/transcript`);
  state.sentences = data.sentences || [];
  $("#task-status").textContent = "转写完成" + (data.language ? ` · ${LANG_NAMES[data.language] || data.language}` : "") + (data.polished ? " · 已标点恢复" : "");
  renderTranscript();
}
function groupParagraphs(sentences) {
  const paras = []; let cur = null;
  sentences.forEach((s, i) => {
    const spk = cur && s.speaker != null && cur.speaker != null && s.speaker !== cur.speaker;
    if (!cur || s.start - cur.end > 1.2 || cur.items.length >= 6 || spk) {
      cur = { start: s.start, end: s.end, items: [], speaker: s.speaker ?? null }; paras.push(cur);
    }
    cur.items.push(i); cur.end = s.end;
  });
  return paras;
}
function needSpace(prev, next) { return /[A-Za-z0-9,;:!?"')\]]$/.test(prev) && /^[A-Za-z0-9"'(\[]/.test(next); }

function renderTranscript() {
  const box = $("#transcript"); box.innerHTML = ""; activeParaIdx = -1;
  if (!state.sentences.length) { box.innerHTML = '<div class="empty-hint">没有识别到语音内容。</div>'; return; }
  state.paras = groupParagraphs(state.sentences);
  const frag = document.createDocumentFragment();
  state.paras.forEach((p, pi) => {
    const el = document.createElement("div"); el.className = "para"; el.dataset.pi = pi;
    if (pi < 18) { el.classList.add("anim"); el.style.animationDelay = (pi * 26) + "ms"; }
    const text = document.createElement("div");
    text.className = "para-text " + (state.displayMode === "both" ? "stacked" : "flow");
    let prev = "";
    p.items.forEach(i => {
      const t = state.sentences[i].text, z = state.translation ? (state.translation[i] || "") : "";
      if (prev && needSpace(prev, t)) text.appendChild(document.createTextNode(" "));
      const seg = document.createElement("span"); seg.className = "seg"; seg.dataset.idx = i;
      const showOrig = state.displayMode !== "zh" || !state.translation;
      const showZh = state.displayMode !== "orig" && state.translation;
      if (showOrig) { const l = document.createElement("span"); l.className = "line orig"; l.textContent = t; seg.appendChild(l); }
      if (showZh) { const l = document.createElement("span"); l.className = "line zh"; l.textContent = z || t; seg.appendChild(l); }
      text.appendChild(seg); prev = t;
    });
    el.insertAdjacentHTML("beforeend", `<span class="ts">${fmtTs(p.start)}</span>`);
    if (p.speaker != null) el.insertAdjacentHTML("beforeend", `<span class="spk spk-${p.speaker % 6}">发言人 ${p.speaker + 1}</span>`);
    el.appendChild(text); frag.appendChild(el);
  });
  box.appendChild(frag);
  const btn = $("#btn-edit");
  btn.disabled = state.displayMode === "zh" && !!state.translation;
  btn.title = btn.disabled ? "请切回「原文」视图再编辑" : "";
  applyTranscriptSearch();
  applyAnnots();
}
$("#transcript").addEventListener("click", e => {
  if (state.editing || e.target.isContentEditable) return;
  const ts = e.target.closest(".ts");
  if (ts) {                          // 时间戳始终可跳转(阅读模式下保留)
    const para = ts.closest(".para");
    if (para) seekTo(state.paras[+para.dataset.pi].start);
    return;
  }
  if (state.reading) return;         // 阅读模式:点正文不跳转,便于选择与标注
  const seg = e.target.closest(".seg"), para = e.target.closest(".para");
  const target = seg ? state.sentences[+seg.dataset.idx] : para ? state.sentences[state.paras[+para.dataset.pi].items[0]] : null;
  if (target) seekTo(target.start);
});

/* ============ 阅读模式 + 批注(高亮 / 评论) ============ */
async function loadHighlights() {
  try {
    const r = await api(`/api/tasks/${state.taskId}/highlights`);
    state.marks = r.marks || [];
    state.comments = r.comments || [];
  } catch { state.marks = []; state.comments = []; }
  applyAnnots(); renderAnnotList();
}
function applyAnnots() {
  const box = $("#transcript"); if (!box) return;
  box.querySelectorAll(".seg").forEach(el => el.classList.remove("hl", "cm"));
  const paint = (r, cls) => {
    for (let i = r.start; i <= r.end; i++) {
      const seg = box.querySelector(`.seg[data-idx="${i}"]`);
      if (seg) seg.classList.add(cls);
    }
  };
  state.marks.forEach(m => paint(m, "hl"));       // 高亮:绿色底
  state.comments.forEach(c => paint(c, "cm"));    // 评论:棕色虚线下划线
}
async function saveAnnots() {
  try {
    await api(`/api/tasks/${state.taskId}/highlights`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marks: state.marks, comments: state.comments }),
    });
  } catch (e) { toast("批注保存失败:" + e.message, 5000); }
}
function setReading(on) {
  state.reading = on; localStorage.setItem("tw_reading", on ? "1" : "0");
  $("#transcript").classList.toggle("reading", on);
  $("#btn-read").classList.toggle("on", on);
  if (!on) { hideHlBar(); hideCmtEditor(); }
}
$("#btn-read").addEventListener("click", () => setReading(!state.reading));

const hlBar = $("#hl-toolbar"), cmtEditor = $("#cmt-editor");
function hideHlBar() { hlBar.hidden = true; }
function hideCmtEditor() { cmtEditor.hidden = true; state.pendingRange = null; }
function placeFloat(el, rect) {
  el.hidden = false;
  el.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - el.offsetWidth - 8)) + "px";
  el.style.top = Math.max(8, rect.top - (el === cmtEditor ? 210 : 44)) + "px";
}
function selectedRange() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0), box = $("#transcript");
  if (!box.contains(range.commonAncestorContainer)) return null;
  let idxs = [];
  box.querySelectorAll(".seg[data-idx]").forEach(seg => { if (sel.containsNode(seg, true)) idxs.push(+seg.dataset.idx); });
  if (!idxs.length) {                 // 选区落在句首/句尾空白 → 按包围盒兜底
    const r = range.getBoundingClientRect();
    box.querySelectorAll(".seg[data-idx]").forEach(seg => {
      const b = seg.getBoundingClientRect();
      if (b.bottom > r.top && b.top < r.bottom) idxs.push(+seg.dataset.idx);
    });
  }
  if (!idxs.length) return null;
  return { start: Math.min(...idxs), end: Math.max(...idxs), rect: range.getBoundingClientRect() };
}
$("#transcript").addEventListener("mouseup", () => setTimeout(() => {
  if (!state.reading || state.editing) { hideHlBar(); return; }
  const r = selectedRange();
  if (!r) { hideHlBar(); return; }
  state.lastSel = r;
  placeFloat(hlBar, r.rect);
}, 0));
hlBar.addEventListener("mousedown", e => e.preventDefault());   // 点浮条不丢选区
hlBar.querySelector('[data-act="hl"]').addEventListener("click", async () => {
  const r = selectedRange(); if (!r) return;
  const quote = (window.getSelection()?.toString() || "").trim();
  state.marks.push({ start: r.start, end: r.end, text: quote });
  applyAnnots(); renderAnnotList(); hideHlBar(); await saveAnnots();
});
hlBar.querySelector('[data-act="vis"]').addEventListener("click", () => {
  const r = selectedRange(); if (!r) return;
  const quote = (window.getSelection()?.toString() || "").trim();
  hideHlBar();
  requestVisual({ scope: "selection", start: r.start, end: r.end, quote });
});
hlBar.querySelector('[data-act="cmt"]').addEventListener("click", () => {
  const r = selectedRange(); if (!r) return;
  const quote = (window.getSelection()?.toString() || "").trim();
  state.pendingRange = { start: r.start, end: r.end, quote };
  hideHlBar();
  $("#cmt-text").value = "";
  placeFloat(cmtEditor, r.rect);
  $("#cmt-text").focus();
});
$("#hl-remove").addEventListener("click", async () => {
  const r = selectedRange(); if (!r) return;
  state.marks = state.marks.filter(m => m.end < r.start || m.start > r.end);
  state.comments = state.comments.filter(c => c.end < r.start || c.start > r.end);
  applyAnnots(); renderAnnotList(); hideHlBar(); await saveAnnots();
});
cmtEditor.addEventListener("mousedown", e => { if (!e.target.closest("textarea")) e.preventDefault(); });
$("#cmt-cancel").addEventListener("click", hideCmtEditor);
$("#cmt-save").addEventListener("click", async () => {
  const text = $("#cmt-text").value.trim(), r = state.pendingRange;
  if (!r || !text) { hideCmtEditor(); return; }
  state.comments.push({ start: r.start, end: r.end, text, quote: r.quote || "" });
  hideCmtEditor(); applyAnnots(); renderAnnotList(); await saveAnnots();
});
$("#cmt-text").addEventListener("keydown", e => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $("#cmt-save").click(); }
});
document.addEventListener("mousedown", e => {
  if (!e.target.closest("#hl-toolbar") && !e.target.closest("#cmt-editor") && !e.target.closest("#transcript")) {
    hideHlBar(); hideCmtEditor();
  }
});
$("#transcript").addEventListener("scroll", hideHlBar);

/* ---- 右栏「批注」清单 ---- */
function annotSnippet(start, end) {
  return state.sentences.slice(start, end + 1).map(s => s.text).join("");
}
function annotStartTs(start) {
  return state.sentences[start] ? state.sentences[start].start : 0;
}
function renderAnnotList() {
  const box = $("#annot-list"); if (!box) return;
  const items = [
    ...state.marks.map((m, i) => ({ ...m, kind: "hl", _i: i })),
    ...state.comments.map((c, i) => ({ ...c, kind: "cm", _i: i })),
  ].sort((a, b) => a.start - b.start);
  const cnt = $("#annot-count");
  if (cnt) cnt.textContent = items.length ? String(items.length) : "";
  if (!items.length) {
    box.innerHTML = '<div class="empty-hint">阅读模式下选中文本,可高亮或写下评论。<br>所有批注会汇总在这里。</div>';
    return;
  }
  box.innerHTML = "";
  for (const it of items) {
    const sentText = annotSnippet(it.start, it.end);
    const quoteText = (it.quote || (it.kind === "hl" ? it.text : "") || sentText).trim();
    const snippet = quoteText.length > 90 ? quoteText.slice(0, 90) + "…" : quoteText;
    const row = document.createElement("div");
    row.className = "annot-item " + it.kind;
    row.innerHTML =
      `<div class="an-head"><span class="an-kind">${it.kind === "hl" ? "高亮" : "评论"}</span>` +
      `<span class="an-time">${fmtTs(annotStartTs(it.start))}</span></div>` +
      `<div class="an-text">${escapeHtml(snippet)}</div>` +
      (it.kind === "cm" ? `<div class="an-cmt">${escapeHtml(it.text)}</div>` : "") +
      `<div class="an-acts"><button class="an-copy">复制</button><button class="an-locate">定位</button>` +
      `<button class="an-del">删除</button></div>`;
    row.querySelector(".an-copy").addEventListener("click", () => {
      copyText(it.kind === "cm" ? `${quoteText}\n${it.text}` : quoteText);
    });
    row.querySelector(".an-locate").addEventListener("click", () => locateAnnot(it.start));
    row.querySelector(".an-del").addEventListener("click", async () => {
      if (it.kind === "hl") state.marks.splice(it._i, 1);
      else state.comments.splice(it._i, 1);
      applyAnnots(); renderAnnotList(); await saveAnnots();
      toast("已删除批注", 2000);
    });
    box.appendChild(row);
  }
}
function copyText(text) {
  const done = () => toast("已复制", 1600);
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try { document.execCommand("copy"); done(); } catch { toast("复制失败", 3000); }
  ta.remove();
}
function locateAnnot(start) {
  const box = $("#transcript");
  const seg = box.querySelector(`.seg[data-idx="${start}"]`);
  if (!seg) return;
  const para = seg.closest(".para");
  const r = box.getBoundingClientRect();
  const el = para || seg;
  const target = Math.max(0, el.offsetTop + el.offsetHeight / 2 - (window.innerHeight / 2 - r.top));
  box.scrollTo({ top: target, behavior: "smooth" });
  box.querySelectorAll(".locate-flash").forEach(x => x.classList.remove("locate-flash"));
  el.classList.add("locate-flash");
  setTimeout(() => el.classList.remove("locate-flash"), 1800);
}

/* 播放高亮 + 滚动 */
let activeParaIdx = -1;
function highlightAt(t) {
  const sents = state.sentences; if (!sents.length) return;
  let idx = sents.findIndex((s, i) => t >= s.start && (t < s.end || i === sents.length - 1));
  if (idx < 0) idx = t >= sents[sents.length - 1]?.end ? sents.length - 1 : -1;
  if (idx < 0) return;
  const segEl = $(`.seg[data-idx="${idx}"]`);
  if (!segEl || segEl.classList.contains("active")) return;
  $$(".seg.active").forEach(el => el.classList.remove("active"));
  segEl.classList.add("active");
  if (state.reading) return;          // 阅读模式不做跟随滚动
  const paraEl = segEl.closest(".para"), pi = +paraEl.dataset.pi, box = $("#transcript");
  // 滚动目标:让当前段落在「整个网页视口」垂直居中,而非转写框居中
  // (转写框上方有视频区/下方有播放栏,框内居中在页面上会偏下)
  const vpCenter = (el) => {
    const r = box.getBoundingClientRect();
    return Math.max(0, el.offsetTop + el.offsetHeight / 2 - (window.innerHeight / 2 - r.top));
  };
  if (pi !== activeParaIdx) {
    activeParaIdx = pi;
    box.scrollTo({ top: vpCenter(paraEl), behavior: "smooth" });
  } else {
    const r = segEl.offsetTop - box.scrollTop;
    if (r < 40 || r > box.clientHeight - 60) box.scrollTo({ top: vpCenter(segEl), behavior: "smooth" });
  }
}
function parseTime(str) {
  if (!str || !String(str).trim()) return null;
  const p = String(str).split(":").map(Number);
  if (p.some(isNaN) || !p.length) return null;
  return p.reduce((acc, v) => acc * 60 + v, 0);
}
function seekTo(sec) {
  if (!player.src || !isFinite(sec)) return;
  player.currentTime = sec + 0.01;
  const p = player.play(); if (p?.catch) p.catch(() => {});
  highlightAt(sec);
}

/* 搜索 */
$("#transcript-search").addEventListener("input", e => applyTranscriptSearch(e.target.value));
function applyTranscriptSearch(q) {
  q = (q !== undefined ? q : $("#transcript-search").value).trim().toLowerCase();
  $$(".seg.hit").forEach(el => el.classList.remove("hit"));
  if (!q) return;
  let first = null;
  $$(".seg").forEach(el => { if (el.textContent.toLowerCase().includes(q)) { el.classList.add("hit"); if (!first) first = el; } });
  if (first) { const box = $("#transcript"); box.scrollTo({ top: first.offsetTop - box.clientHeight / 3, behavior: "smooth" }); }
}

/* 编辑 */
$("#btn-edit").addEventListener("click", () => {
  state.editing = true; $$(".seg .line.orig").forEach(el => (el.contentEditable = "true"));
  $("#btn-edit").hidden = true; $("#btn-save-edit").hidden = false;
  toast("点击文字即可修改,完成后点「保存修改」");
});
$("#btn-save-edit").addEventListener("click", async () => {
  const updated = state.sentences.map((s, i) => ({
    ...s, text: ($(`.seg[data-idx="${i}"] .line.orig`)?.textContent || s.text).trim()
  })).filter(s => s.text);
  try {
    await api(`/api/tasks/${state.taskId}/transcript`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sentences: updated }) });
    const hadAnnots = state.marks.length + state.comments.length;
    state.sentences = updated; state.marks = []; state.comments = [];
    exitEditMode(); renderTranscript(); renderAnnotList();
    toast(hadAnnots ? "已保存,原批注已随文本更新清空" : "已保存");
  } catch (e) { toast("保存失败:" + e.message); }
});
function exitEditMode() {
  state.editing = false; $$(".seg .line.orig").forEach(el => (el.contentEditable = "false"));
  const b1 = $("#btn-edit"), b2 = $("#btn-save-edit");
  if (b1) { b1.hidden = false; b2.hidden = true; }
}

/* ================= 详情页轮询 ================= */
function pollTask() {
  stopAllPolling();
  const tick = async () => {
    try {
      const t = await api(`/api/tasks/${state.taskId}`);
      if (state.view !== "detail" || t.id !== state.taskId) { stopAllPolling(); return; }
      state.task = t; renderDetailHead(t); setupPlayer(t);
      if (t.status === "done") {
        if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
        await loadTranscript(); await loadTranslation(); renderTranscript();
        $("#btn-analyze").disabled = false; $("#btn-mindmap").disabled = false; $("#btn-translate").disabled = false; $("#btn-essay").disabled = false; $("#btn-aititle").disabled = false;
        updateDerivBadges();
        if (t.mindmap_status === "running" || t.essay_status === "running") startDerivPoll();
        if (t.analyzed) await loadAnalysis();
        else if (t.analysis_status === "running") pollAnalysis();
        if (t.polish_status === "running") { $("#btn-analyze").disabled = true; pollPolish(); }
        if (t.translation_status === "running") { $("#btn-translate").disabled = true; pollTranslate(); }
      } else if (t.status === "error") {
        stopAllPolling();
        $("#transcript").innerHTML = `<div class="empty-hint">转写失败:${escapeHtml(t.error || "未知错误")}</div>`;
      }
    } catch (e) { stopAllPolling(); toast("获取任务状态失败:" + e.message); }
  };
  tick(); state.pollTimer = setInterval(tick, 2000);
}
function renderDetailHead(t) {
  $("#detail-title").textContent = titleOf(t);
  const st = statusOf(t), parts = [fmtDate(t.created_at)];
  if (t.duration) parts.push(fmtDur(t.duration));
  $("#detail-meta").textContent = parts.join(" · ") + " · " + st.text;
  if (state.view === "detail") {
    $("#task-status").textContent = st.dot === "done" ? "转写完成" : st.dot === "error" ? "失败" : st.text;
  }
}

/* ================= 标题改名 ================= */
const titleEl = $("#detail-title");
titleEl.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); titleEl.blur(); } if (e.key === "Escape") { titleEl.textContent = titleOf(state.task || {}); titleEl.blur(); } });
titleEl.addEventListener("blur", async () => {
  const val = titleEl.textContent.trim();
  if (!val || !state.task || val === titleOf(state.task)) { titleEl.textContent = titleOf(state.task || {}); return; }
  try {
    await api(`/api/tasks/${state.taskId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: val }) });
    state.task.custom_title = val; toast("已重命名"); fetchTasks();
  } catch (e) { toast("重命名失败:" + e.message); titleEl.textContent = titleOf(state.task); }
});

/* ================= 翻译 ================= */
const TIME_RE = /\b(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)\b/g;
function renderTimeLinks(text) {
  return escapeHtml(text).replace(TIME_RE, (m, h, mm, ss) => {
    const sec = parseInt(h || 0, 10) * 3600 + parseInt(mm, 10) * 60 + parseInt(ss, 10);
    return `<span class="ts-link" data-sec="${sec}" title="点击跳转播放">${m}</span>`;
  });
}
$("#chat-messages").addEventListener("click", e => { const el = e.target.closest(".ts-link"); if (el) seekTo(parseFloat(el.dataset.sec)); });

$$("#lang-ctrl button").forEach(b => {
  if (b.dataset.mode === state.displayMode) { $$("#lang-ctrl button").forEach(x => x.classList.remove("active")); b.classList.add("active"); }
  b.addEventListener("click", () => {
    if (state.editing) exitEditMode();
    state.displayMode = b.dataset.mode; localStorage.setItem("tw_display_mode", state.displayMode);
    $$("#lang-ctrl button").forEach(x => x.classList.toggle("active", x === b));
    renderTranscript();
  });
});
async function loadTranslation() {
  try { const r = await api(`/api/tasks/${state.taskId}/translation`); state.translation = r.zh; } catch { state.translation = null; }
}
$("#btn-translate").addEventListener("click", async () => {
  try { await api(`/api/tasks/${state.taskId}/translate`, { method: "POST" }); pollTranslate(); } catch (e) { toast("无法开始翻译:" + e.message); }
});
function pollTranslate() {
  $("#btn-translate").disabled = true;
  if (state.translatePoll) clearInterval(state.translatePoll);
  state.translatePoll = setInterval(async () => {
    try {
      const t = await api(`/api/tasks/${state.taskId}`); state.task = t;
      if (t.translation_status === "done") { clearInterval(state.translatePoll); state.translatePoll = null; $("#btn-translate").disabled = false; await loadTranslation(); renderTranscript(); fetchTasks(); toast("翻译完成"); }
      else if (t.translation_status === "error") { clearInterval(state.translatePoll); state.translatePoll = null; $("#btn-translate").disabled = false; toast("翻译失败:" + (t.translation_error || ""), 5000); }
      else { $("#task-status").textContent = t.stage || "翻译中"; }
    } catch {}
  }, 2000);
}

/* ================= 导出弹窗 / 更多 ================= */
const exOverlay = $("#export-overlay");
const EX_DIR_KEY = "tw_export_dir", EX_DIRS_KEY = "tw_export_dirs";

function exportDirHistory() {
  try { return JSON.parse(localStorage.getItem(EX_DIRS_KEY) || "[]"); } catch { return []; }
}
function rememberExportDir(dir) {
  const d = (dir || "").trim() || "~/Downloads/Manet";
  localStorage.setItem(EX_DIR_KEY, d);
  const h = exportDirHistory().filter(x => x !== d);
  h.unshift(d);
  localStorage.setItem(EX_DIRS_KEY, JSON.stringify(h.slice(0, 8)));
}
function openExport() {
  $("#more-menu").hidden = true;
  const has = {
    translation: !!state.translation,
    highlights: state.marks.length > 0,
    comments: state.comments.length > 0,
    analysis: !!state.analysis,
    chat: state.chatMessages.length > 0,
    notes: !!$("#my-notes").value.trim(),
  };
  const map = { translation: "#ex-translation", highlights: "#ex-highlights",
    comments: "#ex-comments", analysis: "#ex-analysis", chat: "#ex-chat", notes: "#ex-notes" };
  for (const [k, sel] of Object.entries(map)) {
    const el = $(sel); el.disabled = !has[k]; if (!has[k]) el.checked = false;
  }
  $("#ex-hint").textContent = "Markdown 格式,原文分段与转写框一致。"
    + (has.translation ? "" : " 尚未生成译文。");
  $("#ex-dir").value = localStorage.getItem(EX_DIR_KEY) || "~/Downloads/Manet";
  $("#ex-dir-history").innerHTML = exportDirHistory()
    .map(d => `<option value="${escapeHtml(d)}">`).join("");
  exOverlay.hidden = false;
}
$("#btn-export").addEventListener("click", openExport);
$("#export-close").addEventListener("click", () => (exOverlay.hidden = true));
$("#ex-save").addEventListener("click", async () => {
  const contents = {
    original: $("#ex-original").checked, translation: $("#ex-translation").checked,
    timestamps: $("#ex-timestamps").checked, highlights: $("#ex-highlights").checked,
    comments: $("#ex-comments").checked, analysis: $("#ex-analysis").checked,
    chat: $("#ex-chat").checked, notes: $("#ex-notes").checked,
  };
  const anyBody = contents.original || contents.translation || contents.highlights
    || contents.comments || contents.analysis || contents.chat || contents.notes;
  if (!anyBody) { toast("请至少选择一项导出内容"); return; }
  const dir = $("#ex-dir").value.trim();
  try {
    const r = await api(`/api/tasks/${state.taskId}/export-md`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir, contents }),
    });
    rememberExportDir(dir);
    toast("已导出:" + r.path, 5000);
    exOverlay.hidden = true;
  } catch (e) { toast("导出失败:" + e.message, 5000); }
});

/* 更多菜单:字幕导出与影音封装(从导出弹窗分离,合并为单一封装动作) */
$("#menu-srt").addEventListener("click", () => {
  const lang = state.displayMode;
  if (lang !== "orig" && !state.translation) { toast("请先生成翻译,再导出中文/双语字幕"); return; }
  window.open(`/api/tasks/${state.taskId}/export?format=srt&lang=${lang}`, "_blank");
});
$("#menu-burn").addEventListener("click", () => {
  const mode = state.displayMode;
  if (mode !== "orig" && !state.translation) { toast("请先生成翻译,再封装中文字幕"); return; }
  api(`/api/tasks/${state.taskId}/burn`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, container: "mp4" }),
  }).then(() => openJobs()).catch(e => toast("无法封装:" + e.message));
});

$("#btn-more").addEventListener("click", e => { e.stopPropagation(); $("#more-menu").hidden = !$("#more-menu").hidden; });
document.addEventListener("click", () => { $("#more-menu").hidden = true; });

$("#btn-aititle").addEventListener("click", async () => {
  const b = $("#btn-aititle"); b.disabled = true;   // 生成中防连点
  try {
    const r = await api(`/api/tasks/${state.taskId}/ai-title`, { method: "POST" });
    if (state.task) state.task.ai_title = r.title;
    $("#detail-title").textContent = r.title;
    renderSidebar(); fetchTasks();
  } catch (e) { toast("新标题生成失败:" + e.message, 5000); }
  finally { b.disabled = state.task?.status !== "done"; }
});
$("#menu-polish").addEventListener("click", async () => {
  try { await api(`/api/tasks/${state.taskId}/polish`, { method: "POST" }); pollPolish(); } catch (e) { toast("无法润色:" + e.message); }
});
$("#menu-retranscribe").addEventListener("click", () => { if (state.task) openNewModal(state.task); });
function pollPolish() {
  $("#btn-analyze").disabled = true;
  if (state.polishPoll) clearInterval(state.polishPoll);
  state.polishPoll = setInterval(async () => {
    try {
      const t = await api(`/api/tasks/${state.taskId}`); state.task = t;
      if (t.polish_status === "done") { clearInterval(state.polishPoll); state.polishPoll = null; $("#btn-analyze").disabled = false; await loadTranscript(); fetchTasks(); toast("标点恢复完成"); }
      else if (t.polish_status === "error") { clearInterval(state.polishPoll); state.polishPoll = null; $("#btn-analyze").disabled = false; toast("标点恢复失败:" + (t.polish_error || ""), 5000); }
      else { $("#task-status").textContent = t.stage || "标点恢复中"; }
    } catch {}
  }, 2000);
}


/* ================= AI 解读 ================= */
$("#btn-analyze").addEventListener("click", async () => { try { await api(`/api/tasks/${state.taskId}/analyze`, { method: "POST" }); switchTab("ai"); pollAnalysis(); } catch (e) { toast("无法开始分析:" + e.message); } });
function pollAnalysis() {
  const s = $("#ai-status"); switchTab("ai"); s.hidden = false; s.classList.remove("error");
  s.innerHTML = '<span class="spinner"></span>AI 正在阅读转写稿…';
  $("#btn-analyze").disabled = true;
  if (state.analysisPoll) clearInterval(state.analysisPoll);
  state.analysisPoll = setInterval(async () => {
    try {
      const t = await api(`/api/tasks/${state.taskId}`); state.task = t;
      if (t.analysis_status === "done") { clearInterval(state.analysisPoll); state.analysisPoll = null; s.hidden = true; $("#btn-analyze").disabled = false; await loadAnalysis(); fetchTasks(); }
      else if (t.analysis_status === "error") { clearInterval(state.analysisPoll); state.analysisPoll = null; s.classList.add("error"); s.textContent = "分析失败:" + (t.analysis_error || ""); $("#btn-analyze").disabled = false; }
    } catch {}
  }, 2000);
}
async function loadAnalysis() {
  try { state.analysis = await api(`/api/tasks/${state.taskId}/analysis`); } catch { return; }
  const a = state.analysis, box = $("#ai-content"); box.innerHTML = "";
  let si = 0;
  const sec = (title, build) => { const d = document.createElement("div"); d.className = "ai-section anim"; d.style.animationDelay = (si++ * 50) + "ms"; d.innerHTML = `<h4>${title}</h4>`; const b = document.createElement("div"); build(b); d.appendChild(b); box.appendChild(d); };
  if (a.summary) sec("摘要", b => { b.className = "body"; b.textContent = a.summary; });
  if (a.chapters?.length) sec("章节速览", b => {
    for (const c of a.chapters) {
      const el = document.createElement("div"); el.className = "chapter";
      el.innerHTML = `<div class="c-title"><span class="c-time">${escapeHtml(c.time || "")}</span>${escapeHtml(c.title || "")}</div>${c.detail ? `<div class="c-detail">${escapeHtml(c.detail)}</div>` : ""}`;
      el.addEventListener("click", () => {
        let sec = (typeof c.seconds === "number" && c.seconds > 0) ? c.seconds : parseTime(c.time || "");
        if (!sec) sec = parseTime((c.title || "").match(/^\s*(\d{1,2}:\d{2}(?::\d{2})?)/)?.[1] || "");  // 旧缓存兜底:时间藏在标题开头
        seekTo(sec || 0);
      });
      b.appendChild(el);
    }
  });
  if (a.todos?.length) sec("待办事项", b => { for (const t of a.todos) { const el = document.createElement("div"); el.className = "todo"; el.innerHTML = `<span>${escapeHtml(t.task || "")}</span>` + ((t.owner || t.due) ? `<span class="t-owner">${t.owner ? "@" + escapeHtml(t.owner) : ""}${t.due ? " · " + escapeHtml(t.due) : ""}</span>` : ""); b.appendChild(el); } });
  if (a.keywords?.length) sec("关键词", b => { b.className = "keywords"; b.innerHTML = a.keywords.map(k => `<span>${escapeHtml(k)}</span>`).join(""); });
  if (!box.children.length) box.innerHTML = '<div class="empty-hint">分析结果为空。</div>';
}

/* ================= Tab 切换 ================= */
function switchTab(name) {
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  ["ai", "chat", "notes", "annot", "visual"].forEach(n => ($("#tab-" + n).hidden = n !== name));
  if (name === "annot") renderAnnotList();
  if (name === "visual") { state.seenVisual = true; updateDerivBadges(); renderVisualList(); }
}
$$(".tab").forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));

/* ================= 问答 ================= */
$("#chat-input").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });
const chatInput = $("#chat-input");
chatInput.addEventListener("input", () => { chatInput.style.height = "auto"; chatInput.style.height = Math.min(chatInput.scrollHeight, 110) + "px"; });
$("#btn-chat-send").addEventListener("click", sendChat);
async function sendChat() {
  const text = chatInput.value.trim(); if (!text || state.chatBusy) return;
  state.chatMessages.push({ role: "user", content: text }); chatInput.value = ""; chatInput.style.height = "auto"; renderChat();
  state.chatBusy = true; $("#btn-chat-send").disabled = true;
  state.chatMessages.push({ role: "assistant", content: "思考中…", pending: true }); renderChat();
  try {
    const r = await api(`/api/tasks/${state.taskId}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: state.chatMessages.filter(m => !m.pending).slice(-20) }) });
    state.chatMessages.pop(); state.chatMessages.push({ role: "assistant", content: r.reply });
  } catch (e) { state.chatMessages.pop(); state.chatMessages.push({ role: "assistant", content: e.message, error: true }); }
  finally { state.chatBusy = false; $("#btn-chat-send").disabled = false; renderChat(); saveChatLog(); }
}
function renderChat() {
  const box = $("#chat-messages"); box.innerHTML = "";
  let last = null;
  for (const m of state.chatMessages) {
    const div = document.createElement("div"); div.className = "msg " + (m.role === "user" ? "user" : "ai");
    const bubble = document.createElement("div"); bubble.className = "bubble" + (m.error ? " error" : "");
    if (m.pending) bubble.innerHTML = '<span class="spinner"></span>思考中…';
    else if (m.role === "user") bubble.textContent = m.content;
    else bubble.innerHTML = renderTimeLinks(m.content);
    div.appendChild(bubble); box.appendChild(div); last = div;
  }
  if (last) last.classList.add("new");   // 仅最新一条入场动画
  box.scrollTop = box.scrollHeight;
}

/* ================= 我的笔记 ================= */
async function loadNotes() { try { const r = await api(`/api/tasks/${state.taskId}/notes`); $("#my-notes").value = r.text || ""; $("#notes-status").textContent = ""; } catch {} }
$("#my-notes").addEventListener("input", () => {
  $("#notes-status").textContent = "输入中…";
  clearTimeout(state.notesTimer);
  state.notesTimer = setTimeout(async () => {
    try { await api(`/api/tasks/${state.taskId}/notes`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: $("#my-notes").value }) });
      $("#notes-status").textContent = "已保存 " + new Date().toLocaleTimeString("zh-CN");
    } catch (e) { $("#notes-status").textContent = "保存失败:" + e.message; }
  }, 800);
});

/* ================= 设定 ================= */
const setOverlay = $("#settings-overlay");
$("#nav-settings").addEventListener("click", openSettings);
$("#set-close").addEventListener("click", () => (setOverlay.hidden = true));
async function openSettings() {
  setOverlay.hidden = false; $("#set-result").textContent = ""; $("#set-result").className = "set-result";
  $("#set-key").value = "";
  try {
    const s = await api("/api/settings?reveal=true");   // 本机回环,Key 回显为密码框黑点
    $("#set-base").value = s.llm_base_url || "";
    $("#set-model").value = s.llm_model || "";
    $("#set-polish").checked = !!s.polish_enabled;
    $("#set-key").value = s.llm_api_key || "";
    $("#set-asr").value = s.asr_engine || "whisper";
    $("#set-local-repo").value = s.local_model_repo || "";
    $("#set-essay-prompt").value = s.essay_prompt || "";
    setTrMode(s.translate_mode || "local");
    loadLocalModelStatus();
  } catch (e) { toast("读取设定失败:" + e.message); }
}
function setTrMode(mode) {
  $$("#tr-mode-ctrl button").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  $("#tr-local-box").hidden = mode !== "local";
}
$$("#tr-mode-ctrl button").forEach(b => b.addEventListener("click", () => setTrMode(b.dataset.mode)));
$("#btn-toggle-repo").addEventListener("click", () => {
  const inp = $("#set-local-repo"); inp.hidden = !inp.hidden;
  $("#btn-toggle-repo").textContent = inp.hidden ? "更换模型仓库 ▸" : "收起模型仓库 ▾";
  if (!inp.hidden) inp.focus();
});
let localModelPoll = null;
async function loadLocalModelStatus() {
  try {
    const s = await api("/api/settings/local-model"), el = $("#local-model-status");
    if (s.downloading) {
      el.textContent = `下载中 ${s.downloaded_mb}MB / ${s.total_mb || "?"}MB`;
      if (!localModelPoll) { localModelPoll = setInterval(async () => { await loadLocalModelStatus(); const st = await api("/api/settings/local-model"); if (!st.downloading) { clearInterval(localModelPoll); localModelPoll = null; toast(st.error ? "下载失败:" + st.error : "本地模型已就绪"); } }, 2000); }
    } else if (s.error) { el.textContent = "下载失败:" + s.error; }
    else if (s.installed) { el.textContent = `已就绪(${s.size_mb}MB)${s.loaded ? ",已载入内存" : ""}`; }
    else { el.textContent = "未下载"; }
  } catch {}
}
$("#btn-dl-local").addEventListener("click", async () => { try { await api("/api/settings/local-model/download", { method: "POST" }); loadLocalModelStatus(); } catch (e) { toast("下载失败:" + e.message); } });
function setSetResult(ok, msg) { const el = $("#set-result"); el.className = "set-result " + (ok ? "ok" : "err"); el.textContent = msg; }
async function testSettings(fetchModels) {
  setSetResult(true, "测试中…");
  try {
    const r = await api("/api/settings/test", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ llm_base_url: $("#set-base").value.trim(), llm_api_key: $("#set-key").value.trim() }) });
    if (!r.ok) { setSetResult(false, "连接失败:" + r.error); return; }
    setSetResult(true, `连接成功,共 ${r.models.length} 个可用模型`);
    if (fetchModels) { const dl = $("#model-list"); dl.innerHTML = ""; for (const m of r.models) { const o = document.createElement("option"); o.value = m; dl.appendChild(o); } toast("模型列表已更新"); }
  } catch (e) { setSetResult(false, "测试失败:" + e.message); }
}
$("#set-test").addEventListener("click", () => testSettings(false));

/* ================= 主题:昼 / 夜 / 跟随系统 ================= */
function applyTheme() {
  const pref = localStorage.getItem("tw_theme") || "light";
  const night = pref === "night" || (pref === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = night ? "night" : "light";
  $$("#theme-ctrl button").forEach(b => b.classList.toggle("active", b.dataset.mode === pref));
  if (!$("#mm-overlay").hidden && mmTree) renderMindmap();   // 脑图随主题换配色
}
$$("#theme-ctrl button").forEach(b => b.addEventListener("click", () => {
  localStorage.setItem("tw_theme", b.dataset.mode); applyTheme();
}));
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if ((localStorage.getItem("tw_theme") || "light") === "auto") applyTheme();
});
$("#set-fetch").addEventListener("click", () => testSettings(true));
$("#set-save").addEventListener("click", async () => {
  try {
    await api("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llm_base_url: $("#set-base").value.trim(),
        llm_api_key: $("#set-key").value.trim(),
        llm_model: $("#set-model").value.trim(),
        asr_engine: $("#set-asr").value,
        translate_mode: $("#tr-mode-ctrl button.active").dataset.mode,
        local_model_repo: $("#set-local-repo").value.trim(),
        polish_enabled: $("#set-polish").checked,
        essay_prompt: $("#set-essay-prompt").value.trim(),
      }) });
    toast("设定已保存并立即生效"); setOverlay.hidden = true;
  } catch (e) { toast("保存失败:" + e.message); }
});

/* ================= 思维导图 ================= */
const MM_NODE_H = 36, MM_V_GAP = 12, MM_COL_W = 265, MM_X0 = 30;
let mmTree = null, mmView = { x: 40, y: 40, k: 1 }, mmCollapsed = new Set();
const mmCtx = document.createElement("canvas").getContext("2d");
function mmMeasure(title, depth, reserve) {
  mmCtx.font = (depth === 0 ? "600 15px " : "14px ") + '-apple-system, "PingFang SC", sans-serif';
  const max = (depth === 0 ? 360 : depth === 1 ? 250 : 230) - reserve;
  let t = title, w = mmCtx.measureText(t).width;
  while (w > max && t.length > 4) { t = t.slice(0, -2); w = mmCtx.measureText(t + "…").width; }
  return { text: t === title ? title : t + "…", w: Math.max(w + reserve + 12, 96) };
}
function mmKids(n, path) { return mmCollapsed.has(path) ? [] : (n.children || []); }
function mmLayout(root) {
  const nodes = [], edges = [];
  const heightOf = (n, d, p) => { const k = mmKids(n, p); if (!k.length) return MM_NODE_H; let h = 0; k.forEach((c, i) => { h += heightOf(c, d + 1, p + "." + i); if (i) h += MM_V_GAP; }); return Math.max(h, MM_NODE_H); };
  const place = (n, d, yTop, p) => {
    const h = heightOf(n, d, p), reserve = (n.seconds != null ? 52 : 12), m = mmMeasure(n.title, d, reserve);
    nodes.push({ id: p, depth: d, x: MM_X0 + d * MM_COL_W, y: yTop + h / 2, w: m.w, text: m.text, title: n.title, seconds: n.seconds, time: n.time, nKids: (n.children || []).length, collapsed: mmCollapsed.has(p) });
    let cy = yTop;
    mmKids(n, p).forEach((c, i) => { const kh = heightOf(c, d + 1, p + "." + i); place(c, d + 1, cy, p + "." + i); edges.push([p, p + "." + i]); cy += kh + MM_V_GAP; });
  };
  place(root, 0, 0, "0"); return { nodes, edges };
}
/* 脑图双主题配色:昼=纸面棕系,夜=暖暗底提亮棕 */
const MM_LIGHT = { fills: ["#806B50", "#EFEBE1", "#FFFFFF"], strokes: ["#806B50", "#C9BFAE", "#E4E0D7"], texts: ["#F7F5F0", "#292824", "#55524A"], edge: "#CFC7B4", chip: "#806B50", badge: "#858176", paper: "#FBFAF6" };
const MM_NIGHT = { fills: ["#806B50", "#3A3428", "#2A2823"], strokes: ["#806B50", "#55503F", "#3A372F"], texts: ["#F7F5F0", "#E8E2D5", "#C9C1B0"], edge: "#4A463C", chip: "#C8A878", badge: "#7A7365", paper: "#262420" };
const mmPal = () => (document.documentElement.dataset.theme === "night" ? MM_NIGHT : MM_LIGHT);
function renderMindmap() {
  if (!mmTree) return;
  const P = mmPal();
  const { nodes, edges } = mmLayout(mmTree), byId = {}; nodes.forEach(n => byId[n.id] = n);
  let g = "";
  for (const [a, b] of edges) { const p = byId[a], c = byId[b], x1 = p.x + p.w, x2 = c.x, mx = (x1 + x2) / 2; g += `<path d="M ${x1} ${p.y} C ${mx} ${p.y}, ${mx} ${c.y}, ${x2} ${c.y}" fill="none" stroke="${P.edge}" stroke-width="1.5"/>`; }
  for (const n of nodes) {
    const chip = n.seconds != null ? `<text class="mm-time" data-sec="${n.seconds}" x="${n.x + n.w - 10}" y="${n.y + 4}" text-anchor="end" font-size="11" fill="${P.chip}" font-weight="600">${escapeHtml(n.time || fmtTs(n.seconds, true))}</text>` : "";
    const badge = (n.collapsed && n.nKids) ? `<text x="${n.x + n.w + 8}" y="${n.y + 4}" font-size="11" fill="${P.badge}">+${n.nKids}</text>` : "";
    g += `<g class="mm-node" data-id="${n.id}" data-kids="${n.nKids}"><rect x="${n.x}" y="${n.y - MM_NODE_H / 2}" width="${n.w}" height="${MM_NODE_H}" rx="3" fill="${P.fills[n.depth]}" stroke="${P.strokes[n.depth]}"/><text x="${n.x + 12}" y="${n.y + 5}" font-size="${n.depth === 0 ? 15 : 14}" font-weight="${n.depth === 0 ? 600 : 400}" fill="${P.texts[n.depth]}">${escapeHtml(n.text)}</text>${chip}${badge}<title>${escapeHtml(n.title)}</title></g>`;
  }
  $("#mm-svg").innerHTML = `<g id="mm-root">${g}</g>`; mmApplyView();
}
function mmApplyView() { const r = document.querySelector("#mm-svg > g"); if (r) r.setAttribute("transform", `translate(${mmView.x},${mmView.y}) scale(${mmView.k})`); }
function mmFit() { if (!mmTree) return; const { nodes } = mmLayout(mmTree); if (!nodes.length) return; const xs = nodes.flatMap(n => [n.x, n.x + n.w + 46]), ys = nodes.flatMap(n => [n.y - MM_NODE_H / 2, n.y + MM_NODE_H / 2]); const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys); const wrap = $("#mm-wrap"), W = wrap.clientWidth, H = wrap.clientHeight, bw = maxX - minX, bh = maxY - minY; const kW = W / (bw + 80), kAll = Math.min(kW, H / (bh + 60)); const k = kAll >= 0.8 ? Math.min(kAll, 1.4) : Math.min(kW, 1); mmView = { k, x: (W - bw * k) / 2 - minX * k, y: (H - bh * k) / 2 - minY * k }; mmApplyView(); }
function mmZoom(f) { const w = $("#mm-wrap"), px = w.clientWidth / 2, py = w.clientHeight / 2, k2 = Math.min(3, Math.max(0.2, mmView.k * f)); mmView.x = px - (px - mmView.x) * (k2 / mmView.k); mmView.y = py - (py - mmView.y) * (k2 / mmView.k); mmView.k = k2; mmApplyView(); }
function mmSetStatus(s) { $("#mm-status").textContent = s; }
const MM_HINT = "点击折叠/展开 · 蓝色时间戳跳转播放 · 滚轮滚动 · Ctrl+滚轮缩放";
async function openMindmap(regen = false) {
  if (!regen && mmTree) {
    $("#mm-overlay").hidden = false; state.seenMindmap = true; updateDerivBadges();
    renderMindmap(); mmFit(); mmSetStatus(MM_HINT); return;
  }
  try {
    const r = await api(`/api/tasks/${state.taskId}/mindmap${regen ? "?regen=true" : ""}`, { method: "POST" });
    if (r.queued) { toast("脑图任务已开始,完成后角标提醒", 4000); startDerivPoll(); return; }
    mmTree = r; state.seenMindmap = true; updateDerivBadges();
    $("#mm-overlay").hidden = false; mmCollapsed.clear(); renderMindmap(); mmFit(); mmSetStatus(MM_HINT);
  } catch (e) { toast(/生成中/.test(e.message) ? e.message : "脑图失败:" + e.message, 5000); }
}
/* 脑图/随笔后台任务:角标(完成待看)+ 轮询收尾 */
function updateDerivBadges() {
  const t = state.task; if (!t) return;
  const done = t.status === "done";
  $("#btn-mindmap").classList.toggle("has-new", t.mindmap_status === "done" && !state.seenMindmap);
  $("#btn-essay").classList.toggle("has-new", t.essay_status === "done" && !state.seenEssay);
  $("#btn-visual").classList.toggle("has-new", t.visual_status === "done" && !state.seenVisual);
  $("#btn-mindmap").disabled = !done || t.mindmap_status === "running";
  $("#btn-essay").disabled = !done || t.essay_status === "running";
  $("#btn-visual").disabled = !done || t.visual_status === "running";
}
function startDerivPoll() {
  if (state.derivPoll) return;
  state.derivPoll = setInterval(async () => {
    try {
      const prev = state.task, t = await api(`/api/tasks/${state.taskId}`);
      if (state.view !== "detail" || t.id !== state.taskId) { clearInterval(state.derivPoll); state.derivPoll = null; return; }
      state.task = t; renderDetailHead(t);
      if (prev?.mindmap_status === "running" && t.mindmap_status === "done" && !$("#mm-overlay").hidden) {
        try { mmTree = await api(`/api/tasks/${state.taskId}/mindmap`); renderMindmap(); mmFit(); } catch {}
      }
      if (prev?.mindmap_status === "running" && t.mindmap_status === "error") toast("脑图生成失败:" + (t.mindmap_error || ""), 5000);
      if (prev?.essay_status === "running" && t.essay_status === "done" && !$("#essay-overlay").hidden) {
        try { const r = await api(`/api/tasks/${state.taskId}/essay`); renderEssay(r.essay); } catch {}
      }
      if (prev?.essay_status === "running" && t.essay_status === "error") toast("随笔生成失败:" + (t.essay_error || ""), 5000);
      if (prev?.visual_status === "running" && t.visual_status === "done") loadVisuals();
      if (prev?.visual_status === "running" && t.visual_status === "error") toast("视觉化生成失败:" + (t.visual_error || ""), 5000);
      updateDerivBadges(); fetchTasks();
      if (t.mindmap_status !== "running" && t.essay_status !== "running" && t.visual_status !== "running") { clearInterval(state.derivPoll); state.derivPoll = null; }
    } catch {}
  }, 2500);
}
$("#btn-mindmap").addEventListener("click", () => openMindmap(false));
$("#mm-regen").addEventListener("click", () => openMindmap(true));
$("#mm-close").addEventListener("click", () => ($("#mm-overlay").hidden = true));
$("#mm-fit").addEventListener("click", mmFit);
$("#mm-zoom-in").addEventListener("click", () => mmZoom(1.2));
$("#mm-zoom-out").addEventListener("click", () => mmZoom(1 / 1.2));
let mmDrag = null;
const mmSvg = $("#mm-svg");
mmSvg.addEventListener("pointerdown", e => { if (e.target.closest(".mm-node")) return; mmDrag = { x: e.clientX, y: e.clientY, vx: mmView.x, vy: mmView.y }; mmSvg.setPointerCapture(e.pointerId); mmSvg.classList.add("dragging"); });
mmSvg.addEventListener("pointermove", e => { if (!mmDrag) return; mmView.x = mmDrag.vx + (e.clientX - mmDrag.x); mmView.y = mmDrag.vy + (e.clientY - mmDrag.y); mmApplyView(); });
mmSvg.addEventListener("pointerup", () => { mmDrag = null; mmSvg.classList.remove("dragging"); });
$("#mm-wrap").addEventListener("wheel", e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) { const r = $("#mm-wrap").getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top, f = e.deltaY < 0 ? 1.12 : 1 / 1.12, k2 = Math.min(3, Math.max(0.2, mmView.k * f)); mmView.x = px - (px - mmView.x) * (k2 / mmView.k); mmView.y = py - (py - mmView.y) * (k2 / mmView.k); mmView.k = k2; }
  else { mmView.x -= e.shiftKey ? e.deltaY : e.deltaX; mmView.y -= e.shiftKey ? 0 : e.deltaY; }
  mmApplyView();
}, { passive: false });
mmSvg.addEventListener("click", e => {
  const chip = e.target.closest(".mm-time");
  if (chip) { $("#mm-overlay").hidden = true; seekTo(parseFloat(chip.dataset.sec)); return; }
  const g = e.target.closest(".mm-node");
  if (g && +g.dataset.kids > 0) { const id = g.dataset.id; mmCollapsed.has(id) ? mmCollapsed.delete(id) : mmCollapsed.add(id); renderMindmap(); }
});
$("#mm-export").addEventListener("click", () => {
  const svg = $("#mm-svg"), wrap = $("#mm-wrap"), W = wrap.clientWidth, H = wrap.clientHeight;
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg"); svg.setAttribute("width", W); svg.setAttribute("height", H);
  const xml = new XMLSerializer().serializeToString(svg), url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
  const img = new Image();
  img.onload = () => { const c = document.createElement("canvas"); c.width = W * 2; c.height = H * 2; const ctx = c.getContext("2d"); ctx.scale(2, 2); ctx.fillStyle = mmPal().paper; ctx.fillRect(0, 0, W, H); ctx.drawImage(img, 0, 0, W, H); URL.revokeObjectURL(url); const a = document.createElement("a"); a.download = `${(state.task && state.task.display_title) || "思维导图"}.png`; a.href = c.toDataURL("image/png"); a.click(); toast("已导出 PNG"); };
  img.src = url;
});

/* ================= AI 随笔 ================= */
function essaySetStatus(s) { $("#essay-status").textContent = s; }
function renderEssay(text) {
  const b = $("#essay-body");
  if (!text) { b.innerHTML = '<div class="empty-hint">随笔为空。</div>'; return; }
  b.innerHTML = `<div class="essay-text">${escapeHtml(text)}</div>`;
}
async function openEssay(regen = false) {
  try {
    const r = await api(`/api/tasks/${state.taskId}/essay${regen ? "?regen=true" : ""}`, { method: "POST" });
    if (r.queued) { toast("随笔任务已开始,完成后角标提醒", 4000); startDerivPoll(); return; }
    state.seenEssay = true; updateDerivBadges();
    $("#essay-overlay").hidden = false; renderEssay(r.essay); essaySetStatus("");
  } catch (e) { toast(/生成中/.test(e.message) ? e.message : "随笔失败:" + e.message, 5000); }
}
$("#btn-essay").addEventListener("click", () => openEssay(false));
$("#essay-regen").addEventListener("click", () => openEssay(true));
$("#essay-close").addEventListener("click", () => ($("#essay-overlay").hidden = true));
$("#essay-export-obsidian").addEventListener("click", async () => {
  try {
    const r = await api(`/api/tasks/${state.taskId}/export-essay`, { method: "POST" });
    toast("随笔已导出到 Obsidian:" + r.path, 4000);
  } catch (e) { toast("导出失败:" + e.message, 5000); }
});

/* ================= 视觉化 ================= */
/* 服务端只产出结构化 spec,前端按 Manet 规范渲染为矢量卡片(SVG) */
/* visualSVG 见 visual.js(语义 blocks → SVG 排版引擎) */
function visualItemEl(v, taskId, onDelete) {
  const item = document.createElement("div"); item.className = "vis-item";
  item.innerHTML = `<div class="vis-head"><span class="vis-title">${escapeHtml(v.title || "视觉化")}</span>`
    + `<span class="vis-kind">${v.kind === "selection" ? "节选" : "全文"}</span>`
    + `<button class="vis-del" title="删除"><svg class="icon icon-14"><use href="#i-close"/></svg></button></div>`
    + `<div class="vis-thumb">${visualSVG(v.spec)}</div>`;
  item.addEventListener("click", () => openVisual(v, taskId));
  item.querySelector(".vis-del").addEventListener("click", async e => {
    e.stopPropagation();
    try {
      await api(`/api/tasks/${taskId}/visuals/${v.id}`, { method: "DELETE" });
      item.remove();
      toast("已删除视觉化", 2400);
      onDelete && onDelete(v);
    } catch (err) { toast("删除失败:" + err.message, 4000); }
  });
  return item;
}
function renderVisualList() {
  const box = $("#visual-list"); if (!box) return;
  const cnt = $("#visual-count");
  if (cnt) cnt.textContent = state.visuals.length ? String(state.visuals.length) : "";
  if (!state.visuals.length) {
    box.innerHTML = '<div class="empty-hint">点右上角「视觉化」把全文提炼成一张卡片,<br>或在阅读模式下选中一段文字单独视觉化。</div>';
    return;
  }
  box.innerHTML = "";
  [...state.visuals].sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).forEach(v => {
    box.appendChild(visualItemEl(v, state.taskId, () => {
      state.visuals = state.visuals.filter(x => x.id !== v.id);
      renderVisualList(); updateDerivBadges();
    }));
  });
}
async function loadVisuals() {
  try {
    const r = await api(`/api/tasks/${state.taskId}/visuals`);
    state.visuals = r.visuals || [];
  } catch { state.visuals = []; }
  renderVisualList();
  updateDerivBadges();
}
let currentVisual = null;
function openVisual(v, taskId = state.taskId) {
  currentVisual = { ...v, _taskId: taskId };
  $("#visual-kind").textContent = v.kind === "selection" ? "节选" : "全文";
  $("#visual-body").innerHTML = visualSVG(v.spec);
  $("#visual-overlay").hidden = false;
}
$("#visual-close").addEventListener("click", () => ($("#visual-overlay").hidden = true));
$("#visual-png").addEventListener("click", () => {
  const svg = $("#visual-body svg"); if (!svg) return;
  const vb = svg.viewBox.baseVal, W = vb.width, H = vb.height;
  const xml = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas"); c.width = W * 2; c.height = H * 2;
    const ctx = c.getContext("2d"); ctx.scale(2, 2); ctx.fillStyle = "#F7F5F0";
    ctx.fillRect(0, 0, W, H); ctx.drawImage(img, 0, 0, W, H); URL.revokeObjectURL(url);
    const a = document.createElement("a");
    a.download = `${(currentVisual?.title || "视觉化").replace(/[\\/:*?"<>|]/g, "_")}.png`;
    a.href = c.toDataURL("image/png"); a.click();
    toast("已导出 PNG");
  };
  img.src = url;
});
$("#visual-regen").addEventListener("click", async () => {
  if (!currentVisual) return;
  try {
    await api(`/api/tasks/${currentVisual._taskId}/visuals/${currentVisual.id}/regen`, { method: "POST" });
    toast("已开始重新生成,完成后角标提醒", 4000);
    $("#visual-overlay").hidden = true;
    if (currentVisual._taskId === state.taskId) startDerivPoll();
  } catch (e) { toast(/生成中/.test(e.message) ? e.message : "重新生成失败:" + e.message, 5000); }
});
async function requestVisual(body) {
  try {
    await api(`/api/tasks/${state.taskId}/visuals`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    toast("视觉化任务已开始,完成后角标提醒", 4000);
    startDerivPoll();
  } catch (e) { toast(/生成中/.test(e.message) ? e.message : "视觉化失败:" + e.message, 5000); }
}
$("#btn-visual").addEventListener("click", () => requestVisual({ scope: "full" }));

/* ================= 任务中心 ================= */
function jobsOf(t) {
  const out = [];
  const push = (icon, kind, st, stage, extra) => {
    let s = st; if (st === "running" && t.cancel_requested) s = "canceling"; else if (st === "running" && t.paused) s = "paused";
    out.push(Object.assign({ icon, kind, state: s, stage: stage || "", title: titleOf(t), taskId: t.id, canPause: kind !== "转写" }, extra));
  };
  if (t.status === "queued") push("i-wave", "转写", "running", "排队中");
  else if (t.status === "transcribing") push("i-wave", "转写", "running", t.stage);
  else if (t.status === "error") push("i-wave", "转写", "error", t.error);
  else if (t.status === "cancelled") push("i-wave", "转写", "cancelled", "已终止");
  if (t.polish_status === "running") push("i-punct", "标点恢复", "running", t.stage);
  else if (t.polish_status === "error") push("i-punct", "标点恢复", "error", t.polish_error);
  else if (t.polish_status === "cancelled") push("i-punct", "标点恢复", "cancelled", "已终止");
  if (t.translation_status === "running") push("i-translate", "翻译", "running", t.stage);
  else if (t.translation_status === "error") push("i-translate", "翻译", "error", t.translation_error);
  else if (t.translation_status === "cancelled") push("i-translate", "翻译", "cancelled", "已终止");
  if (t.analysis_status === "running") push("i-interpret", "AI 解读", "running", "生成中");
  else if (t.analysis_status === "error") push("i-interpret", "AI 解读", "error", t.analysis_error);
  else if (t.analysis_status === "cancelled") push("i-interpret", "AI 解读", "cancelled", "已终止");
  if (t.mindmap_status === "running") push("i-mindmap", "脑图", "running", "生成中", { canPause: false });
  else if (t.mindmap_status === "error") push("i-mindmap", "脑图", "error", t.mindmap_error);
  if (t.essay_status === "running") push("i-essay", "随笔", "running", "撰写中");
  else if (t.essay_status === "error") push("i-essay", "随笔", "error", t.essay_error);
  if (t.visual_status === "running") push("i-visual", "视觉化", "running", "生成中", { canPause: false });
  else if (t.visual_status === "error") push("i-visual", "视觉化", "error", t.visual_error);
  if (t.burn_status === "running") push("i-film", "字幕封装", "running", "正在封装");
  else if (t.burn_status === "done") push("i-film", "字幕封装", "await", "已完成,待保存", { path: t.burned_path });
  else if (t.burn_status === "error") push("i-film", "字幕封装", "error", t.burn_error);
  else if (t.burn_status === "cancelled") push("i-film", "字幕封装", "cancelled", "已终止");
  return out;
}
function allJobs() {
  const jobs = []; for (const t of state.tasks) jobs.push(...jobsOf(t));
  const rank = { running: 0, canceling: 0, paused: 1, await: 2, error: 3, cancelled: 4 };
  return jobs.sort((a, b) => rank[a.state] - rank[b.state]);
}
const HIST_CATS = { "转写": "transcribe", "解读": "analyze", "翻译": "translate",
  "脑图": "mindmap", "随笔": "essay", "视觉化": "visual", "封装": "burn" };

async function loadHistory() {
  try { state.history = await api("/api/history"); } catch { state.history = []; }
}
function historyRows() {
  const key = HIST_CATS[state.histFilter];
  return state.history.filter(h => !key || h.kind === key);
}
function renderJobs() {
  const box = $("#jobs-list"); box.innerHTML = "";
  const fb = $("#jobs-filters"); fb.innerHTML = "";
  ["全部", "转写", "解读", "翻译", "脑图", "随笔", "视觉化", "封装"].forEach(f => {
    const c = document.createElement("button");
    c.className = "f-chip" + (state.histFilter === f ? " active" : "");
    c.textContent = f;
    c.addEventListener("click", () => { state.histFilter = f; renderJobs(); });
    fb.appendChild(c);
  });
  const jobs = allJobs().filter(j => ["running", "paused", "canceling", "await"].includes(j.state));
  if (jobs.length) {
    box.insertAdjacentHTML("beforeend", '<div class="jobs-section-head">进行中</div>');
    for (const j of jobs) {
      const row = document.createElement("div");
      row.className = "job-row" + (j.state === "await" ? " done" : j.state === "error" ? " err" : j.state === "cancelled" ? " stop" : j.state === "paused" ? " paused" : "");
      let act = "";
      if (j.state === "await") act = `<button class="btn primary sm" data-save="${j.taskId}">${icon("i-download")}保存文件</button>`;
      else if (j.state === "running") act = (j.canPause ? `<button class="btn ghost sm" data-pause="${j.taskId}" title="暂停">${icon("i-pause")}</button>` : "") + `<button class="btn ghost sm danger" data-cancel="${j.taskId}" title="终止">${icon("i-close")}</button><span class="spinner"></span>`;
      else if (j.state === "paused") act = `<button class="btn ghost sm" data-resume="${j.taskId}" title="继续">${icon("i-play")}</button><button class="btn ghost sm danger" data-cancel="${j.taskId}" title="终止">${icon("i-close")}</button>`;
      else if (j.state === "canceling") act = '<button class="btn ghost sm" disabled>终止中…</button><span class="spinner"></span>';
      const stage = j.stage || { running: "进行中", paused: "已暂停", canceling: "终止中", await: "完成", error: "失败", cancelled: "已终止" }[j.state];
      row.innerHTML = `<span class="j-icon">${icon(j.icon, "icon-18")}</span><div class="j-main"><div class="j-title">${escapeHtml(j.title)} · ${j.kind}</div><div class="j-stage ${j.state === "error" ? "err" : ""}">${escapeHtml(stage)}</div></div>${act}`;
      box.appendChild(row);
    }
    box.querySelectorAll("[data-save]").forEach(b => b.addEventListener("click", () => { const t = state.tasks.find(x => x.id === b.dataset.save); const a = document.createElement("a"); a.href = `/api/tasks/${b.dataset.save}/burned`; a.download = t?.burned_path?.split("/").pop() || "subbed.mp4"; document.body.appendChild(a); a.click(); a.remove(); toast("开始下载"); }));
    box.querySelectorAll("[data-pause]").forEach(b => b.addEventListener("click", () => jobPause(b.dataset.pause, true)));
    box.querySelectorAll("[data-resume]").forEach(b => b.addEventListener("click", () => jobPause(b.dataset.resume, false)));
    box.querySelectorAll("[data-cancel]").forEach(b => b.addEventListener("click", () => jobCancel(b.dataset.cancel)));
  }
  box.insertAdjacentHTML("beforeend", '<div class="jobs-section-head">历史</div>');
  const rows = historyRows();
  if (!rows.length) {
    box.insertAdjacentHTML("beforeend", '<div class="empty-hint">没有匹配的历史记录</div>');
    return;
  }
  for (const h of rows) {
    const kindLabel = Object.keys(HIST_CATS).find(k => HIST_CATS[k] === h.kind) || h.kind;
    const stLabel = h.status === "error" ? "失败" : h.status === "cancelled" ? "已终止" : "";
    const row = document.createElement("div"); row.className = "hist-row";
    row.innerHTML = `<span class="hist-title">${escapeHtml(h.title)}</span>`
      + `<span class="hist-kind">${kindLabel}</span>`
      + (stLabel ? `<span class="hist-status ${h.status === "error" ? "err" : "stop"}">${stLabel}</span>` : "")
      + `<span class="hist-date">${fmtDate(h.at)}</span>`;
    box.appendChild(row);
  }
}
async function jobPause(id, paused) { try { await api(`/api/tasks/${id}/pause`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused }) }); await fetchTasks(); renderJobs(); toast(paused ? "已暂停" : "已继续"); } catch (e) { toast("操作失败:" + e.message); } }
async function jobCancel(id) { if (!confirm("终止任务?进行中的工作会立刻停止并丢弃结果。")) return; try { await api(`/api/tasks/${id}/cancel`, { method: "POST" }); await fetchTasks(); renderJobs(); } catch (e) { toast("终止失败:" + e.message); } }
function updateFab() {
  const jobs = allJobs(), running = jobs.filter(j => j.state === "running").length, awaiting = jobs.filter(j => j.state === "await").length;
  const fab = $("#job-fab"); fab.hidden = !(running || awaiting);
  $("#job-fab-icon").innerHTML = icon(running ? "i-running" : "i-download", "icon-18" + (running ? " spin" : ""));
  $("#job-fab-count").textContent = String(running || awaiting);
  const nc = $("#nav-jobs-count");   // 侧栏「任务」入口同步计数
  nc.textContent = (running || awaiting) ? String(running + awaiting) : "";
  nc.classList.toggle("live", running > 0);
  fab.classList.toggle("attention", !running && awaiting > 0);
}
let jobsPoll = null;
async function openJobs() {
  $("#jobs-overlay").hidden = false;
  await loadHistory(); renderJobs();
  if (jobsPoll) clearInterval(jobsPoll);
  jobsPoll = setInterval(async () => {
    if ($("#jobs-overlay").hidden) { clearInterval(jobsPoll); jobsPoll = null; return; }
    await fetchTasks(); await loadHistory(); renderJobs();
  }, 3000);
}
let clearDays = 7;
function clearEstimate() {
  const cutoff = Date.now() / 1000 - clearDays * 86400;
  const n = (state.history || []).filter(h => h.at < cutoff && h.task_id !== state.taskId).length;
  $("#clear-estimate").textContent = n
    ? `符合条件的历史记录 ${n} 条;当前打开的任务不在其中。`
    : "没有符合条件的历史记录。";
  $("#clear-confirm").disabled = n === 0;
  $("#clear-confirm").textContent = n ? `清除 ${n} 条记录` : "清除记录";
}
function openClear() {
  clearDays = 7;
  document.querySelectorAll("#clear-days button").forEach(b =>
    b.classList.toggle("active", b.dataset.days === "7"));
  clearEstimate();
  $("#clear-overlay").hidden = false;
}
$("#jobs-clear").addEventListener("click", openClear);
$("#clear-close").addEventListener("click", () => ($("#clear-overlay").hidden = true));
$("#clear-cancel").addEventListener("click", () => ($("#clear-overlay").hidden = true));
$("#clear-days").addEventListener("click", e => {
  const b = e.target.closest("button[data-days]");
  if (!b) return;
  clearDays = parseInt(b.dataset.days, 10);
  document.querySelectorAll("#clear-days button").forEach(x =>
    x.classList.toggle("active", x === b));
  clearEstimate();
});
$("#clear-confirm").addEventListener("click", async () => {
  const btn = $("#clear-confirm");
  btn.disabled = true;
  try {
    const excl = state.taskId ? `&exclude=${encodeURIComponent(state.taskId)}` : "";
    const r = await api(`/api/tasks?before_days=${clearDays}${excl}`, { method: "DELETE" });
    $("#clear-overlay").hidden = true;
    const keep = r.skipped ? `,保留运行中 ${r.skipped} 条` : "";
    toast(`已清除 ${r.records ?? r.removed} 条记录${keep}`, 4000);
    await loadHistory(); await fetchTasks(); renderJobs();
  } catch (err) { toast("清除失败:" + err.message, 5000); }
  finally { btn.disabled = false; }
});
$("#jobs-close").addEventListener("click", () => ($("#jobs-overlay").hidden = true));
$("#job-fab").addEventListener("click", openJobs);
$("#nav-jobs").addEventListener("click", openJobs);

/* ================= 侧边栏搜索 ================= */
$("#search-input").addEventListener("input", e => {
  state.search = e.target.value;
  renderSidebar();
  renderHome();
});

function saveChatLog() {
  if (!state.taskId || !state.chatMessages.length) return;
  // 异步落盘,不阻塞 UI
  const msgs = state.chatMessages.filter(m => !m.pending && m.role !== "error");
  api(`/api/tasks/${state.taskId}/chat-log`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: msgs }),
  }).catch(() => {});
}

/* ================= 启动 ================= */
setReading(state.reading); applyTheme(); fetchTasks(); fetchFolders();
