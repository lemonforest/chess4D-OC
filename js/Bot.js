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
        
        // Randomly pick from top moves
        const selectedMove = topMoves[Math.floor(Math.random() * topMoves.length)];
        
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

        if (!move) {
            console.warn(`Bot: No legal moves found for team ${team} - may be checkmate/stalemate`);
            // Double-check win condition if no move found
            if (typeof checkWinCondition === 'function') {
                setTimeout(() => checkWinCondition(), 100);
            }
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
                // Execute the move
                Bot.executeMoveImmediate(gameBoard, moveManager, move, resolve);
            }, wait);
        });
    },
    
    /**
     * Execute move immediately (internal helper)
     */
    executeMoveImmediate: function(gameBoard, moveManager, move, resolve) {
        // Clear bot's visual selection
        const sourcePiece = gameBoard.pieces[move.x0][move.y0][move.z0][move.w0];
        
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
    // M13.1 — SMART-MODE SEARCH (iterative deepening alpha-beta + transposition
    //          table + move ordering). Gated behind ?bot=smart URL flag.
    //
    // The default getBestMove path above does single-ply lookahead with
    // handcrafted heuristics + 30%-randomized top moves. That produces
    // playable but shallow moves. M13.1 adds a deeper search that uses
    // standard 2D-engine techniques (all of which port to 4D unchanged):
    //
    //   - Iterative deepening: ply 1, 2, ... up to maxDepth or timeBudget
    //   - Alpha-beta pruning: cut subtrees that can't improve the bound
    //   - Move ordering (MVV-LVA): try captures of higher-value pieces
    //     first so beta cutoffs fire as early as possible
    //   - Transposition table: skip re-evaluating positions reached by
    //     transposition (multiple move orders → same position)
    //   - Material+mobility position eval (same heuristic as v0)
    //
    // Branching factor in 4D chess is ~60-100 per side, so with good
    // move ordering alpha-beta evaluates ~sqrt(N) of the tree → 2-ply
    // is in the 60-100 effective leaf range, very tractable.
    //
    // Future M13.2 (filed): replace material+mobility eval with chess-
    // spectral channel-energy weighted sum. Async path, follow-up PR.
    // ────────────────────────────────────────────────────────────────────────

    smartMode: false,
    // M11.24 — kept as Bot._PIECE_VALUES for backward-compat with the
    // four call sites (evaluatePosition, evaluatePositionSpectral,
    // getBestMoveWeighted, etc.). Sourced from window.BOT.PIECE_VALUES.
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

    /**
     * Alpha-beta search. Returns { score, move } where score is from
     * `searchTeam`'s perspective (always maximizing). Calls itself
     * recursively, swapping team and negating the recursive score
     * (negamax form). Bails (returns null) if the timeBudget expires —
     * caller falls back to the previous iterative-deepening result.
     */
    _alphaBeta: function (gameBoard, team, searchTeam, depth, alpha, beta, tt, deadline) {
        if (typeof performance !== 'undefined' && performance.now() > deadline) return null;
        if (depth === 0) {
            return { score: Bot.evaluatePosition(gameBoard, searchTeam), move: null };
        }
        const ttKey = depth + '|' + Bot.positionHash(gameBoard, team);
        const cached = tt.get(ttKey);
        if (cached) return cached;
        const moves = Bot.generateOrderedMoves(gameBoard, team);
        if (moves.length === 0) {
            // Checkmate or stalemate. Use the existing inCheck check.
            const inCheck = gameBoard.inCheck && gameBoard.inCheck(team);
            const score = inCheck
                ? (team === searchTeam ? -window.BOT.SCORES.CHECKMATE : window.BOT.SCORES.CHECKMATE)
                : 0;
            return { score: score, move: null };
        }
        let bestScore = -Infinity;
        let bestMove = null;
        const maximizing = (team === searchTeam);
        for (const m of moves) {
            const captured = Bot._applyTemp(gameBoard, m);
            const sub = Bot._alphaBeta(gameBoard, 1 - team, searchTeam, depth - 1, -beta, -alpha, tt, deadline);
            Bot._undoTemp(gameBoard, m, captured);
            if (sub === null) return null; // timeout
            // Negamax: child returns from team's perspective; flip sign for opponent's eval.
            const subScore = maximizing ? sub.score : -sub.score;
            if (subScore > bestScore) {
                bestScore = subScore;
                bestMove = m;
            }
            if (bestScore > alpha) alpha = bestScore;
            if (alpha >= beta) break; // beta cutoff
        }
        const result = { score: bestScore, move: bestMove };
        tt.set(ttKey, result);
        return result;
    },

    /**
     * Iterative-deepening driver. Searches depth 1, 2, ... up to
     * maxDepth or until timeBudgetMs elapses. Returns the best move
     * from the deepest completed iteration.
     *
     * M11.28a: now async with cooperative yields between depth
     * iterations so the browser can paint at least once per pass and
     * the busy-spinner GPU compositor stays responsive. The yield uses
     * scheduler.postTask({priority: 'user-visible'}) on supported
     * browsers (Chrome/Edge 94+) and falls back to setTimeout(0) on
     * Firefox/Safari. Note: this does NOT make the search itself
     * non-blocking — a single deep _alphaBeta still freezes the main
     * thread for its duration. The complete fix is M13.4 (chess-spectral
     * 1.6 engine cutover, search runs in Pyodide worker).
     */
    getBestMoveSmart: async function (gameBoard, team, opts) {
        opts = opts || {};
        const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 3;
        const timeBudgetMs = Number.isFinite(opts.timeBudgetMs) ? opts.timeBudgetMs : 4000;
        const startTime = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        const deadline = startTime + timeBudgetMs;
        const tt = new Map();
        let bestMove = null;
        let bestScore = -Infinity;
        let lastDepthCompleted = 0;
        for (let d = 1; d <= maxDepth; d++) {
            const result = Bot._alphaBeta(gameBoard, team, team, d, -Infinity, Infinity, tt, deadline);
            if (result === null) break; // timed out
            bestMove = result.move;
            bestScore = result.score;
            lastDepthCompleted = d;
            // Yield between depth iterations so the browser gets to
            // paint and process input. Skipped at maxDepth so we don't
            // pay an unnecessary microtask boundary on the last loop.
            if (d < maxDepth) {
                await Bot._yieldToMain();
                // After the yield, re-check the deadline — the user might
                // have eaten budget on a long animation frame.
                if (((typeof performance !== 'undefined') ? performance.now() : Date.now()) > deadline) break;
            }
        }
        const elapsed = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - startTime;
        console.log(
            '[m13.1/bot] smart search: depth=' + lastDepthCompleted + '/' + maxDepth +
            ' score=' + bestScore + ' tt-entries=' + tt.size +
            ' time=' + elapsed.toFixed(0) + 'ms'
        );
        return bestMove;
    },

    /**
     * Yield to the main thread between depth iterations. Uses the
     * scheduler API where available (Chrome/Edge 94+) so the browser
     * can prioritize user input over background bot CPU; falls back
     * to setTimeout(0) on Firefox/Safari which still gives one
     * animation-frame of breathing room.
     *
     * Priority 'user-visible' is the middle tier — bot work should
     * keep flowing but yield to user input. 'background' would starve
     * under load; 'user-blocking' would defeat the point.
     */
    _yieldToMain: function () {
        return new Promise(function (resolve) {
            if (typeof globalThis !== 'undefined'
                && globalThis.scheduler
                && typeof globalThis.scheduler.postTask === 'function') {
                try {
                    globalThis.scheduler.postTask(resolve, { priority: 'user-visible' });
                    return;
                } catch (_) { /* fall through to setTimeout */ }
            }
            setTimeout(resolve, 0);
        });
    },
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
//   - 'v0'         : the original single-ply heuristic + top-30% randomization
//   - 'smart'      : iterative-deepening alpha-beta + transposition table (M13.1)
//   - 'random'     : uniform random over legal moves (control / baseline)
//   - 'aggressive' : capture value × 5 — chases material, ignores safety
//   - 'defensive'  : penalty for under-attack destinations × 5 — avoids danger
//   - 'center'     : center bonus × 5 — fights for the lattice center
//
// Future M13.3 will add 'spectral-eval' once the async chess-spectral
// channel-energy weighted-sum eval is wired up.
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
    smart: {
        label: 'Alpha-beta + TT (depth 3)',
        getBestMove: function (gb, team) { return Bot.getBestMoveSmart(gb, team); },
    },
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
        label: 'Engine — material eval (cs1.6 alpha-beta)',
        getBestMove: function (gb, team) { return Bot._engineGetBestMove('material'); },
    },
    'engine-spectral': {
        label: 'Engine — spectral eval (channel energy)',
        getBestMove: function (gb, team) { return Bot._engineGetBestMove('spectral'); },
    },
    'engine-qm': {
        label: 'Engine — QM eval (Born-rule observables)',
        getBestMove: function (gb, team) { return Bot._engineGetBestMove('qm'); },
    },
};

