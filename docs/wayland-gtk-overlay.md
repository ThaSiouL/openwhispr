# Optional GTK floating control on Wayland

Set `OPENWHISPR_WAYLAND_OVERLAY=gtk` to replace the floating dictation control with a native GTK3 layer-shell window. The Electron application continues to run through XWayland. Both `WAYLAND_DISPLAY` and `DISPLAY` must be available.

This is an opt-in implementation for compositors supporting `zwlr_layer_shell_v1`, including niri and wlroots compositors. GNOME does not provide that protocol. Missing Python/GI dependencies, an unsupported compositor, a startup timeout, or a helper failure restore the existing Electron control. A failed helper is not restarted repeatedly; restart the app to try it again.

## Dependencies

The helper uses the system `/usr/bin/python3`, PyGObject with Cairo bindings, GTK3, the GTK3 GtkLayerShell introspection typelib, and WebKit2GTK 4.1. These are optional runtime dependencies; Python packages from pip do not replace the distribution's GTK/GI libraries.

For Debian/Ubuntu distributions providing these packages:

```sh
sudo apt install python3-gi python3-gi-cairo gir1.2-gtk-3.0 gir1.2-gtklayershell-0.1 gir1.2-webkit2-4.1
```

For Arch Linux:

```sh
sudo pacman -S python-gobject python-cairo gtk3 gtk-layer-shell webkit2gtk-4.1
```

Check the imports without starting a window:

```sh
/usr/bin/python3 -c 'import gi; gi.require_version("Gtk", "3.0"); gi.require_version("GtkLayerShell", "0.1"); gi.require_version("WebKit2", "4.1"); from gi.repository import Gtk, GtkLayerShell, WebKit2'
```

The Python helper is packaged as `resources/linux/wayland-overlay.py` outside ASAR. Its WebView loads the standalone renderer from `src/dist/wayland-overlay/wayland-overlay.html`, with all scripts, styles and fonts stored locally. It needs no added npm dependency or native compilation. Flatpak/container distributions must provide the dependencies inside their own runtime; host Python packages are insufficient there.

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

- Click the pill to start or stop dictation. Processing/thinking retain the existing activation rules.
- Hover during recording or processing to expose the original fused Cancel control. Microphone availability, processing and assistant thinking use the same appearance as the Electron pill.
- Drag the pill to move the native control within its current monitor. Moving more than five pixels suppresses the release click. Placement is kept for that app session. Changing the configured starting position resets it.
- Right-click to open the existing Electron command menu. Its listening, assistant, meeting and Hide for now actions retain their existing policy checks.
- Hotkeys, tray settings access, translation, push-to-talk and auto-hide continue to use the existing application behavior.

The recording renderer stays loaded while its window is hidden. Live transcript, assistant panels, error cards, notifications and the command menu remain in Electron. GTK acknowledges mapping before Electron hides its floating control; Electron returns after GTK acknowledges hiding. Plain dictation while the assistant is open still uses the existing Electron companion pill.

The native window hosts the original React `VoicePill`, `LiquidCancelButton` and `PillTooltip`, using `index.css` and its shared dictation styles. It keeps the original 208×120 transparent viewport, 12-pixel dock insets, 40×40 idle logo and 98×36 recording pill. The identity morph, eleven-bar waveform, fused cancel, hover chevron and tooltip come from those shared components. The recording renderer supplies the current theme, reduced-motion preference, labels and live microphone levels; the native page does not simulate audio or own recording state. Reduced motion disables page transitions and tells the shared components' JavaScript animations to snap too.

`npm run build:renderer` builds both the normal renderer and the standalone page. During development the page is available at `/wayland-overlay.html` on the existing Vite server. The WebView bridge exposes `window.openwhisprOverlay.applyState`, `setAudioLevel` and `setDragging`; it sends only readiness, existing control actions and measured control/tooltip bounds to the helper. Geometry updates follow size and tooltip changes, then stop when the UI settles. GTK uses those bounds for its Wayland input region so transparent window space stays click-through.

Monitor selection matches GTK monitor geometry against Electron's display geometry; verify multi-monitor placement and dragging on the intended compositor, especially with mixed scaling. The native layer window does not offer Electron's content-protection mechanism, so it can appear in screen capture. WebKit and Chromium can differ slightly in font rasterization and compositing even though they render the same component code and styles.

## Checks

```sh
node test/helpers/waylandOverlay.test.js
node test/helpers/windowManagerWaylandOverlay.test.js
python3 -m py_compile resources/linux/wayland-overlay.py
python3 test/native/wayland_overlay_geometry.py
```

On a supported compositor, check idle, microphone warm-up, recording, live waveform activity, stop/processing, cancellation, microphone reconnect, right-click actions, error/retry, auto-hide, panel opening/closing, onboarding, multiple monitors and application exit. Compare light/dark themes, reduced motion, tooltips, both dock directions and drag release behavior against the Electron pill. Kill only the test helper while recording to verify the Electron fallback. Start with a missing dependency or unsupported compositor to check startup fallback. Confirm no orphan helper remains after reload or exit.
