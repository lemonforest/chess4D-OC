/* ============================================
   INTELLIGENT CHESS BOT
   ============================================
   A smart bot that evaluates moves and shows visual feedback
*/

const Bot = {
    /**
     * Evaluate the quality of a move
     * Returns a score: higher = better move
     * @param {GameBoard} gameBoard - The game board
     * @param {number} x0, y0, z0, w0 - Source position
     * @param {number} x1, y1, z1, w1 - Destination position
     * @param {number} team - Team making the move (0=white, 1=black)
     * @returns {number} - Move score (higher is better)
     */
    evaluateMove: function(gameBoard, x0, y0, z0, w0, x1, y1, z1, w1, team) {
        // M11.24: piece values + score weights now sourced from window.BOT
        // (js/constants.js). Unchanged numerics; just one place to tune.
        const pieceValues = window.BOT.PIECE_VALUES;
        const SCORES = window.BOT.SCORES;
        if (!gameBoard || !gameBoard.pieces) {
            return SCORES.NO_BOARD_PENALTY;
        }

        let score = 0;

        // Check if this is a capture
        const targetPiece = gameBoard.pieces[x1][y1][z1][w1];
        if (targetPiece && targetPiece.type && targetPiece.team !== team) {
            // Capture move - prioritize higher value pieces
            score += pieceValues[targetPiece.type] || pieceValues.pawn;

            // Bonus for capturing with a lower value piece
            const sourcePiece = gameBoard.pieces[x0][y0][z0][w0];
            if (sourcePiece && sourcePiece.type) {
                const sourceValue = pieceValues[sourcePiece.type] || pieceValues.pawn;
                const targetValue = pieceValues[targetPiece.type] || pieceValues.pawn;
                if (sourceValue < targetValue) {
                    score += SCORES.GREAT_TRADE_BONUS;
                }
            }
        }

        // Check if moving piece would be captured after move
        // Simulate the move to check safety
        const tempPiece = gameBoard.pieces[x1][y1][z1][w1];
        gameBoard.pieces[x1][y1][z1][w1] = gameBoard.pieces[x0][y0][z0][w0];
        gameBoard.pieces[x0][y0][z0][w0] = Bot.createEmptyPiece();

        // Check if piece is under attack after move
        const isUnderAttack = Bot.isPositionUnderAttack(gameBoard, x1, y1, z1, w1, team);

        // Restore board
        gameBoard.pieces[x0][y0][z0][w0] = gameBoard.pieces[x1][y1][z1][w1];
        gameBoard.pieces[x1][y1][z1][w1] = tempPiece;

        if (isUnderAttack) {
            // Moving into danger - penalty based on piece value
            const sourcePiece = gameBoard.pieces[x0][y0][z0][w0];
            if (sourcePiece && sourcePiece.type) {
                score -= pieceValues[sourcePiece.type] || pieceValues.pawn;
            } else {
                score -= SCORES.DANGER_PENALTY;
            }
        } else {
            // Safe move - small bonus
            score += SCORES.SAFE_MOVE_BONUS;
        }

        // Check if current position is under attack (escape danger)
        const currentUnderAttack = Bot.isPositionUnderAttack(gameBoard, x0, y0, z0, w0, team);
        if (currentUnderAttack) {
            score += SCORES.ESCAPE_DANGER_BONUS;
        }
        
        // Prefer moving pieces that are in better positions (center control)
        const centerBonus = Bot.getCenterBonus(x1, y1, z1, w1);
        score += centerBonus;
        
        return score;
    },
    
    /**
     * Check if a position is under attack by opponent
     * @param {GameBoard} gameBoard - The game board
     * @param {number} x, y, z, w - Position to check
     * @param {number} team - Team defending (0=white, 1=black)
     * @returns {boolean} - True if position is under attack
     */
    isPositionUnderAttack: function(gameBoard, x, y, z, w, team) {
        const opponentTeam = 1 - team; // Opponent team
        
        // Check all opponent pieces
        for (let ox = 0; ox < gameBoard.n; ox++) {
            for (let oy = 0; oy < gameBoard.n; oy++) {
                for (let oz = 0; oz < gameBoard.n; oz++) {
                    for (let ow = 0; ow < gameBoard.n; ow++) {
                        const opponentPiece = gameBoard.pieces[ox][oy][oz][ow];
                        if (opponentPiece && opponentPiece.type && opponentPiece.team === opponentTeam) {
                            try {
                                const possibleMoves = opponentPiece.getPossibleMoves(
                                    gameBoard.pieces, ox, oy, oz, ow
                                );
                                
                                // Check if any move attacks our position
                                for (const move of possibleMoves) {
                                    if (move.x === x && move.y === y && 
                                        move.z === z && move.w === w) {
                                        return true;
                                    }
                                }
                            } catch (error) {
                                // Skip this piece if there's an error
                                continue;
                            }
                        }
                    }
                }
            }
        }
        
        return false;
    },
    
    /**
     * Get bonus for controlling center of board
     * @param {number} x, y, z, w - Position
     * @returns {number} - Bonus score
     */
    getCenterBonus: function(x, y, z, w) {
        const center = 3.5; // Center of 8x8 board
        const distanceX = Math.abs(x - center);
        const distanceZ = Math.abs(z - center);
        
        // Bonus for being closer to center (for X and Z axes)
        const centerBonus = (4 - distanceX) + (4 - distanceZ);
        return centerBonus * 0.5; // Small bonus
    },
    
    /**
     * Create an empty piece (helper function)
     */
    createEmptyPiece: function() {
        return {
            type: null,
            team: -1,
            hasMoved: false,
            position: null
        };
    },
    
    /**
     * Check if a move gets the team out of check
     * @param {GameBoard} gameBoard - The game board
     * @param {number} x0, y0, z0, w0 - Source position
     * @param {number} x1, y1, z1, w1 - Destination position
     * @param {number} team - Team making the move
     * @returns {boolean} - True if move gets out of check
     */
    moveGetsOutOfCheck: function(gameBoard, x0, y0, z0, w0, x1, y1, z1, w1, team) {
        // Simulate the move
        const sourcePiece = gameBoard.pieces[x0][y0][z0][w0];
        const targetPiece = gameBoard.pieces[x1][y1][z1][w1];
        
        // Make the move
        gameBoard.pieces[x1][y1][z1][w1] = sourcePiece;
        gameBoard.pieces[x0][y0][z0][w0] = Bot.createEmptyPiece();
        
        // Check if still in check after move
        const stillInCheck = gameBoard.inCheck(team);
        
        // Restore board
        gameBoard.pieces[x0][y0][z0][w0] = sourcePiece;
        gameBoard.pieces[x1][y1][z1][w1] = targetPiece;
        
        // Return true if NOT still in check (i.e., we got out of check)
        return !stillInCheck;
    },
    
    /**
     * Get the best move for the specified team
     * @param {GameBoard} gameBoard - The game board
     * @param {number} team - Team to move (0=white, 1=black)
     * @returns {Object|null} - Best move object or null if no moves
     */
    getBestMove: function(gameBoard, team) {
        if (!gameBoard || !gameBoard.pieces) {
            return null;
        }
        
        // CRITICAL: Check if team is in check - if so, ONLY consider moves that get out of check
        const isInCheck = gameBoard.inCheck(team);
        
        // Collect all pieces and their possible moves
        const allMoves = [];
        const escapeMoves = []; // Moves that get out of check (if in check)
        
        for (let x = 0; x < gameBoard.n; x++) {
            for (let y = 0; y < gameBoard.n; y++) {
                for (let z = 0; z < gameBoard.n; z++) {
                    for (let w = 0; w < gameBoard.n; w++) {
                        const piece = gameBoard.pieces[x][y][z][w];
                        if (piece && piece.type && piece.team === team) {
                            try {
                                const possibleMoves = piece.getPossibleMoves(gameBoard.pieces, x, y, z, w);
                                
                                if (possibleMoves && possibleMoves.length > 0) {
                                    // Evaluate each move
                                    for (const move of possibleMoves) {
                                        // If in check, filter to only moves that get out of check
                                        if (isInCheck) {
                                            if (!Bot.moveGetsOutOfCheck(gameBoard, x, y, z, w, 
                                                    move.x, move.y, move.z, move.w, team)) {
                                                // This move doesn't get us out of check, skip it
                                                continue;
                                            }
                                            // This move gets us out of check - give it very high priority
                                            escapeMoves.push({
                                                x0: x,
                                                y0: y,
                                                z0: z,
                                                w0: w,
                                                x1: move.x,
                                                y1: move.y,
                                                z1: move.z,
                                                w1: move.w,
                                                score: window.BOT.SCORES.ESCAPE_CHECK,
                                                isCapture: move.possibleCapture || false
                                            });
                                        } else {
                                            // Not in check - evaluate normally
                                            const score = Bot.evaluateMove(
                                                gameBoard, x, y, z, w,
                                                move.x, move.y, move.z, move.w, team
                                            );
                                            
                                            allMoves.push({
                                                x0: x,
                                                y0: y,
                                                z0: z,
                                                w0: w,
                                                x1: move.x,
                                                y1: move.y,
                                                z1: move.z,
                                                w1: move.w,
                                                score: score,
                                                isCapture: move.possibleCapture || false
                                            });
                                        }
                                    }
                                }
                            } catch (error) {
                                console.warn(`Bot: Error getting moves for piece at (${x},${y},${z},${w}):`, error);
                                continue;
                            }
                        }
                    }
                }
            }
        }
        
        // If in check, only use escape moves
        const movesToUse = isInCheck ? escapeMoves : allMoves;
        
        if (movesToUse.length === 0) {
            return null;
        }
        
        // Sort moves by score (best first)
        movesToUse.sort((a, b) => b.score - a.score);

        // Pick from top moves (top 30% to add some randomness while still being smart)
        const topMovesCount = Math.max(1, Math.floor(movesToUse.length * window.BOT.SEARCH.TOP_FRACTION));
        const topMoves = movesToUse.slice(0, topMovesCount);

        // Shuffle top moves so the legal-move filter below picks randomly
        // (previously we picked one random then returned — now we may need to
        // try several until we find a fully legal one).
        for (let i = topMoves.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [topMoves[i], topMoves[j]] = [topMoves[j], topMoves[i]];
        }

        // Root-cause fix for the applyChain timing / stale-engine-board bug.
        //
        // `piece.getPossibleMoves` returns PSEUDO-legal moves — it doesn't
        // filter for moves that leave the king in check. Human moves go
        // through `filterIllegalMoves` before execution; bot moves never
        // did. When the bot plays a pseudo-legal move, `bridge.applyMove`
        // calls Python `_state.push(move)` which raises `IllegalMoveError`.
        // The JS board has already updated but Python state has not —
        // creating silent state divergence. Subsequent engine searches then
        // search the stale (un-updated) Python board, producing moves that
        // reference squares empty or wrong-team on the JS board.
        //
        // Fix: validate each top candidate via `filterIllegalMoves` (JS-only,
        // no Python round-trip) before returning. We only validate until we
        // find one legal move, so the cost is O(pieces) not O(all_candidates).
        if (typeof filterIllegalMoves === 'function') {
            for (const candidate of topMoves) {
                const filteredMoves = filterIllegalMoves(
                    gameBoard,
                    candidate.x0, candidate.y0, candidate.z0, candidate.w0,
                    [{ x: candidate.x1, y: candidate.y1, z: candidate.z1, w: candidate.w1,
                       possibleCapture: candidate.isCapture || false }],
                    team
                );
                if (filteredMoves && filteredMoves.length > 0) {
                    return {
                        x0: candidate.x0, y0: candidate.y0, z0: candidate.z0, w0: candidate.w0,
                        x1: candidate.x1, y1: candidate.y1, z1: candidate.z1, w1: candidate.w1,
                    };
                }
            }
            // All top candidates were pseudo-legal (leave king in check) —
            // scan the full sorted list for any legal move.
            for (const candidate of movesToUse.slice(topMovesCount)) {
                const filteredMoves = filterIllegalMoves(
                    gameBoard,
                    candidate.x0, candidate.y0, candidate.z0, candidate.w0,
                    [{ x: candidate.x1, y: candidate.y1, z: candidate.z1, w: candidate.w1,
                       possibleCapture: candidate.isCapture || false }],
                    team
                );
                if (filteredMoves && filteredMoves.length > 0) {
                    return {
                        x0: candidate.x0, y0: candidate.y0, z0: candidate.z0, w0: candidate.w0,
                        x1: candidate.x1, y1: candidate.y1, z1: candidate.z1, w1: candidate.w1,
                    };
                }
            }
            console.warn(`[bot-v0] no fully-legal moves found for team ${team} after filterIllegalMoves pass`);
            return null;
        }

        // Fallback (filterIllegalMoves not available): pick first top move
        // as before. The applyChain guards in executeMoveImmediate + makeMove
        // will catch and discard any stale result.
        const selectedMove = topMoves[0];
        return {
            x0: selectedMove.x0,
            y0: selectedMove.y0,
            z0: selectedMove.z0,
            w0: selectedMove.w0,
            x1: selectedMove.x1,
            y1: selectedMove.y1,
            z1: selectedMove.z1,
            w1: selectedMove.w1
        };
    },
    
    /**
     * Make a move with visual feedback
     * Shows piece selection, possible moves, then executes
     * @param {GameBoard} gameBoard - The game board
     * @param {MoveManager} moveManager - The move manager
     * @param {number} team - Team to move (0=white, 1=black)
     * @returns {Promise<boolean>} - True if move was made
     */
    // M11.17: now async so we can `await` a setTimeout(0) yield before
    // the sync hasLegalMoves scan, giving the busy-indicator a chance
    // to paint. The function still returns a Promise<boolean> like
    // before — async/await is just shorthand for the Promise plumbing.
    makeMove: async function(gameBoard, moveManager, team) {
        if (!gameBoard || !moveManager) {
            console.error('Bot: gameBoard or moveManager not available');
            return Promise.resolve(false);
        }

        // M13.4.3 — capture the cancel-generation at entry so we can
        // detect mid-flight cancellation (e.g., user clicked Two
        // Players while the engine was searching). Bot.cancelInFlight()
        // increments the generation; every await boundary below checks
        // and bails before doing irreversible work (selecting a piece,
        // applying a move). Pyodide-side searches still complete on
        // their own time — we just discard their result.
        const myCancelGen = Bot._cancelGen;
        const wasCancelled = () => Bot._cancelGen !== myCancelGen;

        // CRITICAL: Check if team is in checkmate/stalemate before attempting to move.
        // M11.17: hasLegalMoves can take hundreds of ms in real checkmate
        // (no piece has a legal escape; we test all 448 × ~80 candidates).
        // Show the busy indicator before blocking the main thread, then
        // yield once so the spinner paints before the sync scan runs.
        const isInCheck = gameBoard.inCheck(team);
        if (typeof window !== 'undefined' && window._showThinking) {
            window._showThinking('Bot ' + (team === 0 ? 'white' : 'black') + ' checking legal moves…');
        }
        // Synchronous yield: setTimeout(0) inside a Promise resolves on the
        // next event-loop tick, which gives the renderer a chance to paint
        // the indicator before we proceed with the heavy sync call below.
        await new Promise(function (r) { setTimeout(r, 0); });
        if (wasCancelled()) {
            if (typeof window !== 'undefined' && window._hideThinking) window._hideThinking();
            console.log('[m13.4.3/bot-cancel] aborted before hasLegalMoves scan');
            return Promise.resolve(false);
        }
        const hasLegalMoves = gameBoard.hasLegalMoves(team);
        if (typeof window !== 'undefined' && window._hideThinking) {
            window._hideThinking();
        }
        
        if (isInCheck && !hasLegalMoves) {
            console.log(`🛑 Bot: Team ${team} is in CHECKMATE - cannot make a move`);
            // Trigger win condition check
            if (typeof checkWinCondition === 'function') {
                setTimeout(() => checkWinCondition(), 100);
            }
            return Promise.resolve(false);
        }
        
        if (!isInCheck && !hasLegalMoves) {
            console.log(`🛑 Bot: Team ${team} is in STALEMATE - cannot make a move`);
            // Trigger win condition check
            if (typeof checkWinCondition === 'function') {
                setTimeout(() => checkWinCondition(), 100);
            }
            return Promise.resolve(false);
        }
        
        // M11.21: record the start time so the visual gate (the
        // 1.2-second pause between piece-highlight and move-execution)
        // can OVERLAP with compute. If a slow strategy (e.g. ?bot=smart
        // depth 3, 4-second budget) already kept the user waiting, we
        // skip the additional pause; if compute was fast (v0 single-ply
        // ~5ms), we still wait the visual gate so the user sees what
        // piece the bot picked before the animation fires.
        const turnStartTime = (typeof performance !== 'undefined') ? performance.now() : Date.now();

        // M13.2: dispatch through the strategy registry. Each team has its
        // own active strategy (default 'v0' both sides; URL flags or UI
        // dropdowns can pick different strategies per team for A/B testing).
        // M11.21: show busy indicator during compute (smart-bot search can
        // take seconds; without the indicator the page LOOKS frozen even
        // though the GPU compositor is still spinning the busy badge from
        // the earlier hasLegalMoves call).
        const stratName = Bot.getActiveStrategyName(team);
        if (typeof window !== 'undefined' && window._showThinking) {
            window._showThinking('Bot ' + (team === 0 ? 'white' : 'black') + ' (' + stratName + ') searching…');
        }
        // Yield once so the indicator paints before the (possibly slow)
        // synchronous search blocks the main thread.
        await new Promise(function (r) { setTimeout(r, 0); });
        if (wasCancelled()) {
            if (typeof window !== 'undefined' && window._hideThinking) window._hideThinking();
            console.log('[m13.4.3/bot-cancel] aborted before strategy.getBestMove');
            return Promise.resolve(false);
        }
        const strategy = Bot.strategies[stratName];
        // M11.28a: smart strategy is now async (cooperative yields between
        // iterative-deepening iterations). Other strategies stay sync, but
        // `await` works fine on sync values — it just resolves at the next
        // microtask boundary. Net cost ~1 microtask which is invisible.
        const move = strategy
            ? await strategy.getBestMove(gameBoard, team)
            : Bot.getBestMove(gameBoard, team); // fallback if registry is missing
        if (typeof window !== 'undefined' && window._hideThinking) {
            window._hideThinking();
        }
        // After the (potentially long) strategy search returns: if mode
        // changed mid-search, discard the move rather than apply it.
        if (wasCancelled()) {
            console.log('[m13.4.3/bot-cancel] discarding move — strategy returned post-cancel');
            return Promise.resolve(false);
        }

        if (!move) {
            console.warn(`Bot: No legal moves found for team ${team} - may be checkmate/stalemate`);
            // Double-check win condition if no move found
            if (typeof checkWinCondition === 'function') {
                setTimeout(() => checkWinCondition(), 100);
            }
            return Promise.resolve(false);
        }

        // Stamp the expected team into the move object so executeMoveImmediate
        // can validate it — catches stale engine results where the engine
        // computed a move for the wrong side (searched pre-previous-move board).
        move.team = team;

        // Sanity-check: verify the piece at the origin square exists and
        // belongs to the expected team. If not, the move came from a stale
        // board snapshot (engine searched before the previous applyMove
        // committed). Log loudly and bail rather than crashing in moveMesh.
        const moveOriginPiece = gameBoard.pieces[move.x0][move.y0][move.z0][move.w0];
        if (!moveOriginPiece) {
            console.error(
                `[bot-stale-move] makeMove: no piece at origin ` +
                `(${move.x0},${move.y0},${move.z0},${move.w0}) for team ${team}. ` +
                `Engine likely searched a stale board. Discarding move; ` +
                `check window.__BRIDGE_LOG__ for applyMove timing.`
            );
            return Promise.resolve(false);
        }
        if (moveOriginPiece.team !== team) {
            console.error(
                `[bot-stale-move] makeMove: piece at origin ` +
                `(${move.x0},${move.y0},${move.z0},${move.w0}) is team ${moveOriginPiece.team} ` +
                `but bot is team ${team}. Engine searched a stale board. Discarding.`
            );
            return Promise.resolve(false);
        }

        console.log(`🤖 Bot (team ${team}) selected move: (${move.x0},${move.y0},${move.z0},${move.w0}) → (${move.x1},${move.y1},${move.z1},${move.w1})`);

        return new Promise((resolve) => {
            // Step 1: Select the piece and show possible moves (visual feedback)
            const sourcePiece = gameBoard.pieces[move.x0][move.y0][move.z0][move.w0];
            if (!sourcePiece || !sourcePiece.mesh) {
                // Fallback: execute immediately if mesh not found
                Bot.executeMoveImmediate(gameBoard, moveManager, move, resolve);
                return;
            }
            
            // Use the selection system for visual feedback
            if (typeof window !== 'undefined' && window.selectionSystem) {
                // Clear any previous selection
                if (window.selectionSystem.selectedPiece) {
                    window.selectionSystem.unhighlight(window.selectionSystem.selectedPiece);
                    window.selectionSystem.selectedPiece = null;
                }
                if (gameBoard.graphics) {
                    gameBoard.graphics.hidePossibleMoves();
                }
                
                // Highlight the bot's selected piece
                window.selectionSystem.highlight(sourcePiece.mesh, window.selectionSystem.SELECT_COLOR);
                window.selectionSystem.selectedPiece = sourcePiece.mesh;
            } else {
                // Fallback: manual highlight
                if (sourcePiece.mesh && sourcePiece.mesh.material) {
                    if (!sourcePiece.mesh.material.originalColor) {
                        sourcePiece.mesh.material.originalColor = sourcePiece.mesh.material.color.getHex();
                    }
                    sourcePiece.mesh.material.color.setHex(0x00B9FF); // Blue highlight
                }
            }
            
            // Show possible moves
            const possibleMoves = sourcePiece.getPossibleMoves(
                gameBoard.pieces, move.x0, move.y0, move.z0, move.w0
            );
            
            if (possibleMoves && possibleMoves.length > 0 && gameBoard.graphics) {
                gameBoard.graphics.showPossibleMoves(possibleMoves, sourcePiece, {}, false);
            }
            
            // M11.21: visual gate now overlaps with compute. If the
            // total elapsed time (since makeMove entered) is already at
            // or beyond VISUAL_GATE_MS, fire the move immediately —
            // the user has already seen plenty of "bot thinking" plus
            // the highlight. Otherwise wait the remainder so fast
            // strategies (v0/random) still pause long enough for the
            // user to register which piece was selected.
            // M11.24 — sourced from window.TIMING (js/constants.js).
            // Always show the highlight for at least BOT_HIGHLIGHT_MIN_MS
            // even if compute was instant + total elapsed already exceeds
            // BOT_VISUAL_GATE_MS — otherwise the highlight might never
            // visibly appear (e.g. compute = 50 ms, gate = 0, execute fires
            // before browser paints the highlight).
            // M11.28a — RUNTIME_OVERRIDES.BOT_VISUAL_GATE_MS lets the bot
            // pacing slider override the default per-session. `??` only
            // falls through on null/undefined, so 0 / very small overrides
            // still take effect (slider min is 100ms by UI clamp).
            const VISUAL_GATE_MS = (window.RUNTIME_OVERRIDES && window.RUNTIME_OVERRIDES.BOT_VISUAL_GATE_MS != null)
                ? window.RUNTIME_OVERRIDES.BOT_VISUAL_GATE_MS
                : window.TIMING.BOT_VISUAL_GATE_MS;
            const HIGHLIGHT_MIN_MS  = window.TIMING.BOT_HIGHLIGHT_MIN_MS;
            const nowT = (typeof performance !== 'undefined') ? performance.now() : Date.now();
            const elapsed = nowT - turnStartTime;
            const wait = Math.max(HIGHLIGHT_MIN_MS, VISUAL_GATE_MS - elapsed);
            console.log(
                '[m11.21/bot-gate] elapsed=' + elapsed.toFixed(0) + 'ms ' +
                'wait=' + wait.toFixed(0) + 'ms ' +
                '(strategy=' + stratName + ')'
            );
            setTimeout(() => {
                // M13.4.3 — final cancel check before executing the
                // move. If user switched to Two Players while we were
                // sitting in the visual-gate setTimeout, drop the move
                // and resolve(false) so callers know nothing happened.
                if (wasCancelled()) {
                    console.log('[m13.4.3/bot-cancel] visual-gate cancelled; not executing move');
                    // Best-effort cleanup: clear the bot's piece highlight
                    // so it doesn't get stuck in selected-state.
                    if (typeof window !== 'undefined' && window.selectionSystem &&
                        window.selectionSystem.selectedPiece) {
                        try {
                            window.selectionSystem.unhighlight(window.selectionSystem.selectedPiece);
                            window.selectionSystem.selectedPiece = null;
                        } catch (_) {}
                    }
                    if (gameBoard && gameBoard.graphics) gameBoard.graphics.hidePossibleMoves();
                    resolve(false);
                    return;
                }
                // Execute the move
                Bot.executeMoveImmediate(gameBoard, moveManager, move, resolve);
            }, wait);
        });
    },
    
    /**
     * Execute move immediately (internal helper)
     */
    executeMoveImmediate: function(gameBoard, moveManager, move, resolve) {
        // Guard: verify the piece at the origin square still exists and belongs
        // to the expected team before doing anything. The engine's search runs
        // asynchronously in the Pyodide worker; if it searched a stale board
        // (e.g., the previous move committed to the JS board after the search
        // started), it can return coordinates from the old position — an origin
        // square that is now empty or occupied by the opponent. Executing that
        // move crashes BoardGraphics.moveMesh with "Cannot read properties of
        // null (reading 'position')". See browser screenshot 2026-05-01.
        const sourcePiece = gameBoard.pieces[move.x0][move.y0][move.z0][move.w0];
        if (!sourcePiece) {
            console.error(
                `[bot-stale-move] executeMoveImmediate: no piece at origin ` +
                `(${move.x0},${move.y0},${move.z0},${move.w0}) — ` +
                `move was likely computed on a stale board. Discarding.`
            );
            if (gameBoard.graphics) gameBoard.graphics.hidePossibleMoves();
            resolve(false);
            return;
        }
        if (sourcePiece.team !== move.team && move.team !== undefined) {
            console.error(
                `[bot-stale-move] executeMoveImmediate: piece at origin ` +
                `(${move.x0},${move.y0},${move.z0},${move.w0}) belongs to team ` +
                `${sourcePiece.team} but expected team ${move.team}. Discarding.`
            );
            if (gameBoard.graphics) gameBoard.graphics.hidePossibleMoves();
            resolve(false);
            return;
        }

        // Use selection system to unhighlight
        if (typeof window !== 'undefined' && window.selectionSystem && sourcePiece && sourcePiece.mesh) {
            window.selectionSystem.unhighlight(sourcePiece.mesh);
            window.selectionSystem.selectedPiece = null;
        } else if (sourcePiece && sourcePiece.mesh && sourcePiece.mesh.material && sourcePiece.mesh.material.originalColor) {
            // Fallback: manual restore
            sourcePiece.mesh.material.color.setHex(sourcePiece.mesh.material.originalColor);
        }

        // Hide possible moves
        if (gameBoard.graphics) {
            gameBoard.graphics.hidePossibleMoves();
        }

        // Execute the move
        try {
            moveManager.move(
                move.x0, move.y0, move.z0, move.w0,
                move.x1, move.y1, move.z1, move.w1
            );
            // M11.20: refresh piece-count statistics. moveManager.move
            // mutates gameBoard.pieces (capture removes the target piece)
            // but doesn't itself fire the UI count update. Human-move
            // paths already call updatePieceCounts; the bot path didn't,
            // so bot games left the white-count/black-count stats stuck
            // at the initial 448/448 even after captures. Patched here.
            if (typeof window !== 'undefined' && typeof window.updatePieceCounts === 'function') {
                window.updatePieceCounts();
            }
            // M11.7: auto-select the bot's moved piece so the spectral
            // overlay continues to show during bot-vs-bot (and vs-bot)
            // games. Without this, the cloud + tint + filaments still
            // refresh on each move (since they trigger off applyMove),
            // but the per-piece HOVER overlay (M5) never fires —
            // because no human is clicking. Auto-select gives the user
            // a continuous spectral story as the bots play.
            //
            // Only fires when window.currentGameMode is 'bot-vs-bot' or
            // 'vs-bot'; the singleplayer (Two Players) mode keeps the
            // existing click-to-select flow intact.
            const mode = (typeof window !== 'undefined') ? window.currentGameMode : null;
            const isBotMode = (mode === 'bot-vs-bot' || mode === 'vs-bot');
            if (isBotMode) {
                // Defer one animation frame so the move animation gets
                // to start visually before we lock the highlight on.
                setTimeout(function () {
                    try {
                        const moved = gameBoard.pieces[move.x1][move.y1][move.z1][move.w1];
                        if (moved && moved.mesh && typeof window !== 'undefined' &&
                            typeof window.selectPiece === 'function') {
                            window.selectPiece(moved.mesh);
                        }
                    } catch (_) { /* best-effort; don't break the move loop */ }
                }, 80);
            }
            resolve(true);
        } catch (error) {
            console.error('Bot: Error executing move:', error);
            resolve(false);
        }
    },

    // ────────────────────────────────────────────────────────────────────────
    // M13.5 (2026-05-08): JS-side `smart` strategy retired.
    //
    // The JS-side iterative-deepening alpha-beta + TT + MVV-LVA search shipped
    // in M13.1 was a useful bootstrap but had two persistent problems:
    //   1. It froze the page during deep search (synchronous main-thread work
    //      with cooperative yields only between depth iterations — the inner
    //      _alphaBeta call still blocked rendering).
    //   2. Its evaluator was material-only; the engine-* strategies (M13.4,
    //      cs1.6+) run inside the Pyodide worker AND have three richer eval
    //      flavors (material / spectral / qm) without freezing the page.
    //
    // M13.5 removes the JS smart code path entirely. The `smart` registry
    // entry is gone; `?bot=smart` URL flag now aliases to engine-material
    // with a one-release deprecation warn. getBestMoveSmart, _alphaBeta,
    // _yieldToMain are deleted. evaluatePosition + _PIECE_VALUES are kept
    // since aggressive/defensive/center heuristic strategies still use them.
    // ────────────────────────────────────────────────────────────────────────

    // M11.24 — kept as Bot._PIECE_VALUES for backward-compat with the
    // call sites (evaluatePosition, evaluatePositionSpectral, _weightedHeuristicMove).
    // Sourced from window.BOT.PIECE_VALUES.
    _PIECE_VALUES: window.BOT.PIECE_VALUES,

    /**
     * Material balance from `team`'s perspective. Static eval, single pass
     * over the 4096-cell board (only ~896 are occupied). No mobility term
     * yet — that costs full move generation per leaf, too expensive for
     * deep search at 4D branching factor. M13.2 will replace this with
     * a chess-spectral channel-energy weighted sum (much richer signal,
     * single Pyodide call instead of per-piece scan).
     */
    evaluatePosition: function (gameBoard, team) {
        const v = Bot._PIECE_VALUES;
        let score = 0;
        const n = gameBoard.n;
        const board = gameBoard.pieces;
        for (let x = 0; x < n; x++) {
            for (let y = 0; y < n; y++) {
                for (let z = 0; z < n; z++) {
                    for (let w = 0; w < n; w++) {
                        const p = board[x][y][z][w];
                        if (!p || !p.type) continue;
                        const pieceVal = v[p.type] || 0;
                        score += (p.team === team) ? pieceVal : -pieceVal;
                    }
                }
            }
        }
        return score;
    },

    /**
     * Compact position hash for transposition-table key. String-based for
     * simplicity (avoid maintaining a Zobrist table over 16 piece-types ×
     * 4096 squares = 65k random ints). For 4D chess with ~896 pieces, the
     * hash string is <30k chars; Map lookup is O(1) amortized via internal
     * string-hashing. Faster than re-evaluating shallow subtrees.
     */
    positionHash: function (gameBoard, team) {
        const n = gameBoard.n;
        const board = gameBoard.pieces;
        const parts = [String(team)];
        for (let x = 0; x < n; x++) {
            for (let y = 0; y < n; y++) {
                for (let z = 0; z < n; z++) {
                    for (let w = 0; w < n; w++) {
                        const p = board[x][y][z][w];
                        if (!p || !p.type) continue;
                        parts.push(p.type[0] + p.team + ':' + x + ',' + y + ',' + z + ',' + w);
                    }
                }
            }
        }
        return parts.join(';');
    },

    /**
     * Generate all legal moves for `team`, ordered by capture value (MVV-LVA
     * approximation: higher-value captures first, then non-captures). Move
     * ordering is critical for alpha-beta efficiency — bad ordering loses
     * most of the pruning benefit.
     */
    generateOrderedMoves: function (gameBoard, team) {
        const v = Bot._PIECE_VALUES;
        const n = gameBoard.n;
        const board = gameBoard.pieces;
        const moves = [];
        for (let x = 0; x < n; x++) {
            for (let y = 0; y < n; y++) {
                for (let z = 0; z < n; z++) {
                    for (let w = 0; w < n; w++) {
                        const p = board[x][y][z][w];
                        if (!p || !p.type || p.team !== team) continue;
                        let candidates = null;
                        try {
                            candidates = p.getPossibleMoves(board, x, y, z, w);
                        } catch (_) { continue; }
                        if (!candidates || !candidates.length) continue;
                        for (const m of candidates) {
                            const target = board[m.x][m.y][m.z][m.w];
                            const captureVal = (target && target.type && target.team !== team)
                                ? (v[target.type] || 0) : 0;
                            moves.push({
                                x0: x, y0: y, z0: z, w0: w,
                                x1: m.x, y1: m.y, z1: m.z, w1: m.w,
                                captureVal: captureVal,
                            });
                        }
                    }
                }
            }
        }
        // MVV-LVA: high-capture moves first → maximize beta cutoffs.
        moves.sort((a, b) => b.captureVal - a.captureVal);
        return moves;
    },

    /**
     * Apply / undo a move in-place via the gameBoard.pieces array (no
     * animations, no spectral refresh — pure search-tree mutation).
     * Returns the captured-piece reference for restoration.
     */
    _applyTemp: function (gameBoard, move) {
        const captured = gameBoard.pieces[move.x1][move.y1][move.z1][move.w1];
        gameBoard.pieces[move.x1][move.y1][move.z1][move.w1] =
            gameBoard.pieces[move.x0][move.y0][move.z0][move.w0];
        gameBoard.pieces[move.x0][move.y0][move.z0][move.w0] = Bot.createEmptyPiece();
        return captured;
    },
    _undoTemp: function (gameBoard, move, captured) {
        gameBoard.pieces[move.x0][move.y0][move.z0][move.w0] =
            gameBoard.pieces[move.x1][move.y1][move.z1][move.w1];
        gameBoard.pieces[move.x1][move.y1][move.z1][move.w1] = captured;
    },

    // M13.5: _alphaBeta, getBestMoveSmart, _yieldToMain removed.
    // Use ?botWhite=engine-material (or engine-spectral / engine-qm) instead.
    // The engine-* strategies run inside the Pyodide worker so the JS main
    // thread stays responsive during search.
};

