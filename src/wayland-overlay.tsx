import { createRoot } from "react-dom/client";
import { WaylandOverlay } from "./components/dictation/WaylandOverlay";
import "./brandFonts";
import "./assets/fonts/noto-sans.css";
import "./index.css";
import "./wayland-overlay.css";

// The native host sends the renderer's preference. The shared components also
// query matchMedia for their JS-driven morphs, so give this isolated document
// the same answer as its CSS override without changing those components.
const matchMedia = window.matchMedia.bind(window);
window.matchMedia = (query) => {
  const media = matchMedia(query);
  if (query !== "(prefers-reduced-motion: reduce)") return media;
  return new Proxy(media, {
    get(target, property) {
      if (property === "matches") {
        return document.documentElement.dataset.overlayReducedMotion === "true";
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

createRoot(document.getElementById("root")!).render(<WaylandOverlay />);
