import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { VoicePill, type VoicePillState } from "./VoicePill";
import { LiquidCancelButton } from "./LiquidCancelButton";
import { PillTooltip } from "./PillTooltip";
import { VoiceModePanelCore, type VoiceModePanelStage } from "./VoiceModePanelCore";
import { LiveTranscriptPanel, type LiveTranscriptPhase } from "./LiveTranscriptPanel";
import {
  VOICE_PILL_FOOTPRINT,
  isVoicePillActivationKey,
} from "../../helpers/voicePillPresentation";

interface OverlaySnapshot {
  revision?: number;
  state: VoicePillState;
  expanded: boolean;
  agentMode: boolean;
  interactive: boolean;
  cancelVisible: boolean;
  collapseToLogo: boolean;
  waveformVisible: boolean;
  showExpandChevron: boolean;
  horizontalDirection: "left" | "right";
  dock: string;
  language?: string;
  direction?: "ltr" | "rtl";
  theme: "light" | "dark";
  reducedMotion: boolean;
  labels: { tooltip: string; cancel: string };
  transcript?: {
    open: boolean;
    text: string;
    measurementText: string;
    phase: LiveTranscriptPhase;
    processing: boolean;
    controlsVisible: boolean;
    contentVisible: boolean;
    stage: VoiceModePanelStage;
    label: string;
    measurementRevision: number;
    copied: boolean;
    labels: { waitingForInput: string; copy: string; copied: string; collapse: string };
  } | null;
}

declare global {
  interface Window {
    openwhisprOverlay?: {
      applyState: (snapshot: OverlaySnapshot) => void;
      setAudioLevel: (level: number | null) => void;
      setDragging: (dragged: boolean) => void;
    };
    webkit?: {
      messageHandlers?: { openwhispr?: { postMessage: (message: string) => void } };
    };
  }
}

const INITIAL_STATE: OverlaySnapshot = {
  state: "idle",
  expanded: false,
  agentMode: false,
  interactive: true,
  cancelVisible: false,
  collapseToLogo: false,
  waveformVisible: true,
  showExpandChevron: false,
  horizontalDirection: "right",
  dock: "bottom-right",
  theme: "light",
  reducedMotion: false,
  labels: { tooltip: "", cancel: "" },
};

function postMessage(message: object) {
  window.webkit?.messageHandlers?.openwhispr?.postMessage(JSON.stringify(message));
}

