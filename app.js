// === CONFIG ===
const N8N_WEBHOOK_URL = "https://n8n.andresmunozt.com/webhook/chat";
const N8N_TOKEN = ""; // si lo usas, puede disparar CORS preflight en navegador

// Reintentos / timeouts
const REQ_TIMEOUT_MS_TEXT = 20000;
const REQ_TIMEOUT_MS_FILES = 45000;
const RETRIES_TEXT = 3;
const RETRIES_FILES = 3;

// Circuit breaker (evita spam si n8n está caído)
const CB_FAIL_THRESHOLD = 3;        // cuantos fallos seguidos para abrir
const CB_OPEN_MS = 25_000;          // cuánto dura "abierto" sin intentar
const CB_HALFOPEN_TRIALS = 1;       // intentos al pasar a half-open

// Cola offline (si falla/red/offline, guarda y reintenta)
const OUTBOX_KEY = "chat_outbox_v1";

// === Storage ===
const LS_KEY = "chat_n8n_state_v14";

function nowIso() { return new Date().toISOString(); }
function uid() { return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random(); }

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function saveState(s) { localStorage.setItem(LS_KEY, JSON.stringify(s)); }

// === Outbox (cola) ===
function loadOutbox() {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveOutbox(items) {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
}
function enqueueOutbox(item) {
  const q = loadOutbox();
  q.push(item);
  saveOutbox(q);
}
function dequeueOutbox() {
  const q = loadOutbox();
  const item = q.shift();
  saveOutbox(q);
  return item;
}
function peekOutbox() {
  const q = loadOutbox();
  return q[0] || null;
}
function outboxCount() {
  return loadOutbox().length;
}

// === Circuit breaker state ===
const cb = {
  consecutiveFails: 0,
  state: "CLOSED", // CLOSED | OPEN | HALF_OPEN
  openedAt: 0,
  halfOpenTrialsLeft: CB_HALFOPEN_TRIALS
};

function cbCanAttempt() {
  if (cb.state === "CLOSED") return true;
  if (cb.state === "OPEN") {
    const elapsed = Date.now() - cb.openedAt;
    if (elapsed >= CB_OPEN_MS) {
      cb.state = "HALF_OPEN";
      cb.halfOpenTrialsLeft = CB_HALFOPEN_TRIALS;
      return true;
    }
    return false;
  }
  // HALF_OPEN
  if (cb.halfOpenTrialsLeft > 0) return true;
  return false;
}

function cbOnSuccess() {
  cb.consecutiveFails = 0;
  cb.state = "CLOSED";
  cb.halfOpenTrialsLeft = CB_HALFOPEN_TRIALS;
}

function cbOnFail() {
  cb.consecutiveFails += 1;
  if (cb.state === "HALF_OPEN") {
    cb.state = "OPEN";
    cb.openedAt = Date.now();
    return;
  }
  if (cb.consecutiveFails >= CB_FAIL_THRESHOLD) {
    cb.state = "OPEN";
    cb.openedAt = Date.now();
  }
}

// === utils ===
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function jitter(ms){ return Math.floor(ms * (0.7 + Math.random() * 0.6)); } // +-30%

async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort("timeout"), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function classifyFetchError(err) {
  // Los navegadores suelen dar TypeError("Failed to fetch") para:
  // - CORS
  // - DNS/TLS
  // - conexión caída
  // - server down
  // No se puede distinguir 100% desde JS, pero podemos mejorar UX.
  const msg = String(err?.message || err);
  if (!navigator.onLine) return { kind: "OFFLINE", msg: "Sin conexión a internet." };
  if (msg.includes("timeout") || err?.name === "AbortError") return { kind: "TIMEOUT", msg: "Tiempo de espera agotado." };
  // default
  return { kind: "NETWORK_OR_CORS", msg: "No se pudo conectar (red/CORS/servidor)." };
}

async function requestWithRetries(makeAttempt, retries) {
  let lastErr = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await makeAttempt(attempt);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        const backoff = jitter(350 * attempt * attempt); // 350, 1400, 3150 aprox
        await sleep(backoff);
        continue;
      }
      throw lastErr;
    }
  }
}

