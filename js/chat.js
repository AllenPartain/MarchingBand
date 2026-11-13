/* chat.js: channels, live messages, unread counts, notifications, read receipts. */
import {
  db, state, $, el, empty, skeleton, SECTIONS, ROLE_LABEL, toast, isStaff, isLeader,
  openModal, emit, debounce, fmtTime,
} from "./core.js";

let channel = "announcements";
let nodes = new Map();      // message id -> element on screen
let lastMsg = null;         // for grouping messages from the same sender
let lastDay = "";
let pendingSends = 0;
let loadToken = 0;
let announceReads = [];     // staff only: who has opened Announcements, and when

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const muted = new Set(JSON.parse(store.get("mutedChannels") || "[]"));

/* ---------- Channels ---------- */
export const channelLabel = (ch) =>
  ch === "announcements" ? "Announcements" : ch === "leaders" ? "Leaders" : ch.replace("section:", "");

// The database enforces the same rules; this just decides which tabs to show
function myChannels() {
  const list = ["announcements"];
  if (isLeader()) list.push("leaders");
  if (isStaff()) SECTIONS.forEach((s) => list.push("section:" + s));
  else if (state.me.section) list.push("section:" + state.me.section);
  return list;
}
const canPost = (ch) => ch !== "announcements" || isStaff();
const chatActive = () => state.tab === "chat" && document.visibilityState === "visible";

export function init() {
  const input = $("chatInput");
  const touch = matchMedia("(pointer: coarse)").matches;
  input.addEventListener("keydown", (e) => {
    // Desktop: Enter sends, Shift+Enter adds a line. Phones: Enter adds a line.
    if (e.key === "Enter" && !e.shiftKey && !touch) { e.preventDefault(); send(); }
  });
  input.addEventListener("input", autosize);
  $("sendBtn").onclick = send;
  $("muteBtn").onclick = toggleMute;
  $("jumpBtn").onclick = () => scrollBottom(true);
  $("msgScroll").addEventListener("scroll", () => { if (nearBottom()) $("jumpBtn").classList.add("hidden"); }, { passive: true });
}

export async function load() {
  buildChannels();
  await Promise.all([refreshUnread(), loadMessages()]);
}

export function onShow() {
  scrollBottom(false);
  markRead();
}

export async function openChannel(ch) {
  if (!myChannels().includes(ch)) return;
  channel = ch;
  buildChannels();
  await loadMessages(true);
}

function buildChannels() {
  const list = myChannels();
  if (!list.includes(channel)) channel = "announcements";

  $("chanBar").replaceChildren(
    ...list.map((ch) => {
      const b = el("button", "chan" + (ch === channel ? " active" : ""));
      b.type = "button";
      b.appendChild(el("span", "", channelLabel(ch)));
      const n = state.unread[ch] || 0;
      if (n) b.appendChild(el("span", "count", n > 99 ? "99+" : String(n)));
      b.onclick = () => openChannel(ch);
      return b;
    })
  );

  const post = canPost(channel);
  $("composer").classList.toggle("hidden", !post);
  $("chatNote").classList.toggle("hidden", post);
  $("chatNote").textContent = post ? "" : "Only directors and drum majors can post announcements.";
  $("chatTitle").textContent = channelLabel(channel);
  $("muteBtn").classList.toggle("is-muted", muted.has(channel));
  $("muteBtn").title = muted.has(channel) ? "Unmute this channel" : "Mute this channel";
}

/* ---------- Loading + rendering ---------- */
async function loadMessages(showSkeleton = false) {
  if (!state.me) return;
  const ch = channel;
  const token = ++loadToken;
  const list = $("msgList");
  if (showSkeleton) list.replaceChildren(skeleton(4));

  const wantReads = ch === "announcements" && isStaff();
  const [msgs, reads] = await Promise.all([
    db.from("messages").select("*").eq("channel", ch).order("created_at", { ascending: false }).limit(150),
    wantReads
      ? db.from("channel_reads").select("user_id,last_read_at").eq("channel", "announcements")
      : Promise.resolve({ data: [] }),
  ]);
  if (token !== loadToken) return; // you switched channels while this loaded
  if (msgs.error) { list.replaceChildren(); return toast(msgs.error.message); }

  announceReads = reads.data || [];
  nodes = new Map();
  lastMsg = null;
  lastDay = "";
  list.replaceChildren();
  const rows = msgs.data.reverse();
  if (!rows.length) list.appendChild(empty("No messages yet. Say something."));
  rows.forEach((m) => appendMessage(m, false));
  scrollBottom(false);
  if (chatActive()) markRead();
}

