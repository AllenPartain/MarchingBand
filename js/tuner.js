// js/tuner.js
let audioCtx = null;
let analyser = null;
let micStream = null;
let rafId = null;
let isRunning = false;
let droneOsc = null;
let droneGain = null;
let isDroneOn = false;
let transpositionOffset = 0; // 0 = Concert C, 2 = Bb, 9 = Eb, 7 = F
let referenceA4 = 440;

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function buildGaugeTicks() {
  const ticksGroup = document.getElementById("tunerTicks");
  if (!ticksGroup || ticksGroup.children.length > 0) return;

  const cx = 150;
  const cy = 155;
  const rOuter = 120;
  const rLabel = 136;

  for (let cents = -50; cents <= 50; cents += 5) {
    const isMajor = cents % 10 === 0;
    const isZero = cents === 0;
    const isSweetEdge = Math.abs(cents) === 10;
    const rInner = isZero ? 96 : isMajor ? 103 : 111;

    // Map -50..+50 cents to -75..+75 degrees from top vertical
    const angleRad = ((cents / 50) * 75 - 90) * (Math.PI / 180);

    const x1 = cx + rInner * Math.cos(angleRad);
    const y1 = cy + rInner * Math.sin(angleRad);
    const x2 = cx + rOuter * Math.cos(angleRad);
    const y2 = cy + rOuter * Math.sin(angleRad);

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1.toFixed(1));
    line.setAttribute("y1", y1.toFixed(1));
    line.setAttribute("x2", x2.toFixed(1));
    line.setAttribute("y2", y2.toFixed(1));
    line.setAttribute(
      "class",
      isZero || isSweetEdge ? "tick-green" : isMajor ? "tick-major" : "tick-minor"
    );
    ticksGroup.appendChild(line);

    // Draw numbers every 10 cents (-50, -40, -30, -20, -10, 0, +10, +20, +30, +40, +50)
    if (isMajor) {
      const lx = cx + rLabel * Math.cos(angleRad);
      const ly = cy + rLabel * Math.sin(angleRad) + 4;

      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", lx.toFixed(1));
      text.setAttribute("y", ly.toFixed(1));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute(
        "class",
        Math.abs(cents) <= 10 ? "gauge-label-green" : "gauge-label"
      );
      text.textContent = cents > 0 ? `+${cents}` : `${cents}`;
      ticksGroup.appendChild(text);
    }
  }
}

function autoCorrelate(buffer, sampleRate) {
  let size = buffer.length;
  let rms = 0;
  for (let i = 0; i < size; i++) rms += buffer[i] * buffer[i];
  rms = Math.sqrt(rms / size);
  if (rms < 0.015) return -1;

  let r1 = 0;
  let r2 = size - 1;
  const threshold = 0.2;

  for (let i = 0; i < size / 2; i++) {
    if (Math.abs(buffer[i]) < threshold) {
      r1 = i;
      break;
    }
  }
  for (let i = 1; i < size / 2; i++) {
    if (Math.abs(buffer[size - i]) < threshold) {
      r2 = size - i;
      break;
    }
  }

  const trimmed = buffer.slice(r1, r2);
  size = trimmed.length;
  const c = new Array(size).fill(0);
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < size - i; j++) {
      c[i] += trimmed[j] * trimmed[j + i];
    }
  }

  let d = 0;
  while (c[d] > c[d + 1]) d++;

  let maxVal = -1;
  let maxPos = -1;
  for (let i = d; i < size; i++) {
    if (c[i] > maxVal) {
      maxVal = c[i];
      maxPos = i;
    }
  }

  let T0 = maxPos;
  const x1 = c[T0 - 1];
  const x2 = c[T0];
  const x3 = c[T0 + 1];
  const a = (x1 + x3 - 2 * x2) / 2;
  const b = (x3 - x1) / 2;
  if (a) T0 = T0 - b / (2 * a);

  return sampleRate / T0;
}

function frequencyToNoteData(freq) {
  const noteNum = 12 * (Math.log(freq / referenceA4) / Math.log(2));
  const roundedNote = Math.round(noteNum) + 69;
  const cents = Math.floor((noteNum - Math.round(noteNum)) * 100);
  const transposedIndex = (((roundedNote + transpositionOffset) % 12) + 12) % 12;
  const octave = Math.floor((roundedNote + transpositionOffset) / 12) - 1;

  return {
    note: NOTE_NAMES[transposedIndex],
    octave,
    cents,
    freq: freq.toFixed(1)
  };
}