// ────────────────────────────────────────────────────────────────────────
// M13.2 — STRATEGY REGISTRY
//
// User said: 'our bots could use different decision matrices too maybe?
// at least for some testing. experiment on everything!' Done. The Bot
// is now a registry of named strategies; the active strategy per side
// is selectable via URL flags ?botWhite=NAME and ?botBlack=NAME, or via
// the dropdowns in the Bot Strategy card.
//
// All strategies share the legality-check + visual-feedback infrastructure
// in Bot.makeMove / Bot.executeMoveImmediate; they only differ in
// HOW they pick the move from the legal-move set.
//
// Available strategies (extensible — add more by registering on Bot.strategies):
//   - 'v0'              : original single-ply heuristic + top-30% randomization
//   - 'random'          : uniform random over legal moves (control / baseline)
//   - 'aggressive'      : capture value × 5 — chases material, ignores safety
//   - 'defensive'       : penalty for under-attack destinations × 5 — avoids danger
//   - 'center'          : center bonus × 5 — fights for the lattice center
//   - 'engine-material' : Pyodide alpha-beta + TT, material eval (cs1.6+)
//   - 'engine-spectral' : Pyodide alpha-beta + TT, spectral eval (cs1.6+)
//   - 'engine-qm'       : Pyodide alpha-beta + TT, Born-rule QM eval (cs1.6+)
//
// M13.5 (2026-05-08): 'smart' retired (JS-side alpha-beta froze the main
// thread). engine-* strategies are the recommended replacement.
// ────────────────────────────────────────────────────────────────────────

