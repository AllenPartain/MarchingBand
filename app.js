const SUPABASE_URL = "https://jqhydaolujztvlnoaqge.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_AgUl45w8FzDdtMwRUmppBA_bDzMP1XE";
const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);
let me = null;

const SECTIONS = [
  "Flutes", "Clarinets", "Saxophones", "Trumpets", "Mellophones",
  "Trombones", "Baritones", "Tubas", "Drumline", "Color Guard",
];
const ROLES = ["director", "drum_major", "section_leader", "member"];

/* ---------- Small helpers ---------- */

// Build an element safely (textContent, so nobody can inject HTML)
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function option(value, text) {
  const o = document.createElement("option");
  o.value = value;
  o.textContent = text;
  return o;
}

function fillSections(selectEl, withBlank) {
  selectEl.innerHTML = "";
  if (withBlank) selectEl.appendChild(option("", "No section"));
  SECTIONS.forEach((s) => selectEl.appendChild(option(s, s)));
}
fillSections($("goalSection"), false);
fillSections($("joinSection"), true);

function today() {
  return new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time
}
$("attDate").value = today();
$("attDate").onchange = () => loadAttendance();

// Popup message: say("text") = error, say("text", "ok") = success, say("") = hide
let toastTimer = null;
function say(text, kind) {
  const t = $("toast");
  clearTimeout(toastTimer);
  if (!text) {
    t.classList.add("hidden");
    return;
  }
  t.textContent = text;
  t.className = "toast " + (kind || "error");
  toastTimer = setTimeout(() => t.classList.add("hidden"), 4500);
}

// Catch errors from background loads so they show up instead of vanishing
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  say("Error: " + (r && r.message ? r.message : r));
});

function show(name) {
  ["auth", "setup", "home"].forEach((s) => $(s).classList.add("hidden"));
  $(name).classList.remove("hidden");
}

function showTab(name) {
  document.querySelectorAll(".panel").forEach((p) =>
    p.classList.toggle("hidden", p.id !== "tab-" + name)
  );
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.tab === name)
  );
  window.scrollTo(0, 0);
}
document.querySelectorAll(".tab").forEach((t) => {
  t.onclick = () => showTab(t.dataset.tab);
});

/* ---------- Startup: decide which screen to show ---------- */

async function start() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) return show("auth");

  const { data: profile, error } = await db
    .from("users")
    .select("id, org_id, full_name, role, section")
    .eq("id", session.user.id)
    .maybeSingle();

  if (error) throw error;
  if (!profile) return show("setup");

  me = profile;
  $("welcome").textContent = me.full_name;
  $("roleBadge").textContent = me.role.replace("_", " ");

  const canAssign = ["director", "drum_major"].includes(me.role);
  $("goalForm").classList.toggle("hidden", !canAssign);
  $("itemForm").classList.toggle("hidden", me.role !== "director");
  $("rosterTab").classList.toggle("hidden", me.role === "member");
  $("inviteBox").classList.toggle("hidden", me.role !== "director");

  show("home");
  showTab("goals");
  loadGoals();
  loadPassOffs();
  loadAttendance();
  if (me.role !== "member") loadRoster();
  if (me.role === "director") loadJoinCode();
}

// If anything goes wrong, fall back to the login screen and show why
async function refresh() {
  try {
    await start();
  } catch (err) {
    console.error(err);
    show("auth");
    say("Startup problem: " + (err.message || err));
  }
}

/* ---------- GOALS ---------- */

