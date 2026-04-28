// spectral_overlay.js — M5 hover spectral preview integration.
//
// Watches piece selection (the existing showPossibleMoves flow), fetches
// the post-move spectral encoding via SpectralBridge.previewEncoding, and
// re-tints the already-visible destination meshes by intensity for the
// channel the user picked. Falls back to default rendering if the encoder
// is unavailable (chess-spectral wheel pending).
//
// Architecture: keep selectPiece() in main.js synchronous (avoids a deep
// async refactor for M5). After it calls showPossibleMoves, fire-and-forget
// bridge.previewEncoding; on resolution, walk the possibleMovesContainer
// children and update opacity. Hover coalescing lives in the bridge so
// rapid selection changes don't pile up encode_4d calls.
//
// Default behavior (channel=off OR engine unavailable): unchanged.

(function () {
  'use strict';

  const SELECTOR_ID = 'spectral-channel';
  const HINT_ID = 'spectral-hint';

  function getSelectedChannel() {
    const el = document.getElementById(SELECTOR_ID);
    return el && el.value ? el.value : 'A1';
  }

  function setHint(text, kind) {
    const el = document.getElementById(HINT_ID);
    if (!el) return;
    el.textContent = text;
    el.classList.remove('spectral-hint--ready', 'spectral-hint--unavailable');
    if (kind === 'ready') el.classList.add('spectral-hint--ready');
    if (kind === 'unavailable') el.classList.add('spectral-hint--unavailable');
  }

  // Apply intensities to the existing possibleMovesContainer children.
  // Each shadow mesh is at a board cell whose (x,y,z,w) we can recover
  // from the intensity map's keys. We match by world-space proximity to
  // the board coordinates that GameBoard.boardCoordinates returns.
  function applyIntensities(gameBoard, channelValues) {
    if (!gameBoard || !gameBoard.graphics || !gameBoard.graphics.possibleMovesContainer) {
      return;
    }
    const container = gameBoard.graphics.possibleMovesContainer;
    const meshes = container.children || [];
    if (meshes.length === 0) return;

    // Normalize intensities to [0.25, 0.95] opacity range.
    const values = channelValues
      .map((v) => v.intensity)
      .filter((v) => v !== null && Number.isFinite(v));
    let lo = 0;
    let hi = 1;
    if (values.length > 0) {
      lo = Math.min(...values);
      hi = Math.max(...values);
      if (hi - lo < 1e-9) hi = lo + 1; // avoid div-by-zero
    }

    // Build a position->intensity lookup keyed on world coords.
    const lookup = new Map();
    for (const c of channelValues) {
      const dest = c.dest;
      if (!gameBoard.boardCoordinates) continue;
      const w = gameBoard.boardCoordinates(dest.x, dest.y, dest.z, dest.w);
      if (!w) continue;
      lookup.set(`${w.x.toFixed(2)},${w.y.toFixed(2)},${w.z.toFixed(2)}`, c.intensity);
    }

    for (const mesh of meshes) {
      if (!mesh.position || !mesh.material) continue;
      const key = `${mesh.position.x.toFixed(2)},${mesh.position.y.toFixed(2)},${mesh.position.z.toFixed(2)}`;
      const intensity = lookup.get(key);
      if (intensity == null || !Number.isFinite(intensity)) continue;
      const norm = (intensity - lo) / (hi - lo);
      const opacity = 0.25 + norm * 0.7;
      // Iterate over potentially nested materials (OBJ groups can have arrays).
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (!mat) continue;
        mat.transparent = true;
        mat.opacity = opacity;
        if (mat.emissive && mat.emissiveIntensity !== undefined) {
          mat.emissiveIntensity = norm * 0.6;
        }
        if (mat.needsUpdate !== undefined) mat.needsUpdate = true;
      }
    }
  }

  // Fire previewEncoding for the given origin and apply intensities for the
  // currently-selected channel. No-ops if channel=off, no bridge, or the
  // encoder isn't installed.
  let lastRequestId = 0;
  function previewAt(origin) {
    const channel = getSelectedChannel();
    if (channel === 'off') return;
    if (typeof window === 'undefined' || !window.SpectralBridge) return;
    const myId = ++lastRequestId;
    window.SpectralBridge.previewEncoding(origin)
      .then((res) => {
        if (myId !== lastRequestId) return; // superseded by a newer hover
        if (!res || !res.ok) {
          if (res && /encoder unavailable/.test(res.reason || '')) {
            setHint('Encoder not yet installed (chess-spectral wheel pending). Default rendering.', 'unavailable');
          }
          return;
        }
        // Pick the requested channel; fall back to first available.
        const previews = res.previews || [];
        const channelValues = previews.map((p) => ({
          dest: p.dest,
          intensity: p.intensities ? (p.intensities[channel] ?? null) : null,
        }));
        const haveAny = channelValues.some((c) => c.intensity !== null);
        if (!haveAny) {
          setHint(`Channel "${channel}" not present in encoder output.`, 'unavailable');
          return;
        }
        if (typeof gameBoard !== 'undefined') {
          applyIntensities(gameBoard, channelValues);
        }
        setHint(`Showing ${channel} intensity over ${channelValues.length} destinations.`, 'ready');
      })
      .catch((err) => {
        if (err && err.message === 'superseded') return;
        console.warn('[m5/overlay] previewEncoding failed:', err);
      });
  }

  // Public API — main.js calls this from the existing selectPiece flow.
  window.SpectralOverlay = {
    onPieceSelected(origin) {
      previewAt(origin);
    },
    getChannel: getSelectedChannel,
  };

  // Status hint follows the bridge's init lifecycle.
  function updateStatusHint() {
    if (window.__SPECTRAL_INFO__) {
      const pkgs = window.__SPECTRAL_INFO__.packages || {};
      const encoderProbeBad =
        pkgs.chess_spectral === false ||
        (typeof pkgs.chess_spectral === 'string' && pkgs.chess_spectral.length > 0);
      if (encoderProbeBad) {
        setHint(`chess-spectral not installed yet — overlay disabled. ${typeof pkgs.chess_spectral === 'string' ? pkgs.chess_spectral : ''}`, 'unavailable');
      } else {
        setHint('Engine ready. Click a piece to preview.', 'ready');
      }
      return true;
    }
    return false;
  }

  // Poll until __SPECTRAL_INFO__ is published or 60 s elapses.
  let pollTries = 0;
  const pollHandle = setInterval(() => {
    if (updateStatusHint() || pollTries++ > 60) clearInterval(pollHandle);
  }, 1000);
})();