Bot._randomLegalMove = function (gameBoard, team) {
    const moves = Bot.generateOrderedMoves(gameBoard, team);
    if (!moves.length) return null;
    return moves[Math.floor(Math.random() * moves.length)];
};

Bot._weightedHeuristicMove = function (gameBoard, team, weights) {
    // Generic single-ply heuristic with adjustable weights. weights = { capture, safety, center }.
    // Keeps the same evaluateMove structure but lets each strategy emphasize
    // a different facet. Re-uses the existing capture/safety/center helpers.
    if (!gameBoard || !gameBoard.pieces) return null;
    const isInCheck = gameBoard.inCheck && gameBoard.inCheck(team);
    const escapeMoves = [];
    const allMoves = [];
    const v = Bot._PIECE_VALUES;
    const n = gameBoard.n;
    for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) {
            for (let z = 0; z < n; z++) {
                for (let w = 0; w < n; w++) {
                    const piece = gameBoard.pieces[x][y][z][w];
                    if (!piece || !piece.type || piece.team !== team) continue;
                    let candidates;
                    try { candidates = piece.getPossibleMoves(gameBoard.pieces, x, y, z, w); }
                    catch (_) { continue; }
                    if (!candidates || !candidates.length) continue;
                    for (const m of candidates) {
                        if (isInCheck) {
                            if (!Bot.moveGetsOutOfCheck(gameBoard, x, y, z, w, m.x, m.y, m.z, m.w, team)) continue;
                            escapeMoves.push({
                                x0: x, y0: y, z0: z, w0: w,
                                x1: m.x, y1: m.y, z1: m.z, w1: m.w,
                                score: window.BOT.SCORES.ESCAPE_CHECK,
                            });
                            continue;
                        }
                        let s = 0;
                        const target = gameBoard.pieces[m.x][m.y][m.z][m.w];
                        if (target && target.type && target.team !== team) {
                            s += weights.capture * (v[target.type] || 10);
                        }
                        // Cheap safety probe: simulate the move briefly.
                        const tempPiece = gameBoard.pieces[m.x][m.y][m.z][m.w];
                        gameBoard.pieces[m.x][m.y][m.z][m.w] = gameBoard.pieces[x][y][z][w];
                        gameBoard.pieces[x][y][z][w] = Bot.createEmptyPiece();
                        const underAttack = Bot.isPositionUnderAttack(gameBoard, m.x, m.y, m.z, m.w, team);
                        gameBoard.pieces[x][y][z][w] = gameBoard.pieces[m.x][m.y][m.z][m.w];
                        gameBoard.pieces[m.x][m.y][m.z][m.w] = tempPiece;
                        if (underAttack) {
                            const sourceVal = v[piece.type] || 10;
                            s -= weights.safety * sourceVal;
                        } else {
                            s += weights.safety * 1;
                        }
                        s += weights.center * Bot.getCenterBonus(m.x, m.y, m.z, m.w);
                        allMoves.push({
                            x0: x, y0: y, z0: z, w0: w,
                            x1: m.x, y1: m.y, z1: m.z, w1: m.w,
                            score: s,
                        });
                    }
                }
            }
        }
    }
    const pool = isInCheck ? escapeMoves : allMoves;
    if (!pool.length) return null;
    pool.sort((a, b) => b.score - a.score);
    // Pick from top 30% to keep games varied even with extreme weights.
    const topN = Math.max(1, Math.floor(pool.length * window.BOT.SEARCH.TOP_FRACTION));
    return pool[Math.floor(Math.random() * topN)];
};