async function loadGoals() {
  const { data, error } = await db
    .from("rehearsal_goals")
    .select("*")
    .order("date", { ascending: false });

  const list = $("goalList");
  list.innerHTML = "";
  if (error) return say(error.message);
  if (data.length === 0) {
    list.appendChild(el("div", "empty", "No goals yet."));
    return;
  }

  const canUpdate = ["director", "section_leader"].includes(me.role);

  data.forEach((g) => {
    const isDone = g.status === "done";
    const card = el("div", "card" + (isDone ? " is-done" : ""));

    const head = el("div", "row");
    head.appendChild(el("span", "badge pill", g.target_section));
    head.appendChild(el("span", "badge " + (isDone ? "done" : "open"), isDone ? "Done" : "Open"));
    card.appendChild(head);

    card.appendChild(el("p", "goal-text", g.goal_text));
    card.appendChild(el("p", "sub", new Date(g.date + "T00:00:00").toLocaleDateString()));

    if (canUpdate) {
      const notes = el("textarea");
      notes.placeholder = "Sectional notes (e.g. Mellophones rushing m. 42)";
      notes.value = g.leader_notes || "";
      card.appendChild(notes);

      const btns = el("div", "btn-row");
      const saveBtn = el("button", "btn ghost", "Save notes");
      saveBtn.onclick = () => updateGoal(g.id, { leader_notes: notes.value });
      const doneBtn = el("button", "btn", isDone ? "Reopen" : "Mark done");
      doneBtn.onclick = () =>
        updateGoal(g.id, { leader_notes: notes.value, status: isDone ? "open" : "done" });
      btns.appendChild(saveBtn);
      btns.appendChild(doneBtn);
      card.appendChild(btns);
    } else if (g.leader_notes) {
      card.appendChild(el("p", "note", "Notes: " + g.leader_notes));
    }

    list.appendChild(card);
  });
}

async function updateGoal(id, changes) {
  const { data, error } = await db
    .from("rehearsal_goals")
    .update(changes)
    .eq("id", id)
    .select();

  if (error) return say(error.message);
  if (data.length === 0) return say("You're not allowed to change that goal.");
  say("Saved", "ok");
  loadGoals();
}

$("addGoalBtn").onclick = async () => {
  const text = $("goalText").value.trim();
  if (!text) return say("Type a goal first.");

  const { error } = await db.from("rehearsal_goals").insert({
    org_id: me.org_id,
    created_by: me.id,
    target_section: $("goalSection").value,
    goal_text: text,
  });

  if (error) return say(error.message);
  say("Goal assigned", "ok");
  $("goalText").value = "";
  $("goalForm").open = false;
  loadGoals();
};

/* ---------- PASS-OFF BOARD ---------- */

async function loadPassOffs() {
  const [itemsRes, rosterRes, recordsRes] = await Promise.all([
    db.from("pass_off_items").select("*").order("due_date", { ascending: true }),
    db.from("users").select("id, full_name, section, role").order("full_name"),
    db.from("student_pass_offs").select("*"),
  ]);

  const list = $("passOffList");
  list.innerHTML = "";

  const err = itemsRes.error || rosterRes.error || recordsRes.error;
  if (err) return say(err.message);

  const items = itemsRes.data;
  if (items.length === 0) {
    list.appendChild(el("div", "empty", "No pass-off items yet."));
    return;
  }

  const students = rosterRes.data.filter((u) => ["member", "section_leader"].includes(u.role));
  const names = {};
  rosterRes.data.forEach((u) => (names[u.id] = u.full_name));

  const records = {};
  recordsRes.data.forEach((r) => (records[r.student_id + "|" + r.pass_off_item_id] = r));

  const canMark = ["director", "section_leader"].includes(me.role);

  items.forEach((item) => {
    const card = el("div", "card");
    card.appendChild(el("strong", "", item.title));

    const bits = [item.movement, item.measure_range && "mm. " + item.measure_range];
    if (item.due_date) bits.push("due " + item.due_date);
    card.appendChild(el("p", "sub", bits.filter(Boolean).join(" • ")));

    // Progress bar: how many of the students you can see have passed
    const passedCount = students.filter(
      (s) => (records[s.id + "|" + item.id] || {}).status === "passed"
    ).length;
    const pct = students.length ? Math.round((passedCount / students.length) * 100) : 0;
    const bar = el("div", "bar");
    const fill = el("span");
    fill.style.width = pct + "%";
    bar.appendChild(fill);
    card.appendChild(bar);
    card.appendChild(el("p", "sub", passedCount + " of " + students.length + " passed (" + pct + "%)"));

    students.forEach((s) => {
      const rec = records[s.id + "|" + item.id];
      const status = rec ? rec.status : "not_started";

      const row = el("div", "student-row");
      const label = el("div", "nm");
      label.appendChild(el("span", "", s.full_name));
      if (s.section) label.appendChild(el("div", "sub", s.section));
      if (rec && rec.status === "passed") {
        const who = names[rec.verified_by];
        label.appendChild(
          el("div", "sub",
            "Passed " + new Date(rec.timestamp).toLocaleDateString() + (who ? " by " + who : ""))
        );
      }
      row.appendChild(label);

      if (canMark) {
        const sel = el("select", "status-select s-" + status);
        [["not_started", "Not started"], ["in_progress", "In progress"], ["passed", "Passed"]]
          .forEach(([value, text]) => {
            const opt = option(value, text);
            if (value === status) opt.selected = true;
            sel.appendChild(opt);
          });
        sel.onchange = () => setPassOff(s.id, item.id, sel.value);
        row.appendChild(sel);
      } else {
        const text = status.replace("_", " ");
        row.appendChild(el("span", "badge " + (status === "passed" ? "done" : "none"), text));
      }

      card.appendChild(row);
    });

    list.appendChild(card);
  });
}

