# Optional GTK floating control on Wayland

Set `OPENWHISPR_WAYLAND_OVERLAY=gtk` to replace the floating dictation control with a native GTK3 layer-shell window. The Electron application continues to run through XWayland. Both `WAYLAND_DISPLAY` and `DISPLAY` must be available.

This is an opt-in implementation for compositors supporting `zwlr_layer_shell_v1`, including niri and wlroots compositors. GNOME does not provide that protocol. Missing Python/GI dependencies, an unsupported compositor, a startup timeout, or a helper failure restore the existing Electron control. A failed helper is not restarted repeatedly; restart the app to try it again.

## Dependencies

The helper uses the system `/usr/bin/python3`, PyGObject, GTK3, and the GTK3 GtkLayerShell introspection typelib. These are optional runtime dependencies; Python packages from pip do not replace the distribution's GTK/GI libraries.

For Debian/Ubuntu distributions providing these packages:

```sh
sudo apt install python3-gi gir1.2-gtk-3.0 gir1.2-gtklayershell-0.1
```

For Arch Linux:

```sh
sudo pacman -S python-gobject gtk3 gtk-layer-shell
```

Check the imports without starting a window:

```sh
/usr/bin/python3 -c 'import gi; gi.require_version("Gtk", "3.0"); gi.require_version("GtkLayerShell", "0.1"); from gi.repository import Gtk, GtkLayerShell'
```

The Python helper is packaged as `resources/linux/wayland-overlay.py` outside ASAR. It needs no added npm dependency or native compilation. Flatpak/container distributions must provide the dependencies inside their own runtime; host Python packages are insufficient there.

## Isolated fork testing

After installing the project's existing dependencies with Node 24, build the renderer and run the isolated test launcher:

```sh
npm run build:renderer
node scripts/run-wayland-test.js
```

The launcher enables the GTK control and creates its own development settings profile under `/tmp/openwhispr-wayland-test-<uid>/config`, with a separate cache root. It links existing model files individually from the normal model cache. Model directories remain separate, so adding or deleting a model in the test profile does not modify the normal model directory. It does not copy production tokens/settings or replace the installed application. Complete onboarding or select an existing local model within that test profile.

The test profile starts with F13–F16 shortcuts and bottom-left placement. Its data/state directories and writable Qdrant index are separate too. Override `OPENWHISPR_TEST_PROFILE` to keep the test profile elsewhere, or `OPENWHISPR_TEST_MODELS` to select a different existing model cache. Linked model contents are shared; do not overwrite model files while testing.

For an existing development profile, the direct opt-in is:

```sh
OPENWHISPR_WAYLAND_OVERLAY=gtk npm run dev
```

That direct command uses the normal development profile. Use the isolated launcher when checking this fork against an installed copy.

## Controls and handoff

- Click the microphone to start or stop dictation. Processing/thinking retain the existing activation rules.
- Hover during recording or processing to expose Cancel. A disconnected microphone shows a warning; processing and assistant thinking show a spinner.
- Drag the microphone to move the native control within its current monitor. Placement is kept for that app session. Changing the configured starting position resets it.
- Right-click to open the existing Electron command menu. Its listening, assistant, meeting and Hide for now actions retain their existing policy checks.
- Hotkeys, tray settings access, translation, push-to-talk and auto-hide continue to use the existing application behavior.

The recording renderer stays loaded while its window is hidden. Live transcript, assistant panels, error cards, notifications and the command menu remain in Electron. GTK acknowledges mapping before Electron hides its floating control; Electron returns after GTK acknowledges hiding. Plain dictation while the assistant is open still uses the existing Electron companion pill.

GTK follows the system theme. It does not reproduce the React control's liquid animations or waveform. The compact control uses a level meter. Monitor selection matches GTK monitor geometry against Electron's display geometry; verify multi-monitor placement and dragging on the intended compositor, especially with mixed scaling. The native layer window does not offer Electron's content-protection mechanism, so it can appear in screen capture.

## Checks

```sh
node test/helpers/waylandOverlay.test.js
node test/helpers/windowManagerWaylandOverlay.test.js
python3 -m py_compile resources/linux/wayland-overlay.py
```

On a supported compositor, check idle, microphone warm-up, recording, meter activity, stop/processing, cancellation, microphone reconnect, right-click actions, error/retry, auto-hide, panel opening/closing, onboarding, multiple monitors and application exit. Kill only the test helper while recording to verify the Electron fallback. Start with a missing dependency or unsupported compositor to check startup fallback. Confirm no orphan helper remains after reload or exit.
