/* home.js: the dashboard. Reads data the other tabs already loaded. */
import {
  db, state, $, el, empty, isLeader, marchers, groupBySection,
  todayStr, shortDate, fmtTime, bus, emit,
} from "./core.js";
import { enableNotifications } from "./chat.js";

let todayRows = []; // today's attendance statuses I'm allowed to see
let latest = null;  // newest announcement

export function init() {
  $("enableNotifBtn").onclick = enableNotifications;
  ["data", "roster", "notif"].forEach((n) => bus.addEventListener(n, render));
}

export async function load() {
  const [att, msg] = await Promise.all([
    db.from("attendance_logs").select("status").eq("date", todayStr()),
    db.from("messages").select("*").eq("channel", "announcements").order("created_at", { ascending: false }).limit(1),
  ]);
  if (!att.error) todayRows = att.data.map((r) => r.status);
  if (!msg.error) latest = msg.data[0] || null;
  render();
}

function readiness(people) {
  if (!state.items.length || !people.length) return null;
  let done = 0;
  people.forEach((p) =>
    state.items.forEach((i) => { if (state.records.get(p.id + "|" + i.id)?.status === "passed") done++; })
  );
  return { done, total: people.length * state.items.length };
}

const tile = (num, label) => {
  const t = el("div", "tile");
  t.append(el("div", "num", String(num)), el("div", "lbl", label));
  return t;
};
function section(title, ...kids) {
  const c = el("div", "card");
  c.append(el("h3", "card-title", title), ...kids);
  return c;
}

function render() {
  if (!state.me) return;
  const hour = new Date().getHours();
  const first = state.me.full_name.split(" ")[0];
  $("homeDate").textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  $("homeTitle").textContent = `${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}, ${first}`;
  $("homeNotify").classList.toggle("hidden", !("Notification" in window) || Notification.permission !== "default");

  const people = marchers();
  const leader = isLeader();
  const openGoals = state.goals.filter((g) => g.status === "open").length;
  const ready = readiness(people);
  const readyPct = ready ? Math.round((ready.done / ready.total) * 100) + "%" : "—";
  const out = [];

  const tiles = el("div", "tiles");
  if (leader) {
    tiles.append(tile(`${todayRows.length}/${people.length}`, "Marked today"), tile(openGoals, "Open goals"), tile(readyPct, "Music check readiness"));
  } else {
    const mine = todayRows[0];
    tiles.append(tile(mine ? mine[0].toUpperCase() + mine.slice(1) : "—", "My attendance today"), tile(openGoals, "Open goals"), tile(ready ? `${ready.done}/${ready.total}` : "—", "My music checks"));
  }
  out.push(tiles);

  if (leader) {
    const c = { present: 0, tardy: 0, absent: 0, excused: 0 };
    todayRows.forEach((s) => c[s]++);
    const chips = el("div", "chips");
    chips.append(
      el("span", "badge ok", "Present " + c.present), el("span", "badge warn", "Tardy " + c.tardy),
      el("span", "badge bad", "Absent " + c.absent), el("span", "badge info", "Excused " + c.excused)
    );
    const go = el("button", "btn secondary sm", "Take attendance");
    go.onclick = () => emit("goto", "attendance");
    out.push(section("Today's attendance", chips, go));

    const rows = ready
      ? groupBySection(people).map(([sec, ps]) => {
          const r = readiness(ps);
          const pct = r ? Math.round((r.done / r.total) * 100) : 0;
          const row = el("div", "rrow");
          const bar = el("div", "bar");
          const fill = el("span");
          fill.style.width = pct + "%";
          bar.appendChild(fill);
          row.append(el("span", "", sec), bar, el("b", "", pct + "%"));
          return row;
        })
      : [empty("Add music checks to see readiness.")];
    out.push(section("Music check readiness by section", ...rows));
  }

  if (latest) {
    const open = el("button", "btn secondary sm", "Open chat");
    open.onclick = () => emit("open-chat", "announcements");
    const body = latest.body.length > 220 ? latest.body.slice(0, 220) + "…" : latest.body;
    out.push(section("Latest announcement", el("p", "goal-text", body), el("p", "sub", `${latest.sender_name || "Staff"} · ${shortDate(latest.created_at)} ${fmtTime(latest.created_at)}`), open));
  }

  $("homeBody").replaceChildren(...out);
}