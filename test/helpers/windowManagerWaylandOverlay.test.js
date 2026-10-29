const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { normalizeOverlaySnapshot } = require("../../src/helpers/waylandOverlay");
const modulePath = require.resolve("../../src/helpers/windowManager");
const originalLoad = Module._load;
let helper;
class FakeOverlay {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.ready = false;
    this.updates = [];
    helper = this;
  }
  start() {}
  stop() {
    this.ready = false;
  }
  update(state) {
    this.updates.push(state);
  }
  becomeReady() {
    this.ready = true;
    this.callbacks.onReady();
  }
}
class Inert {
  unregisterAll() {}
  cancelPending() {}
  markManuallyPositioned() {}
}
Module._load = function (request, parent, isMain) {
  if (request === "electron") return { app: { on() {} } };
  if (parent?.filename === modulePath) {
    if (request === "./waylandOverlay") {
      return {
        WaylandOverlay: FakeOverlay,
        normalizeOverlaySnapshot,
        isWaylandOverlayEnabled: () => true,
        overlayScriptPath: () => "/test/overlay.py",
        overlayUiUri: () => "file:///test/wayland-overlay.html",
      };
    }
    if (
      ["./hotkeyManager", "./dragManager", "./mainWindowPlacementCoordinator"].includes(request)
    ) {
      return Inert;
    }
    if (request === "./notificationTimer") return { NotificationDismissTimer: Inert };
    if (request === "./dictationLifecycle") return originalLoad.call(this, request, parent, isMain);
    if (request === "./windowConfig") {
      return {
        WINDOW_SIZES: { BASE: { width: 208, height: 120 } },
        NOTIFICATION_WINDOW_CONFIG: { width: 400, height: 100 },
        WindowPositionUtil: { clampToWorkArea: ({ x, y }) => ({ x, y }) },
      };
    }
    if (request === "./debugLogger") return { warn() {} };
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};
const WindowManager = require(modulePath);
Module._load = originalLoad;

const snapshot = {
  state: "recording",
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
  cancelVisible: false,
  labels: { tooltip: "Recording", cancel: "Cancel recording" },
};
function harness() {
  const manager = new WindowManager();
  let visible = true;
  const sent = [];
  const win = {
    isDestroyed: () => false,
    isVisible: () => visible,
    getBounds: () => ({ x: 100, y: 100, width: 208, height: 120 }),
    showInactive: () => {
      visible = true;
    },
    hide: () => {
      visible = false;
    },
    focus() {},
    webContents: { send: (...args) => sent.push(args) },
  };
  manager.mainWindow = win;
  manager._onboardingActive = false;
  manager._dictationPanelRequestedVisible = true;
  manager._getMainWindowDisplayFor = () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } });
  manager.publishWaylandOverlayState(snapshot);
  return { manager, win, helper, sent };
}

test("Electron stays visible until GTK maps, and rich UI waits until GTK unmaps", () => {
  const h = harness();
  assert.equal(h.win.isVisible(), true);
  h.helper.becomeReady();
  assert.equal(h.win.isVisible(), true);
  assert.equal(h.helper.updates.at(-1).visible, true);
  h.helper.callbacks.onVisibility(true);
  assert.equal(h.win.isVisible(), false);
  assert.equal(h.manager.isDictationPanelVisible(), true);
  const nativeBounds = h.helper.updates.at(-1).bounds;
  const richBounds = { x: 72, y: 38, width: 466, height: 340 };
  h.win.getBounds = () => richBounds;
  h.manager.publishWaylandOverlayState({ ...snapshot, rich: true });
  assert.deepEqual(h.helper.updates.at(-1).bounds, richBounds);
  assert.equal(h.helper.updates.at(-1).visible, false);
  assert.equal(h.win.isVisible(), false);
  h.helper.callbacks.onVisibility(false);
  assert.equal(h.win.isVisible(), true);
  h.manager.publishWaylandOverlayState(snapshot);
  assert.deepEqual(h.helper.updates.at(-1).bounds, nativeBounds);
});

