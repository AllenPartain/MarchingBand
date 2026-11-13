// js/auth.js — Zero-Rate-Limit Username/Email Auth & First-Time Band Setup
import { db, $, toast } from "./core.js";

function normalizeLoginId(raw) {
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return "";
  if (cleaned.includes("@")) return cleaned;
  const safeUser = cleaned.replace(/[^a-z0-9._-]/g, "");
  return safeUser ? `${safeUser}@slhq.band` : "";
}

export function initAuth(onSuccess) {
  const authScreen = $("auth");
  const setupScreen = $("setup");

  if (authScreen) {
    authScreen.innerHTML = `
      <div class="auth-card card" style="max-width:420px;margin:3rem auto;padding:1.75rem;">
        <div style="text-align:center;margin-bottom:1.25rem;">
          <h1 class="page-title" style="margin-bottom:0.25rem;">Section Leader HQ</h1>
          <p class="sub">Sign in or create an account to access your band</p>
        </div>

        <div class="btn-row" style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-bottom:1.25rem;">
          <button type="button" id="authTabLogin" class="btn sm">Sign In</button>
          <button type="button" id="authTabSignup" class="btn secondary sm">Create Account</button>
        </div>

        <form id="authForm" style="display:flex;flex-direction:column;gap:0.85rem;">
          <label class="sub" style="display:flex;flex-direction:column;gap:0.3rem;">
            Username or Email
            <input id="authIdentifier" type="text" autocomplete="username" placeholder="e.g. alex.sax or alex@school.edu" required>
          </label>

          <label class="sub" style="display:flex;flex-direction:column;gap:0.3rem;">
            Password (6+ characters)
            <input id="authPassword" type="password" autocomplete="current-password" minlength="6" placeholder="••••••••" required>
          </label>

          <button type="submit" id="authSubmitBtn" class="btn" style="margin-top:0.35rem;">Sign In</button>
        </form>
      </div>
    `;
  }

  if (setupScreen) {
    setupScreen.innerHTML = `
      <div class="auth-card card" style="max-width:460px;margin:2.5rem auto;padding:1.75rem;">
        <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:1rem;">
          <div>
            <h1 class="page-title" style="margin-bottom:0.15rem;">Band Profile Setup</h1>
            <p class="sub">Finish setting up your member card</p>
          </div>
          <button type="button" id="setupLogoutBtn" class="btn secondary sm">Log out</button>
        </div>

        <form id="setupForm" style="display:flex;flex-direction:column;gap:0.85rem;">
          <label class="sub" style="display:flex;flex-direction:column;gap:0.3rem;">
            Full Name
            <input id="setupFullName" type="text" placeholder="e.g. Jordan Rivera" required>
          </label>

          <label class="sub" style="display:flex;flex-direction:column;gap:0.3rem;">
            Setup Mode
            <select id="setupModeSelect">
              <option value="join">Join Existing Band</option>
              <option value="create">Create New Band (Director)</option>
            </select>
          </label>

          <label id="setupJoinWrap" class="sub" style="display:flex;flex-direction:column;gap:0.3rem;">
            Band Name or Band ID
            <input id="setupBandLookup" type="text" placeholder="Enter your band's exact name or ID">
          </label>

          <label id="setupCreateWrap" class="sub hidden" style="display:flex;flex-direction:column;gap:0.3rem;">
            New Band / School Name
            <input id="setupNewBandName" type="text" placeholder="e.g. Marching Aztecs">
          </label>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.65rem;">
            <label class="sub" style="display:flex;flex-direction:column;gap:0.3rem;">
              Role
              <select id="setupRoleSelect">
                <option value="member">Member</option>
                <option value="section_leader">Section Leader</option>
                <option value="drum_major">Drum Major</option>
                <option value="director">Director</option>
              </select>
            </label>

            <label class="sub" style="display:flex;flex-direction:column;gap:0.3rem;">
              Section
              <select id="setupSectionSelect">
                <option value="Woodwinds">Woodwinds</option>
                <option value="Brass">Brass</option>
                <option value="Percussion">Percussion</option>
                <option value="Color Guard">Color Guard</option>
                <option value="Leadership">Leadership</option>
              </select>
            </label>
          </div>

          <label class="sub" style="display:flex;flex-direction:column;gap:0.3rem;">
            Instrument
            <input id="setupInstrument" type="text" placeholder="e.g. Alto Saxophone, Trumpet, Snare">
          </label>

          <button type="submit" id="setupSubmitBtn" class="btn" style="margin-top:0.35rem;">Enter Section Leader HQ</button>
        </form>
      </div>
    `;
  }

  let mode = "login";
  const tabLogin = $("authTabLogin");
  const tabSignup = $("authTabSignup");
  const submitBtn = $("authSubmitBtn");
  const passInput = $("authPassword");

  function setMode(nextMode) {
    mode = nextMode;
    const isLogin = mode === "login";
    tabLogin?.classList.toggle("secondary", !isLogin);
    tabSignup?.classList.toggle("secondary", isLogin);
    if (submitBtn) submitBtn.textContent = isLogin ? "Sign In" : "Create Account";
    if (passInput) passInput.autocomplete = isLogin ? "current-password" : "new-password";
  }

  tabLogin?.addEventListener("click", () => setMode("login"));
  tabSignup?.addEventListener("click", () => setMode("signup"));

  $("authForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = normalizeLoginId($("authIdentifier")?.value || "");
    const password = $("authPassword")?.value || "";

    if (!email) {
      toast("Enter a valid username or email address.");
      return;
    }
    if (password.length < 6) {
      toast("Password must be at least 6 characters.");
      return;
    }

    if (submitBtn) submitBtn.disabled = true;

    try {
      if (mode === "signup") {
        // Bypass Supabase email rate limiter completely via SQL RPC
        const { error: rpcErr } = await db.rpc("register_band_member", {
          p_email: email,
          p_password: password,
        });
        if (rpcErr) throw rpcErr;

        const { error: signInErr } = await db.auth.signInWithPassword({ email, password });
        if (signInErr) throw signInErr;
        toast("Account created!");
      } else {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }

      if (typeof onSuccess === "function") await onSuccess();
    } catch (err) {
      console.error("Auth error:", err);
      toast(err?.message || String(err));
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });

  $("setupModeSelect")?.addEventListener("change", (e) => {
    const isCreate = e.target.value === "create";
    $("setupJoinWrap")?.classList.toggle("hidden", isCreate);
    $("setupCreateWrap")?.classList.toggle("hidden", !isCreate);
    if (isCreate && $("setupRoleSelect")) {
      $("setupRoleSelect").value = "director";
    }
  });

  $("setupForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const setupBtn = $("setupSubmitBtn");
    if (setupBtn) setupBtn.disabled = true;

    try {
      const { data: { session } } = await db.auth.getSession();
      if (!session?.user) throw new Error("Session expired. Please sign in again.");

      const fullName = $("setupFullName")?.value.trim();
      const setupMode = $("setupModeSelect")?.value || "join";
      const role = $("setupRoleSelect")?.value || "member";
      const section = $("setupSectionSelect")?.value || "Woodwinds";
      const instrument = $("setupInstrument")?.value.trim() || "";

      if (!fullName) throw new Error("Please enter your full name.");

      let orgId = null;

      if (setupMode === "create") {
        const bandName = $("setupNewBandName")?.value.trim();
        if (!bandName) throw new Error("Enter a name for your new band.");

        const { data: newOrg, error: orgErr } = await db
          .from("organizations")
          .insert({ name: bandName })
          .select("id")
          .single();
        if (orgErr) throw orgErr;
        orgId = newOrg.id;
      } else {
        const lookup = $("setupBandLookup")?.value.trim();
        if (!lookup) throw new Error("Enter your band's name or Band ID.");

        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lookup);
        const query = db.from("organizations").select("id, name").limit(1);
        const { data: orgs, error: findErr } = isUuid
          ? await query.eq("id", lookup)
          : await query.ilike("name", lookup);

        if (findErr) throw findErr;
        if (!orgs || orgs.length === 0) {
          throw new Error("Band not found. Check spelling or switch to 'Create New Band (Director)'.");
        }
        orgId = orgs[0].id;
      }

      const { error: profileErr } = await db.from("users").upsert({
        id: session.user.id,
        org_id: orgId,
        full_name: fullName,
        role,
        section,
        instrument,
      });
      if (profileErr) throw profileErr;

      toast("Welcome to Section Leader HQ!");
      if (typeof onSuccess === "function") await onSuccess();
    } catch (err) {
      console.error("Setup error:", err);
      toast(err?.message || "Could not complete profile setup.");
    } finally {
      if (setupBtn) setupBtn.disabled = false;
    }
  });
}