Bot.strategies = {
    v0: {
        label: 'Handcrafted heuristic (v0)',
        getBestMove: function (gb, team) { return Bot.getBestMove(gb, team); },
    },
    // M13.5: 'smart' retired (was JS-side alpha-beta + TT). Use engine-material /
    // engine-spectral / engine-qm instead — they run in the Pyodide worker
    // and don't freeze the page.
    random: {
        label: 'Random legal move (control)',
        getBestMove: function (gb, team) { return Bot._randomLegalMove(gb, team); },
    },
    aggressive: {
        label: 'Aggressive (5× capture weight)',
        getBestMove: function (gb, team) {
            return Bot._weightedHeuristicMove(gb, team, { capture: 5, safety: 1, center: 1 });
        },
    },
    defensive: {
        label: 'Defensive (5× safety weight)',
        getBestMove: function (gb, team) {
            return Bot._weightedHeuristicMove(gb, team, { capture: 1, safety: 5, center: 1 });
        },
    },
    center: {
        label: 'Center-control (5× center weight)',
        getBestMove: function (gb, team) {
            return Bot._weightedHeuristicMove(gb, team, { capture: 1, safety: 1, center: 5 });
        },
    },
    // M13.4 — chess-spectral 1.6.1 §16 engine strategies. Iterative-
    // deepening alpha-beta with TT + MVV-LVA + quiescence runs entirely
    // in the Pyodide worker; the JS main thread stays responsive
    // throughout the search. Three evaluator flavors:
    //   - engine-material : classical material count
    //   - engine-spectral : channel-energy weighted sum
    //   - engine-qm       : Born-rule observable expectations
    //
    // Returns null on bridge unavailability (e.g., page loaded with
    // bridge boot pending) so Bot.makeMove falls back gracefully.
    'engine-material': {
        label: 'Engine — material eval (cs1.6 alpha-beta, falls back to v0)',
        getBestMove: function (gb, team) { return Bot._engineGetBestMove('material', gb, team); },
    },
    'engine-spectral': {
        label: 'Engine — spectral eval (channel energy, falls back to v0)',
        getBestMove: function (gb, team) { return Bot._engineGetBestMove('spectral', gb, team); },
    },
    'engine-qm': {
        label: 'Engine — QM eval (Born-rule observables, falls back to v0)',
        getBestMove: function (gb, team) { return Bot._engineGetBestMove('qm', gb, team); },
    },
};

