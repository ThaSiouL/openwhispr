const { spawn } = require("child_process");
const path = require("path");

const MAX_MESSAGE_BYTES = 16384;
const ACTIONS = new Set(["activate", "cancel", "menu", "hover"]);
const STATES = new Set(["idle", "hover", "recording", "processing", "thinking", "unavailable"]);

function isWaylandOverlayEnabled(platform = process.platform, env = process.env) {
  return (
    platform === "linux" &&
    env.OPENWHISPR_WAYLAND_OVERLAY === "gtk" &&
    Boolean(env.WAYLAND_DISPLAY) &&
    Boolean(env.DISPLAY)
  );
}

// Only presentation crosses this pipe. Audio, transcript text and credentials
// remain in Electron; each incoming renderer message has a fixed maximum size.
function normalizeOverlaySnapshot(value) {
  if (!value || typeof value !== "object" || !STATES.has(value.state)) return null;
  const snapshot = { state: value.state };
  for (const key of [
    "rich",
    "suppressed",
    "expanded",
    "agentMode",
    "interactive",
    "cancelVisible",
  ]) {
    if (typeof value[key] !== "boolean") return null;
    snapshot[key] = value[key];
  }
  if (
    !value.labels ||
    typeof value.labels.tooltip !== "string" ||
    typeof value.labels.cancel !== "string" ||
    value.labels.tooltip.length > 512 ||
    value.labels.cancel.length > 512
  ) {
    return null;
  }
  snapshot.labels = { tooltip: value.labels.tooltip, cancel: value.labels.cancel };
  return snapshot;
}

class WaylandOverlay {
  constructor({
    scriptPath,
    onReady = () => {},
    onVisibility = () => {},
    onAction = () => {},
    onPosition = () => {},
    onFailure = () => {},
    spawnProcess = spawn,
    timeoutMs = 3000,
  }) {
    this.callbacks = { onReady, onVisibility, onAction, onPosition, onFailure };
    this.scriptPath = scriptPath;
    this.spawnProcess = spawnProcess;
    this.timeoutMs = timeoutMs;
    this.ready = false;
    this.child = null;
    this.revision = 0;
    this.lastState = null;
    this.pendingState = null;
    this.blocked = false;
    this.output = "";
    this.lastAudioAt = 0;
  }

  start() {
    if (this.child) return;
    this.stopped = false;
    try {
      this.child = this.spawnProcess("/usr/bin/python3", ["-u", this.scriptPath], {
        env: { ...process.env, GDK_BACKEND: "wayland" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      this._fail(error.message);
      return;
    }
    const child = this.child;
    child.on("error", (error) => this._fail(error.message));
    child.on("exit", () => {
      if (this.child === child) this._fail("GTK overlay exited");
    });
    child.stdin.on("error", (error) => this._fail(error.message));
    child.stdin.on("drain", () => {
      this.blocked = false;
      this._flush();
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._read(chunk));
    child.stdout.on("end", () => this._fail("GTK overlay output closed"));
    // Drain diagnostics without accumulating potentially unbounded output.
    child.stderr.resume();
    this.timer = setTimeout(() => this._fail("GTK overlay startup timed out"), this.timeoutMs);
    this.timer.unref?.();
  }

  _read(chunk) {
    if (this.stopped) return;
    this.output += chunk;
    if (Buffer.byteLength(this.output) > MAX_MESSAGE_BYTES) {
      this._fail("GTK overlay sent an oversized message");
      return;
    }
    let newline;
    while ((newline = this.output.indexOf("\n")) !== -1) {
      const line = this.output.slice(0, newline);
      this.output = this.output.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this._fail("GTK overlay sent invalid JSON");
        return;
      }
      if (!message || typeof message !== "object") {
        this._fail("GTK overlay sent an invalid message");
        return;
      }
      if (message.event === "ready" && !this.ready) {
        clearTimeout(this.timer);
        this.ready = true;
        this.callbacks.onReady();
      } else if (
        message.event === "visibility" &&
        message.revision === this.revision &&
        typeof message.visible === "boolean"
      ) {
        clearTimeout(this.ackTimer);
        this.callbacks.onVisibility(message.visible);
      } else if (
        message.event === "action" &&
        ACTIONS.has(message.action) &&
        this.lastState?.visible &&
        message.revision === this.revision
      ) {
        if (message.action === "hover" && typeof message.hovered !== "boolean") continue;
        this.callbacks.onAction(message.action, message.hovered);
      } else if (
        message.event === "position" &&
        this.lastState?.visible &&
        message.revision === this.revision &&
        [message.x, message.y, message.width, message.height].every(
          (value) => Number.isFinite(value) && Math.abs(value) < 100000
        ) &&
        message.width > 0 &&
        message.height > 0
      ) {
        this.callbacks.onPosition(message);
      }
    }
  }

  update(state) {
    if (!this.ready || !this.child) return;
    const signature = JSON.stringify(state);
    if (signature === this.signature) return;
    this.signature = signature;
    this.lastState = state;
    this.pendingState = { type: "state", revision: ++this.revision, ...state };
    clearTimeout(this.ackTimer);
    this.ackTimer = setTimeout(() => this._fail("GTK overlay stopped responding"), this.timeoutMs);
    this.ackTimer.unref?.();
    this._flush();
  }

  _write(message) {
    if (!this.child || this.blocked) return false;
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) {
      this._fail("GTK overlay state is too large");
      return false;
    }
    this.blocked = !this.child.stdin.write(line);
    return true;
  }

  _flush() {
    if (!this.pendingState || this.blocked) return;
    const state = this.pendingState;
    this.pendingState = null;
    this._write(state);
  }

  audio(level, now = Date.now()) {
    if (
      !this.ready ||
      !this.lastState?.visible ||
      this.blocked ||
      this.pendingState ||
      now - this.lastAudioAt < 50 ||
      !Number.isFinite(level)
    ) {
      return;
    }
    this.lastAudioAt = now;
    this._write({ type: "audio", level: Math.max(0, Math.min(1, level)) });
  }

  _fail(reason) {
    if (this.stopped) return;
    this.stop();
    this.callbacks.onFailure(reason);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.ackTimer);
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.pendingState = null;
    if (child) {
      child.stdin.destroy();
      child.kill();
    }
  }
}

function overlayScriptPath(app) {
  return app.isPackaged
    ? path.join(process.resourcesPath, "linux", "wayland-overlay.py")
    : path.join(__dirname, "..", "..", "resources", "linux", "wayland-overlay.py");
}

module.exports = {
  WaylandOverlay,
  isWaylandOverlayEnabled,
  normalizeOverlaySnapshot,
  overlayScriptPath,
};
