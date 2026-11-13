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

function fillSections(selectEl, withBlank) {
  selectEl.innerHTML = "";
  if (withBlank) {
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "No section";
    selectEl.appendChild(blank);
  }
  SECTIONS.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    selectEl.appendChild(opt);
  });
}
fillSections($("goalSection"), false);
fillSections($("joinSection"), true);

// Today's date as YYYY-MM-DD in the user's local time
function today() {
  return new Date().toLocaleDateString("en-CA");
}
$("attDate").value = today();
$("attDate").onchange = () => loadAttendance();

function show(name) {
  ["auth", "setup", "home"].forEach((s) => $(s).classList.add("hidden"));
  $(name).classList.remove("hidden");
}

function say(text) {
  $("message").textContent = text;
  if (text) window.scrollTo(0, 0);
}

async function refresh() {
  const { data: { session } } = await db.auth.getSession();
  if (!session) return show("auth");

  const { data: profile } = await db
    .from("users")
    .select("id, org_id, full_name, role, section")
    .eq("id", session.user.id)
    .maybeSingle();

  if (!profile) return show("setup");

  me = profile;
  $("welcome").textContent = `Welcome, ${me.full_name} (${me.role})`;

  const canAssign = ["director", "drum_major"].includes(me.role);
  $("goalForm").classList.toggle("hidden", !canAssign);
  $("itemForm").classList.toggle("hidden", me.role !== "director");
  $("rosterBox").classList.toggle("hidden", me.role === "member");
  $("inviteBox").classList.toggle("hidden", me.role !== "director");

  show("home");
  loadGoals();
  loadPassOffs();
  loadAttendance();
  if (me.role !== "member") loadRoster();
  if (me.role === "director") loadJoinCode();
}

/* ---------- ATTENDANCE ---------- */

