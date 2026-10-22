const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const provider = () => $("#provider").value;

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Turn [S1] / [S1, S3] / [S1][S2] citations into clickable chips.
const cite = (html) => html.replace(/\[((?:S\d+(?:,\s*)?)+)\]/g, (_, ids) =>
  ids.split(/,\s*/).map((id) => `<span class="cite" data-src="${id}">${id}</span>`).join(" "));

// Minimal markdown: paragraphs, bullet lists, **bold**.
function md(text) {
  const lines = esc(text).split("\n");
  let html = "", inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    const bullet = line.match(/^[-*•]\s+(.*)/);
    if (bullet) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${bullet[1]}</li>`;
      continue;
    }
    if (inList) { html += "</ul>"; inList = false; }
    if (line) html += `<p>${line}</p>`;
  }
  if (inList) html += "</ul>";
  return cite(html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>"));
}

function sourcesHTML(sources) {
  if (!sources?.length) return "";
  return `<details class="sources"><summary>Retrieved passages (${sources.length})</summary>
    ${sources.map((s, i) => `<div class="source" data-id="S${i + 1}">
      <div class="src-head">S${i + 1} · ${esc(s.doc || "Guideline")} · p.${s.page}
        <span class="bar"><i style="width:${Math.max(0, Math.min(100, s.score * 100)).toFixed(0)}%"></i></span>
        <span class="score">similarity ${s.score.toFixed(3)}</span></div>
      <p>${esc(s.text)}</p></div>`).join("")}
  </details>`;
}

function metaLine(data) {
  const fb = data.fallback ? " · switched provider automatically" : "";
  return `<div class="meta">${esc(data.model)}${data.latencyMs ? ` · ${(data.latencyMs / 1000).toFixed(1)}s` : ""}${fb}</div>`;
}

// Clicking a citation chip opens and highlights the matching source.
document.addEventListener("click", (e) => {
  const chip = e.target.closest(".cite");
  if (!chip) return;
  const details = $("details.sources", chip.closest(".result, .bubble, .card"));
  if (!details) return;
  details.open = true;
  const src = $(`.source[data-id="${chip.dataset.src}"]`, details);
  if (src) {
    src.scrollIntoView({ behavior: "smooth", block: "center" });
    src.classList.add("flash");
    setTimeout(() => src.classList.remove("flash"), 1500);
  }
});

async function api(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const loading = (msg) => `<div class="loading"><div class="spinner"></div><p>${msg}</p></div>`;

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key));
    localStorage.setItem(key, JSON.stringify(value));
  } catch { return null; }
}

let toastTimer;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

// ---------- dates ----------
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return iso(d); };
const diffDays = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);
const todayISO = () => iso(new Date());
const fmt = (s, opts = { month: "short", day: "numeric" }) => parseDate(s).toLocaleDateString(undefined, opts);

// ---------- theme, navbar, routing ----------
$("#theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("pcos.theme", next); } catch {}
});
addEventListener("scroll", () => $(".navbar").classList.toggle("scrolled", scrollY > 8), { passive: true });

const TABS = ["home", "tracker", "assess", "chat", "image", "arch"];
function route() {
  const tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "home";
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${tab}`));
  $$("[data-tab]").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  if (tab === "home") renderHome();
  if (tab === "tracker") renderTracker();
  scrollTo({ top: 0 });
}
addEventListener("hashchange", route);

// ---------- period tracker: data + cycle maths ----------
// tracker.days: { "YYYY-MM-DD": { period, flow, symptoms: [], mood, notes } } — stored in this browser only.
const TRACK_KEY = "pcos.tracker";
let tracker = store(TRACK_KEY) || { days: {} };
const saveTracker = () => store(TRACK_KEY, tracker);
const SYMPTOMS = ["Cramps", "Acne", "Bloating", "Headache", "Fatigue", "Mood swings", "Cravings", "Back pain", "Breast tenderness", "Excess hair"];

function computeCycle() {
  const periodDates = Object.keys(tracker.days).filter((d) => tracker.days[d].period).sort();
  // Group period days into runs; a gap of up to 2 days still counts as the same period.
  const runs = [];
  for (const d of periodDates) {
    const last = runs[runs.length - 1];
    if (last && diffDays(last.end, d) <= 2) last.end = d;
    else runs.push({ start: d, end: d });
  }
  const starts = runs.map((r) => r.start);
  const cycles = starts.slice(1).map((s, i) => diffDays(starts[i], s)).filter((n) => n >= 10);
  const recent = cycles.slice(-6);
  const avgCycle = recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : 28;
  // Exclude a period still in progress (ended today or yesterday) so a 1-day-old period doesn't skew the average.
  const finished = runs.filter((r) => diffDays(r.end, todayISO()) > 1);
  const periodLens = finished.map((r) => diffDays(r.start, r.end) + 1);
  const avgPeriod = periodLens.length ? Math.round(periodLens.slice(-6).reduce((a, b) => a + b, 0) / Math.min(6, periodLens.length)) : 5;
  const today = todayISO();
  const lastStart = starts[starts.length - 1] || null;
  const c = {
    runs, starts, cycles, avgCycle, avgPeriod, lastStart, estimated: recent.length === 0,
    min: cycles.length ? Math.min(...cycles) : null,
    max: cycles.length ? Math.max(...cycles) : null,
    outside: cycles.filter((n) => n < 21 || n > 35).length,
  };
  c.irregular = c.outside > 0;
  if (lastStart) {
    c.cycleDay = diffDays(lastStart, today) + 1;
    c.nextStart = addDays(lastStart, avgCycle);
    c.daysUntil = diffDays(today, c.nextStart);
    c.ovulation = addDays(c.nextStart, -14);
    c.fertileStart = addDays(c.ovulation, -5);
    c.fertileEnd = addDays(c.ovulation, 1);
    const ovDay = avgCycle - 14;
    c.phase = c.cycleDay <= avgPeriod ? "Menstrual"
      : c.cycleDay > avgCycle ? "Late"
      : c.cycleDay < ovDay - 1 ? "Follicular"
      : c.cycleDay <= ovDay + 1 ? "Ovulatory" : "Luteal";
  }
  c.summary = cycles.length
    ? `${cycles.length} cycles tracked, average ${avgCycle} days (range ${c.min}-${c.max}), ${c.outside} outside the 21-35 day range`
    : lastStart ? `last period started ${lastStart}, not enough cycles to average` : "";
  return c;
}

