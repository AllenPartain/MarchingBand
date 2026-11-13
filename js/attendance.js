/* attendance.js: directors, drum majors, and section leaders take attendance. */
import {
  db, state, $, el, option, empty, skeleton, SECTIONS, toast, can, isStaff,
  marchers, groupBySection, todayStr, shiftDay, bus, emit, cap,
} from "./core.js";

const STATUSES = [
  ["present", "P", "Present"],
  ["tardy", "T", "Tardy"],
  ["absent", "A", "Absent"],
  ["excused", "E", "Excused"],
];
const BADGE = { present: "ok", tardy: "warn", absent: "bad", excused: "info" };

let date = todayStr();
let secFilter = "";
let logs = new Map(); // studentId -> record for the chosen day
let loaded = false;
const rowEls = new Map();

export function init() {
  $("attDate").value = date;
  $("attPrev").onclick = () => setDate(shiftDay(date, -1));
  $("attNext").onclick = () => setDate(shiftDay(date, 1));
  $("attToday").onclick = () => setDate(todayStr());
  $("attDate").onchange = (e) => e.target.value && setDate(e.target.value);

  const sel = $("attSection");
  sel.classList.toggle("hidden", !isStaff());
  sel.replaceChildren(option("", "All sections"), ...SECTIONS.map((s) => option(s, s)));
  sel.onchange = () => { secFilter = sel.value; render(); };

  bus.addEventListener("roster", render);
}

async function setDate(d) {
  date = d;
  $("attDate").value = d;
  loaded = false;
  render();
  await load();
}

export async function load() {
  const day = date;
  const { data, error } = await db.from("attendance_logs").select("*").eq("date", day);
  if (day !== date) return; // you changed the day while this was loading
  if (error) return toast(error.message);
  logs = new Map(data.map((r) => [r.student_id, r]));
  loaded = true;
  render();
}

const people = () => marchers().filter((p) => !secFilter || p.section === secFilter);

function render() {
  const list = $("attList");
  rowEls.clear();
  if (!loaded) {
    $("attSummary").replaceChildren();
    return list.replaceChildren(skeleton(5));
  }
  const ps = people();
  if (!ps.length) {
    summary();
    return list.replaceChildren(empty("No one to show."));
  }
  const nodes = [];
  groupBySection(ps).forEach(([sec, group]) => {
    const head = el("div", "group-head");
    head.appendChild(el("span", "", sec));
    if (can.markAttendance()) {
      const b = el("button", "btn secondary xs", "All present");
      b.onclick = () => markAll(group);
      head.appendChild(b);
    }
    nodes.push(head, ...group.map(buildRow));
  });
  list.replaceChildren(...nodes);
  summary();
}

function buildRow(p) {
  const row = el("div", "srow");
  rowEls.set(p.id, row);
  paintRow(row, p);
  return row;
}

function paintRow(row, p) {
  const status = logs.get(p.id)?.status || "";
  const nm = el("div", "nm");
  nm.appendChild(el("span", "", p.full_name));
  if (p.instrument) nm.appendChild(el("div", "sub", p.instrument));

  let ctl;
  if (can.markAttendance()) {
    ctl = el("div", "seg");
    STATUSES.forEach(([v, short, full]) => {
      const b = el("button", "seg-btn " + v + (status === v ? " on" : ""), short);
      b.type = "button";
      b.title = full;
      b.setAttribute("aria-label", full);
      b.onclick = () => setStatus(p, status === v ? "" : v); // tap again to clear
      ctl.appendChild(b);
    });
  } else {
    ctl = el("span", "badge " + (status ? BADGE[status] : "muted"), status ? cap(status) : "Not recorded");
  }
  row.replaceChildren(nm, ctl);
}

function repaint(p) {
  const row = rowEls.get(p.id);
  if (row) paintRow(row, p);
  summary();
  emit("data");
}

function summary() {
  const ps = people();
  const c = { present: 0, tardy: 0, absent: 0, excused: 0 };
  ps.forEach((p) => { const s = logs.get(p.id)?.status; if (s) c[s]++; });
  const marked = Object.values(c).reduce((a, b) => a + b, 0);
  const chip = (cls, t) => el("span", "badge " + cls, t);
  $("attSummary").replaceChildren(
    chip("ok", "Present " + c.present),
    chip("warn", "Tardy " + c.tardy),
    chip("bad", "Absent " + c.absent),
    chip("info", "Excused " + c.excused),
    chip("muted", "Unmarked " + (ps.length - marked))
  );
}

async function setStatus(p, status) {
  const day = date;
  const before = logs.get(p.id);
  const rec = { org_id: state.me.org_id, student_id: p.id, date: day, status, recorded_by: state.me.id };

  status ? logs.set(p.id, { ...before, ...rec }) : logs.delete(p.id);
  repaint(p);

  const res = status
    ? await db.from("attendance_logs").upsert(rec, { onConflict: "student_id,date" })
    : await db.from("attendance_logs").delete().eq("student_id", p.id).eq("date", day);

  if (res.error && day === date) {
    before ? logs.set(p.id, before) : logs.delete(p.id);
    repaint(p);
    toast(res.error.message);
  }
}

async function markAll(group) {
  const day = date;
  const todo = group.filter((p) => !logs.has(p.id));
  if (!todo.length) return toast("Everyone in this section is already marked.", "ok");

  const recs = todo.map((p) => ({
    org_id: state.me.org_id, student_id: p.id, date: day, status: "present", recorded_by: state.me.id,
  }));
  recs.forEach((r) => logs.set(r.student_id, r));
  todo.forEach(repaint);

  const { error } = await db.from("attendance_logs").upsert(recs, { onConflict: "student_id,date" });
  if (error) {
    todo.forEach((p) => logs.delete(p.id));
    todo.forEach(repaint);
    toast(error.message);
  } else {
    toast(`Marked ${todo.length} present`, "ok");
  }
}