/* app.js: the conductor. Starts everything and wires the pieces together. */
import {
  db, state, $, el, icon, paintIcons, toast, closeModal, debounce, bus, loadRoster, ROLE_LABEL,
} from "./core.js";
import { initAuth } from "./auth.js";
import * as home from "./home.js";
import * as goals from "./goals.js";
import * as passoffs from "./passoffs.js";
import * as attendance from "./attendance.js";
import * as chat from "./chat.js";
import * as roster from "./roster.js";
import { initTuner } from "./tuner.js";
import { initMusic, stopMusic } from "./music.js"; // <-- ADDED MUSIC IMPORT

const TABS = [
  { id: "home", label: "Home", icon: "home" },
  { id: "goals", label: "Goals", icon: "target" },
  { id: "passoffs", label: "Pass-offs", icon: "check" },
  { id: "attendance", label: "Attendance", icon: "calendar" },
  { id: "tuner", label: "Tuner", icon: "target" },
  { id: "music", label: "Practice", icon: "play" }, // <-- ADDED MUSIC TAB
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "roster", label: "Roster", icon: "users", hide: () => state.me.role === "member" },
];
const visibleTabs = () => TABS.filter((t) => !t.hide?.());

let booted = false;
let sync = null;

/* ---------- Screens + tabs ---------- */
function showScreen(name) {
  ["auth", "setup", "app"].forEach((s) => $(s).classList.add("hidden"));
  $(name).classList.remove("hidden");
}

function buildNav() {
  $("nav").replaceChildren(
    ...visibleTabs().map((t) => {
      const b = el("button", "nav-btn");
      b.type = "button";
      b.dataset.tab = t.id;
      const ico = el("span", "nav-ico");
      ico.innerHTML = icon(t.icon, 22);
      b.append(ico, el("span", "nav-label", t.label), el("span", "nav-badge hidden"));
      b.onclick = () => go(t.id);
      return b;
    })
  );
}

function go(tab) {
  if (!visibleTabs().some((t) => t.id === tab)) tab = "home";
  
  // <-- ADDED: Stop the music if the user leaves the Practice tab
  if (state.tab === "music" && tab !== "music") {
    if (typeof stopMusic === "function") stopMusic();
  }

  state.tab = tab;
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("hidden", p.id !== "tab-" + tab));
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  history.replaceState(null, "", "#" + tab);
  $("main").scrollTo(0, 0);
  if (tab === "chat") chat.onShow();
}

/* ---------- Loading ---------- */
const loadAll = () =>
  Promise.all([goals.load(), passoffs.load(), attendance.load(), chat.load(), roster.load(), home.load()]);

const resync = debounce(async () => {
  if (!state.me) return;
  await loadRoster();
  await loadAll();
}, 500);

async function start() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) return showScreen("auth");

  const { data: profile, error } = await db
    .from("users")
    .select("id, org_id, full_name, role, section, instrument")
    .eq("id", session.user.id)
    .maybeSingle();
  if (error) throw error;
  if (!profile) return showScreen("setup");

  state.me = profile;
  $("meName").textContent = profile.full_name;
  $("meRole").textContent = ROLE_LABEL[profile.role] + (profile.section ? " · " + profile.section : "");

  if (!booted) {
    booted = true;
    buildNav();
    [home, goals, passoffs, attendance, chat, roster].forEach((m) => m.init());
    initTuner();
    initMusic(); // <-- ADDED MUSIC INIT
  }

  showScreen("app");
  go(location.hash.slice(1) || "home"); // refreshing keeps you on the same tab
  await loadRoster();                   // everything else depends on the roster
  await loadAll();
  subscribe();
}

async function refresh() {
  try {
    await start();
  } catch (err) {
    console.error(err);
    showScreen("auth");
    toast("Startup problem: " + (err.message || err));
  }
}

/* ---------- Live updates: one connection, many tables ---------- */
const reloadGoals = debounce(() => goals.load(), 300);
const reloadPass = debounce(() => passoffs.load(), 300);
const reloadAtt = debounce(() => { attendance.load(); home.load(); }, 300);
const reloadUsers = debounce(async () => {
  await loadRoster();
  const mine = state.byId.get(state.me.id);
  // If a director changed MY role or section, reload so my screen matches
  if (mine && (mine.role !== state.me.role || mine.section !== state.me.section)) location.reload();
}, 400);

function subscribe() {
  if (sync) db.removeChannel(sync);
  let wasDown = false;
  const on = (table, fn) => ({ event: "*", schema: "public", table, fn });
  const feeds = [
    on("messages", chat.onMessageChange),
    on("rehearsal_goals", reloadGoals),
    on("pass_off_items", reloadPass),
    on("student_pass_offs", reloadPass),
    on("attendance_logs", reloadAtt),
    on("users", reloadUsers),
  ];
  sync = db.channel("band-sync");
  feeds.forEach((f) => sync.on("postgres_changes", { event: f.event, schema: f.schema, table: f.table }, f.fn));
  sync.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      if (wasDown) resync(); // we dropped for a while, so catch up
      wasDown = false;
    } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
      wasDown = true;
    }
  });
}

/* ---------- Wiring (runs once) ---------- */
paintIcons();
initAuth(refresh);

async function logout() {
  await db.auth.signOut();
  history.replaceState(null, "", location.pathname);
  location.reload(); // a clean reload resets every bit of state
}
$("logoutBtn").onclick = logout;
$("setupLogoutBtn").onclick = logout;

$("modal").addEventListener("click", (e) => {
  if (e.target.id === "modal" || e.target.id === "modalClose") closeModal();
});

bus.addEventListener("goto", (e) => go(e.detail));
bus.addEventListener("open-chat", (e) => { go("chat"); chat.openChannel(e.detail); });

bus.addEventListener("unread", () => {
  const total = Object.values(state.unread).reduce((a, n) => a + n, 0);
  const badge = document.querySelector('.nav-btn[data-tab="chat"] .nav-badge');
  if (badge) {
    badge.textContent = total > 99 ? "99+" : String(total);
    badge.classList.toggle("hidden", !total);
  }
  document.title = (total ? `(${total}) ` : "") + "Section Leader HQ";
});

// Phones put the app to sleep, so catch up when you come back
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.me) {
    resync();
    if (state.tab === "chat") chat.onShow();
  }
});
addEventListener("online", resync);

// Service worker: makes notifications work on phones, and opens the right channel when tapped
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "open-chat") { go("chat"); if (e.data.channel) chat.openChannel(e.data.channel); }
  });
}

refresh();