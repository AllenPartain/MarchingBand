// js/drill.js — Pyware-Class Marching Band Drill Designer & Student Yellow-Dot Studio
import { db, state, $, el, toast } from "./core.js";

/* ---------- Field Geometry Constants (8-to-5 Standard) ---------- */
const FIELD_STEPS_X = 160;   // 100 yds = 160 steps (8 steps per 5 yards)
const FIELD_STEPS_Y = 85.33; // 53.33 yds = 85.33 steps
const HASH_Y = {
  hs: { front: 28.44, back: 56.89 },   // High School (53'4" from sidelines)
  ncaa: { front: 32.0, back: 53.33 },  // NCAA College (60' from sidelines)
};

const SECTION_STYLE = {
  Woodwinds: { color: "#38bdf8", shape: "circle" },
  Brass: { color: "#fb923c", shape: "triangle" },
  Percussion: { color: "#c084fc", shape: "square" },
  "Color Guard": { color: "#f472b6", shape: "diamond" },
  Leadership: { color: "#34d399", shape: "circle" },
};

/* ---------- Studio State ---------- */
let shows = [];
let sets = [];
let bandSongs = [];
let activeShow = null;
let activeSetIdx = 0;

let activeTool = "select"; // select | line | arc | circle | block | ftl
let snapStep = 0.5;
let pressBoxView = false;  // false = Field View (Front bottom); true = Press Box (Front top)
let showHeatmap = false;

let viewZoom = 1;
let viewPanX = 0;
let viewPanY = 0;

let selectedIds = new Set();
let undoStack = [];
let redoStack = [];

// Pointer / Gesture State
let pointerMode = null; // null | move-dots | box-select | draw-form | rotate-group | scale-group | drag-curve-ctrl | pan
let dragStartWorld = null;
let dragCurrWorld = null;
let dragOriginDots = null;
let groupCenter = null;
let groupStartAngle = 0;
let groupStartDist = 1;
let ftlDraftPoints = [];

// Playback & Audio Sync State
let isAnimating = false;
let loopCurrentSetOnly = false;
let animRaf = null;
let animDots = null;
let animStartMs = 0;
let animStartCount = 0;
let totalShowCounts = 0;
let currentShowCount = 0;
let showAudioUrl = null;
let metroCtx = null;
let lastMetroBeat = -1;

const isLeader = () => state.me && (state.me.role === "director" || state.me.role === "drum_major");

/* ---------- Undo / Redo Snapshot Helpers ---------- */
function pushUndo() {
  const currentSet = sets[activeSetIdx];
  if (!currentSet) return;
  undoStack.push({
    setIdx: activeSetIdx,
    dots: structuredClone(currentSet.dots || []),
  });
  if (undoStack.length > 40) undoStack.shift();
  redoStack = [];
}

function undo() {
  if (undoStack.length === 0) return toast("Nothing to undo.");
  const snap = undoStack.pop();
  const target = sets[snap.setIdx];
  if (!target) return;
  redoStack.push({ setIdx: snap.setIdx, dots: structuredClone(target.dots || []) });
  target.dots = snap.dots;
  activeSetIdx = snap.setIdx;
  updateSetUI();
}

function redo() {
  if (redoStack.length === 0) return toast("Nothing to redo.");
  const snap = redoStack.pop();
  const target = sets[snap.setIdx];
  if (!target) return;
  undoStack.push({ setIdx: snap.setIdx, dots: structuredClone(target.dots || []) });
  target.dots = snap.dots;
  activeSetIdx = snap.setIdx;
  updateSetUI();
}

/* ---------- Coordinate & Step-Size Math ---------- */
function snapVal(val) {
  if (!snapStep || snapStep <= 0) return Math.round(val * 100) / 100;
  return Math.round(val / snapStep) * snapStep;
}

function clampField(x, y) {
  return {
    x: Math.max(0, Math.min(FIELD_STEPS_X, snapVal(x))),
    y: Math.max(0, Math.min(FIELD_STEPS_Y, snapVal(y))),
  };
}

function formatCoordinates(x, y, fieldType = "hs") {
  let lrText = "";
  if (Math.abs(x - 80) < 0.15) {
    lrText = "On 50-yd line";
  } else {
    const side = x < 80 ? "Side 1" : "Side 2";
    const nearestLineSteps = Math.round(x / 8) * 8;
    const yardLine =
      nearestLineSteps <= 80
        ? (nearestLineSteps / 8) * 5
        : ((160 - nearestLineSteps) / 8) * 5;
    const rawDiff = x - nearestLineSteps;
    const stepDiff = Math.round(Math.abs(rawDiff) * 4) / 4;

    if (stepDiff === 0) {
      lrText = `On ${side} ${yardLine}`;
    } else {
      const isInside = x < 80 ? rawDiff > 0 : rawDiff < 0;
      lrText = `${stepDiff} ${isInside ? "inside" : "outside"} ${side} ${yardLine}`;
    }
  }

  const hashes = HASH_Y[fieldType] || HASH_Y.hs;
  const refs = [
    { name: "Front Sideline", y: 0 },
    { name: "Front Hash", y: hashes.front },
    { name: "Back Hash", y: hashes.back },
    { name: "Back Sideline", y: FIELD_STEPS_Y },
  ];

  let closest = refs[0];
  let minDist = Math.abs(y - refs[0].y);
  for (const r of refs) {
    const d = Math.abs(y - r.y);
    if (d < minDist) {
      minDist = d;
      closest = r;
    }
  }

  const fbDiff = Math.round((y - closest.y) * 4) / 4;
  let fbText = "";
  if (fbDiff === 0) {
    fbText = `On ${closest.name}`;
  } else if (fbDiff < 0) {
    fbText = `${Math.abs(fbDiff)} in front of ${closest.name}`;
  } else {
    fbText = `${fbDiff} behind ${closest.name}`;
  }

  return `${lrText} · ${fbText}`;
}

function findMatchingDot(setObj, dot) {
  if (!setObj?.dots) return null;
  return (
    setObj.dots.find((d) => dot.id && d.id === dot.id) ||
    setObj.dots.find((d) => dot.user_id && d.user_id === dot.user_id) ||
    setObj.dots.find((d) => dot.label && d.label === dot.label) ||
    null
  );
}

function quadBezierPoint(p0, p1, p2, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    y: mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y,
  };
}

function polylinePoint(pts, t) {
  if (!pts || pts.length < 2) return pts?.[0] || { x: 80, y: 40 };
  const segLens = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    segLens.push(d);
    total += d;
  }
  if (total === 0) return pts[pts.length - 1];
  let target = t * total;
  for (let i = 0; i < segLens.length; i++) {
    if (target <= segLens[i] || i === segLens.length - 1) {
      const localT = segLens[i] === 0 ? 0 : target / segLens[i];
      return {
        x: pts[i].x + (pts[i + 1].x - pts[i].x) * localT,
        y: pts[i].y + (pts[i + 1].y - pts[i].y) * localT,
      };
    }
    target -= segLens[i];
  }
  return pts[pts.length - 1];
}

function computeStepMetrics(fromDot, toDot, counts) {
  if (!fromDot || !toDot || !counts || counts <= 0) {
    return { dist: 0, stride: 0, label: "Hold", severity: "hold" };
  }

  let dist = 0;
  if (toDot.pathType === "curve" && toDot.ctrlX != null && toDot.ctrlY != null) {
    let prev = fromDot;
    for (let i = 1; i <= 20; i++) {
      const pt = quadBezierPoint(fromDot, { x: toDot.ctrlX, y: toDot.ctrlY }, toDot, i / 20);
      dist += Math.hypot(pt.x - prev.x, pt.y - prev.y);
      prev = pt;
    }
  } else if (toDot.pathType === "ftl" && Array.isArray(toDot.ftlPoints) && toDot.ftlPoints.length >= 2) {
    for (let i = 0; i < toDot.ftlPoints.length - 1; i++) {
      dist += Math.hypot(
        toDot.ftlPoints[i + 1].x - toDot.ftlPoints[i].x,
        toDot.ftlPoints[i + 1].y - toDot.ftlPoints[i].y
      );
    }
  } else {
    dist = Math.hypot(toDot.x - fromDot.x, toDot.y - fromDot.y);
  }

  if (dist < 0.15) {
    return { dist: 0, stride: 0, label: `Hold (${counts} cts)`, severity: "hold" };
  }

  const stride = (8 * counts) / dist;
  let severity = "easy";
  if (stride < 6.0) severity = "hard";
  else if (stride < 8.0) severity = "moderate";

  return {
    dist,
    stride,
    label: `${stride.toFixed(1)} to 5 (${Math.round(dist * 10) / 10} steps)`,
    severity,
  };
}

