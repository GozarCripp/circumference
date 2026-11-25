# Circumference: Naked & Uninsured (2.5D)

Work-in-progress 2.5D version of the turn-based, procedurally generated planet roguelike. The original ASCII version is included under `classic/` and lives on `main`.

**Play (3D):** https://gozarcripp.github.io/circumference/3d/ · **2.5D:** https://gozarcripp.github.io/circumference/2.5d/

## 3D (first-person) — work in progress

This branch renders the world in first-person 3D with Three.js (vendored in `vendor/`). Add `?view=2.5d` to the URL for the isometric view; it is also the automatic fallback when WebGL is unavailable.

Keys: hold W/S or ↑/↓ to glide forward/back, A/D or ←/→ to turn, Q/E to strafe; walking into a monster attacks it. Space waits. Drag to look around, tap to inspect, double-tap to walk there.

## Run locally

    python3 -m http.server

Then open http://localhost:8000. Browsers block modules opened straight from a file, so use a server.

Feedback and bug reports are welcome in Issues.
