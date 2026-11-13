/* roster.js: who's in the band. Directors edit roles and sections. */
import {
  db, state, $, el, option, empty, SECTIONS, ROLES, ROLE_LABEL, can,
  groupBySection, toast, bus, emit,
} from "./core.js";

let query = "";

export function init() {
  $("rosterSearch").oninput = (e) => { query = e.target.value.trim().toLowerCase(); render(); };
  $("inviteBox").classList.toggle("hidden", !can.editRoster());
  $("newCodeBtn").onclick = newCode;
  $("copyCodeBtn").onclick = copyCode;
  bus.addEventListener("roster", render);
}

export async function load() {
  if (can.editRoster()) await loadCode();
  render();
}

function render() {
  const people = state.roster.filter((p) => !query || p.full_name.toLowerCase().includes(query));
  $("rosterCount").textContent = state.roster.length + (state.roster.length === 1 ? " person" : " people");
  const list = $("rosterList");
  if (!people.length) return list.replaceChildren(empty("No matches."));

  const nodes = [];
  groupBySection(people).forEach(([sec, group]) => {
    nodes.push(el("div", "group-head", sec));
    group.forEach((p) => nodes.push(row(p)));
  });
  list.replaceChildren(...nodes);
}

function row(p) {
  const r = el("div", "srow");
  const nm = el("div", "nm");
  nm.append(el("span", "", p.full_name), el("div", "sub", [ROLE_LABEL[p.role], p.instrument].filter(Boolean).join(" · ")));
  r.appendChild(nm);

  if (can.editRoster() && p.id !== state.me.id) {
    const edit = el("div", "edit");
    const role = el("select", "select-sm");
    ROLES.forEach((x) => role.appendChild(option(x, ROLE_LABEL[x], x === p.role)));
    const sec = el("select", "select-sm");
    sec.append(option("", "No section", !p.section), ...SECTIONS.map((s) => option(s, s, s === p.section)));
    role.onchange = () => update(p, { role: role.value });
    sec.onchange = () => update(p, { section: sec.value || null });
    edit.append(role, sec);
    r.appendChild(edit);
  }
  return r;
}

async function update(p, changes) {
  const before = { role: p.role, section: p.section };
  Object.assign(p, changes);
  emit("roster");
  const { data, error } = await db.from("users").update(changes).eq("id", p.id).select();
  if (error || !data.length) {
    Object.assign(p, before);
    emit("roster");
    toast(error ? error.message : "You can't change that person.");
  }
}

async function loadCode() {
  const { data } = await db.from("join_codes").select("code").maybeSingle();
  $("joinCodeText").textContent = data ? data.code : "—";
}

async function newCode() {
  if ($("joinCodeText").textContent !== "—" && !confirm("This replaces the current code. Anyone with the old one can no longer join.")) return;
  const { data, error } = await db.rpc("new_join_code");
  if (error) return toast(error.message);
  $("joinCodeText").textContent = data;
  toast("New code created", "ok");
}

async function copyCode() {
  const code = $("joinCodeText").textContent;
  if (code === "—") return;
  try { await navigator.clipboard.writeText(code); toast("Code copied", "ok"); }
  catch { toast("Couldn't copy. Select the code and copy it by hand."); }
}