/** The recording renderer owns state and commands; this document only paints it. */
export function WaylandOverlay() {
  const [snapshot, setSnapshot] = useState(INITIAL_STATE);
  const [dragging, setDragging] = useState(false);
  const [cancelSkinActive, setCancelSkinActive] = useState(false);
  const audioLevel = useRef<number | null>(null);
  const hasDragged = useRef(false);
  const presenceRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const refreshGeometry = useRef<(duration?: number) => void>(() => {});
  const reportGeometry = useRef(() => {});
  const geometryRevision = useRef<number | undefined>(undefined);
  const getAudioLevel = useCallback(() => audioLevel.current, []);

  useLayoutEffect(() => {
    const presence = presenceRef.current!;
    const pill = pillRef.current!;
    const root = rootRef.current!;
    let frame = 0;
    let until = 0;
    let lastGeometry = "";
    let tooltip: Element | null = null;
    let panel: Element | null = null;
    const rect = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      // Avoid pipe traffic for subpixel layout noise while retaining native
      // input-region precision throughout the pill's size transition.
      const rounded = (value: number) => Math.round(value * 100) / 100;
      return {
        x: rounded(bounds.x),
        y: rounded(bounds.y),
        width: rounded(bounds.width),
        height: rounded(bounds.height),
      };
    };
    const measure = (now: number) => {
      frame = 0;
      const rects = [rect(presence)];
      if (tooltip) rects.push(rect(tooltip));
      const visiblePanel = root.querySelector(
        ".live-transcript-panel.expanding-panel-surface-open"
      );
      if (visiblePanel) rects.push(rect(visiblePanel));
      const geometry = JSON.stringify({
        event: "geometry",
        revision: geometryRevision.current,
        rects,
        pill: rect(pill),
      });
      if (geometry !== lastGeometry) {
        lastGeometry = geometry;
        window.webkit?.messageHandlers?.openwhispr?.postMessage(geometry);
      }
      if (now < until) frame = requestAnimationFrame(measure);
    };
    const schedule = (duration = 0) => {
      until = Math.max(until, performance.now() + duration);
      if (!frame) frame = requestAnimationFrame(measure);
    };
    refreshGeometry.current = schedule;
    reportGeometry.current = () => {
      cancelAnimationFrame(frame);
      measure(performance.now());
    };
    const resize = new ResizeObserver(() => schedule());
    resize.observe(presence);
    resize.observe(pill);
    const mutation = new MutationObserver(() => {
      const next = root.querySelector("[data-pill-tooltip]");
      if (next !== tooltip) {
        if (tooltip) resize.unobserve(tooltip);
        tooltip = next;
        if (tooltip) resize.observe(tooltip);
      }
      const nextPanel = root.querySelector(".live-transcript-panel");
      if (nextPanel !== panel) {
        if (panel) resize.unobserve(panel);
        panel = nextPanel;
        if (panel) resize.observe(panel);
      }
      schedule(200);
    });
    mutation.observe(root, { childList: true, subtree: true });
    const onResize = () => schedule();
    window.addEventListener("resize", onResize);
    window.openwhisprOverlay = {
      applyState(next) {
        document.documentElement.classList.toggle("dark", next.theme === "dark");
        document.documentElement.dataset.overlayReducedMotion = String(next.reducedMotion);
        document.documentElement.lang = next.language || "en";
        document.documentElement.dir = next.direction || "ltr";
        setSnapshot(next);
        schedule(650);
      },
      setAudioLevel(level) {
        audioLevel.current = typeof level === "number" && Number.isFinite(level) ? level : null;
      },
      setDragging(dragged) {
        if (dragged) hasDragged.current = true;
        setDragging(dragged);
      },
    };
    schedule();
    postMessage({ event: "ready" });
    return () => {
      delete window.openwhisprOverlay;
      refreshGeometry.current = () => {};
      reportGeometry.current = () => {};
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", onResize);
      cancelAnimationFrame(frame);
    };
  }, []);

  useLayoutEffect(() => {
    geometryRevision.current = snapshot.revision;
    refreshGeometry.current(650);
    reportGeometry.current();
    if (typeof snapshot.revision === "number") {
      postMessage({ event: "rendered", revision: snapshot.revision });
    }
  }, [snapshot]);

  const activate = () => {
    if (snapshot.interactive && !hasDragged.current) {
      postMessage({ event: "action", action: "activate" });
    }
  };
  const compact =
    !snapshot.collapseToLogo &&
    snapshot.state !== "thinking" &&
    (snapshot.state === "recording" || snapshot.expanded);
  const footprint = compact ? VOICE_PILL_FOOTPRINT.recording : VOICE_PILL_FOOTPRINT.idle;
  const transcript = snapshot.transcript;
  const requestTranscriptHeight = useCallback(
    (height: number, measurementRevision?: string | number | null) => {
      postMessage({ event: "action", action: "transcript-height", height, measurementRevision });
    },
    []
  );

  return (
    <div ref={rootRef} className="dictation-window">
      <div
        className={`voice-pill-position voice-pill-position-${snapshot.dock} fixed z-50`}
        // GTK compensates a drag's dock change from these final local bounds.
        style={{ transition: hasDragged.current ? "none" : undefined }}
      >
        <div
          ref={presenceRef}
          className="assistant-pill-presence relative flex items-center"
          data-horizontal-direction={snapshot.horizontalDirection}
          onPointerDownCapture={() => {
            hasDragged.current = false;
            setDragging(false);
          }}
          onMouseEnter={() => postMessage({ event: "action", action: "hover", hovered: true })}
          onMouseLeave={() => postMessage({ event: "action", action: "hover", hovered: false })}
        >
          <PillTooltip
            content={snapshot.labels.tooltip}
            align={snapshot.dock === "center" ? "center" : snapshot.horizontalDirection}
            disabled={Boolean(transcript)}
          >
            <VoicePill
              ref={pillRef}
              variant={transcript?.open ? "panel" : "floating"}
              state={snapshot.state}
              expanded={snapshot.expanded}
              collapseToLogo={snapshot.collapseToLogo}
              waveformVisible={snapshot.waveformVisible}
              waveformOnlyWhileRecording={Boolean(transcript)}
              integratedWithPanel={transcript?.open}
              liquidFused={cancelSkinActive}
              agentMode={snapshot.agentMode}
              showExpandChevron={snapshot.showExpandChevron}
              getAudioLevel={getAudioLevel}
              isDragging={dragging}
              horizontalDirection={snapshot.horizontalDirection}
              role={snapshot.interactive ? "button" : "status"}
              tabIndex={snapshot.interactive ? 0 : undefined}
              aria-label={snapshot.labels.tooltip}
              onClick={(event) => {
                event.preventDefault();
                activate();
              }}
              onKeyDown={(event) => {
                if (event.repeat || !isVoicePillActivationKey(event.key)) return;
                event.preventDefault();
                activate();
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                if (!hasDragged.current) postMessage({ event: "action", action: "menu" });
              }}
            />
          </PillTooltip>
          <LiquidCancelButton
            visible={snapshot.cancelVisible}
            fused={!transcript?.open}
            pillWidth={footprint.width}
            pillHeight={footprint.height}
            pillState={snapshot.state}
            ariaLabel={snapshot.labels.cancel}
            onCancel={() => {
              if (!hasDragged.current) postMessage({ event: "action", action: "cancel" });
            }}
            onFusedSkinChange={setCancelSkinActive}
          />
        </div>
      </div>
      <VoiceModePanelCore
        mode={transcript ? "live-transcript" : null}
        open={Boolean(transcript?.open)}
        stage={transcript?.stage}
        horizontalDirection={snapshot.horizontalDirection}
        label={transcript?.label}
        measurementRevision={transcript?.measurementRevision}
        onPreferredHeightChange={requestTranscriptHeight}
      >
        {transcript && (
          <LiveTranscriptPanel
            text={transcript.text}
            measurementText={transcript.measurementText}
            phase={transcript.phase}
            processing={transcript.processing}
            controlsVisible={transcript.controlsVisible}
            contentVisible={transcript.contentVisible}
            labels={{ label: transcript.label, ...transcript.labels }}
            copied={transcript.copied}
            onCopy={() => postMessage({ event: "action", action: "copy-transcript" })}
            onCollapse={() => postMessage({ event: "action", action: "collapse-transcript" })}
            onHoldChange={(held) =>
              postMessage({ event: "action", action: "hold-transcript", hovered: held })
            }
          />
        )}
      </VoiceModePanelCore>
    </div>
  );
}