// Predicted period, fertile and ovulation days for the next 3 cycles (calendar estimates only).
function predictions(c) {
  const map = {};
  if (!c.lastStart) return map;
  // Remaining days of the current period, if it is still ongoing.
  for (let i = 1; i < c.avgPeriod; i++) {
    const d = addDays(c.lastStart, i);
    if (d >= todayISO() && !tracker.days[d]?.period) map[d] = "predicted";
  }
  for (let k = 1; k <= 3; k++) {
    const s = addDays(c.lastStart, c.avgCycle * k);
    for (let i = 0; i < c.avgPeriod; i++) map[addDays(s, i)] = "predicted";
    const ov = addDays(s, -14);
    for (let i = -5; i <= 1; i++) if (!map[addDays(ov, i)]) map[addDays(ov, i)] = i === 0 ? "ovulation" : "fertile";
  }
  return map;
}

function streak() {
  let n = 0;
  let d = tracker.days[todayISO()] ? todayISO() : addDays(todayISO(), -1);
  while (tracker.days[d]) { n++; d = addDays(d, -1); }
  return n;
}

function loadSampleData() {
  // Irregular sample history (typical of PCOS) ending with a period that started 12 days ago.
  const lengths = [41, 33, 52, 38, 45, 36];
  const days = {};
  let start = addDays(todayISO(), -12 - lengths.reduce((a, b) => a + b, 0));
  const flows = ["medium", "heavy", "heavy", "medium", "light", "light"];
  for (let k = 0; k <= lengths.length; k++) {
    const len = 5 + (k % 2);
    for (let i = 0; i < len; i++) {
      days[addDays(start, i)] = { period: true, flow: flows[i], symptoms: i < 2 ? ["Cramps", "Fatigue"] : [], mood: i === 0 ? "low" : "okay", notes: "" };
    }
    if (k < lengths.length) start = addDays(start, lengths[k]);
  }
  for (let i = 1; i <= 6; i++) {
    const d = addDays(todayISO(), -i);
    if (!days[d]) days[d] = { period: false, symptoms: i % 2 ? ["Acne", "Cravings"] : ["Bloating"], mood: i % 3 ? "okay" : "anxious", notes: "" };
  }
  tracker = { days };
  saveTracker();
}

// ---------- home ----------
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function ringSVG(c) {
  const r = 64, C = 2 * Math.PI * r;
  const progress = c.lastStart ? Math.min(1, c.cycleDay / c.avgCycle) : 0;
  const ovAngle = c.lastStart ? (c.avgCycle - 14) / c.avgCycle : 0;
  const ovX = 75 + r * Math.cos(2 * Math.PI * ovAngle), ovY = 75 + r * Math.sin(2 * Math.PI * ovAngle);
  return `<svg viewBox="0 0 150 150">
    <circle cx="75" cy="75" r="${r}" fill="none" stroke="var(--muted)" stroke-width="9"/>
    <circle cx="75" cy="75" r="${r}" fill="none" stroke="var(--highlight)" stroke-width="9" stroke-linecap="round"
      stroke-dasharray="${C * progress} ${C}"/>
    ${c.lastStart ? `<circle cx="${ovX}" cy="${ovY}" r="6" fill="var(--bg)" stroke="var(--green)" stroke-width="2.5"/>` : ""}
  </svg>`;
}

function renderHome() {
  $("#greeting").textContent = greeting();
  const c = computeCycle();
  const card = $("#home-cycle");
  if (!c.lastStart) {
    card.innerHTML = `
      <div class="cycle-ring">${ringSVG(c)}<div class="ring-center"><b>–</b><small>no data yet</small></div></div>
      <div class="cycle-info">
        <h3>Start tracking your cycle</h3>
        <p>Log your last period to see predictions, your cycle phase and patterns worth discussing with a doctor.</p>
        <div class="cal-actions">
          <a class="btn btn-solid" href="#tracker">Log a period ↗</a>
          <button class="btn btn-outline" id="home-sample">Try sample data</button>
        </div>
      </div>`;
    $("#home-sample").addEventListener("click", () => { loadSampleData(); renderHome(); toast("Sample cycle history loaded"); });
  } else {
    const late = c.daysUntil < 0;
    card.innerHTML = `
      <div class="cycle-ring">${ringSVG(c)}<div class="ring-center"><b>${c.cycleDay}</b><small>day of cycle</small></div></div>
      <div class="cycle-info">
        <span class="phase-badge">${c.phase === "Late" ? "Period may be late" : `${c.phase} phase`}</span>
        <h3>${late ? `Period expected ${-c.daysUntil} day${c.daysUntil === -1 ? "" : "s"} ago` : c.daysUntil === 0 ? "Period expected today" : `Next period in about ${c.daysUntil} days`}</h3>
        <div class="facts">
          <span><i class="dot" style="color:var(--red)"></i>Next period <b>${fmt(c.nextStart)}</b></span>
          <span><i class="dot" style="color:var(--green)"></i>Fertile window <b>${fmt(c.fertileStart)} to ${fmt(c.fertileEnd)}</b></span>
        </div>
        <p class="small">Calendar estimates${c.irregular ? `. Your cycles vary, so <span class="highlight">treat these loosely</span>` : ""}. Never use them as contraception.</p>
        <div class="cal-actions">
          <a class="btn btn-solid" href="#tracker">Log today ↗</a>
          ${c.irregular ? `<button class="btn btn-outline" id="home-screen">Check PCOS likelihood</button>` : ""}
        </div>
      </div>`;
    $("#home-screen")?.addEventListener("click", () => { fillFromTracker(); location.hash = "assess"; });
  }

  const chatsCount = (store("pcos.chats") || []).length;
  $("#home-stats").innerHTML = [
    [c.starts.length, "periods logged"],
    [c.cycles.length ? `${c.avgCycle} d` : "–", "average cycle"],
    [streak(), "day logging streak"],
    [chatsCount, "saved conversations"],
  ].map(([v, l]) => `<div class="card stat"><b>${v}</b><small>${l}</small></div>`).join("");

  loadTip();
}