async function loadAttendance() {
  const date = $("attDate").value || today();

  const [rosterRes, logsRes] = await Promise.all([
    db.from("users").select("id, full_name, section, role").order("full_name"),
    db.from("attendance_logs").select("*").eq("date", date),
  ]);

  const list = $("attList");
  list.innerHTML = "";

  const err = rosterRes.error || logsRes.error;
  if (err) return say(err.message);

  const people = rosterRes.data.filter((u) =>
    ["member", "section_leader"].includes(u.role)
  );
  if (people.length === 0) {
    list.textContent = "No students to show.";
    $("attSummary").textContent = "";
    return;
  }

  const logs = {};
  logsRes.data.forEach((l) => (logs[l.student_id] = l));

  const counts = { present: 0, absent: 0, tardy: 0 };
  logsRes.data.forEach((l) => counts[l.status]++);
  $("attSummary").textContent =
    `Present ${counts.present} • Tardy ${counts.tardy} • Absent ${counts.absent}` +
    ` • Not recorded ${people.length - logsRes.data.length}`;

  const canMark = ["director", "section_leader"].includes(me.role);

  people.forEach((p) => {
    const log = logs[p.id];
    const status = log ? log.status : "";

    const row = document.createElement("div");
    row.className = "student-row";

    const nameEl = document.createElement("span");
    nameEl.textContent = p.full_name + (p.section ? " (" + p.section + ")" : "");
    row.appendChild(nameEl);

    if (canMark) {
      const sel = document.createElement("select");
      [
        ["", "Not recorded"],
        ["present", "Present"],
        ["tardy", "Tardy"],
        ["absent", "Absent"],
      ].forEach(([value, text]) => {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = text;
        if (value === status) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.onchange = () => setAttendance(p.id, date, sel.value);
      row.appendChild(sel);
    } else {
      const st = document.createElement("span");
      st.className = status;
      st.textContent = status || "not recorded";
      row.appendChild(st);
    }

    list.appendChild(row);
  });
}

async function setAttendance(studentId, date, status) {
  let error;

  if (status === "") {
    // "Not recorded" removes the record (directors only, per the rules)
    ({ error } = await db
      .from("attendance_logs")
      .delete()
      .eq("student_id", studentId)
      .eq("date", date));
  } else {
    ({ error } = await db.from("attendance_logs").upsert(
      {
        org_id: me.org_id,
        student_id: studentId,
        date: date,
        status: status,
        recorded_by: me.id,
      },
      { onConflict: "student_id,date" }
    ));
  }

  await loadAttendance();
  if (error) say(error.message);
  else say("");
}

/* ---------- ROSTER ---------- */

async function loadJoinCode() {
  const { data } = await db.from("join_codes").select("code").maybeSingle();
  $("joinCodeText").textContent = data ? data.code : "none yet";
}

$("newCodeBtn").onclick = async () => {
  const { data, error } = await db.rpc("new_join_code");
  if (error) return say(error.message);
  say("");
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
    const card = document.createElement("div");
    card.className = "card";

    const nameEl = document.createElement("p");
    nameEl.innerHTML = "<strong></strong>";
    nameEl.querySelector("strong").textContent = u.full_name;
    card.appendChild(nameEl);

    const info = document.createElement("p");
    info.className = "small";
    info.textContent = [u.role.replace("_", " "), u.section, u.instrument]
      .filter(Boolean)
      .join(" • ");
    card.appendChild(info);

    if (isDirector && u.id !== me.id) {
      const roleSel = document.createElement("select");
      ROLES.forEach((r) => {
        const opt = document.createElement("option");
        opt.value = r;
        opt.textContent = r.replace("_", " ");
        if (r === u.role) opt.selected = true;
        roleSel.appendChild(opt);
      });

      const secSel = document.createElement("select");
      fillSections(secSel, true);
      secSel.value = u.section || "";

      const save = () =>
        updateUser(u.id, {
          role: roleSel.value,
          section: secSel.value || null,
        });
      roleSel.onchange = save;
      secSel.onchange = save;

      card.appendChild(roleSel);
      card.appendChild(secSel);
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
  else say("");
  loadRoster();
  loadPassOffs();
  loadAttendance();
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
    list.textContent = "No goals yet.";
    return;
  }

  const canUpdate = ["director", "section_leader"].includes(me.role);

  data.forEach((g) => {
    const card = document.createElement("div");
    card.className = "card";

    const title = document.createElement("p");
    const isDone = g.status === "done";
    title.innerHTML = `<strong></strong> <span class="${isDone ? "done" : ""}"></span>`;
    title.querySelector("strong").textContent = g.target_section;
    title.querySelector("span").textContent = isDone ? "✅ Done" : "Open";
    card.appendChild(title);

    const text = document.createElement("p");
    text.textContent = g.goal_text;
    card.appendChild(text);

    if (canUpdate) {
      const notes = document.createElement("textarea");
      notes.placeholder = "Sectional notes (e.g. Mellophones rushing m. 42)";
      notes.value = g.leader_notes || "";
      card.appendChild(notes);

      const saveBtn = document.createElement("button");
      saveBtn.textContent = "Save notes";
      saveBtn.onclick = () => updateGoal(g.id, { leader_notes: notes.value });
      card.appendChild(saveBtn);

      const doneBtn = document.createElement("button");
      doneBtn.textContent = isDone ? "Reopen" : "Mark done";
      doneBtn.onclick = () =>
        updateGoal(g.id, {
          leader_notes: notes.value,
          status: isDone ? "open" : "done",
        });
      card.appendChild(doneBtn);
    } else if (g.leader_notes) {
      const n = document.createElement("p");
      n.textContent = "Notes: " + g.leader_notes;
      card.appendChild(n);
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
  say("");
  loadGoals();
}

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
    list.textContent = "No pass-off items yet.";
    return;
  }

  const students = rosterRes.data.filter((u) =>
    ["member", "section_leader"].includes(u.role)
  );
  const names = {};
  rosterRes.data.forEach((u) => (names[u.id] = u.full_name));

  const records = {};
  recordsRes.data.forEach((r) => {
    records[r.student_id + "|" + r.pass_off_item_id] = r;
  });

  const canMark = ["director", "section_leader"].includes(me.role);

  items.forEach((item) => {
    const card = document.createElement("div");
    card.className = "card";

    const title = document.createElement("p");
    title.innerHTML = "<strong></strong>";
    title.querySelector("strong").textContent = item.title;
    card.appendChild(title);

    const meta = document.createElement("p");
    meta.className = "small";
    const bits = [item.movement, item.measure_range && "mm. " + item.measure_range];
    if (item.due_date) bits.push("due " + item.due_date);
    meta.textContent = bits.filter(Boolean).join(" • ");
    card.appendChild(meta);

    students.forEach((s) => {
      const rec = records[s.id + "|" + item.id];
      const status = rec ? rec.status : "not_started";

      const row = document.createElement("div");
      row.className = "student-row";

      const label = document.createElement("div");
      const nameEl = document.createElement("span");
      nameEl.textContent = s.full_name + (s.section ? " (" + s.section + ")" : "");
      label.appendChild(nameEl);

      if (rec && rec.status === "passed") {
        const when = document.createElement("div");
        when.className = "small";
        const who = names[rec.verified_by];
        when.textContent =
          "Passed " + new Date(rec.timestamp).toLocaleDateString() +
          (who ? " by " + who : "");
        label.appendChild(when);
      }
      row.appendChild(label);

      if (canMark) {
        const sel = document.createElement("select");
        [
          ["not_started", "Not started"],
          ["in_progress", "In progress"],
          ["passed", "Passed"],
        ].forEach(([value, text]) => {
          const opt = document.createElement("option");
          opt.value = value;
          opt.textContent = text;
          if (value === status) opt.selected = true;
          sel.appendChild(opt);
        });
        sel.onchange = () => setPassOff(s.id, item.id, sel.value);
        row.appendChild(sel);
      } else {
        const st = document.createElement("span");
        st.className = status === "passed" ? "passed" : "";
        st.textContent = status.replace("_", " ");
        row.appendChild(st);
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
  else say("");
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
  say("");
  ["itemTitle", "itemMovement", "itemMeasures", "itemDue"].forEach(
    (id) => ($(id).value = "")
  );
  loadPassOffs();
};

/* ---------- GOALS FORM + AUTH ---------- */

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
  say("");
  $("goalText").value = "";
  loadGoals();
};

$("signupBtn").onclick = async () => {
  const { error } = await db.auth.signUp({
    email: $("email").value,
    password: $("password").value,
  });
  say(error ? error.message : "");
  refresh();
};

$("loginBtn").onclick = async () => {
  const { error } = await db.auth.signInWithPassword({
    email: $("email").value,
    password: $("password").value,
  });
  say(error ? error.message : "");
  refresh();
};

$("createBandBtn").onclick = async () => {
  const { error } = await db.rpc("create_band", {
    band_name: $("bandName").value,
    my_name: $("myName").value,
  });
  say(error ? error.message : "");
  refresh();
};

$("joinBandBtn").onclick = async () => {
  const { error } = await db.rpc("join_band", {
    code_input: $("joinCode").value,
    my_name: $("joinName").value,
    my_section: $("joinSection").value,
    my_instrument: $("joinInstrument").value,
  });
  say(error ? error.message : "");
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