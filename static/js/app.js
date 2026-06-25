// app.js — Digital Twin Avatar frontend
//
// Loads the rigged Mixamo character from Idle.fbx, pulls the animation
// clip out of the other three Mixamo FBX exports (each is a full
// mesh+skeleton+single-clip export, so we only keep the clip from those
// and discard the duplicate mesh/skeleton), and crossfades between
// "idle" / "happy" / "tired" / "sad" based on /api/avatar/status.

import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const MODEL_BASE = "/static/models/";

// Map animation state -> source FBX file. "idle" uses the base file's own
// baked-in clip; the others borrow just their AnimationClip.
const ANIMATION_FILES = {
  idle: "Idle.fbx",
  happy: "Happy_Idle.fbx",
  tired: "Running_Tired.fbx",
  sad: "Sad_Idle.fbx",
};

const STAT_THRESHOLDS = { caution: 50, low: 30 };

// ---------------------------------------------------------------------------
// Three.js scene setup
// ---------------------------------------------------------------------------

const viewerFrame = document.querySelector(".viewer-frame");
const canvas = document.getElementById("avatar-canvas");
const loadingEl = document.getElementById("viewer-loading");
const badgeEl = document.getElementById("viewer-state-badge");
const stateTextEl = document.getElementById("animation-state-text");

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(35, 4 / 3, 0.1, 100);
camera.position.set(0, 1.5, 3.4);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.enableDamping = true;
controls.minDistance = 1.5;
controls.maxDistance = 6;
controls.maxPolarAngle = Math.PI * 0.55;