async function loadTip(force = false) {
  const el = $("#home-tip");
  const today = todayISO();
  const cached = store("pcos.tip");
  if (!force && cached?.date === today) return showTip(cached.tip);
  el.innerHTML = `<div class="card-label">Tip of the day</div><div class="skeleton-line"></div><div class="skeleton-line short"></div>`;
  try {
    const seed = force ? Math.floor(Math.random() * 1000) : Math.floor(Date.now() / 86400000);
    const tip = await api("/api/tip", { provider: provider(), seed });
    store("pcos.tip", { date: today, tip });
    showTip(tip);
  } catch {
    el.innerHTML = `<div class="card-label">Tip of the day</div><p class="muted">Could not load a tip right now.</p>`;
  }
}

function showTip(tip) {
  const doc = String(tip.source.doc).replace("International PMOS (formerly PCOS) Guideline, full, updated 2026", "PMOS guideline 2026");
  $("#home-tip").innerHTML = `
    <div class="card-label">Tip of the day</div>
    <h3>${esc(tip.title)}</h3>
    <p>${esc(tip.tip.replace(/\s*\[S\d+\]/g, ""))}</p>
    <div class="src"><span>Source: ${esc(doc)}, p.${tip.source.page}</span><button class="btn btn-ghost sm" id="tip-next">Another tip</button></div>`;
  $("#tip-next").addEventListener("click", () => loadTip(true));
}

// ---------- tracker UI ----------
let calMonth = new Date(); calMonth.setDate(1);
let selectedDate = todayISO();

function renderTracker() {
  updateLogButton();
  renderCalendar();
  renderDayEditor();
  renderInsights();
  renderChart();
  renderMovement();
}

function renderCalendar() {
  const c = computeCycle();
  const pred = predictions(c);
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  $("#cal-title").textContent = calMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const first = new Date(y, m, 1);
  const offset = (first.getDay() + 6) % 7; // Monday first
  const start = iso(new Date(y, m, 1 - offset));
  const today = todayISO();
  let html = "";
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const entry = tracker.days[d];
    const cls = ["cal-day"];
    if (parseDate(d).getMonth() !== m) cls.push("other");
    if (d === today) cls.push("today");
    if (d === selectedDate) cls.push("selected");
    if (entry?.period) cls.push("period");
    else if (pred[d] && d > (c.lastStart || "")) cls.push(pred[d]);
    if (entry && (entry.symptoms?.length || entry.mood || entry.notes)) cls.push("logged");
    html += `<button class="${cls.join(" ")}" data-date="${d}" title="${fmt(d, { weekday: "short", month: "short", day: "numeric" })}">${parseDate(d).getDate()}</button>`;
  }
  $("#cal-days").innerHTML = html;
}

$("#cal-days").addEventListener("click", (e) => {
  const b = e.target.closest(".cal-day");
  if (!b) return;
  selectedDate = b.dataset.date;
  renderCalendar();
  renderDayEditor();
  if (innerWidth < 960) $("#day-editor").scrollIntoView({ behavior: "smooth" });
});
$("#cal-prev").addEventListener("click", () => { calMonth.setMonth(calMonth.getMonth() - 1); renderCalendar(); });
$("#cal-next").addEventListener("click", () => { calMonth.setMonth(calMonth.getMonth() + 1); renderCalendar(); });

$("#day-symptoms").innerHTML = SYMPTOMS.map((s) => `<button type="button" class="chip-btn" data-v="${s}">${s}</button>`).join("");
$("#day-symptoms").addEventListener("click", (e) => e.target.closest(".chip-btn")?.classList.toggle("on"));
for (const id of ["#day-flow", "#day-mood"]) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const wasActive = b.classList.contains("active");
    $$("button", $(id)).forEach((x) => x.classList.remove("active"));
    if (!wasActive) b.classList.add("active");
  });
}
$("#day-period").addEventListener("change", () => { $("#flow-field").hidden = !$("#day-period").checked; });

function renderDayEditor() {
  const e = tracker.days[selectedDate] || {};
  const isToday = selectedDate === todayISO();
  $("#day-title").textContent = isToday ? "Today" : fmt(selectedDate, { weekday: "long", month: "long", day: "numeric" });
  $("#day-period").checked = !!e.period;
  $("#flow-field").hidden = !e.period;
  $$("#day-flow button").forEach((b) => b.classList.toggle("active", b.dataset.v === e.flow));
  $$("#day-mood button").forEach((b) => b.classList.toggle("active", b.dataset.v === e.mood));
  $$("#day-symptoms .chip-btn").forEach((b) => b.classList.toggle("on", (e.symptoms || []).includes(b.dataset.v)));
  $("#day-notes").value = e.notes || "";
}

$("#day-save").addEventListener("click", () => {
  const entry = {
    period: $("#day-period").checked,
    flow: $("#day-flow .active")?.dataset.v || null,
    symptoms: $$("#day-symptoms .chip-btn.on").map((b) => b.dataset.v),
    mood: $("#day-mood .active")?.dataset.v || null,
    notes: $("#day-notes").value.trim(),
  };
  if (!entry.period && !entry.symptoms.length && !entry.mood && !entry.notes) delete tracker.days[selectedDate];
  else tracker.days[selectedDate] = entry;
  saveTracker();
  renderTracker();
  toast(`Saved ${selectedDate === todayISO() ? "today" : fmt(selectedDate)}`);
});

// True while a period is ongoing: today or yesterday is a logged period day.
const inPeriod = () => !!(tracker.days[todayISO()]?.period || tracker.days[addDays(todayISO(), -1)]?.period);

function updateLogButton() {
  const btn = $("#log-today");
  const today = tracker.days[todayISO()];
  btn.disabled = !!today?.period;
  btn.textContent = today?.period ? "Today is logged" : inPeriod() ? "Log period day" : "Period started today";
}

$("#log-today").addEventListener("click", () => {
  const started = !inPeriod();
  const today = todayISO();
  tracker.days[today] = { ...(tracker.days[today] || { symptoms: [], mood: null, notes: "" }), period: true, flow: tracker.days[today]?.flow || "medium" };
  saveTracker();
  selectedDate = today;
  calMonth = new Date(); calMonth.setDate(1);
  renderTracker();
  const c = computeCycle();
  toast(started
    ? `Period logged. It usually lasts about ${c.avgPeriod} days, shown dashed on the calendar.`
    : `Day ${c.cycleDay} of your period logged.`);
  const editor = $("#day-editor");
  editor.scrollIntoView({ behavior: "smooth", block: "center" });
  editor.classList.remove("flash-card");
  void editor.offsetWidth; // restart the highlight animation
  editor.classList.add("flash-card");
});
$("#pp-start").max = $("#pp-end").max = todayISO();
$("#pp-start").addEventListener("change", () => { $("#pp-end").min = $("#pp-start").value; });

