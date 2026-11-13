/* passoffs.js: the music and drill memorization board. */
import {
  db, state, $, el, option, empty, skeleton, SECTIONS, toast, can, isStaff,
  openModal, closeModal, marchers, groupBySection, shortDate, emit, bus,
} from "./core.js";

let loaded = false;
let secFilter = "";
const openItems = new Set(); // remembers which cards you had open
const key = (student, item) => student + "|" + item;
const LABEL = { not_started: "Not started", in_progress: "In progress", passed: "Passed" };

export function init() {
  const add = $("newItemBtn");
  add.classList.toggle("hidden", !can.manageItems());
  add.onclick = openNew;

  const sel = $("poSection");
  sel.classList.toggle("hidden", !isStaff());
  sel.replaceChildren(option("", "All sections"), ...SECTIONS.map((s) => option(s, s)));
  sel.onchange = () => { secFilter = sel.value; render(); };

  bus.addEventListener("roster", render);
}

export async function load() {
  const [items, recs] = await Promise.all([
    db.from("pass_off_items").select("*").order("movement").order("due_date"),
    db.from("student_pass_offs").select("*"),
  ]);
  const err = items.error || recs.error;
  if (err) return toast(err.message);
  state.items = items.data;
  state.records = new Map(recs.data.map((r) => [key(r.student_id, r.pass_off_item_id), r]));
  loaded = true;
  render();
  emit("data");
}

const people = () => marchers().filter((p) => !secFilter || p.section === secFilter);

function render() {
  const list = $("poList");
  if (!loaded) return list.replaceChildren(skeleton(3));
  if (!state.items.length) {
    return list.replaceChildren(empty(can.manageItems() ? "No pass-off items yet. Add the first one." : "No pass-off items yet."));
  }
  const ps = people();
  const nodes = [];
  let last = Symbol();
  state.items.forEach((item) => {
    if (item.movement !== last) {
      last = item.movement;
      nodes.push(el("div", "group-label", item.movement || "General"));
    }
    nodes.push(itemCard(item, ps));
  });
  list.replaceChildren(...nodes);
}

function progress(item, ps) {
  const done = ps.filter((p) => state.records.get(key(p.id, item.id))?.status === "passed").length;
  return { done, total: ps.length };
}

function itemCard(item, ps) {
  const card = el("details", "card item");
  card.open = openItems.has(item.id);

  const summary = el("summary");
  const top = el("div", "row");
  const title = el("div");
  const meta = [item.measure_range && "mm. " + item.measure_range, item.due_date && "due " + shortDate(item.due_date + "T12:00:00")];
  title.append(el("strong", "", item.title), el("div", "sub", meta.filter(Boolean).join(" · ")));
  const pct = el("span", "pct");
  top.append(title, pct);
  const bar = el("div", "bar");
  const fill = el("span");
  bar.appendChild(fill);
  summary.append(top, bar);

  const body = el("div", "item-body");
  card.append(summary, body);

  const paint = () => {
    const { done, total } = progress(item, ps);
    pct.textContent = done + "/" + total;
    fill.style.width = (total ? (done / total) * 100 : 0) + "%";
  };

  // Student rows are only built when you open the card, which keeps big bands fast
  const fillBody = () => {
    const groups = groupBySection(ps);
    const nodes = [];
    groups.forEach(([sec, group]) => {
      if (groups.length > 1) nodes.push(el("div", "mini-label", sec));
      group.forEach((p) => nodes.push(studentRow(item, p, paint)));
    });
    if (!ps.length) nodes.push(empty("No one to show."));
    if (can.manageItems()) {
      const del = el("button", "btn secondary xs", "Delete item");
      del.onclick = () => removeItem(item);
      nodes.push(del);
    }
    body.replaceChildren(...nodes);
  };

  card.addEventListener("toggle", () => {
    card.open ? openItems.add(item.id) : openItems.delete(item.id);
    if (card.open && !body.firstChild) fillBody();
  });
  paint();
  if (card.open) fillBody();
  return card;
}

function studentRow(item, p, onChange) {
  const row = el("div", "srow");
  const k = key(p.id, item.id);

  const paint = () => {
    const rec = state.records.get(k);
    const status = rec?.status || "not_started";

    const nm = el("div", "nm");
    nm.appendChild(el("span", "", p.full_name));
    if (status === "passed") {
      const by = state.byId.get(rec.verified_by)?.full_name;
      nm.appendChild(el("div", "sub", "Passed " + shortDate(rec.timestamp) + (by ? " · " + by : "")));
    } else if (p.section) {
      nm.appendChild(el("div", "sub", p.section));
    }

    let ctl;
    if (can.markPassOffs()) {
      ctl = el("select", "status-select s-" + status);
      Object.entries(LABEL).forEach(([v, t]) => ctl.appendChild(option(v, t, v === status)));
      ctl.onchange = () => change(ctl.value);
    } else {
      ctl = el("span", "badge " + (status === "passed" ? "ok" : status === "in_progress" ? "warn" : "muted"), LABEL[status]);
    }
    row.replaceChildren(nm, ctl);
  };

  async function change(status) {
    const before = state.records.get(k);
    const rec = {
      org_id: state.me.org_id,
      student_id: p.id,
      pass_off_item_id: item.id,
      status,
      verified_by: state.me.id,
      timestamp: new Date().toISOString(),
    };
    state.records.set(k, rec);
    paint(); onChange(); emit("data");
    const { error } = await db.from("student_pass_offs").upsert(rec, { onConflict: "student_id,pass_off_item_id" });
    if (error) {
      before ? state.records.set(k, before) : state.records.delete(k);
      paint(); onChange(); emit("data");
      toast(error.message);
    }
  }

  paint();
  return row;
}

async function removeItem(item) {
  if (!confirm(`Delete "${item.title}" and all of its pass-off records?`)) return;
  const a = await db.from("student_pass_offs").delete().eq("pass_off_item_id", item.id);
  if (a.error) return toast(a.error.message);
  const b = await db.from("pass_off_items").delete().eq("id", item.id);
  if (b.error) return toast(b.error.message);
  toast("Item deleted", "ok");
  load();
}

function openNew() {
  const form = el("div", "form");
  const title = el("input"); title.placeholder = "Title (e.g. Opener, mm. 1-32)";
  const move = el("input"); move.placeholder = "Movement (e.g. Movement 1)";
  const meas = el("input"); meas.placeholder = "Measures (e.g. 1-32)";
  const due = el("input"); due.type = "date";
  const go = el("button", "btn block", "Add item");
  go.onclick = async () => {
    if (!title.value.trim()) return toast("Give the item a title.");
    go.disabled = true;
    const { error } = await db.from("pass_off_items").insert({
      org_id: state.me.org_id,
      title: title.value.trim(),
      movement: move.value.trim() || null,
      measure_range: meas.value.trim() || null,
      due_date: due.value || null,
    });
    go.disabled = false;
    if (error) return toast(error.message);
    closeModal();
    toast("Item added", "ok");
    load();
  };
  form.append(title, move, meas, due, go);
  openModal("New pass-off item", form);
}