// === State ===
let state = loadState() || { activeId: null, conversations: [] };
let aborter = null;

// Adjuntos en memoria (NO localStorage)
let pendingFiles = [];
let pendingAudio = null; // { file, url }

// Recording
let recorder = null;
let recordingChunks = [];
let recordingStartTs = 0;
let recordingTimer = null;
let micStream = null;

// === DOM ===
const elList = document.getElementById("convList");
const elTitle = document.getElementById("convTitle");
const elStatus = document.getElementById("status");
const elMsgs = document.getElementById("messages");
const elInput = document.getElementById("input");

const btnSend = document.getElementById("btnSend");
const btnStop = document.getElementById("btnStop");
const btnNew = document.getElementById("btnNew");

const overlay = document.getElementById("overlay");
const btnToggleSidebar = document.getElementById("btnToggleSidebar");
const sidebar = document.getElementById("sidebar");

const ctxMenu = document.getElementById("ctxMenu");

const btnScrollDown = document.getElementById("btnScrollDown");

const btnAttach = document.getElementById("btnAttach");
const filePicker = document.getElementById("filePicker");
const btnMic = document.getElementById("btnMic");

const attachBar = document.getElementById("attachBar");

const bottomWrap = document.getElementById("bottomWrap");
const composer = document.getElementById("composer");

const recBar = document.getElementById("recBar");
const recTime = document.getElementById("recTime");
const btnRecCancel = document.getElementById("btnRecCancel");
const btnRecSend = document.getElementById("btnRecSend");

// === UI ===
function setStatus(t) { elStatus.textContent = t || ""; }

function isRecording() {
  return recorder && recorder.state === "recording";
}

function hasPayloadToSend() {
  return !!elInput.value.trim() || pendingFiles.length > 0 || !!pendingAudio;
}

function setThinkingUI(isThinking) {
  btnSend.disabled = isThinking || !hasPayloadToSend();
  btnStop.classList.toggle("hidden", !isThinking);

  const disable = isThinking || isRecording();
  elInput.disabled = disable;
  btnAttach.disabled = disable;
  btnMic.disabled = isThinking || isRecording();
}

function openSidebar() { sidebar.classList.add("open"); overlay.classList.remove("hidden"); }
function closeSidebar() { sidebar.classList.remove("open"); overlay.classList.add("hidden"); closeContextMenu(); }

btnToggleSidebar.addEventListener("click", () => sidebar.classList.contains("open") ? closeSidebar() : openSidebar());
overlay.addEventListener("click", closeSidebar);

elInput.addEventListener("input", () => {
  elInput.style.height = "auto";
  elInput.style.height = Math.min(elInput.scrollHeight, 160) + "px";
  btnSend.disabled = !!aborter || !hasPayloadToSend();
});

btnNew.onclick = newConversation;
btnSend.onclick = sendMessage;
btnStop.onclick = () => { if (aborter) aborter.abort(); };

elInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// === Attachments ===
btnAttach.addEventListener("click", () => filePicker.click());
filePicker.addEventListener("change", () => {
  const files = Array.from(filePicker.files || []);
  filePicker.value = "";
  const pdfs = files.filter(f => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
  if (!pdfs.length) return;
  pendingFiles.push(...pdfs);
  renderAttachBar();
  btnSend.disabled = !!aborter || !hasPayloadToSend();
  updateFloatingUI();
});

function clearPendingAudio() {
  if (pendingAudio?.url) URL.revokeObjectURL(pendingAudio.url);
  pendingAudio = null;
}

function removePendingFile(idx) {
  pendingFiles.splice(idx, 1);
  renderAttachBar();
  btnSend.disabled = !!aborter || !hasPayloadToSend();
  updateFloatingUI();
}

function renderAttachBar() {
  attachBar.innerHTML = "";

  if (isRecording()) { attachBar.classList.add("hidden"); return; }

  const hasAny = pendingFiles.length > 0 || !!pendingAudio;
  attachBar.classList.toggle("hidden", !hasAny);
  if (!hasAny) return;

  pendingFiles.forEach((f, i) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.title = f.name;

    const label = document.createElement("span");
    label.className = "chip-label";
    label.textContent = `📎 ${f.name}`;

    const x = document.createElement("button");
    x.className = "chip-x";
    x.type = "button";
    x.textContent = "✕";
    x.onclick = () => removePendingFile(i);

    chip.appendChild(label);
    chip.appendChild(x);
    attachBar.appendChild(chip);
  });

  if (pendingAudio) {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.title = pendingAudio.file.name;

    const label = document.createElement("span");
    label.className = "chip-label";
    label.textContent = `🎤 ${pendingAudio.file.name}`;

    const play = document.createElement("button");
    play.className = "chip-btn";
    play.type = "button";
    play.textContent = "▶";
    play.onclick = () => { new Audio(pendingAudio.url).play().catch(() => {}); };

    const x = document.createElement("button");
    x.className = "chip-x";
    x.type = "button";
    x.textContent = "✕";
    x.onclick = () => {
      clearPendingAudio();
      renderAttachBar();
      btnSend.disabled = !!aborter || !hasPayloadToSend();
      updateFloatingUI();
    };

    chip.appendChild(label);
    chip.appendChild(play);
    chip.appendChild(x);
    attachBar.appendChild(chip);
  }
}

// === Scroll down button ===
function isScrollable(container) { return (container.scrollHeight - container.clientHeight) > 8; }
function distanceFromBottom(container) { return container.scrollHeight - container.scrollTop - container.clientHeight; }
function isNearBottom(container, thresholdPx = 120) { return distanceFromBottom(container) <= thresholdPx; }

function updateScrollDownButton() {
  const show = isScrollable(elMsgs) && !isNearBottom(elMsgs);
  btnScrollDown.classList.toggle("hidden", !show);
}
btnScrollDown.addEventListener("click", () => {
  const end = document.getElementById("endAnchor");
  if (end) end.scrollIntoView({ block: "end", behavior: "smooth" });
});
elMsgs.addEventListener("scroll", updateScrollDownButton);
window.addEventListener("resize", () => { updateFloatingUI(); updateScrollDownButton(); });

function updateFloatingUI() {
  const bottomH = bottomWrap?.offsetHeight || 0;
  const attachH = attachBar.classList.contains("hidden") ? 0 : attachBar.offsetHeight;
  btnScrollDown.style.bottom = `${bottomH + attachH + 14}px`;
}

// === Recording (permiso 1 vez) ===
function formatMMSS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
function stopRecordingTimer() { if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; } }

function showRecordingMode(show) {
  composer.classList.toggle("hidden", show);
  recBar.classList.toggle("hidden", !show);
  if (show) attachBar.classList.add("hidden");
  else renderAttachBar();
  updateFloatingUI();
  updateScrollDownButton();
}

async function getMicStreamOnce() {
  if (micStream) return micStream;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return micStream;
}