$("#past-period").addEventListener("submit", (e) => {
  e.preventDefault();
  const start = $("#pp-start").value;
  const end = $("#pp-end").value || start;
  if (!start) return;
  if (start > todayISO() || end > todayISO()) return toast("Dates can't be in the future");
  if (end < start) return toast("End date must be on or after the start date");
  if (diffDays(start, end) > 14) return toast("That's longer than 15 days. Please check the dates.");
  for (let d = start; d <= end; d = addDays(d, 1)) {
    tracker.days[d] = { symptoms: [], mood: null, notes: "", ...tracker.days[d], period: true, flow: tracker.days[d]?.flow || "medium" };
  }
  saveTracker();
  selectedDate = start;
  calMonth = parseDate(start); calMonth.setDate(1);
  $("#past-period").reset();
  renderTracker();
  const c = computeCycle();
  toast(`Period ${fmt(start)} to ${fmt(end)} added. Next period predicted around ${fmt(c.nextStart)}.`);
});

$("#sample-data").addEventListener("click", () => { loadSampleData(); renderTracker(); toast("Sample cycle history loaded"); });
$("#clear-data").addEventListener("click", () => {
  if (!confirm("Delete all tracked periods and symptoms from this browser? This cannot be undone.")) return;
  tracker = { days: {} };
  saveTracker();
  renderTracker();
  toast("Tracker data cleared");
});
$("#export-csv").addEventListener("click", () => {
  const rows = [["date", "period", "flow", "symptoms", "mood", "notes"]];
  for (const d of Object.keys(tracker.days).sort()) {
    const e = tracker.days[d];
    rows.push([d, e.period ? "yes" : "no", e.flow || "", (e.symptoms || []).join("; "), e.mood || "", e.notes || ""]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "cycle-tracker.csv";
  a.click();
  URL.revokeObjectURL(a.href);
});

function renderInsights() {
  const c = computeCycle();
  const el = $("#cycle-insights");
  if (!c.lastStart) {
    el.innerHTML = `<div class="card-label">Insights</div><p class="empty-note">Mark the days of your last period (or load sample data) to see predictions and patterns.</p>`;
    return;
  }
  const items = [];
  if (c.cycles.length >= 2) {
    items.push(c.irregular
      ? `<div class="insight"><b class="tone-red">Irregular cycles detected.</b> ${c.outside} of your last ${c.cycles.length} cycles were outside 21 to 35 days. The guideline treats this as a sign of ovulatory dysfunction, one of the three Rotterdam criteria for PCOS.<div class="cal-actions" style="margin-top:10px"><button class="btn btn-outline sm" id="insight-screen">Run screening with my cycle data</button></div></div>`
      : `<div class="insight"><b class="tone-green">Cycles within the typical range.</b> All tracked cycles fall between 21 and 35 days.</div>`);
    if (c.max - c.min > 9) items.push(`<div class="insight"><b class="tone-yellow">Cycle length varies by ${c.max - c.min} days.</b> Predictions below are less reliable.</div>`);
  } else {
    const more = 3 - c.starts.length;
    items.push(`<div class="insight">Log ${more === 1 ? "one more period" : `${more} more periods`} to unlock cycle statistics. Use <b>Add a past period</b> below the calendar.</div>`);
  }
  const recentSymptoms = Object.entries(tracker.days).filter(([d]) => diffDays(d, todayISO()) <= 30).flatMap(([, e]) => e.symptoms || []);
  const counts = SYMPTOMS.map((s) => [s, recentSymptoms.filter((x) => x === s).length]).filter(([, n]) => n).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (counts.length) items.push(`<div class="insight">Most logged in the last 30 days: <b>${counts.map(([s, n]) => `${s} (${n})`).join(", ")}</b></div>`);
  el.innerHTML = `
    <div class="card-label">Insights</div>
    <div class="kv">
      <div><b>${c.cycles.length ? c.avgCycle : "–"}</b><small>avg cycle (days)</small></div>
      <div><b>${c.avgPeriod}</b><small>avg period (days)</small></div>
      <div><b>${c.cycleDay}</b><small>cycle day today</small></div>
    </div>
    ${items.join("")}`;
  $("#insight-screen")?.addEventListener("click", () => { fillFromTracker(); location.hash = "assess"; });
}

function renderChart() {
  const c = computeCycle();
  const el = $("#cycle-chart");
  const data = c.cycles.slice(-8);
  if (!data.length) {
    el.innerHTML = `<p class="empty-note">Your cycle lengths will be charted here, with the typical 21 to 35 day range shaded.</p>`;
    return;
  }
  const W = 420, H = 190, padL = 28, padB = 24, top = 10;
  const maxV = Math.max(60, ...data) , bw = (W - padL) / data.length;
  const y = (v) => top + (H - padB - top) * (1 - v / maxV);
  const bars = data.map((v, i) => {
    const x = padL + i * bw + bw * 0.22, w = bw * 0.56;
    const out = v < 21 || v > 35;
    return `<rect x="${x}" y="${y(v)}" width="${w}" height="${H - padB - y(v)}" rx="4" fill="none" stroke="${out ? "var(--red)" : "var(--green)"}" stroke-width="1.5"/>
      <rect x="${x}" y="${y(v)}" width="${w}" height="${H - padB - y(v)}" rx="4" fill="${out ? "var(--red)" : "var(--green)"}" opacity=".12"/>
      <text x="${x + w / 2}" y="${y(v) - 5}" text-anchor="middle">${v}</text>`;
  }).join("");
  el.className = "chart";
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Recent cycle lengths in days">
    <rect x="${padL}" y="${y(35)}" width="${W - padL}" height="${y(21) - y(35)}" fill="var(--soft)"/>
    <line x1="${padL}" x2="${W}" y1="${y(21)}" y2="${y(21)}" stroke="var(--border)" stroke-dasharray="3 3"/>
    <line x1="${padL}" x2="${W}" y1="${y(35)}" y2="${y(35)}" stroke="var(--border)" stroke-dasharray="3 3"/>
    <text x="0" y="${y(21) + 4}">21</text><text x="0" y="${y(35) + 4}">35</text>
    ${bars}
    <text x="${padL}" y="${H - 6}">older</text><text x="${W}" y="${H - 6}" text-anchor="end">latest</text>
  </svg>
  <p class="meta">Shaded band: typical 21 to 35 day range. Red outline: outside the range.</p>`;
}

// Phase-based movement ideas (general guidance), with an AI option grounded in the guideline.
const PHASE_MOVES = {
  Menstrual: [["Gentle yoga or stretching", "15 to 20 min", "Gentle", "Eases cramps and lower back tension"], ["Easy walk", "20 to 30 min", "Gentle", "Keeps you moving when energy is low"]],
  Follicular: [["Brisk walk, cycling or dance", "30 min", "Moderate", "Energy often rises after your period"], ["Strength training", "30 min", "Moderate", "Builds muscle, which helps insulin sensitivity"]],
  Ovulatory: [["Interval training", "20 min", "Vigorous", "Good time for higher intensity if you feel strong"], ["Strength training", "30 min", "Moderate", "Compound moves like squats and rows"]],
  Luteal: [["Swimming or steady cycling", "30 min", "Moderate", "Steady effort suits this phase"], ["Pilates or yoga", "30 min", "Gentle", "Can help with bloating and mood"]],
  Late: [["Walk outdoors", "30 min", "Gentle", "Light movement while you wait for your period"], ["Stretching", "15 min", "Gentle", "Relaxes tension"]],
};

function renderMovement(ai) {
  const c = computeCycle();
  const phase = c.phase || "Follicular";
  const todaySymptoms = tracker.days[todayISO()]?.symptoms || [];
  let moves = PHASE_MOVES[phase];
  if (todaySymptoms.includes("Cramps") || todaySymptoms.includes("Fatigue")) moves = PHASE_MOVES.Menstrual;
  const list = (ai?.result.exercises || moves.map(([name, duration, intensity, why]) => ({ name, duration, intensity, why })))
    .map((m) => `<li><b>${esc(m.name)}</b><span class="intensity ${esc(m.intensity)}">${esc(m.intensity)} · ${esc(m.duration)}</span><small>${esc(m.why)}</small></li>`).join("");
  const r = ai?.result;
  $("#movement-card").innerHTML = `
    <div class="card-label">Movement for today</div>
    <span class="phase-badge">${c.lastStart ? `${phase} phase · day ${c.cycleDay}` : "Log a period for phase-based ideas"}${todaySymptoms.length ? ` · ${todaySymptoms.join(", ")}` : ""}</span>
    ${r ? `<h3 style="margin-top:4px">${esc(r.headline)}</h3>` : ""}
    <ul class="move-list">${list}</ul>
    ${r ? `
      ${r.nutrition?.length ? `<h3>Food</h3><ul class="plain-list">${r.nutrition.map((x) => `<li>${cite(esc(x))}</li>`).join("")}</ul>` : ""}
      ${r.self_care?.length ? `<h3>Self care</h3><ul class="plain-list">${r.self_care.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
      <p class="callout">${cite(esc(r.weekly_target))}</p>
      ${metaLine(ai)}${sourcesHTML(ai.sources)}`
    : `<p class="callout">Guideline target for adults: 150 to 300 minutes of moderate or 75 to 150 minutes of vigorous activity a week, plus muscle strengthening.</p>`}
    <div class="cal-actions" style="margin-top:14px"><button class="btn btn-card sm" id="ai-plan">${r ? "Refresh AI plan" : "Personalise with AI"}</button></div>`;
  $("#ai-plan").addEventListener("click", loadWellness);
}

async function loadWellness() {
  const c = computeCycle();
  const btn = $("#ai-plan");
  btn.disabled = true;
  btn.textContent = "Creating your plan…";
  try {
    const data = await api("/api/wellness", {
      provider: provider(),
      phase: c.phase,
      cycleDay: c.cycleDay,
      symptoms: tracker.days[todayISO()]?.symptoms || [],
      cycleSummary: c.summary,
    });
    renderMovement(data);
  } catch (err) {
    toast(`Could not create a plan: ${err.message}`);
    btn.disabled = false;
    btn.textContent = "Personalise with AI";
  }
}

// ---------- risk screening ----------
const form = $("#assess-form");

function readProfile() {
  const f = new FormData(form);
  const h = +f.get("height") / 100, w = +f.get("weight");
  const bmi = h && w ? +(w / (h * h)).toFixed(1) : null;
  const c = computeCycle();
  return {
    age: +f.get("age"),
    bmi,
    waist: +f.get("waist") || null,
    cycleLength: +f.get("cycleLength"),
    cycleRegularity: f.get("cycleRegularity"),
    cycleSummary: c.summary || null,
    weightGain: f.has("weightGain"),
    hirsutism: f.has("hirsutism"),
    acne: f.has("acne"),
    hairLoss: f.has("hairLoss"),
    skinDarkening: f.has("skinDarkening"),
    fastFood: f.has("fastFood"),
    exercise: f.has("exercise"),
    sleepIssues: f.has("sleepIssues"),
    familyHistory: f.has("familyHistory"),
    lowMood: f.has("lowMood"),
    tryingToConceive: f.has("tryingToConceive"),
    notes: f.get("notes").trim(),
  };
}

function updateBMI() {
  const { bmi } = readProfile();
  $("#bmi-value").textContent = bmi ?? "–";
  $("#bmi-cat").textContent = !bmi ? "" : bmi < 18.5 ? "(underweight)" : bmi < 25 ? "(healthy range)" : bmi < 30 ? "(overweight)" : "(obese range)";
}
form.addEventListener("input", updateBMI);
updateBMI();

function fillFromTracker() {
  const c = computeCycle();
  const hint = $("#tracker-hint");
  if (!c.cycles.length) {
    hint.hidden = false;
    hint.textContent = "Not enough tracked cycles yet. Log at least two periods in the tracker.";
    return;
  }
  form.elements.cycleLength.value = c.avgCycle;
  form.elements.cycleRegularity.value = c.irregular ? "Irregular" : "Regular";
  hint.hidden = false;
  hint.innerHTML = `Filled from your tracker: ${esc(c.summary)}.`;
}
$("#use-tracker").addEventListener("click", fillFromTracker);

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = $("#assess-result");
  const btn = $("#assess-btn");
  btn.disabled = true;
  out.className = "card result empty";
  out.innerHTML = loading("Retrieving guideline passages and writing your report…");
  if (innerWidth < 960) out.scrollIntoView({ behavior: "smooth" });
  try {
    const data = await api("/api/assess", { profile: readProfile(), provider: provider() });
    store("pcos.lastReport", data);
    renderAssessment(data);
  } catch (err) {
    out.innerHTML = `<p class="error">Error: ${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
});

function renderAssessment(data) {
  const out = $("#assess-result");
  const r = data.result;
  const level = ["Low", "Moderate", "High"].includes(r.risk_level) ? r.risk_level : "Moderate";
  const score = Math.max(0, Math.min(100, Math.round(r.risk_score || 0)));
  const list = (items) => (items || []).map((x) => `<li>${cite(esc(x))}</li>`).join("");
  const recs = r.recommendations || {};
  const met = r.metabolic_health;
  out.className = "card result";
  out.innerHTML = `
    <div class="risk-head ${level}">
      <div class="gauge" style="--v:${score}" data-v="${score}"></div>
      <div>
        <div class="level">${level} likelihood</div>
        <div>${cite(esc(r.summary))}</div>
        ${metaLine(data)}
      </div>
    </div>
    ${r.what_this_means ? `<p class="callout">${cite(esc(r.what_this_means))}</p>` : ""}

    <h3>Rotterdam criteria (2 of 3 needed for a diagnosis)</h3>
    <div class="domains">${(r.rotterdam_domains || []).map((d) => `
      <div class="domain"><b>${esc(d.domain)}</b><span class="tone ${esc(d.status)}">${esc(d.status)}</span><div class="muted">${esc(d.evidence)}</div></div>`).join("")}
    </div>

    <h3>What drove this result</h3>
    <ul class="factors">${(r.key_factors || []).map((f) => `
      <li><span class="tone ${esc(f.impact)}">${esc(f.impact)}</span><div><b>${esc(f.factor)}</b><div class="muted">${esc(f.explanation)}</div></div></li>`).join("")}
    </ul>

    ${met || r.emotional_wellbeing ? `<h3>Your wider health</h3><div class="two-col">
      ${met ? `<div class="panel-box"><h4>Metabolic health <span class="tone ${esc(met.level)}">${esc(met.level)}</span></h4><p>${cite(esc(met.explanation))}</p></div>` : ""}
      ${r.emotional_wellbeing ? `<div class="panel-box"><h4>Emotional wellbeing</h4><p>${cite(esc(r.emotional_wellbeing))}</p></div>` : ""}
    </div>` : ""}

    <h3>Personalised recommendations</h3>
    <div class="recs">
      ${[["diet", "Diet"], ["exercise", "Exercise"], ["lifestyle", "Lifestyle"], ["medical", "Medical"]]
        .filter(([k]) => recs[k]?.length)
        .map(([k, label]) => `<div class="rec"><h4>${label}</h4><ul>${list(recs[k])}</ul></div>`).join("")}
    </div>

    ${r.next_steps?.length ? `<h3>Your next steps</h3><ul class="timeline">${r.next_steps.map((s) => `<li><span class="when">${esc(s.when)}</span><span>${cite(esc(s.action))}</span></li>`).join("")}</ul>` : ""}
    ${r.tests_to_discuss?.length ? `<h3>Tests to discuss with a doctor</h3><ul class="plain-list">${list(r.tests_to_discuss)}</ul>` : ""}
    ${r.red_flags?.length ? `<h3>Seek prompt medical advice if</h3><ul class="plain-list">${list(r.red_flags)}</ul>` : ""}
    <p class="meta">Generated by an LLM following guideline rules. Not a calibrated probability and not a diagnosis.</p>
    ${sourcesHTML(data.sources)}
    <div class="result-actions">
      <button class="btn btn-outline sm" id="print-report">Save as PDF</button>
      <button class="btn btn-ghost sm" id="ask-report">Ask a follow-up question</button>
    </div>`;
  $("#print-report").addEventListener("click", () => print());
  $("#ask-report").addEventListener("click", () => {
    $("#use-profile").checked = true;
    location.hash = "chat";
    $("#chat-text").value = `My screening result was ${level.toLowerCase()} likelihood. What should I focus on first?`;
    $("#chat-text").focus();
  });
}

const lastReport = store("pcos.lastReport");
if (lastReport?.result) renderAssessment(lastReport);

// ---------- chat (streaming + saved conversations) ----------
const STORE_KEY = "pcos.chats";
const WELCOME = "Hi! Ask me anything about PCOS. Every answer comes from the PCOS knowledge base, with sources you can open and check.";
const messagesEl = $("#messages");
let chats = store(STORE_KEY) || [];
let current = null;
let busy = false;
const saveChats = () => store(STORE_KEY, chats);

function newChat() {
  current = { id: Date.now().toString(36), title: "New chat", messages: [], updatedAt: Date.now() };
  renderChat();
  renderChatList();
}

function openChat(id) {
  current = chats.find((c) => c.id === id);
  renderChat();
  renderChatList();
}

function deleteChat(id) {
  chats = chats.filter((c) => c.id !== id);
  saveChats();
  if (current?.id === id) newChat();
  else renderChatList();
}

function persistCurrent() {
  current.updatedAt = Date.now();
  if (!chats.includes(current)) chats.unshift(current);
  chats.sort((a, b) => b.updatedAt - a.updatedAt);
  saveChats();
  renderChatList();
}

function renderChatList() {
  const list = $("#chat-list");
  list.innerHTML = chats.length ? "" : `<li class="muted">No saved chats yet</li>`;
  for (const c of chats) {
    const li = document.createElement("li");
    li.className = c.id === current?.id ? "active" : "";
    li.innerHTML = `<span title="${esc(c.title)}">${esc(c.title)}</span><button title="Delete chat" aria-label="Delete chat">×</button>`;
    li.addEventListener("click", () => openChat(c.id));
    $("button", li).addEventListener("click", (e) => { e.stopPropagation(); deleteChat(c.id); });
    list.appendChild(li);
  }
  $("#chat-title").textContent = current?.messages.length ? current.title : "Ask the guidelines";
}

function addMessage(role, html, container = messagesEl) {
  const el = document.createElement("div");
  el.className = `msg ${role === "user" ? "user" : "bot"}`;
  el.innerHTML = `<div class="bubble">${html}</div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
  return el;
}

const botHTML = (m) => md(m.text) + (m.meta ? metaLine(m.meta) : "") + sourcesHTML(m.sources);

function renderChat() {
  messagesEl.innerHTML = "";
  addMessage("bot", WELCOME);
  for (const m of current.messages) addMessage(m.role, m.role === "user" ? esc(m.text) : botHTML(m));
  $("#suggestions").hidden = current.messages.length > 0;
}

// Reads an SSE response body and calls onEvent(event, data) for each message.
async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop();
    for (const part of parts) {
      const event = part.match(/^event: (.*)$/m)?.[1];
      const data = part.match(/^data: (.*)$/m)?.[1];
      if (event && data) onEvent(event, JSON.parse(data));
    }
  }
}

// POSTs to an SSE endpoint and renders the streamed answer into `bubble`. Resolves to the finished reply.
async function streamReply(url, body, bubble, scroller) {
  const reply = { role: "assistant", text: "", sources: [], meta: null };
  let meta = {};
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await readSSE(res, (event, data) => {
    if (event === "sources") {
      reply.sources = data;
      bubble.innerHTML = `<span class="typing">Found ${data.length} relevant passages, writing the answer…</span>`;
    } else if (event === "meta") {
      meta = data;
      reply.text = "";
    } else if (event === "delta") {
      reply.text += data;
      bubble.innerHTML = `<div class="cursor">${md(reply.text)}</div>`;
      scroller.scrollTop = scroller.scrollHeight;
    } else if (event === "done") {
      reply.meta = { ...meta, ...data };
    } else if (event === "error") {
      throw new Error(data.error);
    }
  });
  if (!reply.text) throw new Error("Empty response");
  bubble.innerHTML = botHTML(reply);
  return reply;
}

async function ask(text) {
  if (!text.trim() || busy) return;
  busy = true;
  $("#send-btn").disabled = true;
  $("#suggestions").hidden = true;
  if (!current.messages.length) current.title = text.length > 48 ? text.slice(0, 45) + "…" : text;
  current.messages.push({ role: "user", text });
  addMessage("user", esc(text));
  const bubble = $(".bubble", addMessage("bot", `<span class="typing">Searching the knowledge base…</span>`));
  try {
    const reply = await streamReply("/api/chat/stream", {
      messages: current.messages.map(({ role, text }) => ({ role, text })),
      provider: provider(),
      profile: $("#use-profile").checked ? readProfile() : null,
    }, bubble, messagesEl);
    current.messages.push(reply);
    persistCurrent();
  } catch (err) {
    current.messages.pop();
    bubble.innerHTML = `<span class="error">Error: ${esc(err.message)}</span>`;
  } finally {
    busy = false;
    $("#send-btn").disabled = false;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function exportChat() {
  if (!current?.messages.length) return toast("Nothing to export yet");
  const lines = [`# ${current.title}`, `_Exported from Cycle Care on ${new Date().toLocaleString()}_`, ""];
  for (const m of current.messages) {
    lines.push(m.role === "user" ? `**You:** ${m.text}` : `**Assistant:**\n\n${m.text}`, "");
    if (m.sources?.length) lines.push("Sources:", ...m.sources.map((s, i) => `- [S${i + 1}] ${s.doc || "Guideline"}, page ${s.page}`), "");
  }
  lines.push("---", "_Educational use only. Not medical advice._");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/markdown" }));
  a.download = `${current.title.replace(/[^\w]+/g, "_").slice(0, 40) || "chat"}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

$("#chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#chat-text");
  ask(input.value);
  input.value = "";
});
$$("#suggestions button").forEach((b) => b.addEventListener("click", () => ask(b.textContent)));
$("#new-chat").addEventListener("click", () => { newChat(); $("#chat-text").focus(); });
$("#export-chat").addEventListener("click", exportChat);
newChat();

// ---------- ultrasound (saved scans + follow-up chat) ----------
const SCAN_KEY = "pcos.scans";
const drop = $("#drop");
const scanMessagesEl = $("#scan-messages");
let scans = store(SCAN_KEY) || [];
let scan = null; // currently open scan: { id, image, saturation, result, meta, messages, createdAt }
let pendingImage = null; // { image, saturation } chosen but not yet analysed
let scanBusy = false;

// Images make this store large; drop the oldest scans if the browser quota is exceeded.
function saveScans() {
  for (;;) {
    try { localStorage.setItem(SCAN_KEY, JSON.stringify(scans)); return; }
    catch { if (scans.length <= 1) return; scans.pop(); }
  }
}

// Average HSV saturation of a downscaled copy; ultrasounds are grayscale (~0).
function measureSaturation(img) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, 64, 64);
  const px = ctx.getImageData(0, 0, 64, 64).data;
  let total = 0;
  for (let i = 0; i < px.length; i += 4) {
    const max = Math.max(px[i], px[i + 1], px[i + 2]), min = Math.min(px[i], px[i + 1], px[i + 2]);
    total += max ? (max - min) / max : 0;
  }
  return total / (px.length / 4);
}

// Downscale so uploads and saved history stay small.
function loadImage(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 768 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = img.width * scale;
      c.height = img.height * scale;
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      pendingImage = { image: c.toDataURL("image/jpeg", 0.85), saturation: measureSaturation(img) };
      scan = null;
      showPreview(pendingImage.image);
      $("#image-btn").disabled = false;
      $("#image-result").className = "card result empty";
      $("#image-result").innerHTML = `<div class="empty-state"><div class="empty-icon">▣</div><p>Click <b>Analyse image</b> to run the analysis.</p></div>`;
      $("#scan-chat").hidden = true;
      renderScanList();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function showPreview(src) {
  $("#preview").src = src || "";
  $("#preview").hidden = !src;
  $("#drop-text").hidden = !!src;
}

function newScan() {
  scan = null;
  pendingImage = null;
  showPreview(null);
  $("#image-input").value = "";
  $("#image-btn").disabled = true;
  $("#image-result").className = "card result empty";
  $("#image-result").innerHTML = `<div class="empty-state"><div class="empty-icon">▣</div><p>Upload an image to start a new analysis.</p></div>`;
  $("#scan-chat").hidden = true;
  renderScanList();
}

function openScan(id) {
  scan = scans.find((s) => s.id === id);
  pendingImage = null;
  showPreview(scan.image);
  $("#image-btn").disabled = true;
  renderScanResult();
  renderScanChat();
  renderScanList();
}

function deleteScan(id) {
  scans = scans.filter((s) => s.id !== id);
  saveScans();
  if (scan?.id === id) newScan();
  else renderScanList();
}

function renderScanList() {
  const list = $("#scan-list");
  list.innerHTML = scans.length ? "" : `<li class="muted">No saved scans yet</li>`;
  for (const s of scans) {
    const li = document.createElement("li");
    li.className = s.id === scan?.id ? "active" : "";
    const label = s.result.is_ultrasound ? "Ultrasound" : "Not an ultrasound";
    li.innerHTML = `<img src="${s.image}" alt=""><div class="scan-meta"><span>${label}</span><small>${new Date(s.createdAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</small></div><button title="Delete scan" aria-label="Delete scan">×</button>`;
    li.addEventListener("click", () => openScan(s.id));
    $("button", li).addEventListener("click", (e) => { e.stopPropagation(); deleteScan(s.id); });
    list.appendChild(li);
  }
}

function renderScanResult() {
  const out = $("#image-result");
  const r = scan.result;
  out.className = "card result";
  out.innerHTML = `
    <div class="verdict ${r.is_ultrasound ? "yes" : "no"}">${r.is_ultrasound ? "Recognised as an ultrasound image" : "Not recognised as an ultrasound image"}</div>
    <h3>What the image shows</h3><p>${esc(r.image_description)}</p>
    ${r.pcom_features?.length ? `<h3>Features relevant to polycystic ovarian morphology</h3><ul class="plain-list">${r.pcom_features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
    <h3>Interpretation</h3><p>${esc(r.assessment)}</p>
    <h3>Limitations</h3><p class="muted">${esc(r.limitations)}</p>
    <div class="meta">${esc(scan.meta.model)}${scan.meta.latencyMs ? ` · ${(scan.meta.latencyMs / 1000).toFixed(1)}s` : ""} · colour saturation ${scan.saturation.toFixed(2)}</div>`;
}

function renderScanChat() {
  $("#scan-chat").hidden = !scan.result.is_ultrasound;
  scanMessagesEl.innerHTML = "";
  addMessage("bot", "Ask follow-up questions about this scan. Answers combine the image with cited knowledge-base passages.", scanMessagesEl);
  for (const m of scan.messages) addMessage(m.role, m.role === "user" ? esc(m.text) : botHTML(m), scanMessagesEl);
  $("#scan-suggestions").hidden = scan.messages.length > 0;
}

$("#image-input").addEventListener("change", (e) => e.target.files[0] && loadImage(e.target.files[0]));
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  if (e.dataTransfer.files[0]) loadImage(e.dataTransfer.files[0]);
});

$("#image-btn").addEventListener("click", async () => {
  if (!pendingImage) return;
  const out = $("#image-result");
  const btn = $("#image-btn");
  btn.disabled = true;
  out.className = "card result empty";
  out.innerHTML = loading("Analysing image…");
  try {
    const data = await api("/api/image", { ...pendingImage, provider: provider() });
    scan = {
      id: Date.now().toString(36),
      ...pendingImage,
      result: data.result,
      meta: { model: data.model, provider: data.provider, latencyMs: data.latencyMs },
      messages: [],
      createdAt: Date.now(),
    };
    pendingImage = null;
    scans.unshift(scan);
    saveScans();
    renderScanResult();
    renderScanChat();
    renderScanList();
  } catch (err) {
    out.innerHTML = `<p class="error">Error: ${esc(err.message)}</p>`;
    btn.disabled = false;
  }
});

async function askScan(text) {
  if (!text.trim() || scanBusy || !scan) return;
  scanBusy = true;
  $("#scan-send-btn").disabled = true;
  $("#scan-suggestions").hidden = true;
  scan.messages.push({ role: "user", text });
  addMessage("user", esc(text), scanMessagesEl);
  const bubble = $(".bubble", addMessage("bot", `<span class="typing">Looking at the image and the knowledge base…</span>`, scanMessagesEl));
  try {
    const reply = await streamReply("/api/image/chat/stream", {
      image: scan.image,
      analysis: scan.result,
      messages: scan.messages.map(({ role, text }) => ({ role, text })),
      provider: provider(),
    }, bubble, scanMessagesEl);
    scan.messages.push(reply);
    saveScans();
  } catch (err) {
    scan.messages.pop();
    bubble.innerHTML = `<span class="error">Error: ${esc(err.message)}</span>`;
  } finally {
    scanBusy = false;
    $("#scan-send-btn").disabled = false;
  }
}

$("#scan-chat-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#scan-chat-text");
  askScan(input.value);
  input.value = "";
});
$$("#scan-suggestions button").forEach((b) => b.addEventListener("click", () => askScan(b.textContent)));
$("#new-scan").addEventListener("click", newScan);
renderScanList();

// ---------- architecture stats ----------
fetch("/api/status").then((r) => r.json()).then((s) => {
  if (s.rag) {
    $("#st-pages").textContent = `${s.rag.pages} pages`;
    $("#st-docs").textContent = `${s.rag.docs.length} PDF document${s.rag.docs.length === 1 ? "" : "s"}`;
    $("#st-chunks").textContent = `${s.rag.chunks} chunks`;
    $("#st-embed").textContent = s.rag.embedModel;
    $("#st-dims").textContent = `${s.rag.dims} dims`;
    $("#doc-list").innerHTML = s.rag.docs.map((d) => `<li><strong>${esc(d.title)}</strong>, ${d.pages} pages, ${d.chunks} chunks</li>`).join("");
  }
  $("#st-llm").textContent = `${s.models.openai} / ${s.models.gemini}`;
  for (const opt of $("#provider").options) opt.disabled = !s.providers[opt.value];
});

route();