// M13.4 — shared engine search helper. Async (returns Promise<move|null>);
// strategy.getBestMove call sites already `await` so the existing async
// path through Bot.makeMove (set up in M11.28a) handles this naturally.
//
// Search depth + time budget come from the existing TIMING constants;
// future work (M13.4.1) can expose per-strategy slider tuning.
Bot._engineGetBestMove = async function (evaluator) {
    if (typeof window === 'undefined' || !window.SpectralBridge ||
        typeof window.SpectralBridge.getBestMove !== 'function') {
        console.warn('[m13.4/engine] bridge.getBestMove unavailable; falling back to null');
        return null;
    }
    try {
        const res = await window.SpectralBridge.getBestMove({
            evaluator: evaluator,
            maxDepth: 3,
            timeBudgetMs: 4000,
        });
        if (!res || !res.ok || !res.move) {
            console.warn('[m13.4/engine] getBestMove failed:', res && res.error);
            return null;
        }
        const m = res.move;
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

// M13.1 + M13.2 boot-time URL-flag handling.
//   ?bot=smart            → backward-compatibility: enables smart for BOTH sides
//   ?botWhite=NAME        → set white's strategy
//   ?botBlack=NAME        → set black's strategy
try {
    if (typeof window !== 'undefined') {
        const params = new URLSearchParams(location.search);
        const legacy = params.get('bot');
        if (legacy === 'smart') {
            Bot.smartMode = true;
            // M13.2: also write into the per-team registry for symmetry.
            Bot.activeStrategy = { 0: 'smart', 1: 'smart' };
            console.log('[m13.1/bot] smart mode enabled (?bot=smart, both sides)');
        }
        const botWhite = params.get('botWhite');
        const botBlack = params.get('botBlack');
        if (botWhite) Bot.setStrategy(0, botWhite);
        if (botBlack) Bot.setStrategy(1, botBlack);
    }
} catch (_) { /* not in a browser; leave defaults */ }
