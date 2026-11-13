// js/music.js
import { db, state, el, toast } from "./core.js";

let osmd = null;
let audioEl = null;
let isPlaying = false;
let animFrameId = null;
let currentAudioUrl = null;
let songList = [];

// Exact score timeline: [{ timeSec: number, bpm: number }, ...]
let scoreTimeline = [];
let baseScoreBpm = 120;
let activeBpm = 120;
let startOffsetSec = 0;
let currentCursorStep = 0;

function getOsmd() {
  if (!osmd && window.opensheetmusicdisplay) {
    osmd = new window.opensheetmusicdisplay.OpenSheetMusicDisplay("osmdCanvas", {
      autoResize: true,
      drawTitle: true,
      backend: "svg",
      followCursor: false,
      defaultColorMusic: "#000000",
      defaultColorLabel: "#000000",
      defaultColorTitle: "#000000",
      pageBackgroundColor: "#ffffff",
    });
  }
  return osmd;
}

function readBlobForOsmd(blob, isMxl) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    if (isMxl) {
      reader.readAsBinaryString(blob);
    } else {
      reader.readAsText(blob);
    }
  });
}

// Walk the rendered score once to build an exact timestamp (in seconds) for every cursor position
function buildScoreTimeline(engine) {
  scoreTimeline = [];
  if (!engine?.cursor) return;

  engine.cursor.reset();
  const sheetDefaultBpm = engine.Sheet?.DefaultStartTempoInBpm || 120;
  baseScoreBpm = sheetDefaultBpm;
  activeBpm = sheetDefaultBpm;

  const bpmInput = document.getElementById("musicBpmInput");
  if (bpmInput) bpmInput.value = Math.round(sheetDefaultBpm);

  let elapsedSec = 0;
  let lastRealVal = 0;

  while (!engine.cursor.iterator.endReached) {
    const iter = engine.cursor.iterator;
    const realVal = iter.currentTimeStamp ? iter.currentTimeStamp.RealValue : lastRealVal;
    const measureBpm = iter.CurrentMeasure?.TempoInBPM || sheetDefaultBpm;

    if (scoreTimeline.length > 0) {
      // RealValue is measured in whole notes (1.0 = 4 quarter notes = 240 / BPM seconds)
      const deltaWholeNotes = Math.max(0, realVal - lastRealVal);
      elapsedSec += deltaWholeNotes * (240 / measureBpm);
    }

    scoreTimeline.push({
      timeSec: elapsedSec,
      bpm: measureBpm,
    });

    lastRealVal = realVal;
    engine.cursor.next();
  }

  engine.cursor.reset();
  currentCursorStep = 0;
}

// Move OSMD cursor directly to the exact step matching the current audio timestamp
function syncCursorToTime(audioTimeSec) {
  const engine = getOsmd();
  if (!engine?.cursor || scoreTimeline.length === 0) return;

  // Adjust for any count-in silence at the start of the MP3 and any manual BPM scaling
  const effectiveTime = Math.max(0, audioTimeSec - startOffsetSec);
  const tempoScale = activeBpm / (baseScoreBpm || 120);
  const scaledScoreTime = effectiveTime * tempoScale;

  // Find the last score step whose timestamp is <= current playback time
  let targetStep = 0;
  for (let i = 0; i < scoreTimeline.length; i++) {
    if (scoreTimeline[i].timeSec <= scaledScoreTime) {
      targetStep = i;
    } else {
      break;
    }
  }

  if (targetStep === currentCursorStep) return;

  if (targetStep < currentCursorStep) {
    engine.cursor.reset();
    currentCursorStep = 0;
  }

  while (currentCursorStep < targetStep && !engine.cursor.iterator.endReached) {
    engine.cursor.next();
    currentCursorStep++;
  }
}