test("fallback restores the recording renderer without retry loops", () => {
  const h = harness();
  h.helper.becomeReady();
  h.helper.callbacks.onVisibility(true);
  h.helper.ready = false;
  h.helper.callbacks.onFailure("dependency missing");
  const fallbackBounds = { x: 72, y: 38, width: 466, height: 340 };
  h.win.getBounds = () => fallbackBounds;
  assert.deepEqual(h.manager._getMainWindowBounds(), fallbackBounds);
  assert.equal(h.win.isVisible(), true);
  assert.equal(h.manager.getWaylandOverlayEnabled(), false);
  assert.deepEqual(h.sent.at(-1), ["wayland-overlay-action", "unavailable"]);
  const previous = h.helper;
  h.manager.publishWaylandOverlayState(snapshot);
  assert.equal(helper, previous);
});

test("GTK mirrors the expanded transcript viewport and its screen position", () => {
  const h = harness();
  h.win.getBounds = () => ({ x: 150, y: 480, width: 466, height: 562 });
  h.helper.becomeReady();
  const state = h.helper.updates.at(-1);
  assert.deepEqual(state.viewport, { width: 466, height: 562 });
  assert.deepEqual(state.bounds, { x: 150, y: 480, width: 466, height: 562 });
  assert.deepEqual(h.sent.at(-1), ["wayland-overlay-action", "available"]);
});

test("hidden Electron movement cannot pull the native preview along with Settings", () => {
  const h = harness();
  h.helper.becomeReady();
  h.helper.callbacks.onVisibility(true);
  const anchored = h.helper.updates.at(-1).bounds;
  h.win.getBounds = () => ({ x: 72, y: 38, width: 1200, height: 800 });
  h.manager.publishWaylandOverlayState({ ...snapshot, cancelVisible: true });
  assert.deepEqual(h.helper.updates.at(-1).bounds, anchored);
});

test("an unmoved Electron click before GTK maps preserves the native anchor", async () => {
  const h = harness();
  const anchor = h.manager._getMainWindowBounds();
  h.win.getBounds = () => ({ x: 72, y: 38, width: 208, height: 120 });
  h.manager._waylandOverlayManualDirection = "right";
  h.manager.dragManager.startWindowDrag = async () => ({ success: true });
  h.manager.dragManager.stopWindowDrag = async () => ({ success: true });
  h.manager.getMainWindowHorizontalDirection = () => "right";
  await h.manager.startWindowDrag();
  await h.manager.stopWindowDrag();
  h.helper.becomeReady();
  assert.deepEqual(h.helper.updates.at(-1).bounds, anchor);
});

test("native placement and transcript growth use requested bounds while XWayland reports stale bounds", async () => {
  const h = harness();
  h.helper.becomeReady();
  h.helper.callbacks.onVisibility(true);
  h.manager._waylandOverlayManualDirection = "right";
  const requested = [];
  h.win.setBounds = (bounds) => requested.push(bounds);
  h.win.getBounds = () => ({ x: 72, y: 38, width: 1200, height: 800 });
  const initial = { x: 600, y: 900, width: 208, height: 120 };
  h.manager._moveMainWindowTo(initial);
  assert.deepEqual(h.helper.updates.at(-1).bounds, initial);
  h.manager._prepareRendererForMainWindowResize = async () => {};
  h.manager._resolveMainWindowSize = (key, _, request) =>
    key === "BASE" ? { width: 208, height: 120 } : { width: 466, height: request.surfaceHeight };
  await h.manager._performMainWindowResize("ASSISTANT_CONTENT", { surfaceHeight: 176 });
  await h.manager._performMainWindowResize("ASSISTANT_CONTENT", { surfaceHeight: 340 });
  assert.deepEqual(h.helper.updates.at(-1).bounds, { x: 342, y: 680, width: 466, height: 340 });
  await h.manager._performMainWindowResize("BASE");
  assert.deepEqual(requested.at(-1), initial);
  assert.deepEqual(h.helper.updates.at(-1).bounds, initial);
});

