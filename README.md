# Circumference: Naked & Uninsured (2.5D)

Work-in-progress 2.5D version of the turn-based, procedurally generated planet roguelike. The original ASCII version is included under `classic/` and lives on `main`.

**Play:** https://gozarcripp.github.io/circumference/2.5d/

## 3D (first-person) — work in progress

This branch renders the world in first-person 3D with Three.js (vendored in `vendor/`). Add `?view=2.5d` to the URL for the isometric view; it is also the automatic fallback when WebGL is unavailable.

Keys: W/S or ↑/↓ walk forward/back, A/D or ←/→ turn 90° (Shift = 45°), Q/E step diagonally ahead, Z/C sidestep, Space waits. Drag to look around, tap to inspect, double-tap to walk there.

## Run locally

    python3 -m http.server

Then open http://localhost:8000. Browsers block modules opened straight from a file, so use a server.

Feedback and bug reports are welcome in Issues.
