const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");

test("the native pill follows the renderer theme, motion preference and absent microphone signal", async (t) => {
  const { Window } = await import("happy-dom");
  const browser = new Window();
  const originals = new Map();
  for (const key of [
    "window",
    "document",
    "navigator",
    "MutationObserver",
    "IS_REACT_ACT_ENVIRONMENT",
  ]) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === "window" ? browser : key === "IS_REACT_ACT_ENVIRONMENT" ? true : browser[key],
    });
  }
  const motionListeners = new Set();
  const motion = {
    matches: false,
    addEventListener: (_event, listener) => motionListeners.add(listener),
    removeEventListener: (_event, listener) => motionListeners.delete(listener),
  };
  browser.matchMedia = () => motion;
  const states = [];
  const audio = [];
  let receiveAction;
  browser.electronAPI = {
    getWaylandOverlayEnabled: async () => true,
    onWaylandOverlayAction: (callback) => {
      receiveAction = callback;
      return () => {};
    },
    publishWaylandOverlayState: (value) => states.push(value),
    waylandOverlayAudioLevel: (value) => audio.push(value),
  };
  const vite = await createRendererServer(t);
  const { useWaylandOverlay } = await vite.ssrLoadModule("/hooks/useWaylandOverlay.js");
  const { createRoot } = require("react-dom/client");
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await React.act(async () => root.unmount());
    await browser.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  let ownership;
  const fullText = "Complete transcript ".repeat(1000);
  function Harness() {
    ownership = useWaylandOverlay({
      snapshot: { state: "recording", rich: false, collapseToLogo: true, waveformVisible: false },
      onAction: () => {},
      getAudioLevel: () => null,
      isRecording: true,
      transcript: { text: fullText, measurementText: fullText },
    });
    return null;
  }
  await React.act(async () => root.render(React.createElement(Harness)));
  assert.equal(states.at(-1).theme, "light");
  assert.equal(states.at(-1).collapseToLogo, true);
  assert.equal(states.at(-1).waveformVisible, false);
  assert.equal(states.at(-1).transcript.text, fullText);
  assert.deepEqual(ownership, { enabled: true, available: false });
  await React.act(async () => receiveAction("available"));
  assert.deepEqual(ownership, { enabled: true, available: true });
  assert.ok(audio.includes(null), "no microphone signal must clear the previous live level");
  await React.act(async () => {
    browser.document.documentElement.classList.add("dark");
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  assert.equal(states.at(-1).theme, "dark");
  await React.act(async () => {
    motion.matches = true;
    motionListeners.forEach((listener) => listener());
  });
  assert.equal(states.at(-1).reducedMotion, true);
  await React.act(async () => receiveAction("unavailable"));
  assert.deepEqual(ownership, { enabled: false, available: false });
  const published = states.length;
  await React.act(async () => {
    motion.matches = false;
    motionListeners.forEach((listener) => listener());
  });
  assert.equal(states.length, published, "fallback stops publishing transcript content");
  await React.act(async () => root.unmount());
  assert.equal(motionListeners.size, 0);
});
