const test = require("node:test");
const assert = require("node:assert/strict");
const GnomeShortcutManager = require("../../src/helpers/gnomeShortcut");
const HyprlandShortcutManager = require("../../src/helpers/hyprlandShortcut");
const KDEShortcutManager = require("../../src/helpers/kdeShortcut");

const ENV_KEYS = [
  "XDG_SESSION_TYPE",
  "WAYLAND_DISPLAY",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_DESKTOP",
  "DESKTOP_SESSION",
  "HYPRLAND_INSTANCE_SIGNATURE",
  "SWAYSOCK",
];

function withEnvironment(environment, run) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, environment);
  try {
    run();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("shortcut managers recognize TTY-launched Wayland sessions and plain X11", () => {
  for (const [environment, expected] of [
    [{ XDG_SESSION_TYPE: "tty", WAYLAND_DISPLAY: "wayland-1" }, true],
    [{ XDG_SESSION_TYPE: "x11" }, false],
  ]) {
    withEnvironment(environment, () => {
      for (const Manager of [GnomeShortcutManager, HyprlandShortcutManager, KDEShortcutManager]) {
        assert.equal(Manager.isWayland(), expected, Manager.name);
      }
    });
  }
});

test("Hyprland shortcuts ignore a stale signature on another named desktop", () => {
  for (const desktop of ["KDE", "GNOME", "COSMIC", "niri"]) {
    withEnvironment(
      {
        XDG_SESSION_TYPE: "wayland",
        XDG_CURRENT_DESKTOP: desktop,
        HYPRLAND_INSTANCE_SIGNATURE: "stale",
      },
      () => assert.equal(HyprlandShortcutManager.isHyprland(), false, desktop)
    );
  }
});