test("a transcript content resize waits for GTK layout before revealing text", async () => {
  const h = harness();
  h.helper.becomeReady();
  let bounds = h.win.getBounds();
  h.win.getBounds = () => bounds;
  h.win.setBounds = (value) => {
    bounds = value;
  };
  h.manager._resolveMainWindowSize = () => ({ width: 466, height: 340 });
  h.manager._waylandOverlayManualDirection = "right";
  h.manager._prepareRendererForMainWindowResize = async () => {};
  let acknowledge;
  h.helper.waitForCurrentState = () =>
    new Promise((resolve) => {
      acknowledge = resolve;
    });
  let completed = false;
  const resize = h.manager._performMainWindowResize("ASSISTANT_CONTENT").then(() => {
    completed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.helper.updates.at(-1).viewport, { width: 466, height: 340 });
  assert.equal(completed, false);
  acknowledge();
  await resize;
  assert.equal(completed, true);
});

test("streaming partials keep the collapsed transcript native until the renderer opens rich UI", async () => {
  const h = harness();
  h.manager.enforceMainWindowOnTop = () => {};
  h.helper.becomeReady();
  h.helper.callbacks.onVisibility(true);
  await h.manager.showTranscriptionPreview("next streaming partial");
  assert.deepEqual(h.sent.at(-1), ["preview-text", "next streaming partial"]);
  assert.equal(h.win.isVisible(), false);
  assert.equal(h.helper.updates.at(-1).visible, true);

  h.manager.publishWaylandOverlayState({ ...snapshot, rich: true });
  h.helper.callbacks.onVisibility(false);
  assert.equal(h.win.isVisible(), true);
});

test("hide, auto-hide and onboarding cannot be undone by a late map acknowledgement", () => {
  const h = harness();
  h.helper.becomeReady();
  h.helper.callbacks.onVisibility(true);
  h.manager.hideDictationPanel();
  assert.equal(h.helper.updates.at(-1).visible, false);
  h.helper.callbacks.onVisibility(false);
  assert.equal(h.win.isVisible(), false);
  h.manager._onboardingActive = true;
  h.manager.showDictationPanel();
  assert.equal(h.win.isVisible(), false);
  h.manager._syncWaylandOverlay();
  assert.equal(h.helper.updates.at(-1).visible, false);
});

test("native toggles stay native and helper actions go to the existing renderer", () => {
  const h = harness();
  h.helper.becomeReady();
  h.helper.callbacks.onVisibility(true);
  h.manager.showDictationPanel();
  assert.equal(h.win.isVisible(), false);
  h.helper.callbacks.onAction("activate");
  assert.deepEqual(h.sent.at(-1), ["wayland-overlay-action", "activate", undefined]);
  h.manager._onboardingActive = true;
  h.helper.callbacks.onAction("activate");
  assert.equal(h.sent.length, 2);
});

test("renderer reload cleanup stops GTK and restores the requested Electron surface", () => {
  const h = harness();
  h.helper.becomeReady();
  h.helper.callbacks.onVisibility(true);
  h.manager.stopWaylandOverlay();
  assert.equal(h.helper.ready, false);
  assert.equal(h.manager._waylandOverlay, null);
  assert.equal(h.manager._waylandOverlaySnapshot, null);
  assert.equal(h.win.isVisible(), true);
});

test("a native drag mirrors the viewport directly and retains its chosen direction for rich UI", () => {
  const h = harness();
  h.helper.becomeReady();
  h.helper.callbacks.onVisibility(true);
  let moved;
  h.manager._moveMainWindowTo = (bounds) => {
    moved = bounds;
  };
  h.helper.callbacks.onPosition({
    x: 600,
    y: 400,
    width: 208,
    height: 120,
    horizontalDirection: "right",
  });
  assert.deepEqual(moved, { x: 600, y: 400, width: 208, height: 120 });
  assert.equal(h.manager.getMainWindowHorizontalDirection(), "right");
  h.manager._assistantPanelOpen = true;
  assert.equal(h.manager.getMainWindowHorizontalDirection(), "right");
});
