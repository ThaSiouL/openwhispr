import { useEffect, useRef, useState } from "react";

// The original renderer remains the owner of recording, policy and rich UI.
// GTK receives presentation and sends the same actions as the floating pill.
export function useWaylandOverlay({ snapshot, onAction, getAudioLevel, isRecording }) {
  const [enabled, setEnabled] = useState(false);
  const actionRef = useRef(onAction);
  actionRef.current = onAction;
  const signature = JSON.stringify(snapshot);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getWaylandOverlayEnabled) return undefined;
    let disposed = false;
    void api.getWaylandOverlayEnabled().then((value) => {
      if (!disposed) setEnabled(value);
    });
    const unsubscribe = api.onWaylandOverlayAction((action, hovered) => {
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
      if (Number.isFinite(level)) window.electronAPI.waylandOverlayAudioLevel(level);
    };
    sample();
    const timer = setInterval(sample, 50);
    return () => clearInterval(timer);
  }, [enabled, isRecording, snapshot.rich, getAudioLevel]);
}
