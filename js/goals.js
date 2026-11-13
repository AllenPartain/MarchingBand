/* goals.js: rehearsal goals. Staff assign, leaders add notes and mark done. */
import {
  db, state, $, el, option, empty, skeleton, SECTIONS, toast, can, isStaff,
  openModal, closeModal, icon, emit, bus, prettyDay,
} from "./core.js";

let loaded = false;
let filter = "open";
let secFilter = "";

export function init() {
  $("newGoalBtn").classList.toggle("hidden", !can.assignGoals());
  $("newGoalBtn").onclick = openNew;
  buildFilters();
  bus.addEventListener("roster", render);
}

function buildFilters() {
  const bar = $("goalFilter");
  bar.replaceChildren();
  [["open", "Open"], ["done", "Done"], ["all", "All"]].forEach(([v, t]) => {
    const b = el("button", "chip-btn" + (filter === v ? " active" : ""), t);
    b.onclick = () => { filter = v; buildFilters(); render(); };
    bar.appendChild(b);
  });
  if (isStaff()) {
    const sel = el("select", "select-sm");
    sel.append(option("", "All sections", secFilter === ""), ...SECTIONS.map((s) => option(s, s, secFilter === s)));
    sel.onchange = () => { secFilter = sel.value; render(); };
    bar.appendChild(sel);
  }
}

const typing = () =>
  $("goalList").contains(document.activeElement) && document.activeElement.tagName === "TEXTAREA";

export async function load() {
  const { data, error } = await db.from("rehearsal_goals").select("*").order("date", { ascending: false });
  if (error) return toast(error.message);
  state.goals = data;
  loaded = true;
  if (!typing()) render(); // don't wipe notes someone is typing
  emit("data");
}

function render() {
  const list = $("goalList");
  if (!loaded) return list.replaceChildren(skeleton(3));
  const rows = state.goals.filter(
    (g) => (filter === "all" || g.status === filter) && (!secFilter || g.target_section === secFilter)
  );
  if (!rows.length) {
    return list.replaceChildren(empty(filter === "open" ? "No open goals right now." : "Nothing here yet."));
  }
  list.replaceChildren(...rows.map(card));
}

function card(g) {
  const done = g.status === "done";
  const c = el("article", "card goal" + (done ? " is-done" : ""));

  const head = el("div", "row");
  const tags = el("div", "tags");
  tags.append(el("span", "pill", g.target_section), el("span", "badge " + (done ? "ok" : "warn"), done ? "Done" : "Open"));
  head.appendChild(tags);
  if (can.manageItems()) {
    const del = el("button", "icon-btn");
    del.innerHTML = icon("trash", 16);
    del.title = "Delete goal";
    del.onclick = () => remove(g.id);
    head.appendChild(del);
  }
  c.append(head, el("p", "goal-text", g.goal_text), el("p", "sub", prettyDay(g.date)));

  if (can.updateGoal()) {
    const notes = el("textarea");
    notes.rows = 2;
    notes.placeholder = "Sectional notes: what needs work?";
    notes.value = g.leader_notes || "";
    const save = el("button", "btn secondary", "Save notes");
    save.onclick = () => patch(g.id, { leader_notes: notes.value }, "Notes saved");
    const toggle = el("button", "btn", done ? "Reopen" : "Mark done");
    toggle.onclick = () => patch(g.id, { leader_notes: notes.value, status: done ? "open" : "done" });
    const row = el("div", "btn-row");
    row.append(save, toggle);
    c.append(notes, row);
  } else if (g.leader_notes) {
    c.appendChild(el("p", "note", g.leader_notes));
  }
  return c;
}

// Update the screen first, then the database. If the database says no, undo it.
async function patch(id, changes, msg) {
  const g = state.goals.find((x) => x.id === id);
  const before = { ...g };
  Object.assign(g, changes);
  render();
  const { data, error } = await db.from("rehearsal_goals").update(changes).eq("id", id).select();
  if (error || !data.length) {
    Object.assign(g, before);
    render();
    return toast(error ? error.message : "You can't change that goal.");
  }
  if (msg) toast(msg, "ok");
  emit("data");
}

async function remove(id) {
  if (!confirm("Delete this goal?")) return;
  state.goals = state.goals.filter((g) => g.id !== id);
  render();
  const { error } = await db.from("rehearsal_goals").delete().eq("id", id);
  if (error) { toast(error.message); load(); } else emit("data");
}

function openNew() {
  const form = el("div", "form");
  const sec = el("select");
  sec.append(option("__all", "All sections"), ...SECTIONS.map((s) => option(s, s)));
  const text = el("textarea");
  text.rows = 4;
  text.placeholder = "e.g. Clean up mm. 40-48 at 120 bpm";
  const go = el("button", "btn block", "Assign goal");
  go.onclick = async () => {
    const t = text.value.trim();
    if (!t) return toast("Write the goal first.");
    const targets = sec.value === "__all" ? SECTIONS : [sec.value];
    go.disabled = true;
    const { error } = await db.from("rehearsal_goals").insert(
      targets.map((s) => ({ org_id: state.me.org_id, created_by: state.me.id, target_section: s, goal_text: t }))
    );
    go.disabled = false;
    if (error) return toast(error.message);
    closeModal();
    toast("Goal assigned", "ok");
    load();
  };
  form.append(sec, text, go);
  openModal("New rehearsal goal", form);
}