const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  WaylandOverlay,
  isWaylandOverlayEnabled,
  normalizeOverlaySnapshot,
} = require("../../src/helpers/waylandOverlay");

function harness(options = {}) {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = { resume() {} };
  child.stdout.setEncoding = () => {};
  const writes = [];
  child.stdin.write = (line) => {
    writes.push(JSON.parse(line));
    return !options.backpressure;
  };
  child.stdin.destroy = () => {};
  let killed = 0;
  child.kill = () => killed++;
  const failures = [];
  const actions = [];
  const visibility = [];
  const positions = [];
  let spawnOptions;
  const overlay = new WaylandOverlay({
    scriptPath: "/test/overlay.py",
    uiUri: "file:///test/wayland-overlay.html",
    spawnProcess: (command, args, opts) => {
      spawnOptions = { command, args, ...opts };
      return child;
    },
    onFailure: (reason) => failures.push(reason),
    onAction: (...args) => actions.push(args),
    onVisibility: (value) => visibility.push(value),
    onPosition: (value) => positions.push(value),
    timeoutMs: options.timeoutMs || 1000,
  });
  overlay.start();
  const receive = (value) => child.stdout.emit("data", JSON.stringify(value) + "\n");
  return {
    overlay,
    child,
    writes,
    failures,
    actions,
    visibility,
    positions,
    receive,
    spawnOptions,
    killed: () => killed,
  };
}

const snapshot = {
  state: "unavailable",
  rich: false,
  suppressed: false,
  expanded: true,
  collapseToLogo: false,
  waveformVisible: true,
  showExpandChevron: false,
  horizontalDirection: "right",
  dock: "bottom-right",
  theme: "dark",
  reducedMotion: false,
  agentMode: false,
  interactive: true,
  cancelVisible: true,
  labels: { tooltip: "Waiting for microphone", cancel: "Cancel recording" },
};

const transcript = {
  open: true,
  text: "A complete transcript ".repeat(1500),
  measurementText: "A complete transcript ".repeat(1500),
  phase: "live",
  processing: false,
  controlsVisible: true,
  contentVisible: true,
  stage: "content",
  label: "Live transcript",
  measurementRevision: 42,
  copied: false,
  labels: { waitingForInput: "Listening", copy: "Copy", copied: "Copied", collapse: "Collapse" },
};

test("native transcript retains complete text and validates measurement actions", () => {
  const state = normalizeOverlaySnapshot({
    ...snapshot,
    dock: "live-transcript-bottom-left",
    transcript,
  });
  assert.equal(state.transcript.text, transcript.text);
  assert.equal(state.transcript.measurementText, transcript.measurementText);
  assert.equal(
    normalizeOverlaySnapshot({ ...snapshot, transcript: { ...transcript, phase: "arbitrary" } }),
    null
  );
  const h = harness();
  h.receive({ event: "ready" });
  h.overlay.update({ ...state, visible: true });
  assert.equal(h.writes[0].transcript.text, transcript.text);
  const height = {
    event: "action",
    action: "transcript-height",
    revision: 1,
    height: 220,
    measurementRevision: 42,
  };
  h.receive(height);
  h.receive({ ...height, measurementRevision: 41 });
  h.receive({ ...height, height: Infinity });
  h.receive({ ...height, height: 539 });
  h.receive({ event: "action", action: "hold-transcript", revision: 1, hovered: true });
  h.receive({ event: "action", action: "hold-transcript", revision: 1, hovered: "true" });
  h.receive({ event: "action", action: "copy-transcript", revision: 1 });
  assert.deepEqual(h.actions, [
    ["transcript-height", { height: 220, measurementRevision: 42 }],
    ["hold-transcript", true],
    ["copy-transcript", undefined],
  ]);
  h.overlay.update({
    ...state,
    transcript: { ...transcript, text: "x".repeat(1024 * 1024) },
    visible: true,
  });
  assert.deepEqual(h.failures, ["GTK overlay state is too large"]);
});

test("content resize waits for the current rendered viewport acknowledgement and releases on failure", async () => {
  const h = harness();
  await h.overlay.waitForCurrentState();
  h.receive({ event: "ready" });
  h.overlay.update({ ...snapshot, visible: true });
  let settled = false;
  const wait = h.overlay.waitForCurrentState().then(() => (settled = true));
  h.overlay.update({ ...snapshot, visible: true, viewport: { width: 442, height: 300 } });
  h.receive({ event: "visibility", revision: 1, visible: true });
  await Promise.resolve();
  assert.equal(settled, false);
  h.receive({ event: "visibility", revision: 2, visible: true });
  await wait;
  assert.equal(settled, true);
  await h.overlay.waitForCurrentState();
  h.overlay.update({ ...snapshot, visible: false });
  const failureWait = h.overlay.waitForCurrentState();
  h.child.emit("exit", 1);
  await failureWait;
  assert.equal(h.overlay.stateWaiters.length, 0);
});

test("GTK is opt-in and requires Wayland plus the retained XWayland engine", () => {
  const env = { OPENWHISPR_WAYLAND_OVERLAY: "gtk", WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":1" };
  assert.equal(isWaylandOverlayEnabled("linux", env), true);
  assert.equal(isWaylandOverlayEnabled("darwin", env), false);
  for (const key of Object.keys(env)) {
    assert.equal(isWaylandOverlayEnabled("linux", { ...env, [key]: "" }), false);
  }
});

