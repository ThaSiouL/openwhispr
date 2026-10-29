const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { createRendererServer } = require("../lib/rendererTestHarness");

test("standalone pill forwards committed state, real audio and existing actions", async (t) => {
  const { Window } = await import("happy-dom");
  const browser = new Window();
  const saved = new Map();
  const frames = new Map();
  let frameId = 0;
  const setGlobal = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ["window", "document", "navigator", "MutationObserver", "HTMLElement"]) {
    setGlobal(key, key === "window" ? browser : browser[key]);
  }
  setGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  setGlobal("requestAnimationFrame", (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  setGlobal("cancelAnimationFrame", (id) => frames.delete(id));
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  browser.matchMedia = () => ({
    get matches() {
      return browser.document.documentElement.dataset.overlayReducedMotion === "true";
    },
  });
  const messages = [];
  browser.webkit = {
    messageHandlers: {
      openwhispr: {
        postMessage(message) {
          const parsed = JSON.parse(message);
          if (parsed.event === "ready") assert.ok(browser.openwhisprOverlay);
          messages.push(parsed);
        },
      },
    },
  };
  const container = browser.document.createElement("div");
  browser.document.body.append(container);
  const vite = await createRendererServer(t);
  const { WaylandOverlay } = await vite.ssrLoadModule("/components/dictation/WaylandOverlay.tsx");
  const { createRoot } = require("react-dom/client");
  const root = createRoot(container);
  t.after(async () => {
    await React.act(async () => root.unmount());
    await browser.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await React.act(async () => root.render(React.createElement(WaylandOverlay)));
  assert.equal(messages[0].event, "ready");
  const bridge = browser.openwhisprOverlay;
  const snapshot = {
    revision: 7,
    state: "recording",
    expanded: true,
    agentMode: true,
    interactive: true,
    cancelVisible: true,
    collapseToLogo: false,
    waveformVisible: true,
    showExpandChevron: true,
    horizontalDirection: "left",
    dock: "bottom-left",
    theme: "dark",
    reducedMotion: true,
    labels: { tooltip: "Stop recording", cancel: "Discard recording" },
  };
  await React.act(async () => bridge.applyState(snapshot));
  const pill = container.querySelector(".voice-pill-control");
  assert.equal(pill.style.width, "98px");
  assert.equal(pill.style.height, "36px");
  assert.equal(pill.getAttribute("aria-label"), snapshot.labels.tooltip);
  assert.equal(pill.dataset.agentMode, "true");
  assert.equal(pill.dataset.expandChevron, "true");
  assert.ok(container.querySelector(".voice-pill-position-bottom-left"));
  assert.ok(browser.document.documentElement.classList.contains("dark"));
  assert.equal(browser.document.documentElement.dataset.overlayReducedMotion, "true");
  const rendered = messages.findIndex((message) => message.event === "rendered");
  assert.ok(messages.slice(0, rendered).some((message) => message.event === "geometry"));
  assert.equal(messages[rendered].revision, 7);

  const advance = async (now) => {
    const pending = [...frames.values()];
    frames.clear();
    await React.act(async () => pending.forEach((callback) => callback(now)));
  };
  await advance(performance.now() + 1000);
  await advance(performance.now() + 1100);
  const cancel = container.querySelector('button[aria-label="Discard recording"]');
  assert.ok(cancel && !cancel.disabled);
  const send = (element, type, options) =>
    React.act(async () =>
      element.dispatchEvent(new browser.MouseEvent(type, { bubbles: true, ...options }))
    );
  const actions = () => messages.filter((message) => message.event === "action");
  await send(pill, "click");
  assert.equal(actions().at(-1).action, "activate");
  await React.act(async () => bridge.setDragging(true));
  await React.act(async () => bridge.setDragging(false));
  const beforeDragRelease = actions().length;
  await send(pill, "click");
  assert.equal(actions().length, beforeDragRelease);
  await send(pill, "pointerdown");
  await send(pill, "click");
  await send(cancel, "click");
  await send(pill, "contextmenu");
  assert.deepEqual(
    actions()
      .slice(-3)
      .map((message) => message.action),
    ["activate", "cancel", "menu"]
  );
  await send(pill, "mouseover", { relatedTarget: null });
  assert.ok(container.querySelector("[data-pill-tooltip]"));
  assert.deepEqual(actions().at(-1), { event: "action", action: "hover", hovered: true });

  const liveBars = () => [
    ...container.querySelectorAll(".voice-pill-waveform > div:last-child > div"),
  ];
  assert.equal(liveBars().length, 11);
  bridge.setAudioLevel(null);
  for (let i = 0; i < 12; i++) await advance(performance.now() + 2000 + i * 100);
  assert.ok(liveBars().every((bar) => bar.style.height === "4px"));
  bridge.setAudioLevel(0.1);
  await advance(performance.now() + 4000);
  assert.ok(Number.parseFloat(liveBars().at(-1).style.height) > 4);

  await React.act(async () =>
    bridge.applyState({ ...snapshot, revision: 8, interactive: false, collapseToLogo: true })
  );
  assert.equal(pill.style.width, "40px");
  assert.equal(pill.style.height, "40px");
  assert.equal(pill.getAttribute("role"), "status");
  const actionCount = actions().length;
  await send(pill, "click");
  assert.equal(actions().length, actionCount);

  await React.act(async () =>
    bridge.applyState({
      ...snapshot,
      revision: 9,
      state: "idle",
      expanded: false,
      cancelVisible: false,
    })
  );
  for (let i = 0; i < 5; i++) await advance(performance.now() + 6000 + i * 1000);
  assert.equal(frames.size, 0, "idle geometry reporting must stop requesting frames");
  await React.act(async () =>
    bridge.applyState({ ...snapshot, revision: 10, dock: "center", state: "idle", expanded: false })
  );
  assert.ok(container.querySelector(".voice-pill-position-center"));
  await send(pill, "mouseover", { relatedTarget: null });
  assert.ok(container.querySelector("[data-pill-tooltip]").className.includes("left-1/2"));
  const transcript = {
    open: true,
    text: "Complete dictated text ".repeat(100),
    measurementText: "Complete dictated text ".repeat(100),
    phase: "live",
    processing: false,
    controlsVisible: true,
    contentVisible: true,
    stage: "content",
    label: "Transcription en direct",
    measurementRevision: 15,
    copied: false,
    labels: { waitingForInput: "Écoute", copy: "Copier", copied: "Copié", collapse: "Réduire" },
  };
  await React.act(async () =>
    bridge.applyState({
      ...snapshot,
      revision: 11,
      transcript,
      language: "fr",
      direction: "rtl",
      dock: "live-transcript-bottom-left",
    })
  );
  assert.equal(container.querySelectorAll(".voice-pill-control").length, 1);
  assert.equal(pill.dataset.integratedWithPanel, "true");
  assert.ok(container.querySelector(".live-transcript-panel.expanding-panel-surface-open"));
  assert.equal(container.querySelector("main p").textContent, transcript.text.trim());
  assert.equal(browser.document.documentElement.lang, "fr");
  assert.equal(browser.document.documentElement.dir, "rtl");
  assert.ok(
    messages.some(
      (message) =>
        message.event === "geometry" && message.revision === 11 && message.rects.length >= 2
    )
  );
  const copy = container.querySelector('button[aria-label="Copier"]');
  await send(copy, "click");
  assert.equal(actions().at(-1).action, "copy-transcript");
  assert.equal(
    copy.getAttribute("aria-label"),
    "Copier",
    "dispatch alone must not claim clipboard success"
  );
  await React.act(async () =>
    bridge.applyState({
      ...snapshot,
      revision: 12,
      transcript: { ...transcript, copied: true },
      dock: "live-transcript-bottom-left",
    })
  );
  assert.equal(copy.getAttribute("aria-label"), "Copié");
  await send(container.querySelector('button[aria-label="Réduire"]'), "click");
  assert.equal(actions().at(-1).action, "collapse-transcript");
  await send(container.querySelector("main"), "mouseover", { relatedTarget: null });
  assert.deepEqual(actions().at(-1), { event: "action", action: "hold-transcript", hovered: true });
  await React.act(async () =>
    bridge.applyState({
      ...snapshot,
      revision: 13,
      transcript: { ...transcript, open: false },
      dock: "bottom-left",
    })
  );
  assert.equal(pill.dataset.integratedWithPanel, undefined);
  assert.equal(container.querySelectorAll(".voice-pill-control").length, 1);
  delete browser.webkit;
  await React.act(async () => bridge.applyState({ ...snapshot, revision: 10, state: "idle" }));
  assert.ok(
    container.querySelector(".voice-pill-control"),
    "normal browser needs no native bridge"
  );
});