async function startRecording() {
  if (!!aborter || isRecording()) return;
  if (!navigator.mediaDevices?.getUserMedia) { alert("Tu navegador no soporta grabación."); return; }
  if (!window.MediaRecorder) { alert("Tu navegador no soporta MediaRecorder."); return; }

  try {
    const stream = await getMicStreamOnce();

    recordingChunks = [];
    recordingStartTs = Date.now();

    const mimeCandidates = ["audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus","audio/ogg"];
    const mimeType = mimeCandidates.find(t => MediaRecorder.isTypeSupported(t)) || "";

    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recordingChunks.push(e.data); };

    recorder.onstop = () => {
      stopRecordingTimer();
      showRecordingMode(false);

      if (!recordingChunks.length) {
        recordingChunks = [];
        btnSend.disabled = !!aborter || !hasPayloadToSend();
        setThinkingUI(!!aborter);
        updateFloatingUI();
        return;
      }

      const blob = new Blob(recordingChunks, { type: recorder.mimeType || "audio/webm" });
      const ext = blob.type.includes("ogg") ? "ogg" : "webm";
      const seconds = Math.max(1, Math.round((Date.now() - recordingStartTs) / 1000));
      const name = `audio_${seconds}s.${ext}`;
      const file = new File([blob], name, { type: blob.type });

      clearPendingAudio();
      pendingAudio = { file, url: URL.createObjectURL(file) };
      recordingChunks = [];

      renderAttachBar();
      btnSend.disabled = !!aborter || !hasPayloadToSend();
      setThinkingUI(!!aborter);
      updateFloatingUI();
    };

    recTime.textContent = "00:00";
    showRecordingMode(true);

    recorder.start();
    recordingTimer = setInterval(() => {
      recTime.textContent = formatMMSS(Date.now() - recordingStartTs);
    }, 250);
  } catch (e) {
    alert("No se pudo acceder al micrófono. Revisa permisos del sitio.");
    micStream = null;
    showRecordingMode(false);
  }
}

function cancelRecording() {
  recordingChunks = [];
  stopRecordingTimer();
  showRecordingMode(false);
  try { if (recorder && recorder.state === "recording") recorder.stop(); } catch {}
  recordingChunks = [];
  btnSend.disabled = !!aborter || !hasPayloadToSend();
  setThinkingUI(!!aborter);
  updateFloatingUI();
}

function finishRecordingAndSend() {
  try {
    if (recorder && recorder.state === "recording") {
      const prev = recorder.onstop;
      recorder.onstop = () => {
        prev?.();
        Promise.resolve().then(() => { if (pendingAudio) sendMessage(); });
      };
      recorder.stop();
    }
  } catch {}
}

btnMic.addEventListener("click", startRecording);
btnRecCancel.addEventListener("click", cancelRecording);
btnRecSend.addEventListener("click", finishRecordingAndSend);

// === Conversation helpers ===
function getActiveConv() { return state.conversations.find(c => c.id === state.activeId) || null; }

function autoTitleFrom(text) {
  const t = (text || "").trim().replace(/\s+/g, " ");
  if (!t) return "Conversación";
  return t.length > 40 ? t.slice(0, 40) + "..." : t;
}

// === Context Menu ===
function closeContextMenu() {
  ctxMenu.classList.add("hidden");
  ctxMenu.innerHTML = "";
  ctxMenu.dataset.convId = "";
}
function openContextMenu(convId, anchorEl) {
  ctxMenu.innerHTML = "";

  const btnRen = document.createElement("button");
  btnRen.textContent = "Renombrar";
  btnRen.onclick = (e) => { e.stopPropagation(); closeContextMenu(); renameConversationById(convId); };

  const btnDel = document.createElement("button");
  btnDel.textContent = "Borrar";
  btnDel.className = "danger";
  btnDel.onclick = (e) => { e.stopPropagation(); closeContextMenu(); deleteConversationById(convId); };

  ctxMenu.appendChild(btnRen);
  ctxMenu.appendChild(btnDel);

  ctxMenu.classList.remove("hidden");

  const rect = anchorEl.getBoundingClientRect();
  const menuRect = ctxMenu.getBoundingClientRect();
  const padding = 8;

  let left = rect.right - menuRect.width;
  let top  = rect.bottom + 8;

  left = Math.max(padding, Math.min(left, window.innerWidth - menuRect.width - padding));
  top  = Math.max(padding, Math.min(top,  window.innerHeight - menuRect.height - padding));

  ctxMenu.style.left = `${left}px`;
  ctxMenu.style.top  = `${top}px`;
  ctxMenu.dataset.convId = convId;
}