test("snapshot validation preserves presentation states and rejects oversized labels", () => {
  assert.deepEqual(normalizeOverlaySnapshot({ ...snapshot, transcript: null }), snapshot);
  assert.equal(normalizeOverlaySnapshot({ ...snapshot, transcript: "invalid" }), null);
  assert.equal(normalizeOverlaySnapshot({ ...snapshot, state: "arbitrary" }), null);
  assert.equal(normalizeOverlaySnapshot({ ...snapshot, rich: 0 }), null);
  assert.equal(normalizeOverlaySnapshot({ ...snapshot, theme: "system" }), null);
  assert.equal(normalizeOverlaySnapshot({ ...snapshot, waveformVisible: "true" }), null);
  assert.equal(
    normalizeOverlaySnapshot({
      ...snapshot,
      labels: { ...snapshot.labels, tooltip: "x".repeat(513) },
    }),
    null
  );
});

test("only the Python helper is forced to Wayland; mapping acknowledges the latest state", () => {
  const h = harness();
  assert.equal(h.spawnOptions.command, "/usr/bin/python3");
  assert.equal(h.spawnOptions.env.GDK_BACKEND, "wayland");
  h.overlay.update({ visible: true });
  assert.equal(h.writes.length, 0);
  h.receive({ event: "ready" });
  h.overlay.update({ ...snapshot, visible: true });
  assert.equal(h.writes.length, 1);
  h.receive({ event: "visibility", revision: 0, visible: true });
  assert.deepEqual(h.visibility, []);
  h.receive({ event: "visibility", revision: 1, visible: true });
  assert.deepEqual(h.visibility, [true]);
  h.overlay.stop();
});

test("actions are whitelisted, current and gated by native visibility", () => {
  const h = harness();
  h.receive({ event: "ready" });
  h.overlay.update({ ...snapshot, visible: true });
  h.receive({ event: "action", revision: 1, action: "activate" });
  h.receive({ event: "action", revision: 1, action: "hover", hovered: true });
  h.receive({ event: "action", revision: 1, action: "arbitrary" });
  h.receive({ event: "action", revision: 0, action: "cancel" });
  h.receive({ event: "action", revision: 1, action: "hover", hovered: "true" });
  assert.deepEqual(h.actions, [
    ["activate", undefined],
    ["hover", true],
  ]);
  h.overlay.update({ ...snapshot, visible: false });
  h.receive({ event: "action", revision: 2, action: "activate" });
  assert.equal(h.actions.length, 2);
  h.overlay.stop();
});

test("backpressure coalesces state and drops meter traffic instead of queuing it", () => {
  const options = { backpressure: true };
  const h = harness(options);
  h.receive({ event: "ready" });
  h.overlay.update({ ...snapshot, visible: true });
  for (let i = 0; i < 100; i++) {
    h.overlay.update({ ...snapshot, visible: true, counter: i });
    h.overlay.audio(0.5, i * 100);
  }
  assert.equal(h.writes.length, 1);
  options.backpressure = false;
  h.child.stdin.emit("drain");
  assert.equal(h.writes.length, 2);
  assert.equal(h.writes[1].counter, 99);
  h.overlay.stop();
});

test("native viewport positions retain their chosen direction and reject stale geometry", () => {
  const h = harness();
  h.receive({ event: "ready" });
  h.overlay.update({ ...snapshot, visible: true });
  const position = {
    event: "position",
    revision: 1,
    x: 600,
    y: 400,
    width: 208,
    height: 120,
    horizontalDirection: "right",
  };
  h.receive(position);
  h.receive({ ...position, revision: 0 });
  h.receive({ ...position, horizontalDirection: "center" });
  assert.deepEqual(h.positions, [position]);
  h.overlay.stop();
});

test("meter messages are clamped and limited to 20 per second", () => {
  const h = harness();
  h.receive({ event: "ready" });
  h.overlay.update({ ...snapshot, visible: true });
  h.overlay.audio(2, 100);
  h.overlay.audio(0.5, 101);
  h.overlay.audio(-1, 150);
  h.overlay.audio(null, 200);
  assert.deepEqual(h.writes.slice(1), [
    { type: "audio", level: 1 },
    { type: "audio", level: 0 },
    { type: "audio", level: null },
  ]);
  h.overlay.stop();
});

test("missing interpreter, malformed output and runtime death fail once and stop the helper", () => {
  for (const fail of [
    (h) => h.child.emit("error", new Error("ENOENT")),
    (h) => h.child.stdout.emit("data", "not json\n"),
    (h) => h.receive(null),
    (h) => h.child.stdout.emit("data", "x".repeat(16385)),
    (h) => h.child.emit("exit", 1),
  ]) {
    const h = harness();
    fail(h);
    assert.equal(h.failures.length, 1);
    assert.equal(h.killed(), 1);
    h.child.emit("error", new Error("late error"));
    assert.equal(h.failures.length, 1);
  }
});

test("startup and state acknowledgement timeouts trigger fallback", async () => {
  for (const ready of [false, true]) {
    const h = harness({ timeoutMs: 15 });
    if (ready) {
      h.receive({ event: "ready" });
      h.overlay.update({ ...snapshot, visible: true });
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.failures.length, 1);
    assert.equal(h.overlay.ready, false);
    assert.equal(h.killed(), 1);
  }
});

test("an intentional stop never reports failure or accepts late messages", () => {
  const h = harness();
  h.overlay.stop();
  h.child.emit("exit", 0);
  h.receive({ event: "ready" });
  assert.equal(h.overlay.ready, false);
  assert.deepEqual(h.failures, []);
});