// M13.4 — shared engine search helper. Async (returns Promise<move|null>);
// strategy.getBestMove call sites already `await` so the existing async
// path through Bot.makeMove (set up in M11.28a) handles this naturally.
//
// M13.4.1 — when the engine returns no move (search budget exhausted
// before any depth completed, FEN4 round-trip failure, etc.), fall back
// to the v0 heuristic so the game progresses. This is the perf escape
// hatch for the chess-spectral 1.6.1 caveat: pure-Python 4D move-gen at
// the 28-king starting position takes ~250s per the upstream docstring,
// so engine-* strategies CANNOT reasonably make a move at full starting
// density within timeBudgetMs=4000. Without the fallback, the user sees
// a silent hang. With it, a v0 move plays and the game progresses; the
// engine becomes practical once material thins later in the game.
//
// Search depth + time budget come from the existing TIMING constants;
// future M13.4.2 can expose per-strategy slider tuning.
Bot._engineGetBestMove = async function (evaluator, gameBoard, team) {
    if (typeof window === 'undefined' || !window.SpectralBridge ||
        typeof window.SpectralBridge.getBestMove !== 'function') {
        console.warn('[m13.4/engine] bridge.getBestMove unavailable; falling back to v0');
        return Bot.getBestMove(gameBoard, team);
    }
    // M13.4.2 — read the engine think-time override (set by the slider
    // in index.html). Falls through to the 4000ms default if no slider
    // value has been set this session.
    const thinkTimeOverride = (window.RUNTIME_OVERRIDES &&
        window.RUNTIME_OVERRIDES.BOT_THINK_TIME_MS != null)
        ? window.RUNTIME_OVERRIDES.BOT_THINK_TIME_MS
        : 4000;
    // M13.4.4 — JS-side hard timeout (defense-in-depth backstop after
    // chess-spectral 1.7.1's mid-iteration budget check shipped).
    //
    // Pre-1.7.1 chess-spectral checked SearchOptions.time_budget_ms only
    // BETWEEN iterative-deepening iterations; depth 1 alone at the dense
    // 28-king starting position took ~8 minutes (pure-Python move-gen
    // ~250s × Pyodide WASM overhead). The slider was effectively
    // advisory; bot appeared stuck for minutes regardless of slider
    // value. JS-side Promise.race forced the v0 fallback at slider+grace,
    // restoring user-facing budget control.
    //
    // chess-spectral 1.7.1 (M11.51 pin bump) threads the budget check
    // INTO the search inner loop, so the engine returns within budget
    // upstream-natively (verified offline: depth-1 at starting position
    // returns in ~2001ms with budget=2000ms, with a real best_move).
    // The Promise.race below now rarely fires — kept as a backstop in
    // case the upstream check ever drifts (regression catch) or the
    // worker JS-RPC overhead spikes unexpectedly.
    const HARD_TIMEOUT_GRACE_MS = 500;
    const hardTimeoutMs = thinkTimeOverride + HARD_TIMEOUT_GRACE_MS;
    try {
        let timedOut = false;
        const timeoutToken = Symbol('engine-timeout');
        const timeoutPromise = new Promise((resolve) => {
            setTimeout(() => {
                timedOut = true;
                resolve(timeoutToken);
            }, hardTimeoutMs);
        });
        const enginePromise = window.SpectralBridge.getBestMove({
            evaluator: evaluator,
            maxDepth: 3,
            timeBudgetMs: thinkTimeOverride,
        });
        const res = await Promise.race([enginePromise, timeoutPromise]);
        if (timedOut || res === timeoutToken) {
            console.warn(
                '[m13.4.4/engine-timeout] bridge.getBestMove(' + evaluator +
                ') exceeded JS hard timeout ' + hardTimeoutMs + 'ms (slider was ' +
                thinkTimeOverride + 'ms); falling back to v0. Worker search continues; ' +
                'discarding eventual result.'
            );
            return Bot.getBestMove(gameBoard, team);
        }
        if (!res || !res.ok || !res.move) {
            // Engine returned but with no move (search budget honored
            // upstream + no completed depth). Fall back to v0 so the
            // game progresses; user sees a move + a console note.
            console.warn(
                '[m13.4.1/engine-fallback] engine eval=' + evaluator +
                ' returned no move (' + (res && res.error ? res.error : 'no-result') +
                '); falling back to v0 heuristic'
            );
            return Bot.getBestMove(gameBoard, team);
        }
        const m = res.move;

        // Validate the engine's move against the current JS board.
        // The engine runs in the Pyodide worker and can lag behind the JS
        // gameBoard state if applyMove and getBestMove are overlapping in the
        // applyChain. A stale result produces a move from a square that's now
        // empty or owned by the opposite team — which crashes BoardGraphics.moveMesh.
        // Fall back to v0 rather than execute a stale move.
        if (m && gameBoard && gameBoard.pieces) {
            const pieceAtOrigin = gameBoard.pieces[m.x0] &&
                                  gameBoard.pieces[m.x0][m.y0] &&
                                  gameBoard.pieces[m.x0][m.y0][m.z0] &&
                                  gameBoard.pieces[m.x0][m.y0][m.z0][m.w0];
            if (!pieceAtOrigin) {
                console.warn(
                    '[m13.4/engine-stale] engine returned move from empty square ' +
                    `(${m.x0},${m.y0},${m.z0},${m.w0}) — JS board has no piece there. ` +
                    'Engine searched a pre-applyMove board snapshot. Falling back to v0.'
                );
                return Bot.getBestMove(gameBoard, team);
            }
            if (pieceAtOrigin.team !== team) {
                console.warn(
                    '[m13.4/engine-stale] engine returned move from wrong-team piece ' +
                    `(${m.x0},${m.y0},${m.z0},${m.w0}): piece.team=${pieceAtOrigin.team} ` +
                    `but expected team=${team}. Falling back to v0.`
                );
                return Bot.getBestMove(gameBoard, team);
            }
        }

        console.log(
            '[m13.4/engine] eval=' + (res.evaluator || evaluator) +
            ' depth=' + res.depth + ' nodes=' + res.nodesSearched +
            ' tt=' + res.ttHits + '/' + res.ttSize +
            ' score=' + (res.score != null ? res.score.toFixed(3) : '?') +
            ' time=' + (res.elapsedMs != null ? res.elapsedMs.toFixed(0) : '?') + 'ms' +
            ' pvlen=' + ((res.pv && res.pv.length) || 0)
        );
        // M14.5 — push the principal variation to the PV overlay so the
        // user sees the engine's predicted line during the visual gate
        // window (between search completion and move execution).
        if (typeof window !== 'undefined' && window.SpectralPV &&
            typeof window.SpectralPV.show === 'function' && res.pv) {
            try { window.SpectralPV.show(res.pv, /*team*/ 0); }
            catch (e) { /* PV overlay is non-critical; swallow */ }
        }
        // M14.7 — focus axial guide lines on the engine's chosen origin
        // square so the user sees what the bot is "thinking about." Cleared
        // when the move executes (GameBoard.move() drops focus via
        // SpectralAxialLines.clear hook below if we wire it; here we just
        // set focus and let selectPiece/deselectPiece manage transitions).
        if (typeof window !== 'undefined' && window.SpectralAxialLines &&
            typeof window.SpectralAxialLines.setFocus === 'function' && res.move) {
            try {
                window.SpectralAxialLines.setFocus({
                    x: res.move.x0, y: res.move.y0,
                    z: res.move.z0, w: res.move.w0,
                });
            } catch (e) { /* non-critical */ }
        }
        // Strategy contract from M13.2: return {x0..w1, score, isCapture}.
        // isCapture is informational; the engine doesn't tell us, so we
        // leave it false (downstream visual gate handles uniformly).
        return {
            x0: m.x0, y0: m.y0, z0: m.z0, w0: m.w0,
            x1: m.x1, y1: m.y1, z1: m.z1, w1: m.w1,
            score: res.score,
            isCapture: false,
        };
    } catch (err) {
        console.warn('[m13.4/engine] bridge call threw:', err);
        return null;
    }
};

