/* auth.js: login, signup, join a band, create a band. */
import { db, $, SECTIONS, option, toast, withBusy } from "./core.js";

export function initAuth(refresh) {
  $("joinSection").replaceChildren(
    option("", "Section (optional)"),
    ...SECTIONS.map((s) => option(s, s))
  );

  const creds = () => ({ email: $("email").value.trim(), password: $("password").value });

  $("loginBtn").onclick = (e) =>
    withBusy(e.currentTarget, async () => {
      const { error } = await db.auth.signInWithPassword(creds());
      if (error) return toast(error.message);
      refresh();
    });

  $("signupBtn").onclick = (e) =>
    withBusy(e.currentTarget, async () => {
      const { error } = await db.auth.signUp(creds());
      if (error) return toast(error.message);
      refresh();
    });

  $("password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("loginBtn").click();
  });

  $("createBandBtn").onclick = (e) =>
    withBusy(e.currentTarget, async () => {
      const { error } = await db.rpc("create_band", {
        band_name: $("bandName").value.trim(),
        my_name: $("myName").value.trim(),
      });
      if (error) return toast(error.message);
      refresh();
    });

  $("joinBandBtn").onclick = (e) =>
    withBusy(e.currentTarget, async () => {
      const { error } = await db.rpc("join_band", {
        code_input: $("joinCode").value,
        my_name: $("joinName").value.trim(),
        my_section: $("joinSection").value,
        my_instrument: $("joinInstrument").value.trim(),
      });
      if (error) return toast(error.message);
      refresh();
    });
}