document.addEventListener("click", (e) => {
  const clickedInsideMenu = e.target.closest("#ctxMenu");
  const clickedKebab = e.target.closest(".kebab");
  if (!clickedInsideMenu && !clickedKebab) closeContextMenu();
});
document.querySelector(".conv-list")?.addEventListener("scroll", closeContextMenu);
window.addEventListener("resize", closeContextMenu);
window.addEventListener("scroll", closeContextMenu, true);

// === Conversation actions ===
function renameConversationById(id) {
  const conv = state.conversations.find(c => c.id === id);
  if (!conv) return;
  const next = prompt("Nuevo nombre:", conv.title || "");
  if (next === null) return;
  conv.title = next.trim() || "Conversación";
  conv.updatedAt = nowIso();
  saveState(state);
  renderAll();
}
function deleteConversationById(id) {
  const conv = state.conversations.find(c => c.id === id);
  if (!conv) return;
  const ok = confirm(`¿Borrar la conversación "${conv.title || "Conversación"}"?`);
  if (!ok) return;

  state.conversations = state.conversations.filter(c => c.id !== id);
  if (state.activeId === id) state.activeId = state.conversations[0]?.id || null;

  saveState(state);
  renderAll();
  if (!state.activeId) newConversation();
}

// === Render ===
function renderConversations() {
  elList.innerHTML = "";
  const sorted = [...state.conversations].sort((a,b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  for (const c of sorted) {
    const row = document.createElement("div");
    row.className = "conv-item" + (c.id === state.activeId ? " active" : "");

    const left = document.createElement("div");
    left.className = "name";
    left.textContent = c.title || "Nueva conversación";

    const right = document.createElement("div");
    right.className = "right";

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = (c.messages?.length || 0);

    const kebab = document.createElement("button");
    kebab.className = "kebab";
    kebab.type = "button";
    kebab.setAttribute("aria-label", "Opciones");
    kebab.textContent = "⋯";
    kebab.onclick = (e) => {
      e.stopPropagation();
      if (ctxMenu.dataset.convId === c.id && !ctxMenu.classList.contains("hidden")) { closeContextMenu(); return; }
      openContextMenu(c.id, kebab);
    };

    right.appendChild(meta);
    right.appendChild(kebab);

    row.appendChild(left);
    row.appendChild(right);

    row.onclick = () => {
      state.activeId = c.id;
      saveState(state);
      closeContextMenu();
      renderAll();
      closeSidebar();
    };

    elList.appendChild(row);
  }
}

function renderHeader() {
  const conv = getActiveConv();
  elTitle.textContent = conv?.title || "Conversación";
}

function renderMessages() {
  const conv = getActiveConv();
  elMsgs.innerHTML = "";
  if (!conv) return;

  const stick = isNearBottom(elMsgs);
  const frag = document.createDocumentFragment();

  for (const m of conv.messages) {
    const row = document.createElement("div");
    const who = (m.role === "user") ? "user" : "assistant";
    row.className = "msg-row " + who;

    const bubble = document.createElement("div");
    bubble.className = "bubble " + who;

    const role = document.createElement("div");
    role.className = "role";
    role.textContent = (m.role === "user") ? "Tú" : "IA";

    const content = document.createElement("div");
    content.className = "content";
    content.textContent = m.content || "";

    bubble.appendChild(role);
    bubble.appendChild(content);

    if (Array.isArray(m.attachments) && m.attachments.length) {
      const att = document.createElement("div");
      att.className = "attachments";
      for (const a of m.attachments) {
        const item = document.createElement("div");
        item.className = "attachment-item";
        const icon = a.kind === "audio" ? "🎤" : "📎";
        item.textContent = `${icon} ${a.name}`;
        att.appendChild(item);
      }
      bubble.appendChild(att);
    }

    row.appendChild(bubble);
    frag.appendChild(row);
  }

  const end = document.createElement("div");
  end.id = "endAnchor";
  end.style.height = "1px";
  frag.appendChild(end);

  elMsgs.appendChild(frag);

  if (stick) {
    requestAnimationFrame(() => {
      end.scrollIntoView({ block: "end" });
      updateScrollDownButton();
    });
  } else {
    updateScrollDownButton();
  }
}

function renderAll() {
  if (!state.activeId || !getActiveConv()) {
    if (state.conversations.length === 0) { newConversation(); return; }
    state.activeId = state.conversations[0].id;
  }
  renderConversations();
  renderHeader();
  renderMessages();
  renderAttachBar();
  updateFloatingUI();
  updateScrollDownButton();
  updateOutboxStatus();
}

// === Robust send: JSON sin adjuntos / FormData con adjuntos, retries + CB + outbox ===
function buildHistory(conv) {
  return conv.messages
    .filter(m => !m.pendingId)
    .slice(-20)
    .map(({ role, content, at, attachments }) => ({
      role, content, at,
      attachments: Array.isArray(attachments) ? attachments : []
    }));
}

async function callN8N({ convId, message, history, files, timeoutMs, retries }) {
  if (!cbCanAttempt()) {
    const wait = Math.max(0, CB_OPEN_MS - (Date.now() - cb.openedAt));
    throw new Error(`Servicio ocupado temporalmente. Reintentando en ${Math.ceil(wait/1000)}s.`);
  }

  const hasFiles = files && files.length > 0;

  const headersJson = {
    "Content-Type": "application/json",
    ...(N8N_TOKEN ? { "X-Auth": N8N_TOKEN } : {})
  };
  const headersForm = {
    ...(N8N_TOKEN ? { "X-Auth": N8N_TOKEN } : {})
  };

  const makeAttempt = async () => {
    let res;

    if (!hasFiles) {
      res = await fetchWithTimeout(N8N_WEBHOOK_URL, {
        method: "POST",
        headers: headersJson,
        body: JSON.stringify({ conversationId: convId, message, history })
      }, timeoutMs);
    } else {
      const fd = new FormData();
      fd.append("conversationId", convId);
      fd.append("message", message || "");
      fd.append("history", JSON.stringify(history));
      for (const f of files) fd.append("files", f, f.name);

      res = await fetchWithTimeout(N8N_WEBHOOK_URL, {
        method: "POST",
        headers: headersForm,
        body: fd
      }, timeoutMs);
    }

    const raw = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}\n${raw}`);
    return raw;
  };

  try {
    if (cb.state === "HALF_OPEN") cb.halfOpenTrialsLeft -= 1;
    const raw = await requestWithRetries(makeAttempt, retries);
    cbOnSuccess();
    return raw;
  } catch (e) {
    cbOnFail();
    throw e;
  }
}

// Estado/contador outbox
function updateOutboxStatus() {
  const n = outboxCount();
  if (n > 0) setStatus(`Pendientes por enviar: ${n}`);
  else if (!isRecording() && !aborter) setStatus("");
}

async function flushOutbox() {
  if (!navigator.onLine) return;
  // no procesar si estamos grabando o ya hay una request en curso
  if (isRecording() || aborter) return;

  let item = peekOutbox();
  while (item) {
    try {
      // reconstruir conv + placeholder
      const conv = state.conversations.find(c => c.id === item.convId);
      if (!conv) { dequeueOutbox(); item = peekOutbox(); continue; }

      // mostrar que se está enviando
      setStatus(`Reintentando envío pendiente… (${outboxCount()})`);

      // no podemos guardar Files en localStorage; esta outbox es SOLO para texto/metadata
      // Por eso: outbox SOLO guarda mensajes sin adjuntos.
      const raw = await callN8N({
        convId: item.convId,
        message: item.message,
        history: item.history,
        files: [],
        timeoutMs: REQ_TIMEOUT_MS_TEXT,
        retries: RETRIES_TEXT
      });

      let data = {};
      try { data = JSON.parse(raw); } catch {}
      const reply = (data && data.reply != null) ? String(data.reply) : (raw || "Sin respuesta");

      // reemplazar pending
      const idx = conv.messages.findIndex(m => m.pendingId === item.pendingId);
      if (idx !== -1) conv.messages[idx] = { role: "assistant", content: reply, at: nowIso() };
      else conv.messages.push({ role: "assistant", content: reply, at: nowIso() });

      conv.updatedAt = nowIso();
      saveState(state);

      dequeueOutbox();
      item = peekOutbox();
      renderAll();
    } catch (e) {
      // si sigue fallando, no loops infinito ahora; corta y reintenta después
      const info = classifyFetchError(e);
      setStatus(`Pendiente: ${info.msg} (reintento automático)`);
      return;
    }
  }

  updateOutboxStatus();
}

// Cuando vuelve internet, reintenta cola
window.addEventListener("online", () => {
  flushOutbox().catch(() => {});
});

// === Core ===
function newConversation() {
  const id = uid();
  const conv = { id, title: "Nueva conversación", updatedAt: nowIso(), messages: [] };
  state.conversations.unshift(conv);
  state.activeId = id;
  saveState(state);
  closeContextMenu();
  renderAll();
  closeSidebar();
  elInput.focus();
  btnSend.disabled = !!aborter || !hasPayloadToSend();
}

async function sendMessage() {
  const conv = getActiveConv();
  if (!conv) return;

  const content = elInput.value.trim();
  const hasAny = !!content || pendingFiles.length > 0 || !!pendingAudio;
  if (!hasAny) return;
  if (isRecording()) return;

  // abort anterior
  if (aborter) aborter.abort();
  aborter = new AbortController();

  // UI
  elInput.value = "";
  elInput.style.height = "auto";
  setThinkingUI(true);
  setStatus("Enviando…");

  // metadata adjuntos para mostrar
  const attachmentsMeta = [
    ...pendingFiles.map(f => ({ kind: "pdf", name: f.name, type: f.type || "application/pdf", size: f.size })),
    ...(pendingAudio ? [{ kind: "audio", name: pendingAudio.file.name, type: pendingAudio.file.type, size: pendingAudio.file.size }] : [])
  ];

  conv.messages.push({ role: "user", content: content || "(Adjunto)", at: nowIso(), attachments: attachmentsMeta });
  conv.updatedAt = nowIso();

  if (!conv.title || conv.title === "Nueva conversación") {
    conv.title = autoTitleFrom(content || attachmentsMeta[0]?.name || "Conversación");
  }

  const pendingId = uid();
  conv.messages.push({ role: "assistant", content: "Enviando…", at: nowIso(), pendingId });
  conv.updatedAt = nowIso();

  saveState(state);
  renderAll();

  try {
    const history = buildHistory(conv);

    // armar files: (NO se pueden encolar offline porque no se serializan)
    const files = [];
    for (const f of pendingFiles) files.push(f);
    if (pendingAudio?.file) files.push(pendingAudio.file);

    const hasFiles = files.length > 0;

    // Si estamos offline y no hay adjuntos, encolar y listo
    if (!navigator.onLine && !hasFiles) {
      enqueueOutbox({
        convId: conv.id,
        message: content || "",
        history,
        pendingId,
        createdAt: nowIso()
      });
      setStatus(`Sin internet. Guardado para enviar (${outboxCount()}).`);
      return;
    }

    // Si offline pero hay adjuntos: no se puede encolar (por seguridad/tamaño). Mostrar claro.
    if (!navigator.onLine && hasFiles) {
      throw new Error("Estás sin internet. No puedo enviar PDF/audio hasta que vuelva conexión.");
    }

    const raw = await callN8N({
      convId: conv.id,
      message: content || "",
      history,
      files,
      timeoutMs: hasFiles ? REQ_TIMEOUT_MS_FILES : REQ_TIMEOUT_MS_TEXT,
      retries: hasFiles ? RETRIES_FILES : RETRIES_TEXT
    });

    let data = {};
    try { data = JSON.parse(raw); } catch {}
    const reply = (data && data.reply != null) ? String(data.reply) : (raw || "Sin respuesta");

    const idx = conv.messages.findIndex(m => m.pendingId === pendingId);
    if (idx !== -1) conv.messages[idx] = { role: "assistant", content: reply, at: nowIso() };
    else conv.messages.push({ role: "assistant", content: reply, at: nowIso() });

    conv.updatedAt = nowIso();
    saveState(state);
    renderAll();
    setStatus("");

  } catch (err) {
    // abort manual
    if (err?.name === "AbortError") {
      const idx = conv.messages.findIndex(m => m.pendingId === pendingId);
      if (idx !== -1) conv.messages[idx] = { role: "assistant", content: "⛔ Envío detenido.", at: nowIso() };
      conv.updatedAt = nowIso();
      saveState(state);
      renderAll();
      setStatus("");
      return;
    }

    // si NO hay archivos, encolamos para reintento automático
    const filesWereIncluded = (pendingFiles.length > 0) || !!pendingAudio;

    if (!filesWereIncluded) {
      const history = buildHistory(conv);
      enqueueOutbox({
        convId: conv.id,
        message: content || "",
        history,
        pendingId,
        createdAt: nowIso()
      });

      const info = classifyFetchError(err);
      const idx = conv.messages.findIndex(m => m.pendingId === pendingId);
      if (idx !== -1) conv.messages[idx] = {
        role: "assistant",
        content: `⚠️ No se pudo enviar ahora (${info.msg}).\n✅ Quedó en cola y se reintentará automáticamente.`,
        at: nowIso()
      };

      conv.updatedAt = nowIso();
      saveState(state);
      renderAll();
      updateOutboxStatus();
      return;
    }

    // con adjuntos: mostramos error claro (no encolamos archivos)
    const info = classifyFetchError(err);
    const idx = conv.messages.findIndex(m => m.pendingId === pendingId);
    const extra = (info.kind === "NETWORK_OR_CORS")
      ? "\nSugerencia: revisa CORS/Cloudflare/SSL en n8n o usa un proxy."
      : "";

    if (idx !== -1) conv.messages[idx] = {
      role: "assistant",
      content: `⚠️ Error llamando a n8n:\n${info.msg}\n${String(err?.message || err)}${extra}`,
      at: nowIso()
    };

    conv.updatedAt = nowIso();
    saveState(state);
    renderAll();
    setStatus("");

  } finally {
    aborter = null;

    // limpiar adjuntos siempre después del intento
    pendingFiles = [];
    clearPendingAudio();
    renderAttachBar();

    setThinkingUI(false);
    elInput.disabled = false;
    elInput.focus();
    btnSend.disabled = !!aborter || !hasPayloadToSend();

    updateFloatingUI();
    updateScrollDownButton();

    // si hay cola y volvió conexión, intenta mandar
    flushOutbox().catch(() => {});
  }
}

// === init ===
function closeContextMenu() {
  ctxMenu.classList.add("hidden");
  ctxMenu.innerHTML = "";
  ctxMenu.dataset.convId = "";
}

function renderAllInit() {
  renderAll();
  btnStop.classList.add("hidden");
  btnScrollDown.classList.add("hidden");
  recBar.classList.add("hidden");
  composer.classList.remove("hidden");
  attachBar.classList.add("hidden");
  btnSend.disabled = !!aborter || !hasPayloadToSend();
  updateFloatingUI();
  updateScrollDownButton();
  updateOutboxStatus();
  flushOutbox().catch(() => {});
}
renderAllInit();

