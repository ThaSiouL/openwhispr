#!/usr/bin/python3
"""GTK layer-shell host for the app's shared floating-pill renderer."""
import json
import math
import os
import sys

import cairo
import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GtkLayerShell", "0.1")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gdk, GLib, Gtk, GtkLayerShell, WebKit2  # noqa: E402

MAX_MESSAGE_BYTES = 16384
MAX_STATE_BYTES = 1024 * 1024


def emit(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class Overlay:
    def __init__(self, ui_uri):
        self.ui_uri = ui_uri
        self.revision = 0
        self.rendered_revision = -1
        self.wanted_visible = False
        self.buffer = b""
        self.dragged = False
        self.drag_allowed = False
        self.manual_position = None
        self.native_dragged = False
        self.placement = None
        self.geometry = None
        self.snapshot = {}
        self.viewport = (208, 120)
        self.pill_rect = None
        self.pending_dock_anchor = None
        self.input_rects = []
        self.ui_ready = False
        self.js_busy = False
        self.pending_state = None
        self.pending_audio = None
        self.pending_drag = None
        self.failed = False
        self.window = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
        self.window.set_name("openwhispr-native-overlay")
        self.window.set_decorated(False)
        self.window.set_resizable(False)
        self.window.set_accept_focus(False)
        self.window.set_app_paintable(True)
        css = Gtk.CssProvider()
        css.load_from_data(b"#openwhispr-native-overlay { background-color: transparent; }")
        self.window.get_style_context().add_provider(css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        self.window.set_default_size(*self.viewport)
        visual = self.window.get_screen().get_rgba_visual()
        if visual:
            self.window.set_visual(visual)
        GtkLayerShell.init_for_window(self.window)
        GtkLayerShell.set_namespace(self.window, "openwhispr-dictation")
        GtkLayerShell.set_layer(self.window, GtkLayerShell.Layer.OVERLAY)
        GtkLayerShell.set_keyboard_mode(self.window, GtkLayerShell.KeyboardMode.NONE)
        GtkLayerShell.set_exclusive_zone(self.window, 0)
        GtkLayerShell.set_anchor(self.window, GtkLayerShell.Edge.BOTTOM, True)
        GtkLayerShell.set_anchor(self.window, GtkLayerShell.Edge.LEFT, True)
        self.window.connect("map-event", self.visibility_changed)
        self.window.connect("unmap-event", self.visibility_changed)
        self.window.connect("delete-event", lambda *_: True)

        manager = WebKit2.UserContentManager()
        manager.connect("script-message-received::openwhispr", self.ui_message)
        manager.register_script_message_handler("openwhispr")
        self.webview = WebKit2.WebView(
            web_context=WebKit2.WebContext.new_ephemeral(), user_content_manager=manager
        )
        self.webview.set_background_color(Gdk.RGBA(0, 0, 0, 0))
        self.webview.get_settings().set_allow_file_access_from_file_urls(ui_uri.startswith("file:"))
        self.webview.set_size_request(*self.viewport)
        self.webview.connect("context-menu", lambda *_: True)
        self.webview.connect("decide-policy", self.navigation)
        self.webview.connect("load-failed", self.load_failed)
        self.webview.connect("web-process-terminated", lambda *_: self.fail("Overlay renderer exited"))
        self.webview.connect("permission-request", self.deny_permission)
        self.webview.connect("size-allocate", lambda *_: self.acknowledge())
        self.window.add(self.webview)
        self.drag = Gtk.GestureDrag.new(self.webview)
        self.drag.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        self.drag.connect("drag-begin", self.drag_begin)
        self.drag.connect("drag-update", self.drag_update)
        self.drag.connect("drag-end", self.drag_end)
        self.webview.show()
        self.window.realize()
        self.webview.load_uri(ui_uri)
        os.set_blocking(sys.stdin.fileno(), False)
        GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, self.read)

    def fail(self, reason):
        self.failed = True
        print(reason, file=sys.stderr, flush=True)
        Gtk.main_quit()

    def load_failed(self, _view, _event, _uri, error):
        self.fail("Overlay renderer could not load: " + error.message)
        return True

    def navigation(self, _view, decision, kind):
        if kind in (WebKit2.PolicyDecisionType.NAVIGATION_ACTION,
                    WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION):
            if kind == WebKit2.PolicyDecisionType.NAVIGATION_ACTION and decision.get_navigation_action().get_request().get_uri() == self.ui_uri:
                decision.use()
            else:
                decision.ignore()
            return True
        return False

    def deny_permission(self, _view, request):
        request.deny()
        return True

    def ui_message(self, _manager, result):
        raw = result.get_js_value().to_string()
        if len(raw.encode("utf8")) > MAX_MESSAGE_BYTES:
            self.fail("Oversized overlay UI message")
            return
        try:
            message = json.loads(raw)
            event = message.get("event")
            if event == "ready" and not self.ui_ready:
                self.ui_ready = True
                emit({"event": "ready"})
            elif event == "rendered" and message.get("revision") == self.revision:
                self.rendered_revision = self.revision
                if self.wanted_visible:
                    self.window.show()
                self.acknowledge()
            elif event == "action" and self.wanted_visible:
                action = message.get("action")
                if action in ("activate", "cancel", "menu", "hover", "collapse-transcript",
                              "hold-transcript", "copy-transcript", "transcript-height"):
                    payload = {"event": "action", "revision": self.revision, "action": action}
                    if action in ("hover", "hold-transcript"):
                        if not isinstance(message.get("hovered"), bool):
                            return
                        payload["hovered"] = message["hovered"]
                    elif action == "transcript-height":
                        height, revision = message.get("height"), message.get("measurementRevision")
                        if (not isinstance(height, (int, float)) or not math.isfinite(height)
                                or not 0 < height <= 538 or type(revision) is not int or revision < 0):
                            return
                        payload.update(height=height, measurementRevision=revision)
                    emit(payload)
            elif event == "geometry":
                if message.get("revision") != self.revision:
                    return
                rects = message.get("rects", [])
                if not isinstance(rects, list) or len(rects) > 8:
                    return
                if not all(self.valid_rect(rect) for rect in rects):
                    return
                self.input_rects = rects
                pill = message.get("pill")
                self.pill_rect = pill if self.valid_rect(pill) else None
                if self.pending_dock_anchor and self.pill_rect:
                    x, y = self.pending_dock_anchor
                    self.manual_position = (
                        x - self.geometry.x - self.pill_rect["x"],
                        self.geometry.y + self.geometry.height - self.viewport[1] + self.pill_rect["y"] - y,
                    )
                    self.pending_dock_anchor = None
                    self.place()
                    self.report_position(self.snapshot["horizontalDirection"])
                self.shape_input()
        except (ValueError, TypeError, AttributeError) as error:
            self.fail("Invalid overlay UI message: " + str(error))

    @staticmethod
    def valid_rect(rect):
        return (isinstance(rect, dict)
                and all(isinstance(rect.get(key), (int, float)) and math.isfinite(rect[key])
                        and abs(rect[key]) < 10000 for key in ("x", "y", "width", "height"))
                and rect["width"] >= 0 and rect["height"] >= 0)

    def shape_input(self):
        region = cairo.Region()
        for rect in self.input_rects:
            x, y = max(0, math.floor(rect["x"])), max(0, math.floor(rect["y"]))
            right = min(self.viewport[0], math.ceil(rect["x"] + rect["width"]))
            bottom = min(self.viewport[1], math.ceil(rect["y"] + rect["height"]))
            if right > x and bottom > y:
                region.union(cairo.RectangleInt(x, y, right - x, bottom - y))
        self.window.get_window().input_shape_combine_region(region, 0, 0)
        self.webview.input_shape_combine_region(region)

    def dispatch_javascript(self):
        if not self.ui_ready or self.js_busy:
            return
        commands = []
        if self.pending_drag is not None:
            # A quick release may coalesce with drag start; keep its click guard.
            dragged, active = self.pending_drag
            if dragged:
                commands.append("window.openwhisprOverlay.setDragging(true)")
            if not active:
                commands.append("window.openwhisprOverlay.setDragging(false)")
            self.pending_drag = None
        if self.pending_state is not None:
            commands.append("window.openwhisprOverlay.applyState(" + json.dumps(self.pending_state) + ")")
            self.pending_state = None
        if self.pending_audio is not None:
            commands.append("window.openwhisprOverlay.setAudioLevel(" + json.dumps(self.pending_audio["level"]) + ")")
            self.pending_audio = None
        if not commands:
            return
        self.js_busy = True
        self.webview.evaluate_javascript(";".join(commands), -1, None, None, None, self.javascript_finished, None)

    def javascript_finished(self, view, result, _data):
        try:
            view.evaluate_javascript_finish(result)
        except GLib.Error as error:
            self.fail("Overlay renderer failed: " + error.message)
            return
        self.js_busy = False
        self.dispatch_javascript()

    def drag_begin(self, _gesture, x, y):
        self.dragged = False
        rect = self.pill_rect
        self.drag_allowed = bool(not self.snapshot.get("transcript") and rect
                                 and rect["x"] <= x <= rect["x"] + rect["width"]
                                 and rect["y"] <= y <= rect["y"] + rect["height"])
        if not self.drag_allowed:
            self.drag.set_state(Gtk.EventSequenceState.DENIED)
            return
        self.drag_origin = (self.left, self.bottom)

    def drag_update(self, _gesture, x, y):
        if not self.drag_allowed or not self.geometry or (not self.dragged and math.hypot(x, y) < 5):
            return
        self.dragged = True
        self.drag.set_state(Gtk.EventSequenceState.CLAIMED)
        self.pending_drag = (True, True)
        self.dispatch_javascript()
        self.manual_position = (self.drag_origin[0] + x, self.drag_origin[1] - y)
        self.place()

    def drag_end(self, *_):
        if self.dragged and self.geometry and self.pill_rect:
            self.native_dragged = True
            self.report_position()
        self.pending_drag = (self.dragged, False)
        self.dispatch_javascript()

    def report_position(self, direction=None):
        if direction is None:
            direction = "left" if self.placement != "center" and self.left + self.viewport[0] / 2 < self.geometry.width / 2 else "right"
        emit({"event": "position", "revision": self.revision,
              "x": self.geometry.x + self.left,
              "y": self.geometry.y + self.geometry.height - self.bottom - self.viewport[1],
              "width": self.viewport[0], "height": self.viewport[1],
              "horizontalDirection": direction})

    def place(self):
        if not self.geometry:
            return
        width, height = self.viewport
        if self.manual_position:
            left, bottom = self.manual_position
        elif self.placement == "bottom-left":
            left, bottom = 4, 4
        elif self.placement == "center":
            left, bottom = (self.geometry.width - width) / 2, 4
        else:
            left, bottom = self.geometry.width - width - 4, 4
        self.left = max(0, min(round(left), self.geometry.width - width))
        self.bottom = max(0, min(round(bottom), self.geometry.height - height))
        GtkLayerShell.set_margin(self.window, GtkLayerShell.Edge.LEFT, self.left)
        GtkLayerShell.set_margin(self.window, GtkLayerShell.Edge.BOTTOM, self.bottom)

    def set_monitor(self, target):
        display = self.window.get_display()
        monitors = [display.get_monitor(i) for i in range(display.get_n_monitors())]
        if not monitors:
            raise RuntimeError("No Wayland monitor available")
        target = target or {}
        monitor = min(monitors, key=lambda m: sum(abs(getattr(m.get_geometry(), key) - target.get(key, 0))
                                                for key in ("x", "y", "width", "height")))
        geometry = monitor.get_geometry()
        identity = (geometry.x, geometry.y, geometry.width, geometry.height)
        if identity != getattr(self, "monitor_identity", None):
            self.manual_position = None
            self.pending_dock_anchor = None
        self.monitor_identity = identity
        self.geometry = geometry
        GtkLayerShell.set_monitor(self.window, monitor)

    def visibility_changed(self, *_):
        self.shape_input()
        self.acknowledge()
        return False

    def acknowledge(self):
        visible = self.window.get_mapped()
        if visible and (self.webview.get_allocated_width(), self.webview.get_allocated_height()) != self.viewport:
            return False
        if visible == self.wanted_visible and (not visible or self.rendered_revision == self.revision):
            emit({"event": "visibility", "revision": self.revision, "visible": visible})
        return False

    def apply(self, state):
        if state.get("position") != self.placement:
            self.manual_position = None
            self.native_dragged = False
            self.pending_dock_anchor = None
        elif (getattr(self, "native_dragged", False) and self.manual_position and self.pill_rect
              and not self.snapshot.get("transcript") and not state.get("transcript")
              and self.wanted_visible and state["visible"]
              and self.snapshot.get("dock") != state.get("dock")):
            self.pending_dock_anchor = (
                self.geometry.x + self.left + self.pill_rect["x"],
                self.geometry.y + self.geometry.height - self.bottom - self.viewport[1] + self.pill_rect["y"],
            )
        self.snapshot = state
        self.revision = state["revision"]
        self.wanted_visible = state["visible"]
        self.placement = state.get("position")
        self.set_monitor(state.get("monitor"))
        viewport = state.get("viewport", {"width": 208, "height": 120})
        self.viewport = (viewport["width"], viewport["height"])
        bounds = state.get("bounds")
        if bounds:
            self.manual_position = (
                bounds["x"] - self.geometry.x,
                self.geometry.y + self.geometry.height - bounds["y"] - self.viewport[1],
            )
        self.webview.set_size_request(*self.viewport)
        self.window.resize(*self.viewport)
        self.place()
        self.pending_state = state
        self.dispatch_javascript()
        if not self.wanted_visible:
            self.window.hide()
            self.acknowledge()

    def read(self, _fd, condition):
        if condition & GLib.IO_ERR:
            Gtk.main_quit()
            return False
        try:
            chunk = os.read(sys.stdin.fileno(), 4096)
            if not chunk:
                Gtk.main_quit()
                return False
            self.buffer += chunk
            while b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                if len(line) > MAX_STATE_BYTES:
                    raise ValueError("Oversized overlay message")
                message = json.loads(line)
                if message.get("type") == "state":
                    self.apply(message)
                elif message.get("type") == "audio":
                    level = message.get("level", 0)
                    if level is None or (isinstance(level, (int, float)) and math.isfinite(level)):
                        self.pending_audio = {"level": None if level is None else max(0, min(1, level))}
                        self.dispatch_javascript()
            if len(self.buffer) > MAX_STATE_BYTES:
                raise ValueError("Oversized overlay message")
        except (ValueError, TypeError, KeyError, GLib.Error) as error:
            self.fail("Invalid overlay message: " + str(error))
            return False
        return True


if __name__ == "__main__":
    initialized, _ = Gtk.init_check(None)
    if not initialized or not GtkLayerShell.is_supported():
        sys.exit("GTK Wayland layer-shell is unavailable")
    if len(sys.argv) != 2:
        sys.exit("Expected the local overlay UI URI")
    overlay = Overlay(sys.argv[1])
    Gtk.main()
    overlay.window.destroy()
    sys.exit(1 if overlay.failed else 0)