function updateUI(data) {
  const noteEl = document.getElementById("tunerNote");
  const octaveEl = document.getElementById("tunerOctave");
  const centsEl = document.getElementById("tunerCents");
  const freqEl = document.getElementById("tunerFreq");
  const needleEl = document.getElementById("tunerNeedle");
  const statusEl = document.getElementById("tunerStatus");
  const cardEl = document.querySelector(".tuner-card");

  if (!noteEl || !needleEl || !statusEl) return;

  if (!data) {
    noteEl.textContent = "--";
    octaveEl.textContent = "";
    centsEl.textContent = "0¢";
    freqEl.textContent = isRunning ? "Listening..." : "— Hz";
    needleEl.style.transform = "translateX(-50%) rotate(0deg)";
    needleEl.className = "gauge-needle";
    statusEl.textContent = isRunning ? "Play a steady tone" : "Tap Start to Tune";
    statusEl.className = "tuner-status-bar";
    cardEl?.classList.remove("locked-in-tune");
    return;
  }

  noteEl.textContent = data.note;
  octaveEl.textContent = data.octave;
  freqEl.textContent = `${data.freq} Hz`;

  // Rotate needle from -75deg (-50 cents) to +75deg (+50 cents)
  const clamped = Math.max(-50, Math.min(50, data.cents));
  const deg = (clamped / 50) * 75;
  needleEl.style.transform = `translateX(-50%) rotate(${deg.toFixed(1)}deg)`;
  centsEl.textContent = `${data.cents > 0 ? "+" : ""}${data.cents}¢`;

  if (Math.abs(data.cents) <= 10) {
    needleEl.className = "gauge-needle in-tune";
    statusEl.textContent = "IN TUNE";
    statusEl.className = "tuner-status-bar in-tune";
    cardEl?.classList.add("locked-in-tune");
  } else if (data.cents < -10) {
    needleEl.className = "gauge-needle flat";
    statusEl.textContent = "FLAT — Push In";
    statusEl.className = "tuner-status-bar flat";
    cardEl?.classList.remove("locked-in-tune");
  } else {
    needleEl.className = "gauge-needle sharp";
    statusEl.textContent = "SHARP — Pull Out";
    statusEl.className = "tuner-status-bar sharp";
    cardEl?.classList.remove("locked-in-tune");
  }
}

function listenLoop() {
  if (!isRunning) return;
  const buffer = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buffer);

  const freq = autoCorrelate(buffer, audioCtx.sampleRate);
  updateUI(freq > 55 && freq < 2000 ? frequencyToNoteData(freq) : null);
  rafId = requestAnimationFrame(listenLoop);
}

function stopDrone() {
  if (!isDroneOn) return;
  try {
    droneOsc?.stop();
  } catch (_) {}
  droneOsc = null;
  isDroneOn = false;
  const droneBtn = document.getElementById("tunerDroneBtn");
  if (droneBtn) {
    droneBtn.textContent = "Bb Drone";
    droneBtn.classList.remove("active-drone");
  }
}

function toggleDrone() {
  if (isDroneOn) {
    stopDrone();
    return;
  }
  const ctx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (!audioCtx) audioCtx = ctx;

  // Concert Bb3 scaled to current A4 calibration (233.08 Hz at A=440)
  const bbFreq = referenceA4 * Math.pow(2, -10 / 12);
  droneOsc = ctx.createOscillator();
  droneGain = ctx.createGain();
  droneOsc.type = "triangle";
  droneOsc.frequency.setValueAtTime(bbFreq, ctx.currentTime);
  droneGain.gain.setValueAtTime(0.18, ctx.currentTime);

  droneOsc.connect(droneGain);
  droneGain.connect(ctx.destination);
  droneOsc.start();
  isDroneOn = true;

  const droneBtn = document.getElementById("tunerDroneBtn");
  if (droneBtn) {
    droneBtn.textContent = "Stop Bb";
    droneBtn.classList.add("active-drone");
  }
}

export function stopTuner() {
  stopDrone();
  if (!isRunning) return;
  isRunning = false;
  cancelAnimationFrame(rafId);
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
  micStream = null;
  audioCtx = null;
  const btn = document.getElementById("tunerToggleBtn");
  if (btn) {
    btn.textContent = "Start Tuner";
    btn.classList.remove("danger");
  }
  updateUI(null);
}

async function toggleTuner() {
  if (isRunning) {
    stopTuner();
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false
      }
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    isRunning = true;
    const btn = document.getElementById("tunerToggleBtn");
    if (btn) {
      btn.textContent = "Stop Tuner";
      btn.classList.add("danger");
    }
    listenLoop();
  } catch (err) {
    alert("Microphone permission is needed to use the tuner.");
  }
}

export function initTuner() {
  buildGaugeTicks();
  document.getElementById("tunerToggleBtn")?.addEventListener("click", toggleTuner);
  document.getElementById("tunerDroneBtn")?.addEventListener("click", toggleDrone);
  document.getElementById("tunerTranspose")?.addEventListener("change", (e) => {
    transpositionOffset = parseInt(e.target.value, 10);
  });
  document.getElementById("tunerRefA4")?.addEventListener("change", (e) => {
    referenceA4 = parseInt(e.target.value, 10);
    if (isDroneOn && droneOsc && audioCtx) {
      droneOsc.frequency.setValueAtTime(
        referenceA4 * Math.pow(2, -10 / 12),
        audioCtx.currentTime
      );
    }
  });
}