async function setPassOff(studentId, itemId, status) {
  const { error } = await db.from("student_pass_offs").upsert(
    {
      org_id: me.org_id,
      student_id: studentId,
      pass_off_item_id: itemId,
      status: status,
      verified_by: me.id,
      timestamp: new Date().toISOString(),
    },
    { onConflict: "student_id,pass_off_item_id" }
  );

  await loadPassOffs();
  if (error) say(error.message);
}

$("addItemBtn").onclick = async () => {
  const title = $("itemTitle").value.trim();
  if (!title) return say("Give the item a title.");

  const { error } = await db.from("pass_off_items").insert({
    org_id: me.org_id,
    title: title,
    movement: $("itemMovement").value.trim() || null,
    measure_range: $("itemMeasures").value.trim() || null,
    due_date: $("itemDue").value || null,
  });

  if (error) return say(error.message);
  say("Item added", "ok");
  ["itemTitle", "itemMovement", "itemMeasures", "itemDue"].forEach((id) => ($(id).value = ""));
  $("itemForm").open = false;
  loadPassOffs();
};

/* ---------- ATTENDANCE ---------- */

async function loadAttendance() {
  const date = $("attDate").value || today();

  const [rosterRes, logsRes] = await Promise.all([
    db.from("users").select("id, full_name, section, role").order("full_name"),
    db.from("attendance_logs").select("*").eq("date", date),
  ]);

  const list = $("attList");
  list.innerHTML = "";
  $("attSummary").innerHTML = "";

  const err = rosterRes.error || logsRes.error;
  if (err) return say(err.message);

  const people = rosterRes.data.filter((u) => ["member", "section_leader"].includes(u.role));
  if (people.length === 0) {
    list.appendChild(el("div", "empty", "No students to show."));
    return;
  }

  const logs = {};
  logsRes.data.forEach((l) => (logs[l.student_id] = l));

  const counts = { present: 0, tardy: 0, absent: 0 };
  logsRes.data.forEach((l) => counts[l.status]++);
  const notRecorded = people.length - logsRes.data.length;
  $("attSummary").appendChild(el("span", "chip present", "Present " + counts.present));
  $("attSummary").appendChild(el("span", "chip tardy", "Tardy " + counts.tardy));
  $("attSummary").appendChild(el("span", "chip absent", "Absent " + counts.absent));
  $("attSummary").appendChild(el("span", "chip none", "Not recorded " + notRecorded));

  const canMark = ["director", "section_leader"].includes(me.role);

  people.forEach((p) => {
    const status = logs[p.id] ? logs[p.id].status : "";
    const row = el("div", "student-row");

    const label = el("div", "nm");
    label.appendChild(el("span", "", p.full_name));
    if (p.section) label.appendChild(el("div", "sub", p.section));
    row.appendChild(label);

    if (canMark) {
      const seg = el("div", "seg");
      [["present", "P", "Present"], ["tardy", "T", "Tardy"], ["absent", "A", "Absent"]]
        .forEach(([value, short, full]) => {
          const b = el("button", "seg-btn " + value + (status === value ? " on" : ""), short);
          b.type = "button";
          b.title = full;
          b.onclick = () => {
            // Tapping the active button clears it (directors only, per the rules)
            if (status === value && me.role !== "director") return;
            setAttendance(p.id, date, status === value ? "" : value);
          };
          seg.appendChild(b);
        });
      row.appendChild(seg);
    } else {
      row.appendChild(el("span", "badge " + (status || "none"), status || "not recorded"));
    }

    list.appendChild(row);
  });
}

