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
        if (!gameBoard || !gameBoard.pieces) {
            return -1000;
        }
        
        let score = 0;
        
        // Check if this is a capture
        const targetPiece = gameBoard.pieces[x1][y1][z1][w1];
        if (targetPiece && targetPiece.type && targetPiece.team !== team) {
            // Capture move - prioritize higher value pieces
            const pieceValues = {
                'pawn': 10,
                'knight': 30,
                'bishop': 30,
                'rook': 50,
                'queen': 90,
                'king': 1000  // Checkmate
            };
            score += pieceValues[targetPiece.type] || 10;
            
            // Bonus for capturing with a lower value piece
            const sourcePiece = gameBoard.pieces[x0][y0][z0][w0];
            if (sourcePiece && sourcePiece.type) {
                const sourceValue = pieceValues[sourcePiece.type] || 10;
                const targetValue = pieceValues[targetPiece.type] || 10;
                if (sourceValue < targetValue) {
                    score += 50; // Great trade!
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
                const pieceValues = {
                    'pawn': 10,
                    'knight': 30,
                    'bishop': 30,
                    'rook': 50,
                    'queen': 90,
                    'king': 1000
                };
                score -= pieceValues[sourcePiece.type] || 10;
            } else {
                score -= 20; // Default penalty
            }
        } else {
            // Safe move - small bonus
            score += 5;
        }
        
        // Check if current position is under attack (escape danger)
        const currentUnderAttack = Bot.isPositionUnderAttack(gameBoard, x0, y0, z0, w0, team);
        if (currentUnderAttack) {
            score += 30; // Bonus for escaping danger
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
                                                score: 10000, // Very high score for escaping check
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
        const topMovesCount = Math.max(1, Math.floor(movesToUse.length * 0.3));
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
    makeMove: function(gameBoard, moveManager, team) {
        if (!gameBoard || !moveManager) {
            console.error('Bot: gameBoard or moveManager not available');
            return Promise.resolve(false);
        }
        
        // CRITICAL: Check if team is in checkmate/stalemate before attempting to move
        const isInCheck = gameBoard.inCheck(team);
        const hasLegalMoves = gameBoard.hasLegalMoves(team);
        
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
        
        // M13.1: when smart mode is on, use the iterative-deepening alpha-
        // beta search instead of the v0 single-ply heuristic. Otherwise
        // keep the original behavior — backward-compatible default.
        const move = Bot.smartMode
            ? Bot.getBestMoveSmart(gameBoard, team)
            : Bot.getBestMove(gameBoard, team);
        
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
            
            // Step 2: Wait a bit for visual feedback, then execute
            setTimeout(() => {
                // Execute the move
                Bot.executeMoveImmediate(gameBoard, moveManager, move, resolve);
            }, 1200); // 1.2 seconds to see the selection
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
    _PIECE_VALUES: { pawn: 10, knight: 30, bishop: 30, rook: 50, queen: 90, king: 1000 },

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
                ? (team === searchTeam ? -100000 : 100000)
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
     */
    getBestMoveSmart: function (gameBoard, team, opts) {
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
        }
        const elapsed = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - startTime;
        console.log(
            '[m13.1/bot] smart search: depth=' + lastDepthCompleted + '/' + maxDepth +
            ' score=' + bestScore + ' tt-entries=' + tt.size +
            ' time=' + elapsed.toFixed(0) + 'ms'
        );
        return bestMove;
    },
};

// M13.1 — URL flag opt-in. ?bot=smart enables iterative-deepening alpha-beta.
// Fully backward compatible — default behavior is unchanged (single-ply
// heuristic + top-30% randomization). Once shipped + tested, M13.2 can
// replace the eval function with chess-spectral channel-energy weights.
try {
    if (typeof window !== 'undefined') {
        const flag = new URLSearchParams(location.search).get('bot');
        if (flag === 'smart') {
            Bot.smartMode = true;
            console.log('[m13.1/bot] smart mode enabled (?bot=smart)');
        }
    }
} catch (_) { /* not in a browser; leave smartMode = false */ }