// Per-side active strategy. Default both to v0 (existing behavior).
// URL flags: ?botWhite=smart&botBlack=defensive (e.g.) override the default
// at page load. UI dropdowns can flip these mid-game.
Bot.activeStrategy = { 0: 'v0', 1: 'v0' }; // 0=white, 1=black

Bot.setStrategy = function (team, name) {
    if (!Bot.strategies[name]) {
        console.warn('[m13.2/bot] unknown strategy:', name, '— available:', Object.keys(Bot.strategies));
        return;
    }
    Bot.activeStrategy[team] = name;
    console.log('[m13.2/bot] team ' + team + ' (' + (team === 0 ? 'white' : 'black') + ') → ' + name);
};

Bot.getActiveStrategyName = function (team) {
    return Bot.activeStrategy[team] || 'v0';
};

// M13.1 + M13.2 + M13.5 boot-time URL-flag handling.
//   ?bot=smart            → DEPRECATED, aliases to engine-material with warn (M13.5)
//   ?botWhite=NAME        → set white's strategy
//   ?botBlack=NAME        → set black's strategy
try {
    if (typeof window !== 'undefined') {
        const params = new URLSearchParams(location.search);
        const legacy = params.get('bot');
        if (legacy === 'smart' || legacy === 'engine-material') {
            const target = 'engine-material';
            Bot.activeStrategy = { 0: target, 1: target };
            if (legacy === 'smart') {
                console.warn(
                    '[m13.5/bot] ?bot=smart is deprecated; aliasing to engine-material. ' +
                    'The JS-side alpha-beta search was retired in M13.5 — engine-* runs in ' +
                    'the Pyodide worker and does not freeze the page. ' +
                    'Use ?botWhite=engine-material&botBlack=engine-material in the future.'
                );
            } else {
                console.log('[m13.4/bot] engine-material enabled (?bot=engine-material, both sides)');
            }
        }
        const botWhite = params.get('botWhite');
        const botBlack = params.get('botBlack');
        // M13.5: redirect 'smart' aliases to engine-material on the per-team flags too.
        if (botWhite === 'smart') {
            console.warn('[m13.5/bot] ?botWhite=smart deprecated → engine-material');
            Bot.setStrategy(0, 'engine-material');
        } else if (botWhite) {
            Bot.setStrategy(0, botWhite);
        }
        if (botBlack === 'smart') {
            console.warn('[m13.5/bot] ?botBlack=smart deprecated → engine-material');
            Bot.setStrategy(1, 'engine-material');
        } else if (botBlack) {
            Bot.setStrategy(1, botBlack);
        }
    }
} catch (_) { /* not in a browser; leave defaults */ }

