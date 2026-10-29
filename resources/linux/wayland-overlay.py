#!/usr/bin/python3
"""Optional GTK3 layer-shell floating control. JSON lines on stdin/stdout."""
import json
import math
import os
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("GtkLayerShell", "0.1")
from gi.repository import Gdk, GLib, Gtk, GtkLayerShell  # noqa: E402

MAX_MESSAGE_BYTES = 16384


def emit(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class Overlay:
    def __init__(self):
        self.revision = 0
        self.wanted_visible = False
        self.buffer = b""
        self.dragged = False
        self.manual_position = None
        self.placement = None
        self.geometry = None
        self.snapshot = {}
        self.window = Gtk.Window(type=Gtk.WindowType.TOPLEVEL)
        self.window.set_name("openwhispr-native-overlay")
        self.window.set_decorated(False)
        self.window.set_resizable(False)
        self.window.set_accept_focus(False)
        self.window.set_app_paintable(True)
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
        self.window.connect("size-allocate", lambda *_: self.place())

        css = Gtk.CssProvider()
        css.load_from_data(b"""
          #openwhispr-native-overlay { background-color: transparent; }
          #openwhispr-native-overlay button { border-radius: 20px; min-height: 28px; padding: 5px 9px; }
          #openwhispr-native-overlay .recording { border-color: @theme_selected_bg_color; }
          #openwhispr-native-overlay .unavailable { opacity: 0.65; }
          #openwhispr-native-overlay .thinking { border-color: @theme_selected_bg_color; }
        """)
        Gtk.StyleContext.add_provider_for_screen(
            self.window.get_screen(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
        )
        outer = Gtk.EventBox()
        outer.set_visible_window(False)
        outer.add_events(Gdk.EventMask.ENTER_NOTIFY_MASK | Gdk.EventMask.LEAVE_NOTIFY_MASK)
        outer.connect("enter-notify-event", self.hover, True)
        outer.connect("leave-notify-event", self.hover, False)
        self.box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        outer.add(self.box)
        self.window.add(outer)
        self.button = Gtk.Button()
        self.button.set_can_focus(False)
        self.button.connect("clicked", self.activate)
        self.button.connect("button-press-event", self.press)
        content = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        self.icon = Gtk.Image.new_from_icon_name("audio-input-microphone-symbolic", Gtk.IconSize.BUTTON)
        self.spinner = Gtk.Spinner()
        self.spinner.set_no_show_all(True)
        self.meter = Gtk.LevelBar.new_for_interval(0, 1)
        self.meter.set_size_request(48, 8)
        self.meter.set_valign(Gtk.Align.CENTER)
        self.meter.set_no_show_all(True)
        content.pack_start(self.icon, False, False, 0)
        content.pack_start(self.spinner, False, False, 0)
        content.pack_start(self.meter, False, False, 0)
        self.button.add(content)
        self.box.pack_start(self.button, False, False, 0)
        self.cancel = Gtk.Button.new_from_icon_name("window-close-symbolic", Gtk.IconSize.BUTTON)
        self.cancel.set_can_focus(False)
        self.cancel.set_no_show_all(True)
        self.cancel.connect("clicked", lambda *_: self.action("cancel"))
        self.box.pack_start(self.cancel, False, False, 0)
        # Layer surfaces cannot use xdg_toplevel's move request. Move by margins
        # during a pointer drag; keep the chosen monitor until settings changes.
        self.drag = Gtk.GestureDrag.new(self.button)
        self.drag.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        self.drag.connect("drag-begin", self.drag_begin)
        self.drag.connect("drag-update", self.drag_update)
        self.drag.connect("drag-end", self.drag_end)
        outer.show_all()
        os.set_blocking(sys.stdin.fileno(), False)
        GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, self.read)
        emit({"event": "ready"})

    def action(self, name, **extra):
        if self.wanted_visible:
            emit({"event": "action", "revision": self.revision, "action": name, **extra})

    def activate(self, *_):
        if not self.dragged and self.snapshot.get("interactive"):
            self.action("activate")

    def press(self, _button, event):
        if event.button == 3:
            self.action("menu")
            return True
        return False

    def hover(self, _widget, event, hovered):
        if event.detail != Gdk.NotifyType.INFERIOR:
            self.action("hover", hovered=hovered)
        return False

    def drag_begin(self, *_):
        self.dragged = False
        self.drag_origin = (self.left, self.bottom)

    def drag_update(self, _gesture, x, y):
        if not self.geometry or (not self.dragged and math.hypot(x, y) < 5):
            return
        self.dragged = True
        self.drag.set_state(Gtk.EventSequenceState.CLAIMED)
        self.manual_position = (self.drag_origin[0] + x, self.drag_origin[1] - y)
        self.place()

    def drag_end(self, *_):
        if self.dragged and self.geometry:
            width, height = self.window.get_size()
            emit({"event": "position", "revision": self.revision,
                  "x": self.geometry.x + self.left,
                  "y": self.geometry.y + self.geometry.height - self.bottom - height,
                  "width": width, "height": height})

    def place(self):
        if not self.geometry:
            return
        width = max(1, self.box.get_preferred_width()[1])
        height = max(1, self.box.get_preferred_height()[1])
        if self.manual_position:
            left, bottom = self.manual_position
        elif self.placement == "bottom-left":
            left, bottom = 20, 20
        elif self.placement == "center":
            left = (self.geometry.width - width) / 2
            bottom = 20
        else:
            left, bottom = self.geometry.width - width - 20, 20
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
        monitor = min(monitors, key=lambda m: (
            abs(m.get_geometry().x - target.get("x", 0))
            + abs(m.get_geometry().y - target.get("y", 0))
            + abs(m.get_geometry().width - target.get("width", 0))
            + abs(m.get_geometry().height - target.get("height", 0))
        ))
        geometry = monitor.get_geometry()
        identity = (geometry.x, geometry.y, geometry.width, geometry.height)
        if identity != getattr(self, "monitor_identity", None):
            self.manual_position = None
        self.monitor_identity = identity
        self.geometry = geometry
        GtkLayerShell.set_monitor(self.window, monitor)

    def visibility_changed(self, *_):
        self.acknowledge()
        return False

    def acknowledge(self):
        visible = self.window.get_mapped()
        if visible == self.wanted_visible:
            emit({"event": "visibility", "revision": self.revision, "visible": visible})
        return False

    def apply(self, state):
        self.snapshot = state
        self.revision = state["revision"]
        self.wanted_visible = state["visible"]
        if state.get("position") != self.placement:
            self.manual_position = None
        self.placement = state.get("position")
        self.set_monitor(state.get("monitor"))
        presentation = state.get("state", "idle")
        style = self.button.get_style_context()
        for name in ("idle", "hover", "recording", "processing", "thinking", "unavailable"):
            style.remove_class(name)
        style.add_class(presentation)
        busy = presentation in ("processing", "thinking")
        self.icon.set_visible(not busy)
        self.icon.set_from_icon_name(
            "dialog-warning-symbolic" if presentation == "unavailable" else "audio-input-microphone-symbolic",
            Gtk.IconSize.BUTTON,
        )
        self.spinner.set_visible(busy)
        if busy:
            self.spinner.start()
        else:
            self.spinner.stop()
        self.meter.set_visible(bool(state.get("expanded")) and not busy)
        if presentation != "recording":
            self.meter.set_value(0)
        labels = state.get("labels", {})
        self.button.set_tooltip_text(labels.get("tooltip", ""))
        self.button.get_accessible().set_name(labels.get("tooltip", ""))
        self.cancel.set_tooltip_text(labels.get("cancel", ""))
        self.cancel.get_accessible().set_name(labels.get("cancel", ""))
        self.cancel.set_visible(bool(state.get("cancelVisible")))
        self.place()
        if self.wanted_visible:
            self.window.show()
        else:
            self.window.hide()
        GLib.idle_add(self.acknowledge)

    def read(self, _fd, condition):
        if condition & GLib.IO_ERR:
            Gtk.main_quit()
            return False
        chunk = os.read(sys.stdin.fileno(), 4096)
        if not chunk:
            Gtk.main_quit()
            return False
        self.buffer += chunk
        while b"\n" in self.buffer:
            line, self.buffer = self.buffer.split(b"\n", 1)
            if len(line) > MAX_MESSAGE_BYTES:
                raise ValueError("Oversized overlay message")
            message = json.loads(line)
            if message.get("type") == "state":
                self.apply(message)
            elif message.get("type") == "audio":
                level = message.get("level", 0)
                if isinstance(level, (int, float)) and math.isfinite(level):
                    self.meter.set_value(max(0, min(1, level)))
        if len(self.buffer) > MAX_MESSAGE_BYTES:
            raise ValueError("Oversized overlay message")
        return True


if __name__ == "__main__":
    initialized, _ = Gtk.init_check(None)
    if not initialized or not GtkLayerShell.is_supported():
        sys.exit("GTK Wayland layer-shell is unavailable")
    Overlay()
    Gtk.main()
