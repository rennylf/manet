/* Manet — quod manet, manet. 思想仍在。 */
"use strict";
window.onerror = (msg, src, line, col) => {
  const el = document.getElementById("toast");
  el.textContent = `JS错误: ${msg} (第${line}行)`;
  el.hidden = false; setTimeout(() => (el.hidden = true), 12000);
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const state = {
  tasks: [], view: "home", taskId: null, task: null,
  sentences: [], paras: [], analysis: null, editing: false, search: "",
  pollTimer: null, polishPoll: null, analysisPoll: null,
  chatMessages: [], chatBusy: false, notesTimer: null,
  translation: null, displayMode: localStorage.getItem("tw_display_mode") || "orig",
  folders: [], folderFilter: null, translatePoll: null, burnPoll: null,
};
const MODE_NAMES = { orig: "原文", zh: "中文", both: "双语" };
const VIDEO_EXT = ["mp4", "mov", "mkv", "avi", "webm", "flv", "wmv", "ts"];
const AUDIO_EXT = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "wma", "amr"];
const LANG_NAMES = { zh: "中文", en: "英文", ja: "日文", ko: "韩文", yue: "粤语" };

/* ================= 工具 ================= */
function toast(msg, ms = 2600) {
  const el = $("#toast"); el.textContent = msg; el.hidden = false;
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
  if (t.analysis_status === "running") return { dot: "running", text: "Scriba 解读生成中" };
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
    c.textContent = label;
    c.addEventListener("click", () => { state.folderFilter = id; renderFolderBar(); renderHome(); });
    bar.appendChild(c);
  };
  mk(null, `全部 ${state.tasks.length}`);
  for (const f of state.folders) mk(f.id, `📁 ${f.name} ${counts[f.id] || 0}`);
  if (state.folderFilter) {
    const mkAct = (txt, fn) => { const s = document.createElement("span"); s.className = "f-act"; s.textContent = txt; s.addEventListener("click", fn); bar.appendChild(s); };
    mkAct("✏️ 重命名", async () => {
      const f = state.folders.find(x => x.id === state.folderFilter);
      const n = prompt("文件夹新名称:", f.name);
      if (!n?.trim()) return;
      await api(`/api/folders/${f.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: n }) });
      fetchFolders();
    });
    mkAct("🗑 删除", async () => {
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
  for (const t of list) {
    const st = statusOf(t), card = document.createElement("div");
    card.className = "task-card";
    const badges = [];
    if (t.status === "error") badges.push('<span class="badge warn">转写失败</span>');
    else if (st.dot === "running" || st.dot === "queued") badges.push(`<span class="badge run">${escapeHtml(st.text)}</span>`);
    if (t.polish_status === "done" || t.polished) badges.push('<span class="badge ai">AI 润色</span>');
    if (t.analyzed) badges.push('<span class="badge ai">已解读</span>');
    if (t.translation_status === "done") badges.push('<span class="badge ai">已翻译</span>');
    if (t.burn_status === "done") badges.push('<span class="badge ai">字幕视频</span>');
    card.innerHTML = `<div class="c-top"><span class="status-dot ${st.dot}"></span><span class="c-title">${escapeHtml(titleOf(t))}</span><button class="card-menu-btn" title="管理">⋯</button></div><div class="c-meta">${fmtDate(t.created_at)}${t.duration ? " · " + fmtDur(t.duration) : ""}${t.language ? " · " + (LANG_NAMES[t.language] || t.language) : ""}</div><div class="c-badges">${badges.join("")}</div>`;
    card.addEventListener("click", () => openDetail(t.id));
    card.querySelector(".card-menu-btn").addEventListener("click", e => { e.stopPropagation(); openCardMenu(t, e.clientX, e.clientY); });
    grid.appendChild(card);
  }
  if (!list.length && state.tasks.length) grid.innerHTML = '<div class="empty-hint">没有匹配的录音</div>';
  else if (!state.tasks.length) grid.innerHTML = '<div class="empty-hint">还没有录音,上传第一个文件开始吧</div>';
}
function openCardMenu(t, x, y) {
  const menu = $("#card-menu");
  const items = ['<div class="cm-head">移动到</div><a data-move="">📄 根目录</a>'];
  for (const f of state.folders) if (f.id !== t.folder) items.push(`<a data-move="${f.id}">📁 ${escapeHtml(f.name)}</a>`);
  items.push('<div class="cm-sep"></div><a class="danger" data-del="1">🗑 删除录音…</a>');
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
  state.view = "home"; stopAllPolling(); $("#player").pause();
  $("#view-detail").hidden = true; $("#view-home").hidden = false;
  renderSidebar(); fetchTasks(); fetchFolders();
}
function openDetail(taskId) {
  state.view = "detail"; state.taskId = taskId;
  state.analysis = null; state.sentences = []; state.paras = [];
  state.chatMessages = []; state.translation = null;
  activeParaIdx = -1; playerReadyFor = null; exitEditMode();
  $("#view-home").hidden = true; $("#view-detail").hidden = false;
  $("#chat-messages").innerHTML = '<div class="empty-hint">就这段录音提问…</div>';
  $("#transcript").innerHTML = '<div class="empty-hint"><span class="spinner"></span>加载中…</div>';
  $("#ai-content").innerHTML = '<div class="empty-hint">点击右上角「✨ Scriba 解读」,<br>生成摘要、章节速览、待办与关键词。</div>';
  $("#ai-status").hidden = true; switchTab("ai");
  $("#btn-analyze").disabled = true; $("#btn-mindmap").disabled = true; $("#btn-translate").disabled = true; $("#btn-essay").disabled = true;
  renderSidebar(); pollTask(); loadNotes();
}
$("#nav-home").addEventListener("click", showHome);
$("#btn-back").addEventListener("click", showHome);
function stopAllPolling() {
  for (const k of ["pollTimer", "polishPoll", "analysisPoll", "translatePoll", "burnPoll"])
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
        t.analyzed && "Scriba 解读(摘要/章节/待办)",
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
      $("#ai-content").innerHTML = '<div class="empty-hint">转写完成后可生成 Scriba 解读。</div>';
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
player.addEventListener("play", () => { $("#pb-play").textContent = "⏸"; });
player.addEventListener("pause", () => { $("#pb-play").textContent = "▶"; });
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
$("#pb-mute").addEventListener("click", () => { player.muted = !player.muted; $("#pb-mute").textContent = player.muted ? "🔇" : "🔊"; });
document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
  if (e.code === "Space" && state.view === "detail") { e.preventDefault(); player.paused ? player.play() : player.pause(); }
});

/* ================= 转写稿 ================= */
async function loadTranscript() {
  const data = await api(`/api/tasks/${state.taskId}/transcript`);
  state.sentences = data.sentences || [];
  $("#task-status").textContent = "✅ 转写完成" + (data.language ? ` · ${LANG_NAMES[data.language] || data.language}` : "") + (data.polished ? " · 已 AI 润色" : "");
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
}
$("#transcript").addEventListener("click", e => {
  if (state.editing || e.target.isContentEditable) return;
  const seg = e.target.closest(".seg"), para = e.target.closest(".para");
  const target = seg ? state.sentences[+seg.dataset.idx] : para ? state.sentences[state.paras[+para.dataset.pi].items[0]] : null;
  if (target) seekTo(target.start);
});

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
  const paraEl = segEl.closest(".para"), pi = +paraEl.dataset.pi, box = $("#transcript");
  if (pi !== activeParaIdx) {
    activeParaIdx = pi;
    box.scrollTo({ top: Math.max(0, paraEl.offsetTop - box.clientHeight / 2 + paraEl.offsetHeight / 2), behavior: "smooth" });
  } else {
    const r = segEl.offsetTop - box.scrollTop;
    if (r < 40 || r > box.clientHeight - 60) box.scrollTo({ top: segEl.offsetTop - box.clientHeight / 2, behavior: "smooth" });
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
  highlightAt(sec); toast("已跳转 " + fmtTs(sec, true));
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
    state.sentences = updated; exitEditMode(); renderTranscript(); toast("已保存");
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
        $("#btn-analyze").disabled = false; $("#btn-mindmap").disabled = false; $("#btn-translate").disabled = false; $("#btn-essay").disabled = false;
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
    $("#task-status").textContent = st.dot === "done" ? "✅ 转写完成" : st.dot === "error" ? "❌ 失败" : "🔄 " + st.text;
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
      else { $("#task-status").textContent = "🌐 " + (t.stage || "翻译中"); }
    } catch {}
  }, 2000);
}

/* ================= 导出 / 更多 ================= */
$("#btn-export").addEventListener("click", e => { e.stopPropagation(); $("#more-menu").hidden = true; $("#export-menu").hidden = !$("#export-menu").hidden; });
$("#btn-more").addEventListener("click", e => { e.stopPropagation(); $("#export-menu").hidden = true; $("#more-menu").hidden = !$("#more-menu").hidden; });
document.addEventListener("click", () => { $("#export-menu").hidden = true; $("#more-menu").hidden = true; });
$$("#export-menu a[data-format]").forEach(a => a.addEventListener("click", () => {
  const lang = a.dataset.lang || state.displayMode;
  if (lang !== "orig" && !state.translation) { toast("请先生成翻译,再导出中文/双语版本"); return; }
  window.open(`/api/tasks/${state.taskId}/export?format=${a.dataset.format}&lang=${lang}`, "_blank");
}));

$("#menu-obsidian").addEventListener("click", async () => {
  try {
    const r = await api(`/api/tasks/${state.taskId}/export-obsidian`, { method: "POST" });
    toast("已导出到 Obsidian:" + r.path);
  } catch (e) { toast("Obsidian 导出失败:" + e.message); }
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
      else { $("#task-status").textContent = "✨ " + (t.stage || "AI 标点恢复中"); }
    } catch {}
  }, 2000);
}

/* 字幕封装 */
function bindBurn(sel, container) {
  $(sel).addEventListener("click", async () => {
    const mode = state.displayMode;
    if (mode !== "orig" && !state.translation) { toast("请先生成翻译再封装中文字幕"); return; }
    try { await api(`/api/tasks/${state.taskId}/burn`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, container }) }); openJobs(); } catch (e) { toast("无法封装:" + e.message); }
  });
}
bindBurn("#menu-burn-mp4", "mp4"); bindBurn("#menu-burn-mkv", "mkv");

/* ================= Scriba 解读 ================= */
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
  const sec = (title, build) => { const d = document.createElement("div"); d.className = "ai-section"; d.innerHTML = `<h4>${title}</h4>`; const b = document.createElement("div"); build(b); d.appendChild(b); box.appendChild(d); };
  if (a.summary) sec("📝 摘要", b => { b.className = "body"; b.textContent = a.summary; });
  if (a.chapters?.length) sec("📑 章节速览", b => {
    for (const c of a.chapters) {
      const el = document.createElement("div"); el.className = "chapter";
      el.innerHTML = `<div class="c-title"><span class="c-time">${escapeHtml(c.time || "")}</span>${escapeHtml(c.title || "")}</div>${c.detail ? `<div class="c-detail">${escapeHtml(c.detail)}</div>` : ""}`;
      el.addEventListener("click", () => seekTo((typeof c.seconds === "number" && c.seconds > 0) ? c.seconds : (parseTime(c.time) || 0)));
      b.appendChild(el);
    }
  });
  if (a.todos?.length) sec("✅ 待办事项", b => { for (const t of a.todos) { const el = document.createElement("div"); el.className = "todo"; el.innerHTML = `<span>${escapeHtml(t.task || "")}</span>` + ((t.owner || t.due) ? `<span class="t-owner">${t.owner ? "@" + escapeHtml(t.owner) : ""}${t.due ? " · " + escapeHtml(t.due) : ""}</span>` : ""); b.appendChild(el); } });
  if (a.keywords?.length) sec("🏷️ 关键词", b => { b.className = "keywords"; b.innerHTML = a.keywords.map(k => `<span>${escapeHtml(k)}</span>`).join(""); });
  if (!box.children.length) box.innerHTML = '<div class="empty-hint">分析结果为空。</div>';
}

/* ================= Tab 切换 ================= */
function switchTab(name) { $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name)); ["ai", "chat", "notes"].forEach(n => ($("#tab-" + n).hidden = n !== name)); }
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
  } catch (e) { state.chatMessages.pop(); state.chatMessages.push({ role: "assistant", content: "⚠️ " + e.message, error: true }); }
  finally { state.chatBusy = false; $("#btn-chat-send").disabled = false; renderChat(); saveChatLog(); }
}
function renderChat() {
  const box = $("#chat-messages"); box.innerHTML = "";
  for (const m of state.chatMessages) {
    const div = document.createElement("div"); div.className = "msg " + (m.role === "user" ? "user" : "ai");
    const bubble = document.createElement("div"); bubble.className = "bubble" + (m.error ? " error" : "");
    if (m.pending) bubble.innerHTML = '<span class="spinner"></span>思考中…';
    else if (m.role === "user") bubble.textContent = m.content;
    else bubble.innerHTML = renderTimeLinks(m.content);
    div.appendChild(bubble); box.appendChild(div);
  }
  box.scrollTop = box.scrollHeight;
}

/* ================= 我的笔记 ================= */
async function loadNotes() { try { const r = await api(`/api/tasks/${state.taskId}/notes`); $("#my-notes").value = r.text || ""; $("#notes-status").textContent = ""; } catch {} }
$("#my-notes").addEventListener("input", () => {
  $("#notes-status").textContent = "输入中…";
  clearTimeout(state.notesTimer);
  state.notesTimer = setTimeout(async () => {
    try { await api(`/api/tasks/${state.taskId}/notes`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: $("#my-notes").value }) });
      $("#notes-status").textContent = "✓ 已保存 " + new Date().toLocaleTimeString("zh-CN");
    } catch (e) { $("#notes-status").textContent = "保存失败:" + e.message; }
  }, 800);
});

/* ================= 设置 ================= */
const setOverlay = $("#settings-overlay");
$("#nav-settings").addEventListener("click", openSettings);
$("#set-close").addEventListener("click", () => (setOverlay.hidden = true));
async function openSettings() {
  setOverlay.hidden = false; $("#set-result").textContent = ""; $("#set-result").className = "set-result";
  $("#set-key").value = "";
  try {
    const s = await api("/api/settings");
    $("#set-base").value = s.llm_base_url || "";
    $("#set-model").value = s.llm_model || "";
    $("#set-polish").checked = !!s.polish_enabled;
    $("#set-key-hint").textContent = s.has_key ? `(已配置:${s.llm_api_key_masked})` : "(未配置)";
    $("#set-asr").value = s.asr_engine || "whisper";
    $("#set-local-repo").value = s.local_model_repo || "";
    $("#set-obsidian-path").value = s.obsidian_path || "";
    $("#set-obsidian-sections").value = s.obsidian_sections || "transcript,ai,chat,notes";
    $("#set-essay-prompt").value = s.essay_prompt || "";
    setTrMode(s.translate_mode || "local");
    loadLocalModelStatus();
  } catch (e) { toast("读取设置失败:" + e.message); }
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
    else if (s.installed) { el.textContent = `✓ 已就绪(${s.size_mb}MB)${s.loaded ? ",已载入内存" : ""}`; }
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
    setSetResult(true, `✓ 连接成功,共 ${r.models.length} 个可用模型`);
    if (fetchModels) { const dl = $("#model-list"); dl.innerHTML = ""; for (const m of r.models) { const o = document.createElement("option"); o.value = m; dl.appendChild(o); } toast("模型列表已更新"); }
  } catch (e) { setSetResult(false, "测试失败:" + e.message); }
}
$("#set-test").addEventListener("click", () => testSettings(false));
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
        obsidian_path: $("#set-obsidian-path").value.trim(),
        obsidian_sections: $("#set-obsidian-sections").value.trim(),
        essay_prompt: $("#set-essay-prompt").value.trim(),
      }) });
    toast("设置已保存并立即生效"); setOverlay.hidden = true;
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
const MM_FILLS = ["#615ced", "#eef0ff", "#f7f7fc"], MM_STROKES = ["#615ced", "#b9b6f2", "#dcdce8"], MM_TEXTS = ["#ffffff", "#4038b0", "#3c4048"];
function renderMindmap() {
  if (!mmTree) return;
  const { nodes, edges } = mmLayout(mmTree), byId = {}; nodes.forEach(n => byId[n.id] = n);
  let g = "";
  for (const [a, b] of edges) { const p = byId[a], c = byId[b], x1 = p.x + p.w, x2 = c.x, mx = (x1 + x2) / 2; g += `<path d="M ${x1} ${p.y} C ${mx} ${p.y}, ${mx} ${c.y}, ${x2} ${c.y}" fill="none" stroke="#c9ccdb" stroke-width="1.5"/>`; }
  for (const n of nodes) {
    const chip = n.seconds != null ? `<text class="mm-time" data-sec="${n.seconds}" x="${n.x + n.w - 10}" y="${n.y + 4}" text-anchor="end" font-size="11" fill="#615ced" font-weight="600">${escapeHtml(n.time || fmtTs(n.seconds, true))}</text>` : "";
    const badge = (n.collapsed && n.nKids) ? `<text x="${n.x + n.w + 8}" y="${n.y + 4}" font-size="11" fill="#8a8fa3">+${n.nKids}</text>` : "";
    g += `<g class="mm-node" data-id="${n.id}" data-kids="${n.nKids}"><rect x="${n.x}" y="${n.y - MM_NODE_H / 2}" width="${n.w}" height="${MM_NODE_H}" rx="9" fill="${MM_FILLS[n.depth]}" stroke="${MM_STROKES[n.depth]}"/><text x="${n.x + 12}" y="${n.y + 5}" font-size="${n.depth === 0 ? 15 : 14}" font-weight="${n.depth === 0 ? 600 : 400}" fill="${MM_TEXTS[n.depth]}">${escapeHtml(n.text)}</text>${chip}${badge}<title>${escapeHtml(n.title)}</title></g>`;
  }
  $("#mm-svg").innerHTML = `<g id="mm-root">${g}</g>`; mmApplyView();
}
function mmApplyView() { const r = document.querySelector("#mm-svg > g"); if (r) r.setAttribute("transform", `translate(${mmView.x},${mmView.y}) scale(${mmView.k})`); }
function mmFit() { if (!mmTree) return; const { nodes } = mmLayout(mmTree); if (!nodes.length) return; const xs = nodes.flatMap(n => [n.x, n.x + n.w + 46]), ys = nodes.flatMap(n => [n.y - MM_NODE_H / 2, n.y + MM_NODE_H / 2]); const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys); const wrap = $("#mm-wrap"), W = wrap.clientWidth, H = wrap.clientHeight, bw = maxX - minX, bh = maxY - minY; const kW = W / (bw + 80), kAll = Math.min(kW, H / (bh + 60)); const k = kAll >= 0.8 ? Math.min(kAll, 1.4) : Math.min(kW, 1); mmView = { k, x: (W - bw * k) / 2 - minX * k, y: (H - bh * k) / 2 - minY * k }; mmApplyView(); }
function mmZoom(f) { const w = $("#mm-wrap"), px = w.clientWidth / 2, py = w.clientHeight / 2, k2 = Math.min(3, Math.max(0.2, mmView.k * f)); mmView.x = px - (px - mmView.x) * (k2 / mmView.k); mmView.y = py - (py - mmView.y) * (k2 / mmView.k); mmView.k = k2; mmApplyView(); }
function mmSetStatus(s) { $("#mm-status").textContent = s; }
async function openMindmap(regen = false) {
  $("#mm-overlay").hidden = false;
  if (!regen && mmTree) { renderMindmap(); mmFit(); return; }
  mmSetStatus(regen ? "重新生成中…" : "加载…");
  try {
    if (regen) mmTree = await api(`/api/tasks/${state.taskId}/mindmap?regen=true`, { method: "POST" });
    else { try { mmTree = await api(`/api/tasks/${state.taskId}/mindmap`); } catch { mmSetStatus("AI 生成思维导图中…"); mmTree = await api(`/api/tasks/${state.taskId}/mindmap`, { method: "POST" }); } }
  } catch (e) { mmSetStatus("生成失败:" + e.message); return; }
  mmCollapsed.clear(); renderMindmap(); mmFit(); mmSetStatus("点击折叠/展开 · 蓝色时间戳跳转播放 · 滚轮滚动 · Ctrl+滚轮缩放");
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
  img.onload = () => { const c = document.createElement("canvas"); c.width = W * 2; c.height = H * 2; const ctx = c.getContext("2d"); ctx.scale(2, 2); ctx.fillStyle = "#fafafa"; ctx.fillRect(0, 0, W, H); ctx.drawImage(img, 0, 0, W, H); URL.revokeObjectURL(url); const a = document.createElement("a"); a.download = `${(state.task && state.task.display_title) || "思维导图"}.png`; a.href = c.toDataURL("image/png"); a.click(); toast("已导出 PNG"); };
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
  $("#essay-overlay").hidden = false;
  essaySetStatus(regen ? "重新生成中…" : "加载…");
  $("#essay-body").innerHTML = '<div class="empty-hint"><span class="spinner"></span>AI 正在撰写随笔…</div>';
  try {
    let r;
    if (regen) {
      r = await api(`/api/tasks/${state.taskId}/essay?regen=true`, { method: "POST" });
    } else {
      try { r = await api(`/api/tasks/${state.taskId}/essay`); }
      catch { essaySetStatus("AI 正在撰写随笔…"); r = await api(`/api/tasks/${state.taskId}/essay`, { method: "POST" }); }
    }
    renderEssay(r.essay); essaySetStatus("");
  } catch (e) {
    essaySetStatus("");
    $("#essay-body").innerHTML = `<div class="empty-hint">生成失败:${escapeHtml(e.message)}</div>`;
    toast("随笔生成失败:" + e.message, 5000);
  }
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

/* ================= 任务中心 ================= */
function jobsOf(t) {
  const out = [];
  const push = (icon, kind, st, stage, extra) => {
    let s = st; if (st === "running" && t.cancel_requested) s = "canceling"; else if (st === "running" && t.paused) s = "paused";
    out.push(Object.assign({ icon, kind, state: s, stage: stage || "", title: titleOf(t), taskId: t.id, canPause: kind !== "转写" }, extra));
  };
  if (t.status === "queued") push("🎙", "转写", "running", "排队中");
  else if (t.status === "transcribing") push("🎙", "转写", "running", t.stage);
  else if (t.status === "error") push("🎙", "转写", "error", t.error);
  else if (t.status === "cancelled") push("🎙", "转写", "cancelled", "已终止");
  if (t.polish_status === "running") push("✨", "AI 标点", "running", t.stage);
  else if (t.polish_status === "error") push("✨", "AI 标点", "error", t.polish_error);
  else if (t.polish_status === "cancelled") push("✨", "AI 标点", "cancelled", "已终止");
  if (t.translation_status === "running") push("🌐", "翻译", "running", t.stage);
  else if (t.translation_status === "error") push("🌐", "翻译", "error", t.translation_error);
  else if (t.translation_status === "cancelled") push("🌐", "翻译", "cancelled", "已终止");
  if (t.analysis_status === "running") push("📝", "Scriba 解读", "running", "生成中");
  else if (t.analysis_status === "error") push("📝", "Scriba 解读", "error", t.analysis_error);
  else if (t.analysis_status === "cancelled") push("📝", "Scriba 解读", "cancelled", "已终止");
  if (t.burn_status === "running") push("🎬", "字幕封装", "running", "正在封装");
  else if (t.burn_status === "done") push("🎬", "字幕封装", "await", "已完成,待保存", { path: t.burned_path });
  else if (t.burn_status === "error") push("🎬", "字幕封装", "error", t.burn_error);
  else if (t.burn_status === "cancelled") push("🎬", "字幕封装", "cancelled", "已终止");
  return out;
}
function allJobs() {
  const jobs = []; for (const t of state.tasks) jobs.push(...jobsOf(t));
  const rank = { running: 0, canceling: 0, paused: 1, await: 2, error: 3, cancelled: 4 };
  return jobs.sort((a, b) => rank[a.state] - rank[b.state]);
}
function renderJobs() {
  const box = $("#jobs-list"), jobs = allJobs();
  if (!jobs.length) { box.innerHTML = '<div class="empty-hint">没有进行中或待保存的任务</div>'; return; }
  box.innerHTML = "";
  for (const j of jobs) {
    const row = document.createElement("div");
    row.className = "job-row" + (j.state === "await" ? " done" : j.state === "error" ? " err" : j.state === "cancelled" ? " stop" : j.state === "paused" ? " paused" : "");
    let act = "";
    if (j.state === "await") act = `<button class="btn primary sm" data-save="${j.taskId}">💾 保存文件</button>`;
    else if (j.state === "running") act = (j.canPause ? `<button class="btn ghost sm" data-pause="${j.taskId}" title="暂停">⏸</button>` : "") + `<button class="btn ghost sm danger" data-cancel="${j.taskId}" title="终止">⛔</button><span class="spinner"></span>`;
    else if (j.state === "paused") act = `<button class="btn ghost sm" data-resume="${j.taskId}" title="继续">▶</button><button class="btn ghost sm danger" data-cancel="${j.taskId}" title="终止">⛔</button>`;
    else if (j.state === "canceling") act = '<button class="btn ghost sm" disabled>终止中…</button><span class="spinner"></span>';
    const stage = j.stage || { running: "进行中", paused: "已暂停", canceling: "终止中", await: "完成", error: "失败", cancelled: "已终止" }[j.state];
    row.innerHTML = `<span class="j-icon">${j.icon}</span><div class="j-main"><div class="j-title">${escapeHtml(j.title)} · ${j.kind}</div><div class="j-stage ${j.state === "error" ? "err" : ""}">${escapeHtml(stage)}</div></div>${act}`;
    box.appendChild(row);
  }
  box.querySelectorAll("[data-save]").forEach(b => b.addEventListener("click", () => { const t = state.tasks.find(x => x.id === b.dataset.save); const a = document.createElement("a"); a.href = `/api/tasks/${b.dataset.save}/burned`; a.download = t?.burned_path?.split("/").pop() || "subbed.mp4"; document.body.appendChild(a); a.click(); a.remove(); toast("开始下载"); }));
  box.querySelectorAll("[data-pause]").forEach(b => b.addEventListener("click", () => jobPause(b.dataset.pause, true)));
  box.querySelectorAll("[data-resume]").forEach(b => b.addEventListener("click", () => jobPause(b.dataset.resume, false)));
  box.querySelectorAll("[data-cancel]").forEach(b => b.addEventListener("click", () => jobCancel(b.dataset.cancel)));
}
async function jobPause(id, paused) { try { await api(`/api/tasks/${id}/pause`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused }) }); await fetchTasks(); renderJobs(); toast(paused ? "已暂停" : "已继续"); } catch (e) { toast("操作失败:" + e.message); } }
async function jobCancel(id) { if (!confirm("终止任务?进行中的工作会立刻停止并丢弃结果。")) return; try { await api(`/api/tasks/${id}/cancel`, { method: "POST" }); await fetchTasks(); renderJobs(); } catch (e) { toast("终止失败:" + e.message); } }
function updateFab() {
  const jobs = allJobs(), running = jobs.filter(j => j.state === "running").length, awaiting = jobs.filter(j => j.state === "await").length;
  const fab = $("#job-fab"); fab.hidden = !(running || awaiting);
  $("#job-fab-icon").textContent = running ? "⏳" : "💾"; $("#job-fab-count").textContent = String(running || awaiting);
  fab.classList.toggle("attention", !running && awaiting > 0);
}
let jobsPoll = null;
function openJobs() {
  $("#jobs-overlay").hidden = false; renderJobs();
  if (jobsPoll) clearInterval(jobsPoll);
  jobsPoll = setInterval(async () => { if ($("#jobs-overlay").hidden) { clearInterval(jobsPoll); jobsPoll = null; return; } await fetchTasks(); renderJobs(); }, 2000);
}
$("#jobs-close").addEventListener("click", () => ($("#jobs-overlay").hidden = true));
$("#job-fab").addEventListener("click", openJobs);

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
fetchTasks(); fetchFolders();