/* ---------- World <-> Screen Projection (Supports Press Box Flip + Zoom/Pan) ---------- */
function getFieldBox(w, h) {
  const padX = 24;
  const padY = 22;
  return { padX, padY, fw: w - padX * 2, fh: h - padY * 2 };
}

function worldToScreen(wx, wy, w, h) {
  const { padX, padY, fw, fh } = getFieldBox(w, h);
  const nx = pressBoxView ? (FIELD_STEPS_X - wx) / FIELD_STEPS_X : wx / FIELD_STEPS_X;
  const ny = pressBoxView ? wy / FIELD_STEPS_Y : 1 - wy / FIELD_STEPS_Y;

  const baseX = padX + nx * fw;
  const baseY = padY + ny * fh;

  const cx = w / 2;
  const cy = h / 2;
  return {
    x: cx + (baseX - cx) * viewZoom + viewPanX,
    y: cy + (baseY - cy) * viewZoom + viewPanY,
  };
}

function screenToWorld(sx, sy, w, h) {
  const { padX, padY, fw, fh } = getFieldBox(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const baseX = (sx - cx - viewPanX) / viewZoom + cx;
  const baseY = (sy - cy - viewPanY) / viewZoom + cy;

  const nx = (baseX - padX) / fw;
  const ny = (baseY - padY) / fh;

  const wx = pressBoxView ? (1 - nx) * FIELD_STEPS_X : nx * FIELD_STEPS_X;
  const wy = pressBoxView ? ny * FIELD_STEPS_Y : (1 - ny) * FIELD_STEPS_Y;
  return { wx, wy };
}

/* ---------- Group Bounding Box & Handles ---------- */
function getSelectionBounds(dots) {
  const sel = dots.filter((d) => selectedIds.has(d.id));
  if (sel.length < 2) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  sel.forEach((d) => {
    if (d.x < minX) minX = d.x;
    if (d.x > maxX) maxX = d.x;
    if (d.y < minY) minY = d.y;
    if (d.y > maxY) maxY = d.y;
  });
  return {
    minX,
    maxX,
    minY,
    maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    count: sel.length,
  };
}

/* ---------- Main Field Canvas Renderer ---------- */
function renderField() {
  const canvas = document.getElementById("drillCanvas");
  if (!canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0) return;

  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;

  // 1. Stadium apron & turf background
  ctx.fillStyle = "#081711";
  ctx.fillRect(0, 0, w, h);

  const topLeft = worldToScreen(0, pressBoxView ? 0 : FIELD_STEPS_Y, w, h);
  const botRight = worldToScreen(FIELD_STEPS_X, pressBoxView ? FIELD_STEPS_Y : 0, w, h);
  const turfX = Math.min(topLeft.x, botRight.x);
  const turfY = Math.min(topLeft.y, botRight.y);
  const turfW = Math.abs(botRight.x - topLeft.x);
  const turfH = Math.abs(botRight.y - topLeft.y);

  // Alternating 5-yard mown turf stripes
  for (let i = 0; i < 20; i++) {
    const p1 = worldToScreen(i * 8, 0, w, h);
    const p2 = worldToScreen((i + 1) * 8, FIELD_STEPS_Y, w, h);
    ctx.fillStyle = i % 2 === 0 ? "#0f2e21" : "#123526";
    ctx.fillRect(Math.min(p1.x, p2.x), turfY, Math.abs(p2.x - p1.x), turfH);
  }

  // Outer field border
  ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
  ctx.lineWidth = 2;
  ctx.strokeRect(turfX, turfY, turfW, turfH);

  // 2. Grid lines (1-step when zoomed >= 1.6x, 4-step always)
  const stepInc = viewZoom >= 1.6 ? 1 : 4;
  for (let sx = stepInc; sx < FIELD_STEPS_X; sx += stepInc) {
    if (sx % 8 === 0) continue;
    const pTop = worldToScreen(sx, FIELD_STEPS_Y, w, h);
    const pBot = worldToScreen(sx, 0, w, h);
    ctx.strokeStyle = sx % 4 === 0 ? "rgba(255,255,255,0.09)" : "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pTop.x, pTop.y);
    ctx.lineTo(pBot.x, pBot.y);
    ctx.stroke();
  }

  for (let sy = stepInc; sy < FIELD_STEPS_Y; sy += stepInc) {
    const pL = worldToScreen(0, sy, w, h);
    const pR = worldToScreen(FIELD_STEPS_X, sy, w, h);
    ctx.strokeStyle = sy % 4 === 0 ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.035)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pL.x, pL.y);
    ctx.lineTo(pR.x, pR.y);
    ctx.stroke();
  }

  // 3. Yard lines every 5 yards (8 steps) + Yard numbers
  for (let sx = 0; sx <= FIELD_STEPS_X; sx += 8) {
    const p1 = worldToScreen(sx, 0, w, h);
    const p2 = worldToScreen(sx, FIELD_STEPS_Y, w, h);
    const isTen = sx % 16 === 0;
    ctx.strokeStyle = sx === 80 ? "rgba(250, 204, 21, 0.55)" : isTen ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.2)";
    ctx.lineWidth = sx === 80 ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    if (isTen && sx > 0 && sx < 160) {
      const yd = sx <= 80 ? (sx / 8) * 5 : ((160 - sx) / 8) * 5;
      const numBot = worldToScreen(sx, 11, w, h);
      const numTop = worldToScreen(sx, FIELD_STEPS_Y - 11, w, h);
      ctx.fillStyle = "rgba(255, 255, 255, 0.34)";
      ctx.font = `700 ${Math.round(12 * Math.min(1.5, viewZoom))}px 'Barlow Condensed', sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(yd), numBot.x, numBot.y);
      ctx.fillText(String(yd), numTop.x, numTop.y);
    }
  }

  // 4. Front & Back Hash Marks
  const fieldType = document.getElementById("drillHashSelect")?.value || "hs";
  const hashes = HASH_Y[fieldType] || HASH_Y.hs;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.65)";
  ctx.lineWidth = 1.5;
  for (let sx = 0; sx <= FIELD_STEPS_X; sx += 8) {
    [hashes.front, hashes.back].forEach((hy) => {
      const pt = worldToScreen(sx, hy, w, h);
      ctx.beginPath();
      ctx.moveTo(pt.x - 4 * viewZoom, pt.y);
      ctx.lineTo(pt.x + 4 * viewZoom, pt.y);
      ctx.stroke();
    });
  }

  // 5. Transition Pathways (Previous Set -> Current Set, plus Next Set Preview)
  const currSet = sets[activeSetIdx];
  const prevSet = sets[activeSetIdx - 1];
  const nextSet = sets[activeSetIdx + 1];
  const dots = animDots || currSet?.dots || [];

  if (!isAnimating && currSet) {
    dots.forEach((dot) => {
      const isMe = state.me && dot.user_id === state.me.id;
      const isSel = selectedIds.has(dot.id);

      // Incoming path from previous set (shows Curved Bézier / FTL / Linear path)
      if (prevSet && (isMe || isSel || dot.pathType === "curve" || dot.pathType === "ftl")) {
        const prevDot = findMatchingDot(prevSet, dot);
        if (prevDot) {
          const p0 = worldToScreen(prevDot.x, prevDot.y, w, h);
          const p2 = worldToScreen(dot.x, dot.y, w, h);
          ctx.save();
          ctx.strokeStyle = isMe
            ? "rgba(250, 204, 21, 0.6)"
            : isSel
            ? "rgba(56, 189, 248, 0.65)"
            : "rgba(255, 255, 255, 0.22)";
          ctx.lineWidth = isMe || isSel ? 1.75 : 1;

          if (dot.pathType === "curve" && dot.ctrlX != null && dot.ctrlY != null) {
            const pc = worldToScreen(dot.ctrlX, dot.ctrlY, w, h);
            ctx.beginPath();
            ctx.moveTo(p0.x, p0.y);
            ctx.quadraticCurveTo(pc.x, pc.y, p2.x, p2.y);
            ctx.stroke();

            // Draw draggable Curve Control Handle for leaders when selected
            if (isSel && isLeader()) {
              ctx.fillStyle = "#38bdf8";
              ctx.beginPath();
              ctx.arc(pc.x, pc.y, 5, 0, Math.PI * 2);
              ctx.fill();
            }
          } else if (dot.pathType === "ftl" && Array.isArray(dot.ftlPoints) && dot.ftlPoints.length >= 2) {
            ctx.beginPath();
            dot.ftlPoints.forEach((fp, idx) => {
              const sp = worldToScreen(fp.x, fp.y, w, h);
              if (idx === 0) ctx.moveTo(sp.x, sp.y);
              else ctx.lineTo(sp.x, sp.y);
            });
            ctx.stroke();
          } else if (isMe || isSel) {
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(p0.x, p0.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
          }
          ctx.restore();
        }
      }

      // Outgoing dashed preview to next set for user's dot or single selected dot
      if (nextSet && (isMe || (isSel && selectedIds.size === 1))) {
        const nextDot = findMatchingDot(nextSet, dot);
        if (nextDot) {
          const p1 = worldToScreen(dot.x, dot.y, w, h);
          const p2 = worldToScreen(nextDot.x, nextDot.y, w, h);
          ctx.save();
          ctx.setLineDash([3, 4]);
          ctx.strokeStyle = isMe ? "rgba(250, 204, 21, 0.4)" : "rgba(56, 189, 248, 0.4)";
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
          ctx.restore();
        }
      }
    });
  }

  // 6. Render Marcher Dots (Section Shapes, Heatmap, & Glowing Student Yellow Dot)
  dots.forEach((dot) => {
    const pt = worldToScreen(dot.x, dot.y, w, h);
    const isMe = state.me && dot.user_id === state.me.id;
    const isSel = selectedIds.has(dot.id);
    const secStyle = SECTION_STYLE[dot.section] || { color: "#e2e8f0", shape: "circle" };

    let fillColor = secStyle.color;
    if (showHeatmap && prevSet) {
      const prevDot = findMatchingDot(prevSet, dot);
      const metrics = computeStepMetrics(prevDot, dot, currSet?.counts || 16);
      fillColor =
        metrics.severity === "hard"
          ? "#ef4444"
          : metrics.severity === "moderate"
          ? "#f59e0b"
          : metrics.severity === "easy"
          ? "#22c55e"
          : "#64748b";
    }
    if (isMe) fillColor = "#facc15";

    // Radar halo for logged-in student or selected dots
    if (isMe || isSel) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, isMe ? 12 : 10, 0, Math.PI * 2);
      ctx.fillStyle = isMe ? "rgba(250, 204, 21, 0.28)" : "rgba(56, 189, 248, 0.28)";
      ctx.fill();
    }

    const r = isMe ? 6.5 : 5;
    ctx.fillStyle = fillColor;
    ctx.strokeStyle = isSel ? "#38bdf8" : "#090d16";
    ctx.lineWidth = isSel ? 2 : 1.5;

    ctx.beginPath();
    if (secStyle.shape === "triangle" && !isMe) {
      ctx.moveTo(pt.x, pt.y - r - 1);
      ctx.lineTo(pt.x + r + 1, pt.y + r);
      ctx.lineTo(pt.x - r - 1, pt.y + r);
      ctx.closePath();
    } else if (secStyle.shape === "square" && !isMe) {
      ctx.rect(pt.x - r, pt.y - r, r * 2, r * 2);
    } else if (secStyle.shape === "diamond" && !isMe) {
      ctx.moveTo(pt.x, pt.y - r - 1.5);
      ctx.lineTo(pt.x + r + 1.5, pt.y);
      ctx.lineTo(pt.x, pt.y + r + 1.5);
      ctx.lineTo(pt.x - r - 1.5, pt.y);
      ctx.closePath();
    } else {
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();

    if (dot.label) {
      ctx.fillStyle = isMe ? "#facc15" : isSel ? "#7dd3fc" : "rgba(255, 255, 255, 0.88)";
      ctx.font = isMe ? "700 10.5px Inter, sans-serif" : "600 9px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(dot.label, pt.x, pt.y - r - 4);
    }
  });

  // 7. Group Transform Bounding Box + Rotate & Scale Handles (Select Tool)
  if (!isAnimating && isLeader() && activeTool === "select") {
    const bounds = getSelectionBounds(dots);
    if (bounds) {
      const p1 = worldToScreen(bounds.minX, bounds.maxY, w, h);
      const p2 = worldToScreen(bounds.maxX, bounds.minY, w, h);
      const bx = Math.min(p1.x, p2.x) - 10;
      const by = Math.min(p1.y, p2.y) - 10;
      const bw = Math.abs(p2.x - p1.x) + 20;
      const bh = Math.abs(p2.y - p1.y) + 20;

      ctx.save();
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(bx, by, bw, bh);
      ctx.setLineDash([]);

      // Rotate Handle above top-center
      const rotX = bx + bw / 2;
      const rotY = by - 20;
      ctx.beginPath();
      ctx.moveTo(rotX, by);
      ctx.lineTo(rotX, rotY);
      ctx.stroke();
      ctx.fillStyle = "#38bdf8";
      ctx.beginPath();
      ctx.arc(rotX, rotY, 6, 0, Math.PI * 2);
      ctx.fill();

      // Scale Handle at bottom-right corner
      ctx.fillStyle = "#facc15";
      ctx.fillRect(bx + bw - 5, by + bh - 5, 10, 10);
      ctx.restore();
    }
  }

  // 8. Marquee Selection Box or Live Form Ghost Preview
  if (pointerMode === "box-select" && dragStartWorld && dragCurrWorld) {
    const a = worldToScreen(dragStartWorld.wx, dragStartWorld.wy, w, h);
    const b = worldToScreen(dragCurrWorld.wx, dragCurrWorld.wy, w, h);
    ctx.save();
    ctx.fillStyle = "rgba(56, 189, 248, 0.14)";
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 1.5;
    ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    ctx.restore();
  }

  if (pointerMode === "draw-form" && dragStartWorld && dragCurrWorld) {
    const previewPts = computeFormPoints(
      activeTool,
      dragStartWorld,
      dragCurrWorld,
      selectedIds.size >= 2
        ? selectedIds.size
        : parseInt(document.getElementById("drillNewCountInput")?.value, 10) || 8,
      ftlDraftPoints
    );
    ctx.save();
    ctx.strokeStyle = "#facc15";
    ctx.fillStyle = "#facc15";
    ctx.lineWidth = 1.5;
    previewPts.forEach((p, i) => {
      const sp = worldToScreen(p.x, p.y, w, h);
      if (i > 0) {
        const prevSp = worldToScreen(previewPts[i - 1].x, previewPts[i - 1].y, w, h);
        ctx.beginPath();
        ctx.moveTo(prevSp.x, prevSp.y);
        ctx.lineTo(sp.x, sp.y);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }
}

/* ---------- Pyware Form Geometry Generators ---------- */
function computeFormPoints(tool, startW, endW, count, ftlPts = []) {
  const n = Math.max(2, count);
  const pts = [];

  if (tool === "line") {
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      pts.push(clampField(startW.wx + (endW.wx - startW.wx) * t, startW.wy + (endW.wy - startW.wy) * t));
    }
  } else if (tool === "arc") {
    const midX = (startW.wx + endW.wx) / 2;
    const midY = (startW.wy + endW.wy) / 2;
    const dx = endW.wx - startW.wx;
    const dy = endW.wy - startW.wy;
    // Perpendicular bulge proportional to 35% of chord length
    const ctrl = { x: midX - dy * 0.35, y: midY + dx * 0.35 };
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const p = quadBezierPoint({ x: startW.wx, y: startW.wy }, ctrl, { x: endW.wx, y: endW.wy }, t);
      pts.push(clampField(p.x, p.y));
    }
  } else if (tool === "circle") {
    const r = Math.hypot(endW.wx - startW.wx, endW.wy - startW.wy);
    const startAng = Math.atan2(endW.wy - startW.wy, endW.wx - startW.wx);
    for (let i = 0; i < n; i++) {
      const ang = startAng + (i / n) * Math.PI * 2;
      pts.push(clampField(startW.wx + r * Math.cos(ang), startW.wy + r * Math.sin(ang)));
    }
  } else if (tool === "block") {
    const cols = Math.max(2, Math.round(Math.sqrt(n * 1.5)));
    const rows = Math.ceil(n / cols);
    for (let i = 0; i < n; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const tx = cols > 1 ? c / (cols - 1) : 0;
      const ty = rows > 1 ? r / (rows - 1) : 0;
      pts.push(clampField(startW.wx + (endW.wx - startW.wx) * tx, startW.wy + (endW.wy - startW.wy) * ty));
    }
  } else if (tool === "ftl" && ftlPts.length >= 2) {
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const p = polylinePoint(ftlPts, t);
      pts.push(clampField(p.x, p.y));
    }
  }
  return pts;
}

/* ---------- Timeline & Count Calculations ---------- */
function recalcShowCounts() {
  let acc = 0;
  sets.forEach((s, idx) => {
    s._startCount = idx === 0 ? 0 : acc;
    if (idx > 0) acc += Number(s.counts) || 16;
    s._endCount = acc;
  });
  totalShowCounts = Math.max(1, acc);

  const scrubber = document.getElementById("drillScrubber");
  if (scrubber) {
    scrubber.max = String(totalShowCounts);
    scrubber.value = String(Math.min(currentShowCount, totalShowCounts));
  }
}

function scrubToCount(targetCount) {
  currentShowCount = Math.max(0, Math.min(totalShowCounts, targetCount));
  const scrubber = document.getElementById("drillScrubber");
  if (scrubber) scrubber.value = String(currentShowCount);

  if (sets.length === 0) return;
  if (sets.length === 1 || currentShowCount <= 0) {
    activeSetIdx = 0;
    animDots = null;
    updateCountBadge();
    renderField();
    return;
  }

  // Locate segment where targetCount falls
  let segIdx = 1;
  for (let i = 1; i < sets.length; i++) {
    if (currentShowCount <= sets[i]._endCount) {
      segIdx = i;
      break;
    }
    segIdx = i;
  }

  const fromSet = sets[segIdx - 1];
  const toSet = sets[segIdx];
  const segDuration = Math.max(1, toSet._endCount - toSet._startCount);
  const t = Math.max(0, Math.min(1, (currentShowCount - toSet._startCount) / segDuration));

  activeSetIdx = segIdx;
  animDots = (toSet.dots || []).map((d2) => {
    const d1 = findMatchingDot(fromSet, d2) || d2;
    if (d2.pathType === "curve" && d2.ctrlX != null && d2.ctrlY != null) {
      const pt = quadBezierPoint(d1, { x: d2.ctrlX, y: d2.ctrlY }, d2, t);
      return { ...d2, x: pt.x, y: pt.y };
    }
    if (d2.pathType === "ftl" && Array.isArray(d2.ftlPoints) && d2.ftlPoints.length >= 2) {
      const pt = polylinePoint(d2.ftlPoints, t);
      return { ...d2, x: pt.x, y: pt.y };
    }
    return {
      ...d2,
      x: d1.x + (d2.x - d1.x) * t,
      y: d1.y + (d2.y - d1.y) * t,
    };
  });

  updateCountBadge();
  renderField();
}

function updateCountBadge() {
  const elCount = document.getElementById("drillCountDisplay");
  const currSet = sets[activeSetIdx];
  if (!elCount) return;
  if (!currSet) {
    elCount.textContent = "No sets";
    return;
  }
  const localCt = Math.max(0, Math.round((currentShowCount - (currSet._startCount || 0)) * 10) / 10);
  elCount.textContent = `${currSet.label} · Ct ${localCt} / ${currSet.counts} (Total ${Math.round(currentShowCount)}/${totalShowCounts})`;
}

/* ---------- UI & Inspector Updates ---------- */
function updateSetUI() {
  recalcShowCounts();
  const strip = document.getElementById("drillSetStrip");
  if (strip) {
    strip.replaceChildren(
      ...sets.map((s, idx) => {
        const btn = el("button", "chip" + (idx === activeSetIdx ? " active" : ""), `${s.label} (${s.counts})`);
        btn.type = "button";
        btn.onclick = () => {
          stopDrill();
          activeSetIdx = idx;
          currentShowCount = s._endCount || 0;
          animDots = null;
          updateSetUI();
        };
        return btn;
      })
    );
  }

  const currSet = sets[activeSetIdx];
  const labelInput = document.getElementById("drillSetLabelInput");
  const countsInput = document.getElementById("drillSetCounts");
  const notesInput = document.getElementById("drillSetNotes");
  if (labelInput && currSet) labelInput.value = currSet.label;
  if (countsInput && currSet) countsInput.value = currSet.counts;
  if (notesInput && currSet) notesInput.value = currSet.notes || "";

  updateCountBadge();
  updateCoordCard();
  renderField();
}

function updateCoordCard() {
  const currSet = sets[activeSetIdx];
  const prevSet = sets[activeSetIdx - 1];
  const dots = currSet?.dots || [];
  const fieldType = document.getElementById("drillHashSelect")?.value || "hs";

  // Pick single selected dot, or default to logged-in student's yellow dot
  let targetDot = null;
  if (selectedIds.size >= 1) {
    const firstId = Array.from(selectedIds)[0];
    targetDot = dots.find((d) => d.id === firstId) || null;
  }
  if (!targetDot && state.me) {
    targetDot = dots.find((d) => d.user_id === state.me.id) || null;
  }

  const ownerLabel = document.getElementById("drillDotOwnerLabel");
  const nameEl = document.getElementById("drillDotName");
  const coordEl = document.getElementById("drillCoordText");
  const stepEl = document.getElementById("drillStepSizeText");
  const selCountEl = document.getElementById("drillSelectionCountText");
  const noteEl = document.getElementById("drillSetNoteDisplay");
  const assignControls = document.getElementById("drillDotAssignControls");

  if (noteEl) noteEl.textContent = currSet?.notes ? `Note: ${currSet.notes}` : "";
  if (selCountEl) {
    selCountEl.textContent = selectedIds.size > 1 ? `${selectedIds.size} marchers selected` : "";
  }

  if (!targetDot) {
    if (ownerLabel) ownerLabel.textContent = "COORDINATES";
    if (nameEl) nameEl.textContent = "No dot selected";
    if (coordEl) {
      coordEl.textContent = isLeader()
        ? "Select a drawing tool (Line, Arc, Circle, Block) or click 'Place Roster' to build your form."
        : "Your dot has not been placed in this set yet.";
    }
    if (stepEl) stepEl.textContent = "Step Size: —";
    assignControls?.classList.add("hidden");
    return;
  }

  const member = targetDot.user_id ? state.byId.get(targetDot.user_id) : null;
  const isMe = state.me && targetDot.user_id === state.me.id;

  if (ownerLabel) {
    ownerLabel.textContent = isMe
      ? "YOUR YELLOW DOT"
      : `${(targetDot.section || "MARCHER").toUpperCase()} · DOT ${targetDot.label || ""}`;
  }
  if (nameEl) {
    nameEl.textContent = member
      ? `${member.full_name} (${targetDot.label || "—"})`
      : `Unassigned Dot (${targetDot.label || "—"})`;
  }
  if (coordEl) {
    coordEl.textContent = formatCoordinates(targetDot.x, targetDot.y, fieldType);
  }

  const prevDot = prevSet ? findMatchingDot(prevSet, targetDot) : null;
  const metrics = computeStepMetrics(prevDot, targetDot, currSet?.counts || 16);
  if (stepEl) {
    stepEl.textContent = `Step Size: ${metrics.label}`;
  }

  if (assignControls && isLeader()) {
    assignControls.classList.remove("hidden");
    const lblIn = document.getElementById("drillDotLabelInput");
    const secSel = document.getElementById("drillDotSectionSelect");
    const usrSel = document.getElementById("drillAssignSelect");
    if (lblIn) lblIn.value = targetDot.label || "";
    if (secSel) secSel.value = targetDot.section || "Woodwinds";
    if (usrSel) usrSel.value = targetDot.user_id || "";
  }
}

/* ---------- Playback Engine (Synced Show Audio OR Metronome) ---------- */
function playMetronomeClick(isAccent) {
  try {
    if (!metroCtx) metroCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (metroCtx.state === "suspended") metroCtx.resume();
    const osc = metroCtx.createOscillator();
    const gain = metroCtx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(isAccent ? 1100 : 820, metroCtx.currentTime);
    gain.gain.setValueAtTime(0.18, metroCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, metroCtx.currentTime + 0.06);
    osc.connect(gain);
    gain.connect(metroCtx.destination);
    osc.start();
    osc.stop(metroCtx.currentTime + 0.06);
  } catch (_) {}
}

function togglePlayback(loopSingle = false) {
  if (isAnimating) {
    stopDrill();
    return;
  }
  if (sets.length < 2) return toast("Create at least 2 sets to animate drill.");

  loopCurrentSetOnly = loopSingle;
  isAnimating = true;
  lastMetroBeat = -1;

  const playBtn = document.getElementById("drillPlayBtn");
  if (playBtn) playBtn.textContent = "⏹ Stop";

  const bpm = parseInt(document.getElementById("drillBpmInput")?.value, 10) || activeShow?.bpm || 144;
  const audioEl = document.getElementById("drillShowAudio");
  const useShowAudio = Boolean(audioEl?.src && !loopSingle);

  if (loopSingle) {
    const targetIdx = Math.max(1, activeSetIdx);
    animStartCount = sets[targetIdx - 1]._endCount || 0;
  } else {
    animStartCount = currentShowCount >= totalShowCounts ? 0 : currentShowCount;
  }

  if (useShowAudio) {
    audioEl.currentTime = (animStartCount / bpm) * 60;
    audioEl.play().catch(() => {});
  }

  animStartMs = performance.now();

  function frame(now) {
    if (!isAnimating) return;

    const elapsedSec = useShowAudio && !audioEl.paused
      ? audioEl.currentTime - (animStartCount / bpm) * 60
      : (now - animStartMs) / 1000;

    let nextCount = animStartCount + (elapsedSec * bpm) / 60;

    if (!useShowAudio) {
      const beatInt = Math.floor(nextCount);
      if (beatInt !== lastMetroBeat && beatInt >= 0) {
        lastMetroBeat = beatInt;
        playMetronomeClick(beatInt % 4 === 0);
      }
    }

    if (loopCurrentSetOnly) {
      const targetIdx = Math.max(1, activeSetIdx);
      const startCt = sets[targetIdx - 1]._endCount || 0;
      const endCt = sets[targetIdx]._endCount || totalShowCounts;
      if (nextCount >= endCt) {
        animStartMs = now;
        nextCount = startCt;
      }
      scrubToCount(nextCount);
    } else if (nextCount >= totalShowCounts) {
      scrubToCount(totalShowCounts);
      stopDrill();
      return;
    } else {
      scrubToCount(nextCount);
    }

    animRaf = requestAnimationFrame(frame);
  }

  animRaf = requestAnimationFrame(frame);
}

export function stopDrill() {
  isAnimating = false;
  loopCurrentSetOnly = false;
  animDots = null;
  cancelAnimationFrame(animRaf);
  const audioEl = document.getElementById("drillShowAudio");
  if (audioEl) audioEl.pause();
  const playBtn = document.getElementById("drillPlayBtn");
  if (playBtn) playBtn.textContent = "▶ Play Show";
  renderField();
}

/* ---------- Printable Pyware Dot Book Modal ---------- */
function openDotBookModal() {
  if (!activeShow || sets.length === 0) return toast("Load a show first.");
  const fieldType = document.getElementById("drillHashSelect")?.value || "hs";
  const currDots = sets[activeSetIdx]?.dots || [];

  let focusDot = null;
  if (selectedIds.size >= 1) {
    const id = Array.from(selectedIds)[0];
    focusDot = currDots.find((d) => d.id === id);
  }
  if (!focusDot && state.me) {
    focusDot = currDots.find((d) => d.user_id === state.me.id);
  }
  if (!focusDot && currDots.length > 0) focusDot = currDots[0];
  if (!focusDot) return toast("No dots in this show yet.");

  const member = focusDot.user_id ? state.byId.get(focusDot.user_id) : null;
  const titleText = `${activeShow.title} — ${member ? member.full_name : focusDot.label}`;

  const rowsHtml = sets
    .map((s, idx) => {
      const d = findMatchingDot(s, focusDot);
      if (!d) {
        return `<tr><td>${s.label}</td><td>${s.counts}</td><td colspan="3">Not in set</td><td>${s.notes || ""}</td></tr>`;
      }
      const prevD = idx > 0 ? findMatchingDot(sets[idx - 1], focusDot) : null;
      const m = computeStepMetrics(prevD, d, s.counts);
      const coordParts = formatCoordinates(d.x, d.y, fieldType).split(" · ");
      return `
        <tr>
          <td><strong>${s.label}</strong></td>
          <td>${idx === 0 ? "0" : s.counts}</td>
          <td>${coordParts[0] || ""}</td>
          <td>${coordParts[1] || ""}</td>
          <td>${m.label}</td>
          <td>${s.notes || ""}</td>
        </tr>
      `;
    })
    .join("");

  $("modalTitle").textContent = "Coordinate Sheet (Dot Book)";
  $("modalBody").innerHTML = `
    <div class="dotbook-sheet">
      <div class="row" style="margin-bottom:0.75rem;">
        <div>
          <strong>${titleText}</strong>
          <div class="sub">${fieldType === "ncaa" ? "NCAA College Hashes" : "High School Hashes"} · ${sets.length} Sets</div>
        </div>
        <button type="button" class="btn sm" onclick="window.print()">Print / PDF</button>
      </div>
      <div style="overflow-x:auto;">
        <table class="dotbook-table">
          <thead>
            <tr>
              <th>Set</th>
              <th>Cts</th>
              <th>Side-to-Side</th>
              <th>Front-to-Back</th>
              <th>Step Size</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </div>
  `;
  $("modal").classList.remove("hidden");
}

/* ---------- Supabase Load & Save ---------- */
export async function loadDrill() {
  if (!state.me) return;
  const showSelect = document.getElementById("drillShowSelect");
  if (!showSelect) return;

  // Load Practice Library songs so director can attach show music
  const { data: songs } = await db
    .from("rehearsal_music")
    .select("id, title, mp3_file_path")
    .eq("org_id", state.me.org_id)
    .order("created_at", { ascending: false });
  bandSongs = songs || [];

  const musicSel = document.getElementById("drillMusicSelect");
  if (musicSel) {
    musicSel.replaceChildren(
      el("option", "", "Metronome Click Only"),
      ...bandSongs.map((m) => {
        const o = el("option", "", `♪ ${m.title}`);
        o.value = m.id;
        return o;
      })
    );
    musicSel.firstChild.value = "";
  }

  const { data, error } = await db
    .from("drill_shows")
    .select("*")
    .eq("org_id", state.me.org_id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Drill load error:", error);
    return;
  }

  shows = data || [];
  if (shows.length === 0) {
    showSelect.innerHTML = `<option value="">No shows created yet</option>`;
    sets = [];
    updateSetUI();
    return;
  }

  const prevSelectedId = activeShow?.id;
  showSelect.replaceChildren(
    ...shows.map((s) => {
      const opt = el("option", "", s.title);
      opt.value = s.id;
      return opt;
    })
  );

  const targetId = shows.some((s) => s.id === prevSelectedId) ? prevSelectedId : shows[0].id;
  showSelect.value = targetId;
  await selectShow(targetId);
}

async function attachShowAudio(musicId) {
  const audioEl = document.getElementById("drillShowAudio");
  if (!audioEl) return;
  if (showAudioUrl) {
    URL.revokeObjectURL(showAudioUrl);
    showAudioUrl = null;
  }
  audioEl.removeAttribute("src");
  if (!musicId) return;

  const song = bandSongs.find((s) => s.id === musicId);
  if (!song?.mp3_file_path) return;

  const { data: blob } = await db.storage.from("band_music").download(song.mp3_file_path);
  if (blob) {
    showAudioUrl = URL.createObjectURL(blob);
    audioEl.src = showAudioUrl;
  }
}

async function selectShow(showId) {
  activeShow = shows.find((s) => s.id === showId) || null;
  if (!activeShow) return;

  const hashSel = document.getElementById("drillHashSelect");
  const bpmIn = document.getElementById("drillBpmInput");
  const musicSel = document.getElementById("drillMusicSelect");
  if (hashSel) hashSel.value = activeShow.field_type || "hs";
  if (bpmIn) bpmIn.value = activeShow.bpm || 144;
  if (musicSel) musicSel.value = activeShow.music_id || "";

  await attachShowAudio(activeShow.music_id || "");

  const { data, error } = await db
    .from("drill_sets")
    .select("*")
    .eq("show_id", activeShow.id)
    .order("set_order", { ascending: true });

  if (error) return toast("Could not load drill sets.");

  sets = (data || []).map((s) => ({
    ...s,
    dots: (s.dots || []).map((d, i) => ({
      id: d.id || d.user_id || `${d.label || "dot"}_${i}`,
      section: d.section || "Woodwinds",
      pathType: d.pathType || "linear",
      ...d,
    })),
  }));

  activeSetIdx = 0;
  currentShowCount = 0;
  selectedIds.clear();
  undoStack = [];
  redoStack = [];
  updateSetUI();
}

function populateRosterDropdown() {
  const sel = document.getElementById("drillAssignSelect");
  if (!sel) return;
  const members = Array.from(state.byId.values()).sort((a, b) =>
    a.full_name.localeCompare(b.full_name)
  );
  sel.replaceChildren(
    el("option", "", "Unassigned dot"),
    ...members.map((m) => {
      const o = el("option", "", `${m.full_name} (${m.section || m.role})`);
      o.value = m.id;
      return o;
    })
  );
  sel.firstChild.value = "";
}

/* ---------- Studio Initialization & Interactive Canvas ---------- */
export function initDrill() {
  const leader = isLeader();
  document.getElementById("newShowBtn")?.classList.toggle("hidden", !leader);
  document.getElementById("drillLeaderPalette")?.classList.toggle("hidden", !leader);
  document.getElementById("drillSetCrudBtns")?.classList.toggle("hidden", !leader);
  document.getElementById("drillLeaderSetMeta")?.classList.toggle("hidden", !leader);

  // Tool selection buttons
  document.querySelectorAll(".tool-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTool = btn.dataset.tool;
      document.querySelectorAll(".tool-btn").forEach((b) => b.classList.toggle("active", b === btn));
    });
  });

  // Perspective (Press Box vs Field View)
  document.getElementById("drillPerspectiveBtn")?.addEventListener("click", (e) => {
    pressBoxView = !pressBoxView;
    e.target.textContent = pressBoxView ? "Press Box View" : "Field View";
    document.getElementById("drillTopEdgeLabel").textContent = pressBoxView
      ? "FRONT SIDELINE (PRESS BOX)"
      : "BACK SIDELINE (VISITOR)";
    document.getElementById("drillBottomEdgeLabel").textContent = pressBoxView
      ? "BACK SIDELINE (VISITOR)"
      : "FRONT SIDELINE (HOME)";
    document.getElementById("drillLeftEdgeLabel").textContent = pressBoxView ? "SIDE 2 (RIGHT)" : "SIDE 1 (LEFT)";
    document.getElementById("drillRightEdgeLabel").textContent = pressBoxView ? "SIDE 1 (LEFT)" : "SIDE 2 (RIGHT)";
    renderField();
  });

  // Step-Size Heatmap toggle
  document.getElementById("drillHeatmapBtn")?.addEventListener("click", (e) => {
    showHeatmap = !showHeatmap;
    e.target.classList.toggle("active", showHeatmap);
    renderField();
  });

  // Zoom controls
  document.getElementById("drillZoomInBtn")?.addEventListener("click", () => {
    viewZoom = Math.min(3, Math.round((viewZoom + 0.25) * 100) / 100);
    document.getElementById("drillZoomResetBtn").textContent = `${Math.round(viewZoom * 100)}%`;
    renderField();
  });
  document.getElementById("drillZoomOutBtn")?.addEventListener("click", () => {
    viewZoom = Math.max(1, Math.round((viewZoom - 0.25) * 100) / 100);
    if (viewZoom === 1) { viewPanX = 0; viewPanY = 0; }
    document.getElementById("drillZoomResetBtn").textContent = `${Math.round(viewZoom * 100)}%`;
    renderField();
  });
  document.getElementById("drillZoomResetBtn")?.addEventListener("click", () => {
    viewZoom = 1;
    viewPanX = 0;
    viewPanY = 0;
    document.getElementById("drillZoomResetBtn").textContent = "100%";
    renderField();
  });

  // Snap & Section quick-select
  document.getElementById("drillSnapSelect")?.addEventListener("change", (e) => {
    snapStep = parseFloat(e.target.value);
  });
  document.getElementById("drillSectionFilter")?.addEventListener("change", (e) => {
    const sec = e.target.value;
    if (!sec) return;
    const currDots = sets[activeSetIdx]?.dots || [];
    selectedIds = new Set(currDots.filter((d) => d.section === sec).map((d) => d.id));
    e.target.value = "";
    updateCoordCard();
    renderField();
  });

  // Undo / Redo / Curved Path / Mirror / Delete
  document.getElementById("drillUndoBtn")?.addEventListener("click", undo);
  document.getElementById("drillRedoBtn")?.addEventListener("click", redo);

  document.getElementById("drillCurvePathBtn")?.addEventListener("click", () => {
    const currSet = sets[activeSetIdx];
    const prevSet = sets[activeSetIdx - 1];
    if (!currSet || !prevSet) return toast("Curved paths apply to Set 2 and onward.");
    pushUndo();
    (currSet.dots || []).forEach((d) => {
      if (selectedIds.size === 0 || selectedIds.has(d.id)) {
        const p0 = findMatchingDot(prevSet, d) || d;
        const midX = (p0.x + d.x) / 2;
        const midY = (p0.y + d.y) / 2;
        const dx = d.x - p0.x;
        const dy = d.y - p0.y;
        d.pathType = "curve";
        d.ctrlX = snapVal(midX - dy * 0.3);
        d.ctrlY = snapVal(midY + dx * 0.3);
      }
    });
    updateCoordCard();
    renderField();
    toast("Curved pathway enabled — drag the blue midpoint handle to shape the arc.");
  });

  document.getElementById("drillLinearPathBtn")?.addEventListener("click", () => {
    const currSet = sets[activeSetIdx];
    if (!currSet) return;
    pushUndo();
    (currSet.dots || []).forEach((d) => {
      if (selectedIds.size === 0 || selectedIds.has(d.id)) {
        d.pathType = "linear";
        d.ctrlX = null;
        d.ctrlY = null;
        d.ftlPoints = null;
      }
    });
    updateCoordCard();
    renderField();
  });

  document.getElementById("drillMirrorHBtn")?.addEventListener("click", () => {
    const currSet = sets[activeSetIdx];
    if (!currSet) return;
    pushUndo();
    (currSet.dots || []).forEach((d) => {
      if (selectedIds.size === 0 || selectedIds.has(d.id)) {
        d.x = snapVal(160 - d.x);
      }
    });
    updateCoordCard();
    renderField();
  });

  document.getElementById("drillDeleteDotsBtn")?.addEventListener("click", () => {
    const currSet = sets[activeSetIdx];
    if (!currSet || selectedIds.size === 0) return;
    pushUndo();
    currSet.dots = currSet.dots.filter((d) => !selectedIds.has(d.id));
    selectedIds.clear();
    updateCoordCard();
    renderField();
  });

  // Create New Show
  document.getElementById("newShowBtn")?.addEventListener("click", async () => {
    const title = prompt("Show / Movement title (e.g., 2026 Show - Opener):");
    if (!title?.trim()) return;

    const { data: show, error } = await db
      .from("drill_shows")
      .insert({
        org_id: state.me.org_id,
        title: title.trim(),
        field_type: document.getElementById("drillHashSelect")?.value || "hs",
        bpm: parseInt(document.getElementById("drillBpmInput")?.value, 10) || 144,
        created_by: state.me.id,
      })
      .select()
      .single();

    if (error) return toast(error.message);

    await db.from("drill_sets").insert({
      show_id: show.id,
      set_order: 1,
      label: "Set 1",
      counts: 0,
      dots: [],
    });

    toast("Show created!");
    await loadDrill();
  });

  // Add Next Set (copies current set dots so director only shapes movers)
  document.getElementById("drillAddSetBtn")?.addEventListener("click", async () => {
    if (!activeShow) return toast("Create a show first.");
    const prevDots = (sets[activeSetIdx]?.dots || []).map((d) => ({
      ...structuredClone(d),
      pathType: "linear",
      ctrlX: null,
      ctrlY: null,
      ftlPoints: null,
    }));
    const nextOrder = sets.length + 1;

    const { error } = await db.from("drill_sets").insert({
      show_id: activeShow.id,
      set_order: nextOrder,
      label: `Set ${nextOrder}`,
      counts: 16,
      dots: prevDots,
    });
    if (error) return toast(error.message);

    await selectShow(activeShow.id);
    activeSetIdx = sets.length - 1;
    updateSetUI();
    toast(`Set ${nextOrder} created!`);
  });

  // Insert Set right after current set
  document.getElementById("drillInsertSetBtn")?.addEventListener("click", async () => {
    if (!activeShow || sets.length === 0) return;
    const insertOrder = activeSetIdx + 2;
    const copiedDots = (sets[activeSetIdx]?.dots || []).map((d) => ({
      ...structuredClone(d),
      pathType: "linear",
      ctrlX: null,
      ctrlY: null,
      ftlPoints: null,
    }));

    // Shift subsequent set_orders up
    for (let i = sets.length - 1; i > activeSetIdx; i--) {
      await db.from("drill_sets").update({ set_order: i + 2 }).eq("id", sets[i].id);
    }

    const { error } = await db.from("drill_sets").insert({
      show_id: activeShow.id,
      set_order: insertOrder,
      label: `Set ${activeSetIdx + 1}A`,
      counts: 8,
      dots: copiedDots,
    });
    if (error) return toast(error.message);

    await selectShow(activeShow.id);
    activeSetIdx = insertOrder - 1;
    updateSetUI();
    toast("Inserted intermediate set!");
  });

  // Delete Current Set
  document.getElementById("drillDeleteSetBtn")?.addEventListener("click", async () => {
    const currSet = sets[activeSetIdx];
    if (!currSet || sets.length <= 1) return toast("A show must have at least one set.");
    if (!confirm(`Delete ${currSet.label}?`)) return;

    const { error } = await db.from("drill_sets").delete().eq("id", currSet.id);
    if (error) return toast(error.message);
    await selectShow(activeShow.id);
    toast("Set deleted.");
  });

  // Auto-Place Roster grouped by section
  document.getElementById("drillAutoPlaceBtn")?.addEventListener("click", () => {
    const currSet = sets[activeSetIdx];
    if (!currSet) return;
    const members = Array.from(state.byId.values()).sort((a, b) =>
      (a.section || "").localeCompare(b.section || "") || a.full_name.localeCompare(b.full_name)
    );
    if (members.length === 0) return toast("Roster is empty.");

    pushUndo();
    const cols = Math.min(12, members.length);
    const startX = 80 - ((cols - 1) * 4) / 2;
    currSet.dots = members.map((m, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const initials = m.full_name
        .split(" ")
        .map((p) => p[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);
      const sec = Object.keys(SECTION_STYLE).find((k) =>
        (m.section || "").toLowerCase().includes(k.toLowerCase())
      ) || "Woodwinds";
      return {
        id: `dot_${m.id}`,
        user_id: m.id,
        label: `${initials}${i + 1}`,
        section: sec,
        pathType: "linear",
        x: snapVal(startX + col * 4),
        y: snapVal(20 + row * 4),
      };
    });
    updateSetUI();
    toast("Roster placed — use Line, Arc, Circle, or Block to shape your form, then Save Set.");
  });

  // Save Set + Show Settings
  document.getElementById("drillSaveSetBtn")?.addEventListener("click", async () => {
    const currSet = sets[activeSetIdx];
    if (!currSet || !activeShow) return;

    const label = document.getElementById("drillSetLabelInput")?.value.trim() || currSet.label;
    const counts = Math.max(0, parseInt(document.getElementById("drillSetCounts")?.value, 10) || 0);
    const notes = document.getElementById("drillSetNotes")?.value || "";
    const bpm = parseInt(document.getElementById("drillBpmInput")?.value, 10) || 144;
    const fieldType = document.getElementById("drillHashSelect")?.value || "hs";
    const musicId = document.getElementById("drillMusicSelect")?.value || null;

    currSet.label = label;
    currSet.counts = counts;
    currSet.notes = notes;

    const { error: setErr } = await db
      .from("drill_sets")
      .update({ label, counts, notes, dots: currSet.dots })
      .eq("id", currSet.id);
    if (setErr) return toast("Save failed: " + setErr.message);

    // Save show-level metadata (gracefully ignore music_id if column wasn't added yet)
    const showPatch = { bpm, field_type: fieldType, music_id: musicId };
    const { error: showErr } = await db.from("drill_shows").update(showPatch).eq("id", activeShow.id);
    if (showErr && showErr.message?.includes("music_id")) {
      await db.from("drill_shows").update({ bpm, field_type: fieldType }).eq("id", activeShow.id);
    }

    updateSetUI();
    toast(`${label} saved!`);
  });

  // Dot Inspector edits (Label, Section, Assigned Student)
  document.getElementById("drillDotLabelInput")?.addEventListener("input", (e) => {
    const currSet = sets[activeSetIdx];
    if (!currSet || selectedIds.size === 0) return;
    const firstId = Array.from(selectedIds)[0];
    const dot = currSet.dots.find((d) => d.id === firstId);
    if (dot) {
      dot.label = e.target.value;
      renderField();
    }
  });

  document.getElementById("drillDotSectionSelect")?.addEventListener("change", (e) => {
    const currSet = sets[activeSetIdx];
    if (!currSet || selectedIds.size === 0) return;
    pushUndo();
    currSet.dots.forEach((d) => {
      if (selectedIds.has(d.id)) d.section = e.target.value;
    });
    updateCoordCard();
    renderField();
  });

  document.getElementById("drillAssignSelect")?.addEventListener("change", (e) => {
    const currSet = sets[activeSetIdx];
    if (!currSet || selectedIds.size === 0) return;
    const firstId = Array.from(selectedIds)[0];
    const dot = currSet.dots.find((d) => d.id === firstId);
    if (dot) {
      dot.user_id = e.target.value || null;
      updateCoordCard();
      renderField();
    }
  });

  // Show, Music, Hash, Scrubber, & Transport listeners
  document.getElementById("drillShowSelect")?.addEventListener("change", (e) => selectShow(e.target.value));
  document.getElementById("drillMusicSelect")?.addEventListener("change", (e) => attachShowAudio(e.target.value));
  document.getElementById("drillHashSelect")?.addEventListener("change", updateSetUI);
  document.getElementById("drillDotBookBtn")?.addEventListener("click", openDotBookModal);

  document.getElementById("drillPlayBtn")?.addEventListener("click", () => togglePlayback(false));
  document.getElementById("drillLoopSetBtn")?.addEventListener("click", () => togglePlayback(true));
  document.getElementById("drillPrevSetBtn")?.addEventListener("click", () => {
    stopDrill();
    if (activeSetIdx > 0) {
      activeSetIdx--;
      currentShowCount = sets[activeSetIdx]._endCount || 0;
      updateSetUI();
    }
  });
  document.getElementById("drillNextSetBtn")?.addEventListener("click", () => {
    stopDrill();
    if (activeSetIdx < sets.length - 1) {
      activeSetIdx++;
      currentShowCount = sets[activeSetIdx]._endCount || 0;
      updateSetUI();
    }
  });
  document.getElementById("drillScrubber")?.addEventListener("input", (e) => {
    if (isAnimating) stopDrill();
    scrubToCount(parseFloat(e.target.value) || 0);
  });

  /* ---------- Interactive Pointer Gestures on Field Canvas ---------- */
  const canvas = document.getElementById("drillCanvas");
  if (canvas) {
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.15 : -0.15;
      viewZoom = Math.max(1, Math.min(3, Math.round((viewZoom + delta) * 100) / 100));
      if (viewZoom === 1) { viewPanX = 0; viewPanY = 0; }
      const btn = document.getElementById("drillZoomResetBtn");
      if (btn) btn.textContent = `${Math.round(viewZoom * 100)}%`;
      renderField();
    }, { passive: false });

    canvas.addEventListener("pointerdown", (e) => {
      const currSet = sets[activeSetIdx];
      if (!currSet || isAnimating) return;
      populateRosterDropdown();

      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = screenToWorld(sx, sy, rect.width, rect.height);
      dragStartWorld = world;
      dragCurrWorld = world;

      // Middle-button pan
      if (e.button === 1) {
        pointerMode = "pan";
        canvas.setPointerCapture(e.pointerId);
        return;
      }

      // 1. Check Curve Control Handle hit (for curved transitions)
      if (leader && activeTool === "select") {
        const curveDot = (currSet.dots || []).find(
          (d) =>
            selectedIds.has(d.id) &&
            d.pathType === "curve" &&
            d.ctrlX != null &&
            Math.hypot(d.ctrlX - world.wx, d.ctrlY - world.wy) <= 3.5
        );
        if (curveDot) {
          pushUndo();
          pointerMode = "drag-curve-ctrl";
          dragOriginDots = [curveDot];
          canvas.setPointerCapture(e.pointerId);
          return;
        }

        // 2. Check Group Rotate / Scale Handle hit
        const bounds = getSelectionBounds(currSet.dots || []);
        if (bounds) {
          const p1 = worldToScreen(bounds.minX, bounds.maxY, rect.width, rect.height);
          const p2 = worldToScreen(bounds.maxX, bounds.minY, rect.width, rect.height);
          const bx = Math.min(p1.x, p2.x) - 10;
          const by = Math.min(p1.y, p2.y) - 10;
          const bw = Math.abs(p2.x - p1.x) + 20;
          const bh = Math.abs(p2.y - p1.y) + 20;

          // Rotate handle
          if (Math.hypot(sx - (bx + bw / 2), sy - (by - 20)) <= 12) {
            pushUndo();
            pointerMode = "rotate-group";
            groupCenter = { x: bounds.cx, y: bounds.cy };
            groupStartAngle = Math.atan2(world.wy - bounds.cy, world.wx - bounds.cx);
            dragOriginDots = structuredClone(currSet.dots.filter((d) => selectedIds.has(d.id)));
            canvas.setPointerCapture(e.pointerId);
            return;
          }

          // Scale handle
          if (Math.hypot(sx - (bx + bw), sy - (by + bh)) <= 12) {
            pushUndo();
            pointerMode = "scale-group";
            groupCenter = { x: bounds.cx, y: bounds.cy };
            groupStartDist = Math.max(1, Math.hypot(world.wx - bounds.cx, world.wy - bounds.cy));
            dragOriginDots = structuredClone(currSet.dots.filter((d) => selectedIds.has(d.id)));
            canvas.setPointerCapture(e.pointerId);
            return;
          }
        }
      }

      // 3. Check Dot Hit
      const hitDot = (currSet.dots || []).find(
        (d) => Math.hypot(d.x - world.wx, d.y - world.wy) <= 3.2 / viewZoom
      );

      if (activeTool === "select") {
        if (hitDot) {
          if (e.shiftKey) {
            if (selectedIds.has(hitDot.id)) selectedIds.delete(hitDot.id);
            else selectedIds.add(hitDot.id);
          } else if (!selectedIds.has(hitDot.id)) {
            selectedIds = new Set([hitDot.id]);
          }
          if (leader) {
            pushUndo();
            pointerMode = "move-dots";
            dragOriginDots = structuredClone(currSet.dots.filter((d) => selectedIds.has(d.id)));
            canvas.setPointerCapture(e.pointerId);
          }
          updateCoordCard();
          renderField();
        } else {
          if (!e.shiftKey) selectedIds.clear();
          pointerMode = "box-select";
          canvas.setPointerCapture(e.pointerId);
          updateCoordCard();
          renderField();
        }
        return;
      }

      // 4. Form Drawing Tools (Line, Arc, Circle, Block, FTL)
      if (leader) {
        pointerMode = "draw-form";
        ftlDraftPoints = [{ x: snapVal(world.wx), y: snapVal(world.wy) }];
        canvas.setPointerCapture(e.pointerId);
        renderField();
      }
    });

    canvas.addEventListener("pointermove", (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = screenToWorld(sx, sy, rect.width, rect.height);
      dragCurrWorld = world;

      // Live cursor coordinate readout
      const fieldType = document.getElementById("drillHashSelect")?.value || "hs";
      const clampedCursor = clampField(world.wx, world.wy);
      const readoutEl = document.getElementById("drillCursorReadout");
      if (readoutEl) {
        readoutEl.textContent = formatCoordinates(clampedCursor.x, clampedCursor.y, fieldType);
      }

      const currSet = sets[activeSetIdx];
      if (!currSet || !pointerMode) return;

      if (pointerMode === "pan") {
        viewPanX += e.movementX;
        viewPanY += e.movementY;
        renderField();
      } else if (pointerMode === "move-dots" && dragOriginDots) {
        const dx = world.wx - dragStartWorld.wx;
        const dy = world.wy - dragStartWorld.wy;
        dragOriginDots.forEach((orig) => {
          const live = currSet.dots.find((d) => d.id === orig.id);
          if (live) {
            const p = clampField(orig.x + dx, orig.y + dy);
            live.x = p.x;
            live.y = p.y;
          }
        });
        updateCoordCard();
        renderField();
      } else if (pointerMode === "drag-curve-ctrl" && dragOriginDots?.[0]) {
        const p = clampField(world.wx, world.wy);
        dragOriginDots[0].ctrlX = p.x;
        dragOriginDots[0].ctrlY = p.y;
        updateCoordCard();
        renderField();
      } else if (pointerMode === "rotate-group" && dragOriginDots && groupCenter) {
        const ang = Math.atan2(world.wy - groupCenter.y, world.wx - groupCenter.x) - groupStartAngle;
        const cosA = Math.cos(ang);
        const sinA = Math.sin(ang);
        dragOriginDots.forEach((orig) => {
          const live = currSet.dots.find((d) => d.id === orig.id);
          if (live) {
            const rx = orig.x - groupCenter.x;
            const ry = orig.y - groupCenter.y;
            const p = clampField(groupCenter.x + rx * cosA - ry * sinA, groupCenter.y + rx * sinA + ry * cosA);
            live.x = p.x;
            live.y = p.y;
          }
        });
        updateCoordCard();
        renderField();
      } else if (pointerMode === "scale-group" && dragOriginDots && groupCenter) {
        const currDist = Math.max(0.5, Math.hypot(world.wx - groupCenter.x, world.wy - groupCenter.y));
        const ratio = currDist / groupStartDist;
        dragOriginDots.forEach((orig) => {
          const live = currSet.dots.find((d) => d.id === orig.id);
          if (live) {
            const p = clampField(
              groupCenter.x + (orig.x - groupCenter.x) * ratio,
              groupCenter.y + (orig.y - groupCenter.y) * ratio
            );
            live.x = p.x;
            live.y = p.y;
          }
        });
        updateCoordCard();
        renderField();
      } else if (pointerMode === "box-select") {
        const minX = Math.min(dragStartWorld.wx, world.wx);
        const maxX = Math.max(dragStartWorld.wx, world.wx);
        const minY = Math.min(dragStartWorld.wy, world.wy);
        const maxY = Math.max(dragStartWorld.wy, world.wy);
        selectedIds = new Set(
          (currSet.dots || [])
            .filter((d) => d.x >= minX && d.x <= maxX && d.y >= minY && d.y <= maxY)
            .map((d) => d.id)
        );
        updateCoordCard();
        renderField();
      } else if (pointerMode === "draw-form") {
        if (activeTool === "ftl") {
          const last = ftlDraftPoints[ftlDraftPoints.length - 1];
          if (Math.hypot(world.wx - last.x, world.wy - last.y) >= 2) {
            ftlDraftPoints.push({ x: snapVal(world.wx), y: snapVal(world.wy) });
          }
        }
        renderField();
      }
    });

    canvas.addEventListener("pointerup", () => {
      const currSet = sets[activeSetIdx];
      if (pointerMode === "draw-form" && currSet && dragStartWorld && dragCurrWorld && isLeader()) {
        const dist = Math.hypot(dragCurrWorld.wx - dragStartWorld.wx, dragCurrWorld.wy - dragStartWorld.wy);
        if (dist >= 1.5 || activeTool === "ftl") {
          pushUndo();
          const useSelected = selectedIds.size >= 2;
          const count = useSelected
            ? selectedIds.size
            : parseInt(document.getElementById("drillNewCountInput")?.value, 10) || 8;
          const pts = computeFormPoints(activeTool, dragStartWorld, dragCurrWorld, count, ftlDraftPoints);

          if (useSelected) {
            const orderedDots = currSet.dots.filter((d) => selectedIds.has(d.id));
            orderedDots.forEach((d, idx) => {
              if (pts[idx]) {
                d.x = pts[idx].x;
                d.y = pts[idx].y;
                if (activeTool === "ftl") {
                  d.pathType = "ftl";
                  d.ftlPoints = structuredClone(ftlDraftPoints);
                }
              }
            });
          } else {
            const baseIdx = currSet.dots.length;
            const newDots = pts.map((p, i) => ({
              id: `dot_${Date.now()}_${i}`,
              user_id: null,
              label: `D${baseIdx + i + 1}`,
              section: "Woodwinds",
              pathType: "linear",
              x: p.x,
              y: p.y,
            }));
            currSet.dots.push(...newDots);
            selectedIds = new Set(newDots.map((d) => d.id));
          }
          updateCoordCard();
        }
      }

      pointerMode = null;
      dragStartWorld = null;
      dragCurrWorld = null;
      dragOriginDots = null;
      ftlDraftPoints = [];
      renderField();
    });
  }

  // Keyboard shortcuts when Drill tab is active
  window.addEventListener("keydown", (e) => {
    if (state.tab !== "drill") return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
      return;
    }

    const toolShortcuts = { v: "select", l: "line", c: "arc", o: "circle", b: "block", f: "ftl" };
    if (toolShortcuts[e.key.toLowerCase()] && isLeader()) {
      activeTool = toolShortcuts[e.key.toLowerCase()];
      document.querySelectorAll(".tool-btn").forEach((b) =>
        b.classList.toggle("active", b.dataset.tool === activeTool)
      );
      return;
    }

    // Arrow key precision nudging (0.5 step, or 1.0 step with Shift)
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && isLeader() && selectedIds.size > 0) {
      e.preventDefault();
      const currSet = sets[activeSetIdx];
      if (!currSet) return;
      pushUndo();
      const delta = e.shiftKey ? 1 : 0.5;
      const flip = pressBoxView ? -1 : 1;
      currSet.dots.forEach((d) => {
        if (!selectedIds.has(d.id)) return;
        if (e.key === "ArrowLeft") d.x = Math.max(0, Math.min(FIELD_STEPS_X, d.x - delta * flip));
        if (e.key === "ArrowRight") d.x = Math.max(0, Math.min(FIELD_STEPS_X, d.x + delta * flip));
        if (e.key === "ArrowUp") d.y = Math.max(0, Math.min(FIELD_STEPS_Y, d.y + delta * flip));
        if (e.key === "ArrowDown") d.y = Math.max(0, Math.min(FIELD_STEPS_Y, d.y - delta * flip));
      });
      updateCoordCard();
      renderField();
    }
  });

  window.addEventListener("resize", renderField);
}