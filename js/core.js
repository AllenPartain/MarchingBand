/* core.js: the shared toolbox. Every other file imports from here. */

const SUPABASE_URL = "https://jqhydaolujztvlnoaqge.supabase.co";
const SUPABASE_KEY = "sb_publishable_AgUl45w8FzDdtMwRUmppBA_bDzMP1XE";
export const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ---------- Constants ---------- */
export const SECTIONS = [
  "Flutes", "Clarinets", "Saxophones", "Trumpets", "Mellophones",
  "Trombones", "Baritones", "Tubas", "Drumline", "Color Guard",
];
export const ROLES = ["director", "drum_major", "section_leader", "member"];
export const ROLE_LABEL = {
  director: "Director",
  drum_major: "Drum Major",
  section_leader: "Section Leader",
  member: "Member",
};

/* ---------- Shared state ---------- */
export const state = {
  me: null,
  tab: "home",
  roster: [],          // everyone I'm allowed to see
  byId: new Map(),
  goals: [],
  items: [],           // pass-off items
  records: new Map(),  // "studentId|itemId" -> pass-off record
  unread: {},          // channel -> unread count
};

/* ---------- Permissions (these only control what the screen shows; ---------- */
/* ---------- the database rules are the real enforcement)           ---------- */
export const isStaff = () => ["director", "drum_major"].includes(state.me?.role);
export const isLeader = () => isStaff() || state.me?.role === "section_leader";
export const can = {
  assignGoals: isStaff,
  updateGoal: isLeader,
  markAttendance: isLeader,
  manageItems: () => state.me?.role === "director",
  markPassOffs: () => ["director", "section_leader"].includes(state.me?.role),
  editRoster: () => state.me?.role === "director",
};

/* ---------- Tiny event bus: files talk without importing each other ---------- */
export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));

/* ---------- DOM helpers ---------- */
export const $ = (id) => document.getElementById(id);

// Builds an element using textContent, so nobody can inject HTML through names or messages
export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
export function option(value, text, selected = false) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = text;
  o.selected = selected;
  return o;
}
export const empty = (text) => el("div", "empty", text);
export function skeleton(n = 3) {
  const d = el("div", "skeleton");
  for (let i = 0; i < n; i++) d.appendChild(document.createElement("i"));
  return d;
}
export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------- Icons ---------- */
const ICONS = {
  chevrons: '<path d="M4 7l8 5 8-5"/><path d="M4 13l8 5 8-5"/>',
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  chevL: '<polyline points="15 18 9 12 15 6"/>',
  chevR: '<polyline points="9 18 15 12 9 6"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
};
export function icon(name, size = 20) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;
}
export function paintIcons() {
  document.querySelectorAll("[data-icon]").forEach((n) => {
    n.innerHTML = icon(n.dataset.icon, Number(n.dataset.size) || 20);
  });
}

/* ---------- Dates ---------- */
export const todayStr = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
export function shiftDay(str, n) {
  const d = new Date(str + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("en-CA");
}
export const prettyDay = (s) =>
  new Date(s + "T12:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
export const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const shortDate = (d) => new Date(d).toLocaleDateString([], { month: "short", day: "numeric" });

/* ---------- Toast + modal ---------- */
let toastTimer;
export function toast(text, kind = "error", onClick = null) {
  const t = $("toast");
  clearTimeout(toastTimer);
  if (!text) return t.classList.add("hidden");
  t.textContent = text;
  t.className = "toast " + kind;
  t.onclick = onClick ? () => { t.classList.add("hidden"); onClick(); } : null;
  toastTimer = setTimeout(() => t.classList.add("hidden"), kind === "error" ? 6000 : 3500);
}
export function openModal(title, body) {
  $("modalTitle").textContent = title;
  $("modalBody").replaceChildren(body);
  $("modal").classList.remove("hidden");
}
export const closeModal = () => $("modal").classList.add("hidden");

/* ---------- Misc helpers ---------- */
export async function withBusy(btn, fn) {
  btn.disabled = true;
  try { return await fn(); } finally { btn.disabled = false; }
}
export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ---------- Roster (loaded once, shared by every tab) ---------- */
export async function loadRoster() {
  const { data, error } = await db
    .from("users")
    .select("id, full_name, role, section, instrument")
    .order("full_name");
  if (error) return toast(error.message);
  state.roster = data;
  state.byId = new Map(data.map((p) => [p.id, p]));
  emit("roster");
}

// Everyone who marches (directors are staff, so they're not tracked)
export const marchers = () => state.roster.filter((p) => p.role !== "director");

// [[section, people[]], ...] in band order
export function groupBySection(list) {
  const groups = new Map();
  list.forEach((p) => {
    const k = p.section || "Unassigned";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  });
  const order = (k) => { const i = SECTIONS.indexOf(k); return i === -1 ? 99 : i; };
  return [...groups.entries()].sort((a, b) => order(a[0]) - order(b[0]));
}