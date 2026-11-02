// UniQlaw dashboard — vanilla JS. All server data is rendered with textContent.
const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); for (const k of kids) e.append(k); return e; };
const api = async (path, opts) => { const r = await fetch(path, { credentials: "same-origin", ...opts }); if (!r.ok) throw new Error(`${path}: ${r.status}`); return r.json(); };
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : "");

let selected = null;
let lastId = 0;

// ── tabs ──
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${b.dataset.tab}`));
  if (b.dataset.tab === "jobs") loadJobs();
  if (b.dataset.tab === "logs") loadLogs();
}));

// ── sessions ──
async function loadAgents() {
  const { agents } = await api("/api/agents");
  const tbody = $("#agents tbody");
  tbody.replaceChildren();
  $("#no-agents").hidden = agents.length > 0;
  agents.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  for (const a of agents) {
    const tr = el("tr", { className: a.name === selected ? "sel" : "" },
      el("td", { textContent: a.name }),
      el("td", { textContent: `${a.profile} · ${a.provider}` }),
      el("td", {}, el("span", { className: `state ${a.state}`, textContent: a.state + (a.queue ? ` +${a.queue}` : "") })));
    tr.dataset.key = a.name;
    tr.dataset.meta = JSON.stringify(a);
    if (a.state !== "remote") tr.addEventListener("click", () => select(a.name));
    tbody.append(tr);
  }
  if (selected) renderMeta();
}

function renderMeta() {
  const tr = document.querySelector(`#agents tr[data-key="${CSS.escape(selected)}"]`);
  if (!tr) return;
  const a = JSON.parse(tr.dataset.meta);
  $("#detail-title").textContent = a.name;
  const target = a.lastTarget ? `${a.lastTarget.platform}:${a.lastTarget.chatId}` : "—";
  $("#detail-meta").textContent = `${a.profile} · ${a.provider} · ${a.state} · session ${a.providerSessionId ?? "(new)"} · last chat ${target} · pending ${a.pending} · active ${fmtTime(a.lastActivityAt)}`;
}

async function select(key) {
  selected = key; lastId = 0;
  $("#transcript").replaceChildren();
  $("#pick").hidden = true;
  $("#detail-head").hidden = false;
  document.querySelectorAll("#agents tbody tr").forEach((r) => r.classList.toggle("sel", r.dataset.key === key));
  renderMeta();
  await loadTranscript();
}

async function loadTranscript() {
  if (!selected) return;
  const { entries } = await api(`/api/sessions/${encodeURIComponent(selected)}/transcript?after=${lastId}`);
  for (const e of entries) appendEntry(e);
}

function appendEntry(e) {
  if (e.id) { if (e.id <= lastId) return; lastId = e.id; }
  const list = $("#transcript");
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.append(el("li", { className: e.kind }, el("span", { className: "meta", textContent: `${e.kind} · ${fmtTime(e.at)}` }), e.text));
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

$("#btn-stop").addEventListener("click", async () => { if (selected) await api(`/api/sessions/${encodeURIComponent(selected)}/stop`, { method: "POST" }); });
$("#btn-reset").addEventListener("click", async () => {
  if (!selected || !confirm(`Start a fresh agent session for ${selected}? The current conversation context is dropped.`)) return;
  await api(`/api/sessions/${encodeURIComponent(selected)}/reset`, { method: "POST" });
  loadAgents();
});

// ── jobs / logs ──
async function loadJobs() {
  const { jobs } = await api("/api/jobs");
  const tbody = $("#jobs tbody");
  tbody.replaceChildren();
  $("#no-jobs").hidden = jobs.length > 0;
  for (const j of jobs) tbody.append(el("tr", {},
    el("td", { textContent: j.name + (j.recurring ? "" : " (once)") }), el("td", { textContent: `${j.schedule} (${j.timezone})` }),
    el("td", { textContent: j.target }), el("td", { textContent: j.replyTo ?? "—" }), el("td", { textContent: j.next ? fmtTime(Date.parse(j.next)) : "—" }),
    el("td", { className: "prompt", textContent: j.prompt.length > 300 ? j.prompt.slice(0, 300) + "…" : j.prompt })));
}
async function loadLogs() { const { lines } = await api("/api/logs?lines=400"); const pre = $("#logs"); pre.textContent = lines.join("\n"); pre.scrollTop = pre.scrollHeight; }
$("#btn-logs").addEventListener("click", loadLogs);

// ── live events ──
let refreshTimer;
const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(loadAgents, 300); };
function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("hello", () => { $("#live").textContent = "live"; $("#live").className = "pill on"; });
  es.addEventListener("state", scheduleRefresh);
  es.addEventListener("turn_start", scheduleRefresh);
  es.addEventListener("turn_end", (m) => { scheduleRefresh(); const ev = JSON.parse(m.data); if (ev.channelKey === selected) loadTranscript(); });
  es.addEventListener("transcript", (m) => { const ev = JSON.parse(m.data); if (ev.channelKey === selected) loadTranscript(); });
  es.onerror = () => { $("#live").textContent = "reconnecting"; $("#live").className = "pill off"; };
}

(async () => {
  try { const s = await api("/api/status"); $("#version").textContent = `v${s.version}`; } catch {}
  await loadAgents();
  connect();
  setInterval(loadAgents, 15000);
})();