export function initMusic() {
  audioEl = document.getElementById("musicAudio");
  const playBtn = document.getElementById("musicPlayBtn");
  const stopBtn = document.getElementById("musicStopBtn");

  // Show native scrub bar so students can rewind/loop tricky measures
  if (audioEl) {
    audioEl.classList.remove("hidden");
    audioEl.controls = true;
    audioEl.style.width = "100%";
    audioEl.style.marginBottom = "1rem";

    audioEl.addEventListener("play", () => {
      isPlaying = true;
      if (playBtn) playBtn.textContent = "⏸️";
      startSyncLoop();
    });

    audioEl.addEventListener("pause", () => {
      isPlaying = false;
      cancelAnimationFrame(animFrameId);
      if (playBtn) playBtn.textContent = "▶️";
    });

    audioEl.addEventListener("seeked", () => {
      syncCursorToTime(audioEl.currentTime);
    });

    audioEl.addEventListener("ended", () => {
      stopMusic();
    });
  }

  // Inject BPM + Count-in Offset controls into .music-controls if not already present
  const controlsBar = document.querySelector("#activeSongView .music-controls");
  if (controlsBar && !document.getElementById("musicBpmInput")) {
    const timingBox = document.createElement("div");
    timingBox.style.cssText = "display:flex;align-items:center;gap:0.6rem;margin-left:auto;flex-wrap:wrap;";
    timingBox.innerHTML = `
      <label class="sub" style="display:flex;align-items:center;gap:4px;">
        BPM
        <input id="musicBpmInput" type="number" value="120" min="30" max="300"
          style="width:62px;padding:4px 6px;border-radius:6px;background:#1f2430;border:1px solid #333a4d;color:#fff;text-align:center;font-weight:700;">
      </label>
      <label class="sub" title="Seconds of count-off before Measure 1 starts" style="display:flex;align-items:center;gap:4px;">
        Offset(s)
        <input id="musicOffsetInput" type="number" value="0" step="0.1" min="0" max="30"
          style="width:58px;padding:4px 6px;border-radius:6px;background:#1f2430;border:1px solid #333a4d;color:#fff;text-align:center;font-weight:700;">
      </label>
    `;
    controlsBar.appendChild(timingBox);

    document.getElementById("musicBpmInput")?.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      if (val > 0) {
        activeBpm = val;
        if (audioEl) syncCursorToTime(audioEl.currentTime);
      }
    });

    document.getElementById("musicOffsetInput")?.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      startOffsetSec = isNaN(val) ? 0 : Math.max(0, val);
      if (audioEl) syncCursorToTime(audioEl.currentTime);
    });
  }

  // Force crisp white sheet-music background
  const canvasEl = document.getElementById("osmdCanvas");
  if (canvasEl) {
    canvasEl.style.background = "#ffffff";
    canvasEl.style.color = "#000000";
    canvasEl.style.borderRadius = "8px";
    canvasEl.style.padding = "12px";
    canvasEl.style.minHeight = "320px";
    canvasEl.style.overflowX = "auto";
  }

  // Show upload card only for directors and drum majors
  const isLeader = state.me && (state.me.role === "director" || state.me.role === "drum_major");
  const uploadCard = document.getElementById("musicUploadCard");
  if (uploadCard) {
    uploadCard.classList.toggle("hidden", !isLeader);
  }

  // Director / Drum Major File Upload
  document.getElementById("musicUploadForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!isLeader) return;

    const title = document.getElementById("songTitleInput").value.trim();
    const xmlFile = document.getElementById("musicXmlFile").files[0];
    const mp3File = document.getElementById("musicAudioFile").files[0];

    if (!title || !xmlFile || !mp3File) {
      toast("Please provide a song title, sheet music file, and audio file.");
      return;
    }

    toast("Uploading song package...");
    try {
      const orgId = state.me.org_id;
      const safeXmlName = xmlFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const safeMp3Name = mp3File.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const xmlPath = `${orgId}/${Date.now()}_${safeXmlName}`;
      const mp3Path = `${orgId}/${Date.now()}_${safeMp3Name}`;

      const { error: xmlUpErr } = await db.storage.from("band_music").upload(xmlPath, xmlFile);
      if (xmlUpErr) throw new Error("Sheet music upload failed: " + xmlUpErr.message);

      const { error: mp3UpErr } = await db.storage.from("band_music").upload(mp3Path, mp3File);
      if (mp3UpErr) throw new Error("Audio upload failed: " + mp3UpErr.message);

      const { error: dbErr } = await db.from("rehearsal_music").insert({
        org_id: orgId,
        title,
        xml_file_path: xmlPath,
        mp3_file_path: mp3Path,
        created_by: state.me.id,
      });
      if (dbErr) throw dbErr;

      toast("Song published to band!");
      document.getElementById("musicUploadForm").reset();
      loadSongLibrary();
    } catch (err) {
      console.error("Upload error:", err);
      toast(err.message || "Upload failed.");
    }
  });

  playBtn?.addEventListener("click", togglePlay);
  stopBtn?.addEventListener("click", stopMusic);

  loadSongLibrary();
}