scene.add(new THREE.HemisphereLight(0xbfd9ff, 0x14181d, 1.1));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
keyLight.position.set(2.5, 4, 2.5);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x5eead4, 0.5);
rimLight.position.set(-3, 1.5, -2);
scene.add(rimLight);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(2.2, 48),
  new THREE.MeshStandardMaterial({ color: 0x10151b, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

function resizeRenderer() {
  const w = viewerFrame.clientWidth;
  const h = viewerFrame.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resizeRenderer).observe(viewerFrame);
resizeRenderer();

const clock = new THREE.Clock();
let mixer = null;
const actions = {};
let currentAction = null;

function renderLoop() {
  const delta = clock.getDelta();
  if (mixer) mixer.update(delta);
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

function playAnimationState(state) {
  const next = actions[state] || actions.idle;
  if (!next || next === currentAction) return;
  if (currentAction) {
    currentAction.fadeOut(0.4);
  }
  next.reset().fadeIn(0.4).play();
  currentAction = next;

  stateTextEl.textContent = state;
  badgeEl.textContent = state;
  badgeEl.className = "viewer-state-badge" + (state !== "idle" ? ` is-${state}` : "");
}

// ---------------------------------------------------------------------------
// Avatar + animation loading
// ---------------------------------------------------------------------------

function loadFbx(filename) {
  return new Promise((resolve, reject) => {
    new FBXLoader().load(
      MODEL_BASE + filename,
      (object) => resolve(object),
      undefined,
      (err) => reject(err)
    );
  });
}

async function loadAvatar() {
  // Base mesh + skeleton + its own "idle" clip.
  const base = await loadFbx(ANIMATION_FILES.idle);

  // Mixamo FBX exports come in centimeters and are quite large; normalize
  // scale and re-center on the ground plane.
  base.scale.setScalar(0.01);
  base.traverse((child) => {
    if (child.isMesh) {
      child.castShadow = false;
      child.receiveShadow = false;
    }
  });
  scene.add(base);

  mixer = new THREE.AnimationMixer(base);

  if (base.animations.length) {
    actions.idle = mixer.clipAction(base.animations[0]);
  }

  // Pull just the AnimationClip out of the other three exports — they
  // share the same Mixamo rig/skeleton naming, so the clip retargets
  // cleanly onto the base model without keeping their duplicate meshes.
  const others = Object.entries(ANIMATION_FILES).filter(([state]) => state !== "idle");
  await Promise.all(
    others.map(async ([state, filename]) => {
      const obj = await loadFbx(filename);
      if (obj.animations.length) {
        actions[state] = mixer.clipAction(obj.animations[0]);
      }
    })
  );

  Object.values(actions).forEach((action) => {
    action.enabled = true;
  });

  playAnimationState("idle");
  loadingEl.classList.add("is-hidden");
}

// ---------------------------------------------------------------------------
// Pulse strip (signature element) — ECG-style line driven by "energy"
// ---------------------------------------------------------------------------

const pulseLine = document.getElementById("pulse-line");
const pulseEnergyValue = document.getElementById("pulse-energy-value");
let energyRatio = 0.5; // 0..1, updated from /api/avatar/status

function ecgOffset(x, t, ratio) {
  const speed = 0.7 + ratio * 2.0;
  const amplitude = 4 + ratio * 13;
  const cycleLength = 2.4; // px-units per cycle before x scaling
  const phase = (x * 0.03 + t * speed) % cycleLength;
  const cyclePos = (phase / cycleLength) * Math.PI * 2;
  let y = Math.sin(cyclePos * 2) * 1.2;
  const distFromPeak = Math.min(Math.abs(cyclePos - Math.PI), Math.PI * 2 - Math.abs(cyclePos - Math.PI));
  const spikeWidth = 0.35;
  if (distFromPeak < spikeWidth) {
    y += amplitude * (1 - distFromPeak / spikeWidth);
  }
  return y;
}

function animatePulse() {
  const t = performance.now() / 1000;
  const points = [];
  for (let x = 0; x <= 400; x += 4) {
    const y = 20 - ecgOffset(x, t, energyRatio);
    points.push(`${x},${y.toFixed(2)}`);
  }
  pulseLine.setAttribute("points", points.join(" "));
  requestAnimationFrame(animatePulse);
}
requestAnimationFrame(animatePulse);

// ---------------------------------------------------------------------------
// Stat bars + status fetch
// ---------------------------------------------------------------------------

const vitalRows = document.querySelectorAll(".vital-row");
const lastSyncEl = document.getElementById("last-sync");
const refreshBtn = document.getElementById("refresh-btn");
const refreshStatusEl = document.getElementById("refresh-status");

function fillClassForValue(value) {
  if (value <= STAT_THRESHOLDS.low) return "is-low";
  if (value <= STAT_THRESHOLDS.caution) return "is-caution";
  return "";
}

function renderStats(stats) {
  vitalRows.forEach((row) => {
    const key = row.dataset.stat;
    const value = stats[key];
    if (value === undefined || value === null) return;

    row.querySelector("[data-value]").textContent = Math.round(value);
    const fill = row.querySelector("[data-fill]");
    fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
    fill.className = "vital-fill " + fillClassForValue(value);
  });

  energyRatio = Math.max(0, Math.min(100, stats.energy ?? 50)) / 100;
  pulseEnergyValue.textContent = Math.round(stats.energy ?? 0);
}

function formatTimestamp(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

async function fetchStatus() {
  const res = await fetch("/api/avatar/status");
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Status fetch failed (${res.status})`);
  return res.json();
}

async function recalculate() {
  const res = await fetch("/api/avatar/recalculate", { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Recalculate failed (${res.status})`);
  }
  return res.json();
}

async function refreshUI({ triggerRecalculate = false } = {}) {
  refreshBtn.disabled = true;
  refreshStatusEl.classList.remove("is-error");
  refreshStatusEl.textContent = triggerRecalculate ? "Recalculating…" : "Loading…";

  try {
    if (triggerRecalculate) {
      await recalculate();
    }

    let status = await fetchStatus();
    if (!status && !triggerRecalculate) {
      // First load, nothing computed yet — bootstrap it once automatically.
      refreshStatusEl.textContent = "No data yet — running first calculation…";
      await recalculate();
      status = await fetchStatus();
    }

    if (status) {
      renderStats(status.stats);
      playAnimationState(status.animation_state);
      lastSyncEl.textContent = `Last synced ${formatTimestamp(status.timestamp)}`;
      refreshStatusEl.textContent = "Up to date";
    }

    await refreshHistoryChart();
  } catch (err) {
    console.error(err);
    refreshStatusEl.classList.add("is-error");
    refreshStatusEl.textContent = err.message || "Couldn't reach the avatar service.";
  } finally {
    refreshBtn.disabled = false;
  }
}

refreshBtn.addEventListener("click", () => refreshUI({ triggerRecalculate: true }));

// ---------------------------------------------------------------------------
// History chart
// ---------------------------------------------------------------------------

let historyChart = null;

async function refreshHistoryChart() {
  const res = await fetch("/api/avatar/history");
  if (!res.ok) return;
  const { history } = await res.json();

  const labels = history.map((row) => formatTimestamp(row.timestamp));
  const datasets = [
    { key: "health", label: "Health", color: "#5eead4" },
    { key: "energy", label: "Energy", color: "#f2b84b" },
    { key: "happiness", label: "Happiness", color: "#a7c4ff" },
    { key: "wealth_level", label: "Wealth level", color: "#f2685c" },
  ].map((d) => ({
    label: d.label,
    data: history.map((row) => row[d.key]),
    borderColor: d.color,
    backgroundColor: d.color,
    tension: 0.35,
    pointRadius: 2,
    borderWidth: 2,
  }));

  const ctx = document.getElementById("history-chart");

  if (!historyChart) {
    historyChart = new Chart(ctx, {
      type: "line",
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            min: 0,
            max: 100,
            ticks: { color: "#8b98a5" },
            grid: { color: "#28323d" },
          },
          x: {
            ticks: { color: "#8b98a5", maxRotation: 0, autoSkip: true },
            grid: { display: false },
          },
        },
        plugins: {
          legend: { labels: { color: "#e8ecef", boxWidth: 10, font: { size: 11 } } },
        },
      },
    });
  } else {
    historyChart.data.labels = labels;
    historyChart.data.datasets = datasets;
    historyChart.update();
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadAvatar().catch((err) => {
  console.error("Failed to load avatar:", err);
  loadingEl.textContent = "Couldn't load avatar model.";
});

refreshUI({ triggerRecalculate: false });