function relativeDay(d) {
  const diff = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

function appendMessage(m, animate = true) {
  const list = $("msgList");
  list.querySelectorAll(":scope > .empty, :scope > .skeleton").forEach((n) => n.remove());

  const d = new Date(m.created_at);
  const day = d.toDateString();
  if (day !== lastDay) {
    list.appendChild(el("div", "day-sep", relativeDay(d)));
    lastDay = day;
    lastMsg = null;
  }
  const grouped = !!lastMsg && lastMsg.sender_id === m.sender_id && d - new Date(lastMsg.created_at) < 5 * 60000;
  const node = buildNode(m, grouped, animate);
  list.appendChild(node);
  nodes.set(m.id, node);
  lastMsg = m;
  return node;
}

function buildNode(m, grouped, animate) {
  const mine = m.sender_id === state.me.id;
  const wrap = el(
    "div",
    "msg " + (mine ? "mine" : "theirs") + (grouped ? " grouped" : "") + (m.pending ? " pending" : "") + (animate ? " pop" : "")
  );
  wrap.dataset.id = m.id;

  if (!mine && !grouped) {
    const head = el("div", "msg-head");
    head.appendChild(el("span", "msg-name", m.sender_name || "Unknown"));
    if (m.sender_role && m.sender_role !== "member") {
      head.appendChild(el("span", "role-tag", ROLE_LABEL[m.sender_role] || m.sender_role));
    }
    wrap.appendChild(head);
  }
  wrap.appendChild(el("div", "bubble", m.body));

  const meta = el("div", "msg-meta", fmtTime(m.created_at));
  if (!m.pending) {
    if (mine || state.me.role === "director") {
      const del = el("button", "link-btn", "Delete");
      del.type = "button";
      del.onclick = () => deleteMessage(m.id);
      meta.appendChild(del);
    }
    if (m.channel === "announcements" && isStaff()) {
      const { seen, total } = seenInfo(m);
      const b = el("button", "link-btn", `Seen by ${seen}/${total}`);
      b.type = "button";
      b.onclick = () => showSeen(m);
      meta.appendChild(b);
    }
  }
  wrap.appendChild(meta);
  return wrap;
}

/* ---------- Read receipts (announcements, staff only) ---------- */
function seenInfo(m) {
  const audience = state.roster.filter((p) => p.id !== m.sender_id);
  const sentAt = new Date(m.created_at);
  const seenIds = new Set(announceReads.filter((r) => new Date(r.last_read_at) >= sentAt).map((r) => r.user_id));
  const unseen = audience.filter((p) => !seenIds.has(p.id));
  return { seen: audience.length - unseen.length, total: audience.length, unseen };
}

function showSeen(m) {
  const { seen, total, unseen } = seenInfo(m);
  const box = el("div", "form");
  box.appendChild(el("p", "sub", `${seen} of ${total} have opened Announcements since this was posted.`));
  if (!unseen.length) {
    box.appendChild(el("p", "", "Everyone has seen it."));
  } else {
    const list = el("div");
    unseen.forEach((p) => {
      const row = el("div", "srow");
      const nm = el("div", "nm");
      nm.append(el("span", "", p.full_name), el("div", "sub", [ROLE_LABEL[p.role], p.section].filter(Boolean).join(" · ")));
      row.appendChild(nm);
      list.appendChild(row);
    });
    box.appendChild(list);
  }
  openModal("Not seen yet", box);
}

/* ---------- Sending + deleting ---------- */
function autosize() {
  const i = $("chatInput");
  i.style.height = "auto";
  i.style.height = Math.min(i.scrollHeight, 120) + "px";
}

async function send() {
  if (!canPost(channel)) return;
  const input = $("chatInput");
  const body = input.value.trim();
  if (!body) return;
  input.value = "";
  autosize();

  const ch = channel;
  pendingSends++;
  const temp = {
    id: "tmp-" + Date.now(), channel: ch, body, pending: true,
    sender_id: state.me.id, sender_name: state.me.full_name, sender_role: state.me.role,
    created_at: new Date().toISOString(),
  };
  const node = appendMessage(temp);
  scrollBottom(true);

  const { data, error } = await db.from("messages").insert({ org_id: state.me.org_id, channel: ch, body }).select().single();
  pendingSends--;

  if (error) {
    node.remove();
    nodes.delete(temp.id);
    input.value = body; // give the text back so nothing is lost
    autosize();
    return toast(error.message);
  }
  if (!node.isConnected) return; // you switched channels; the reload already has it
  const fresh = buildNode(data, node.classList.contains("grouped"), false);
  node.replaceWith(fresh);
  nodes.delete(temp.id);
  nodes.set(data.id, fresh);
  if (lastMsg === temp) lastMsg = data;
}

function removeNode(id) {
  const n = nodes.get(id);
  if (n) { n.remove(); nodes.delete(id); }
}

async function deleteMessage(id) {
  if (!confirm("Delete this message?")) return;
  removeNode(id);
  const { error } = await db.from("messages").delete().eq("id", id);
  if (error) { toast(error.message); loadMessages(); }
}

/* ---------- Live updates (called from app.js) ---------- */
export function onMessageChange(payload) {
  if (!state.me) return;
  if (payload.eventType === "DELETE") return removeNode(payload.old.id);
  if (payload.eventType !== "INSERT") return;

  const m = payload.new;
  if (nodes.has(m.id)) return;
  const mine = m.sender_id === state.me.id;
  if (mine && pendingSends > 0) return; // we're already showing our own message

  if (m.channel === channel) {
    const stick = nearBottom();
    appendMessage(m);
    if (stick || mine) scrollBottom(true);
    else $("jumpBtn").classList.remove("hidden");
    if (chatActive()) markRead();
    else if (!mine) bump(m);
  } else if (!mine) {
    bump(m);
  }
}

/* ---------- Scrolling ---------- */
function nearBottom() {
  const s = $("msgScroll");
  return s.scrollHeight - s.scrollTop - s.clientHeight < 140;
}
function scrollBottom(smooth) {
  const s = $("msgScroll");
  requestAnimationFrame(() => s.scrollTo({ top: s.scrollHeight, behavior: smooth ? "smooth" : "auto" }));
  $("jumpBtn").classList.add("hidden");
}

/* ---------- Unread counts ---------- */
async function refreshUnread() {
  const { data, error } = await db.rpc("unread_counts");
  if (error) return; // chat still works without badges
  state.unread = Object.fromEntries(data.map((r) => [r.channel, Number(r.unread)]));
  buildChannels();
  emit("unread");
}

const markRead = debounce(async () => {
  if (state.unread[channel]) {
    state.unread[channel] = 0;
    buildChannels();
    emit("unread");
  }
  await db.rpc("mark_channel_read", { ch: channel });
}, 600);

function bump(m) {
  state.unread[m.channel] = (state.unread[m.channel] || 0) + 1;
  buildChannels();
  emit("unread");
  notify(m);
}

/* ---------- Notifications ---------- */
const preview = (t) => (t.length > 90 ? t.slice(0, 90) + "…" : t);

function notify(m) {
  if (muted.has(m.channel)) return;
  const who = m.sender_name || "Someone";
  const title = channelLabel(m.channel);
  navigator.vibrate?.(40);

  if (document.visibilityState === "visible") {
    // App is open on another tab: show a banner you can tap
    toast(`${title} · ${who}: ${preview(m.body)}`, "info", () => emit("open-chat", m.channel));
  } else {
    systemNotify(title, `${who}: ${preview(m.body)}`, m.channel);
  }
}

async function systemNotify(title, body, ch) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const opts = { body, tag: ch, renotify: true, data: { channel: ch } };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return reg.showNotification(title, opts); // works on phones too
  } catch { /* fall through */ }
  new Notification(title, opts);
}

export async function enableNotifications() {
  if (!("Notification" in window)) return toast("This browser doesn't support notifications.");
  const result = await Notification.requestPermission();
  if (result === "granted") {
    toast("Notifications are on", "ok");
    systemNotify("Notifications enabled", "You'll get alerts for new messages.", "welcome");
  } else {
    toast("Notifications are blocked. You can change that in your browser settings.");
  }
  emit("notif");
}

function toggleMute() {
  muted.has(channel) ? muted.delete(channel) : muted.add(channel);
  store.set("mutedChannels", JSON.stringify([...muted]));
  buildChannels();
  toast(muted.has(channel) ? "Channel muted" : "Channel unmuted", "ok");
}