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
  h.manager.publishWaylandOverlayState({ ...snapshot, rich: true });
  assert.equal(h.helper.updates.at(-1).visible, false);
  assert.equal(h.win.isVisible(), false);
  h.helper.callbacks.onVisibility(false);
  assert.equal(h.win.isVisible(), true);
});

test("fallback restores the recording renderer without retry loops", () => {
  const h = harness();
  h.helper.becomeReady();
  h.helper.callbacks.onVisibility(true);
  h.helper.ready = false;
  h.helper.callbacks.onFailure("dependency missing");
  assert.equal(h.win.isVisible(), true);
  assert.equal(h.manager.getWaylandOverlayEnabled(), false);
  const previous = h.helper;
  h.manager.publishWaylandOverlayState(snapshot);
  assert.equal(helper, previous);
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
  assert.equal(h.sent.length, 1);
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