async function loadSongLibrary() {
  const container = document.getElementById("songFolderList");
  if (!container || !state.me) return;

  try {
    const { data, error } = await db
      .from("rehearsal_music")
      .select("*")
      .eq("org_id", state.me.org_id)
      .order("created_at", { ascending: false });

    if (error) throw error;
    songList = data || [];

    if (songList.length === 0) {
      container.innerHTML = `<p class="sub text-center">No songs uploaded yet. Leadership can add songs above.</p>`;
      return;
    }

    container.replaceChildren(
      ...songList.map((song) => {
        const folder = el("div", "song-folder-card");
        folder.innerHTML = `
          <div class="folder-icon">📁</div>
          <div class="folder-info">
            <strong>${song.title}</strong>
            <span class="sub">Tap to open sheet music & audio</span>
          </div>
        `;
        folder.onclick = () => openSong(song);
        return folder;
      })
    );
  } catch (err) {
    console.error("Error loading songs:", err);
    toast("Error loading song list: " + (err.message || err));
  }
}

async function openSong(song) {
  stopMusic();
  toast(`Loading ${song.title}...`);

  try {
    const engine = getOsmd();
    if (!engine) {
      throw new Error("Sheet music engine not loaded. Check the OSMD script tag in index.html.");
    }

    const { data: xmlBlob, error: xmlErr } = await db.storage
      .from("band_music")
      .download(song.xml_file_path);
    if (xmlErr) throw new Error("Sheet music missing from storage: " + xmlErr.message);

    const { data: audioBlob, error: audioErr } = await db.storage
      .from("band_music")
      .download(song.mp3_file_path);
    if (audioErr) throw new Error("Audio missing from storage: " + audioErr.message);

    // Unhide player BEFORE rendering so #osmdCanvas has full width
    document.getElementById("activeSongTitle").textContent = song.title;
    document.getElementById("activeSongView").classList.remove("hidden");
    document.getElementById("songLibraryView").classList.add("hidden");
    await new Promise((r) => requestAnimationFrame(r));

    const isMxl = song.xml_file_path.toLowerCase().endsWith(".mxl");
    const scoreContent = await readBlobForOsmd(xmlBlob, isMxl);
    await engine.load(scoreContent);
    engine.render();

    // Build exact note-by-note timestamp map and show cursor at Measure 1 Beat 1
    buildScoreTimeline(engine);
    engine.cursor.show();

    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = URL.createObjectURL(audioBlob);
    audioEl.src = currentAudioUrl;

    toast(`${song.title} ready!`);
  } catch (err) {
    console.error("Error opening song:", err);
    toast(err.message || "Error loading song.");
  }
}

window.closeActiveSong = function () {
  stopMusic();
  document.getElementById("activeSongView").classList.add("hidden");
  document.getElementById("songLibraryView").classList.remove("hidden");
};

function togglePlay() {
  if (!getOsmd() || !audioEl?.src) return;

  if (isPlaying) {
    audioEl.pause();
  } else {
    audioEl.play().catch((err) => {
      console.error("Playback error:", err);
      toast("Audio playback blocked: " + (err.message || err));
    });
  }
}

function startSyncLoop() {
  cancelAnimationFrame(animFrameId);
  function tick() {
    if (!isPlaying || !audioEl) return;
    syncCursorToTime(audioEl.currentTime);
    animFrameId = requestAnimationFrame(tick);
  }
  animFrameId = requestAnimationFrame(tick);
}

export function stopMusic() {
  isPlaying = false;
  cancelAnimationFrame(animFrameId);
  if (audioEl) {
    audioEl.pause();
    audioEl.currentTime = 0;
  }
  const playBtn = document.getElementById("musicPlayBtn");
  if (playBtn) playBtn.textContent = "▶️";

  const engine = getOsmd();
  if (engine?.cursor) {
    engine.cursor.reset();
    currentCursorStep = 0;
  }
}