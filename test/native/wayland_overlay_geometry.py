"""Run directly with system Python; exercises GTK-host geometry without opening windows."""
import json
from pathlib import Path
import runpy
from types import SimpleNamespace
import unittest

Overlay = runpy.run_path(str(Path(__file__).resolve().parents[2] / "resources/linux/wayland-overlay.py"))["Overlay"]


class GeometryTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.globals = Overlay.drag_end.__globals__
        self.emit = self.globals["emit"]
        self.globals["emit"] = self.events.append
        self.addCleanup(lambda: self.globals.__setitem__("emit", self.emit))
        self.host = Overlay.__new__(Overlay)
        h = self.host
        h.geometry = SimpleNamespace(x=0, y=0, width=1920, height=1080)
        h.viewport = (208, 120)
        h.left, h.bottom = 600, 4
        h.manual_position = (600, 4)
        h.snapshot = {"dock": "bottom-right", "horizontalDirection": "right"}
        h.placement = "bottom-right"
        h.revision = 1
        h.wanted_visible = True
        h.dragged = True
        h.pill_rect = {"x": 156, "y": 68, "width": 40, "height": 40}
        h.input_rects = []
        h.webview = SimpleNamespace(set_size_request=lambda *args: None)
        h.window = SimpleNamespace(resize=lambda *args: None)
        h.set_monitor = lambda *args: None
        h.dispatch_javascript = lambda: None
        h.shape_input = lambda: None
        h.place = lambda: (setattr(h, "left", round(h.manual_position[0])), setattr(h, "bottom", round(h.manual_position[1])))

    def test_dock_flip_preserves_the_dropped_pill(self):
        h = self.host
        h.apply({"revision": 2, "visible": True, "dock": "bottom-left", "horizontalDirection": "left", "position": "bottom-right"})
        message = {"event": "geometry", "revision": 2, "pill": {"x": 12, "y": 68, "width": 40, "height": 40}, "rects": []}
        result = SimpleNamespace(get_js_value=lambda: SimpleNamespace(to_string=lambda: json.dumps(message)))
        h.ui_message(None, result)
        self.assertEqual(h.left + h.pill_rect["x"], 756)
        self.assertEqual(h.bottom, 4)

    def test_drag_reports_the_viewport_instead_of_the_cancel_offset_pill(self):
        h = self.host
        h.pill_rect = {"x": 62, "y": 72, "width": 98, "height": 36}
        h.drag_end()
        position = self.events[0]
        self.assertEqual([position[key] for key in ("x", "y", "width", "height")], [600, 956, 208, 120])


if __name__ == "__main__":
    unittest.main()