async function setAttendance(studentId, date, status) {
  let result;

  if (status === "") {
    result = await db
      .from("attendance_logs")
      .delete()
      .eq("student_id", studentId)
      .eq("date", date);
  } else {
    result = await db.from("attendance_logs").upsert(
      {
        org_id: me.org_id,
        student_id: studentId,
        date: date,
        status: status,
        recorded_by: me.id,
      },
      { onConflict: "student_id,date" }
    );
  }

  await loadAttendance();
  if (result.error) say(result.error.message);
}

/* ---------- ROSTER ---------- */

async function loadJoinCode() {
  const { data } = await db.from("join_codes").select("code").maybeSingle();
  $("joinCodeText").textContent = data ? data.code : "none yet";
}

$("newCodeBtn").onclick = async () => {
  const { data, error } = await db.rpc("new_join_code");
  if (error) return say(error.message);
  say("New code generated", "ok");
  $("joinCodeText").textContent = data;
};

async function loadRoster() {
  const { data, error } = await db
    .from("users")
    .select("id, full_name, role, section, instrument")
    .order("full_name");

  const list = $("rosterList");
  list.innerHTML = "";
  if (error) return say(error.message);

  const isDirector = me.role === "director";

  data.forEach((u) => {
    const card = el("div", "card");

    const head = el("div", "row");
    head.appendChild(el("strong", "", u.full_name));
    head.appendChild(el("span", "badge pill", u.role.replace("_", " ")));
    card.appendChild(head);

    card.appendChild(
      el("p", "sub", [u.section, u.instrument].filter(Boolean).join(" • ") || "No section yet")
    );

    // Directors can edit everyone except themselves
    if (isDirector && u.id !== me.id) {
      const edit = el("div", "edit-row");

      const roleSel = el("select");
      ROLES.forEach((r) => {
        const opt = option(r, r.replace("_", " "));
        if (r === u.role) opt.selected = true;
        roleSel.appendChild(opt);
      });

      const secSel = el("select");
      fillSections(secSel, true);
      secSel.value = u.section || "";

      const save = () =>
        updateUser(u.id, { role: roleSel.value, section: secSel.value || null });
      roleSel.onchange = save;
      secSel.onchange = save;

      edit.appendChild(roleSel);
      edit.appendChild(secSel);
      card.appendChild(edit);
    }

    list.appendChild(card);
  });
}

async function updateUser(id, changes) {
  const { data, error } = await db
    .from("users")
    .update(changes)
    .eq("id", id)
    .select();

  if (error) say(error.message);
  else if (data.length === 0) say("You're not allowed to change that person.");
  else say("Updated", "ok");
  loadRoster();
  loadPassOffs();
  loadAttendance();
}

/* ---------- AUTH ---------- */

$("signupBtn").onclick = async () => {
  const { error } = await db.auth.signUp({
    email: $("email").value,
    password: $("password").value,
  });
  if (error) say(error.message);
  refresh();
};

$("loginBtn").onclick = async () => {
  const { error } = await db.auth.signInWithPassword({
    email: $("email").value,
    password: $("password").value,
  });
  if (error) return say(error.message);
  say("");
  refresh();
};

$("createBandBtn").onclick = async () => {
  const { error } = await db.rpc("create_band", {
    band_name: $("bandName").value,
    my_name: $("myName").value,
  });
  if (error) return say(error.message);
  say("");
  refresh();
};

$("joinBandBtn").onclick = async () => {
  const { error } = await db.rpc("join_band", {
    code_input: $("joinCode").value,
    my_name: $("joinName").value,
    my_section: $("joinSection").value,
    my_instrument: $("joinInstrument").value,
  });
  if (error) return say(error.message);
  say("");
  refresh();
};

async function logout() {
  await db.auth.signOut();
  me = null;
  say("");
  refresh();
}
$("logoutBtn").onclick = logout;
$("setupLogoutBtn").onclick = logout;

refresh();