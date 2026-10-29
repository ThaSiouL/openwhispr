import { useEffect, useRef, useState } from "react";

// The original renderer remains the owner of recording, policy and rich UI.
// GTK receives presentation and sends the same actions as the floating pill.
export function useWaylandOverlay({ snapshot, transcript, onAction, getAudioLevel, isRecording }) {
  const [enabled, setEnabled] = useState(false);
  const [available, setAvailable] = useState(false);
  const [appearance, setAppearance] = useState(() => ({
    theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  }));
  const actionRef = useRef(onAction);
  actionRef.current = onAction;
  const signature = JSON.stringify({
    ...snapshot,
    ...appearance,
    // Transcript content only leaves this renderer for the opted-in native UI.
    ...(enabled ? { transcript: transcript ?? null } : {}),
  });

  useEffect(() => {
    if (!enabled) return undefined;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () =>
      setAppearance({
        theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
        reducedMotion: motion.matches,
      });
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    motion.addEventListener("change", update);
    update();
    return () => {
      observer.disconnect();
      motion.removeEventListener("change", update);
    };
  }, [enabled]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getWaylandOverlayEnabled) return undefined;
    let disposed = false;
    void api.getWaylandOverlayEnabled().then((value) => {
      if (!disposed) setEnabled(value);
    });
    const unsubscribe = api.onWaylandOverlayAction((action, hovered) => {
      if (action === "available") {
        setAvailable(true);
        return;
      }
      if (action === "unavailable") {
        setAvailable(false);
        setEnabled(false);
        return;
      }
      actionRef.current(action, hovered);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (enabled) window.electronAPI.publishWaylandOverlayState(JSON.parse(signature));
  }, [enabled, signature]);

  useEffect(() => {
    if (!enabled || !isRecording || snapshot.rich) return undefined;
    const sample = () => {
      const level = getAudioLevel();
      if (level === null || Number.isFinite(level))
        window.electronAPI.waylandOverlayAudioLevel(level);
    };
    sample();
    const timer = setInterval(sample, 50);
    return () => clearInterval(timer);
  }, [enabled, isRecording, snapshot.rich, getAudioLevel]);
  return { enabled, available };
}