// M11.50: expose Bot on window so the headless regression test can drive
// Bot.makeMove via page.evaluate. Top-level `const Bot = ...` lives in the
// script-tag's lexical scope but isn't auto-promoted to window the way
// `var` would be. Explicit assignment for test reachability.
if (typeof window !== 'undefined') {
    window.Bot = Bot;
}

// M13.4.3 — cancel-generation counter for in-flight Bot.makeMove. Each
// makeMove call captures the current value at entry; bumping this
// counter (via cancelInFlight) signals every in-flight makeMove to bail
// at its next await boundary without applying its move. Used by
// main.js's setGameMode when the user switches to Two Players (or any
// mode change) so an engine bot mid-search doesn't suddenly play a
// move from a previous mode after the user has already taken control.
//
// Why a counter and not a boolean: multiple makeMove calls can be
// in-flight simultaneously (rare but possible — e.g., a stale promise
// from a previous mode racing with a newly scheduled one). Each gets a
// snapshot of the counter at entry and bails if the live counter has
// moved past it. A boolean would have ambiguous reset semantics.
//
// What this does NOT cancel: the underlying Pyodide search. The worker
// keeps computing until time_budget_ms expires; we just discard the
// returned move on the JS side. To truly abort the worker we'd need a
// cancellation token in the bridge protocol — out of scope here.
Bot._cancelGen = 0;
Bot.cancelInFlight = function () {
    Bot._cancelGen++;
    console.log('[m13.4.3/bot-cancel] cancel requested; gen=' + Bot._cancelGen);
};
