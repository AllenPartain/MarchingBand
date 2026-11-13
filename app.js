const SUPABASE_URL = "https://jqhydaolujztvlnoaqge.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_AgUl45w8FzDdtMwRUmppBA_bDzMP1XE";
const db = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);
let me = null; // the logged-in person's profile

function show(name) {
  ["auth", "setup", "home"].forEach((s) => $(s).classList.add("hidden"));
  $(name).classList.remove("hidden");
}

function say(text) {
  $("message").textContent = text;
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

  // Only directors and drum majors can assign goals
  const canAssign = ["director", "drum_major"].includes(me.role);
  $("goalForm").classList.toggle("hidden", !canAssign);

  show("home");
  loadGoals();
}

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

  // Directors and section leaders can add notes and mark done
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

$("logoutBtn").onclick = async () => {
  await db.auth.signOut();
  me = null;
  say("");
  refresh();
};

refresh();