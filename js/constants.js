// constants.js — M11.24 SSOT for bot-evaluation magic numbers and
// user-pacing timer thresholds.
//
// Why this exists: the original M13.x bot work and M11.21 visual-gate
// optimization scattered hand-tuned numbers across Bot.js (3 inline copies
// of the piece-value map; 10000/100000 escape/checkmate scores; 0.3 top-
// fraction sampling; 250/1200 ms visual gate; 5/20/30/50 various bonuses)
// and main.js (100 ms win-check defer, used twice). Centralizing these
// gives one place to tune the bot's "feel" without grepping the codebase.
//
// Two namespaces:
//   window.BOT     — piece values, evaluation scores, search behavior
//   window.TIMING  — UI/UX pacing thresholds, in milliseconds
//
// Notes on values:
// - PIECE_VALUES uses standard 1/3/3/5/9/100 chess weighting × 10 (so
//   pawn = 10, queen = 90, king = 1000). The king value is a sentinel,
//   never actually traded — it forces a checkmate move to dominate any
//   non-checkmate alternative under simple sum-of-material eval.
// - SCORES.CHECKMATE (100000) is two orders of magnitude above any plausible
//   material evaluation, so iterative-deepening alpha-beta correctly
//   prefers a forced mate at depth N over any non-mate at depth M < N.
// - SCORES.ESCAPE_CHECK (10000) is the heuristic-strategy escape bias —
//   one order below CHECKMATE so the negamax search can still distinguish
//   "actually mating opponent" from "merely escaping our own check".
// - SEARCH.TOP_FRACTION (0.3) keeps games varied: bot picks randomly from
//   the top 30% of moves rather than always the first sorted move. Without
//   this, two identical bots play the same game forever. Lower = more
//   consistent, higher = more random.
// - TIMING.BOT_VISUAL_GATE_MS (1200) is the M11.21 "minimum bot turn
//   length" so a fast strategy doesn't snap moves before the user can
//   register what happened. The gate overlaps with compute — compute
//   counts toward the gate.
// - TIMING.BOT_HIGHLIGHT_MIN_MS (250) is the floor on how long the
//   "selected piece" highlight is visible regardless of how the gate
//   computed. Without this, a fast compute + already-elapsed gate would
//   collapse the highlight to a single frame.
// - TIMING.WIN_CHECK_DEFER_MS (100) lets the move-execution animation
//   tick once before checking checkmate/stalemate, so the modal pops
//   AFTER the move visibly lands rather than mid-flight.

(function () {
  'use strict';

  if (typeof window === 'undefined') return;

  window.BOT = Object.freeze({
    // Material eval weights. King is sentinel — see header notes.
    PIECE_VALUES: Object.freeze({
      pawn: 10,
      knight: 30,
      bishop: 30,
      rook: 50,
      queen: 90,
      king: 1000,
    }),
    // Heuristic-search scoring (single-ply move evaluation in evaluateMove
    // and getBestMoveWeighted) and search-tree terminal scoring (alpha-beta
    // checkmate/stalemate leaf).
    SCORES: Object.freeze({
      CHECKMATE: 100000,         // alpha-beta terminal: opponent mated
      ESCAPE_CHECK: 10000,       // single-ply: this move escapes our check
      GREAT_TRADE_BONUS: 50,     // capturing bigger piece with smaller piece
      ESCAPE_DANGER_BONUS: 30,   // moving a piece that was under attack
      DANGER_PENALTY: 20,        // generic "moves into attacked square" fallback
      SAFE_MOVE_BONUS: 5,        // tiny tiebreaker for safe non-capture moves
      NO_BOARD_PENALTY: -1000,   // evaluator called with broken state
    }),
    SEARCH: Object.freeze({
      TOP_FRACTION: 0.3,         // sample top 30% of sorted moves at random
    }),
  });

  window.TIMING = Object.freeze({
    BOT_VISUAL_GATE_MS:  1200,   // M11.21 — minimum total bot-turn length
    BOT_HIGHLIGHT_MIN_MS: 250,   // floor on selected-piece highlight visibility
    WIN_CHECK_DEFER_MS:   100,   // delay before checkmate check after move
  });
})();
