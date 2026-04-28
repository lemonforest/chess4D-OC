/* ============================================
   4D CHESS - MAIN GAME CONTROLLER
   ============================================ */

// Global variables
let scene, camera, renderer, controls;
let gameBoard, moveManager;
let canvas, loadingScreen;

// Make functions globally available for GameBoard callbacks (will be set after functions are defined)

// Game mode constants
const GAME_MODES = {
    SINGLEPLAYER: 'singleplayer',  // Two players, both manual
    VS_BOT: 'vs-bot',              // Player (white) vs Bot (black)
    BOT_VS_BOT: 'bot-vs-bot'       // Two bots, watch mode
};

// Current game mode
let currentGameMode = GAME_MODES.SINGLEPLAYER;

// Bot move interval (for Bot vs Bot mode)
let botMoveInterval = null;

// Game mode (local single player for now)
const LocalMode = {
    move: function(x0, y0, z0, w0, x1, y1, z1, w1, receiving) {
        // Execute the move on the board
        const metaData = this.gameBoard.move(x0, y0, z0, w0, x1, y1, z1, w1);
        
        // Add move to history (this updates turn counter)
        this.moveHistory.add(x0, y0, z0, w0, x1, y1, z1, w1, metaData);
        
        // Update move history UI
        if (typeof addMoveToHistory === 'function') {
            addMoveToHistory(this, x0, y0, z0, w0, x1, y1, z1, w1, metaData);
        }
        
        // Update piece selectability based on whose turn it is
        this.updateSelectability();
        
        // Update UI (status display) - do this AFTER move is added to history
        this.updateUI();
        
        // Force UI update for turn-text and indicator styling
        const turnIndicator = document.getElementById('turn-indicator');
        const turnTextEl = document.getElementById('turn-text');
        const turnIcon = document.getElementById('turn-icon');
        
            if (turnTextEl && turnIndicator && turnIcon) {
                const currentTeam = this.whoseTurn();
                turnTextEl.textContent = currentTeam === 0 ? 'White to Move' : 'Black to Move';
                turnIcon.textContent = currentTeam === 0 ? '♔' : '♚';
                
                // Update indicator class for styling
                turnIndicator.classList.remove('white-turn', 'black-turn');
                if (currentTeam === 0) {
                    turnIndicator.classList.add('white-turn');
                } else {
                    turnIndicator.classList.add('black-turn');
                }
            }
            
            // Schedule bot move if needed (after UI update)
            if (typeof scheduleBotMove === 'function') {
                scheduleBotMove();
            }
            
            // IMPORTANT: After any move, deselect any selected piece to ensure
            // the next player sees fresh legal moves (especially important when in check)
            // This prevents stale move lists from before check was applied
            if (typeof deselectPiece === 'function') {
                deselectPiece();
            }
        },
    undo: function() {
        if (this.moveHistory.undo()) {
            // Undo successful, update UI
            this.updateSelectability();
            this.updateUI();
            if (typeof updateMoveHistoryDisplay === 'function') {
                updateMoveHistoryDisplay(this);
            }
            
            // Update piece counts
            if (typeof updatePieceCounts === 'function') {
                updatePieceCounts();
            }
            
            // Check for win condition (in case we undo back to a checkmate state)
            if (typeof checkWinCondition === 'function') {
                checkWinCondition();
            }
        }
    },
    redo: function() {
        if (this.moveHistory.redo()) {
            // Redo successful, update UI
            this.updateSelectability();
            this.updateUI();
            if (typeof updateMoveHistoryDisplay === 'function') {
                updateMoveHistoryDisplay(this);
            }
            
            // Update piece counts
            if (typeof updatePieceCounts === 'function') {
                updatePieceCounts();
            }
            
            // Check for win condition (in case we redo into a checkmate state)
            if (typeof checkWinCondition === 'function') {
                checkWinCondition();
            }
        }
    },
    canMove: function(team) {
        // Only allow the current team to move
        return this.whoseTurn() === team;
    },
    updateSelectability: function() {
        // Enable selectability for current team only
        const currentTeam = this.whoseTurn();
        this.setSelectability(0, currentTeam === 0);
        this.setSelectability(1, currentTeam === 1);
    },
    moveStatus: function() {
        const winStatus = this.winCondition();
        if (winStatus == 0) {
            return "Checkmate! White wins!";
        } else if (winStatus == 1) {
            return "Checkmate! Black wins!";
        } else if (winStatus == 2) {
            return "Stalemate! It's a draw!";
        }
        const checked = this.inCheck();
        const currentTeam = this.whoseTurn();
        // Only show check for the CURRENT team (whose turn it is)
        if (checked == 0 && currentTeam == 0) {
            return "White is in check!";
        } else if (checked == 1 && currentTeam == 1) {
            return "Black is in check!";
        }
        
        return currentTeam === 0 ? "White to Move" : "Black to Move";
    }
};

// Game state
const gameState = {
    currentW: 0,  // Show white pieces (W=0,1) by default
    currentY: 0,  // Show bottom boards
    boardOpacity: 0.8,
    showGrid: true,
    highlightMoves: true,
    showCoords: false,
    animatePieces: true,
    showAllBoards: false,
    selectedPiece: null,  // Currently selected piece mesh
    selectedPieceData: null,  // Piece data (from gameBoard.pieces)
    possibleMoves: null  // Array of possible moves for selected piece
};

// Selection system
const selectionSystem = {
    raycaster: new THREE.Raycaster(),
    mouse: new THREE.Vector2(),
    hoveredPiece: null,
    selectedPiece: null,
    
    // Colors
    HOVER_COLOR: 0x00B9FF,  // Blue for hover
    SELECT_COLOR: 0x00B9FF,  // Blue for selection
    
    // Highlight a piece
    highlight: function(mesh, color) {
        if (!mesh || !mesh.material) return;
        
        // Store original color if not already stored
        if (!mesh.material.originalColor) {
            mesh.material.originalColor = mesh.material.color.getHex();
        }
        
        // Set new color
        mesh.material.color.setHex(color);
    },
    
    // Unhighlight a piece
    unhighlight: function(mesh) {
        if (!mesh || !mesh.material || !mesh.material.originalColor) return;
        
        mesh.material.color.setHex(mesh.material.originalColor);
    }
};

// Expose selectionSystem globally for bot to use
if (typeof window !== 'undefined') {
    window.selectionSystem = selectionSystem;
}

/* ============================================
   INITIALIZATION
   ============================================ */

function init() {
    console.log('🎮 Initializing 4D Chess...');
    
    // Setup global callbacks for GameBoard (so it can call deselectPiece after animation)
    if (typeof window !== 'undefined') {
        window.setupGlobalCallbacks = function() {
            window.deselectPiece = deselectPiece;
            window.selectionSystem = selectionSystem;
        };
        // Call it now since functions are already defined
        if (typeof deselectPiece === 'function' && typeof selectionSystem !== 'undefined') {
            window.deselectPiece = deselectPiece;
            window.selectionSystem = selectionSystem;
        }
    }
    
    // Suppress browser extension errors (common Chrome extension issue)
    window.addEventListener('error', (e) => {
        if (e.message && e.message.includes('message channel closed')) {
            e.preventDefault();
            return false;
        }
    }, true);
    
    // Also catch unhandled promise rejections (the error shows "(in promise)")
    window.addEventListener('unhandledrejection', (e) => {
        if (e.reason && e.reason.message && e.reason.message.includes('message channel closed')) {
            e.preventDefault();
            return false;
        }
    });
    
    // Get canvas and loading screen
    canvas = document.getElementById('game-canvas');
    loadingScreen = document.getElementById('loading-screen');
    
    // Setup Three.js
    setupThreeJS();
    
    // Setup UI event listeners
    setupUIEvents();
    
    // Setup keyboard shortcuts
    setupKeyboardShortcuts();
    
    // Initialize game (wait for models to load first)
    initializeGame();
    
    // Setup mouse interaction for piece selection
    setupPieceSelection();
    
    // Tutorial will initialize after models are loaded (see initializeGame)
    
    // Start animation loop
    animate();
    
    console.log('✅ Initialization complete!');
}

/* ============================================
   MOUSE INTERACTION SETUP
   ============================================ */

function setupPieceSelection() {
    if (!canvas) return;
    
    // Update mouse position
    canvas.addEventListener('mousemove', function(event) {
        // Calculate mouse position in normalized device coordinates (-1 to +1)
        const rect = canvas.getBoundingClientRect();
        selectionSystem.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        selectionSystem.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    });
    
    // Handle clicks
    canvas.addEventListener('click', function(event) {
        // Check if clicking on a possible move location
        if (selectionSystem.selectedPiece && gameState.possibleMoves) {
            const pieces = gameBoard.graphics.possibleMovesContainer.children.filter(p => p.canRayCast);
            if (pieces.length > 0) {
                selectionSystem.raycaster.setFromCamera(selectionSystem.mouse, camera);
                const intersects = selectionSystem.raycaster.intersectObjects(pieces);
                
                if (intersects.length > 0) {
                    // Clicked on a possible move - execute move
                    const targetMesh = intersects[0].object;
                    const targetWorldPos = targetMesh.position;
                    const targetCoords = gameBoard.graphics.worldCoordinates(targetWorldPos);
                    
                    // Find this move in possibleMoves
                    const move = gameState.possibleMoves.find(m => 
                        m.x === targetCoords.x && 
                        m.y === targetCoords.y && 
                        m.z === targetCoords.z && 
                        m.w === targetCoords.w
                    );
                    
                    if (move) {
                        // Get source coordinates
                        const sourceCoords = gameBoard.graphics.worldCoordinates(selectionSystem.selectedPiece.position);
                        
                        // Execute move
                        executeMove(
                            sourceCoords.x, sourceCoords.y, sourceCoords.z, sourceCoords.w,
                            targetCoords.x, targetCoords.y, targetCoords.z, targetCoords.w
                        );
                        return;
                    }
                }
            }
        }
        
        // Regular piece selection
        if (!gameBoard || !gameBoard.graphics) return;
        
        const pieces = gameBoard.graphics.piecesContainer.children.filter(p => p.canRayCast);
        if (pieces.length === 0) return;
        
        selectionSystem.raycaster.setFromCamera(selectionSystem.mouse, camera);
        const intersects = selectionSystem.raycaster.intersectObjects(pieces);
        
        if (intersects.length > 0) {
            const clickedPiece = intersects[0].object;
            
            // If clicking the same piece, deselect it
            if (selectionSystem.selectedPiece === clickedPiece) {
                deselectPiece();
            } else {
                selectPiece(clickedPiece);
            }
        } else {
            // Clicked on empty space, deselect
            deselectPiece();
        }
    });
    
    console.log('✅ Piece selection system initialized');
}

function executeMove(x0, y0, z0, w0, x1, y1, z1, w1) {
    console.log(`🎯 Executing move: (${x0},${y0},${z0},${w0}) → (${x1},${y1},${z1},${w1})`);
    
    if (!gameBoard || !PieceMovement) {
        console.error('❌ Cannot execute move: gameBoard or PieceMovement not available');
        deselectPiece();
        return;
    }
    
    // Get current team (if moveManager exists)
    let currentTeam = null;
    if (moveManager && typeof moveManager.whoseTurn === 'function') {
        currentTeam = moveManager.whoseTurn();
    }
    
    // Execute move using moveManager (which handles turn tracking and history)
    // OR fall back to PieceMovement if moveManager doesn't exist
    let success = false;
    
    if (moveManager && typeof moveManager.move === 'function') {
        // Validate move first (without executing)
        const sourcePiece = gameBoard.pieces[x0][y0][z0][w0];
        if (!sourcePiece || !sourcePiece.type) {
            console.error('❌ No piece at source position');
            return;
        }
        
        // Check if it's the current player's turn
        if (currentTeam !== null && sourcePiece.team !== currentTeam) {
            console.error(`❌ Not your turn (piece is team ${sourcePiece.team}, current team is ${currentTeam})`);
            return;
        }
        
        // Check if move is legal (basic validation)
        let possibleMoves = sourcePiece.getPossibleMoves(gameBoard.pieces, x0, y0, z0, w0);

        // M4a shadow check: if ?legalityEngine=shadow|py, ask Python in
        // parallel and log any diff. Doesn't block move validation; the
        // JS engine remains the gate until M4b flips polarity.
        if (typeof window !== 'undefined' && window.SpectralBridge &&
                (window.__LEGALITY_ENGINE__ === 'shadow' || window.__LEGALITY_ENGINE__ === 'py')) {
            window.SpectralBridge.legalMoves({x: x0, y: y0, z: z0, w: w0})
                .then((res) => {
                    if (!res || !res.ok) {
                        console.warn(`[m4a/shadow] py.legalMoves not ok at (${x0},${y0},${z0},${w0}):`, res && res.reason);
                        return;
                    }
                    const jsKeys = new Set(possibleMoves.map(m => `${m.x},${m.y},${m.z},${m.w}`));
                    const pyKeys = new Set(res.moves.map(m => `${m.x},${m.y},${m.z},${m.w}`));
                    const onlyJs = [...jsKeys].filter(k => !pyKeys.has(k));
                    const onlyPy = [...pyKeys].filter(k => !jsKeys.has(k));
                    if (onlyJs.length === 0 && onlyPy.length === 0) {
                        console.log(`[m4a/shadow] OK at (${x0},${y0},${z0},${w0}): ${jsKeys.size} moves agree`);
                    } else {
                        console.warn(`[m4a/shadow] DIFF at (${x0},${y0},${z0},${w0}): JS-only=${onlyJs.join('|')} Py-only=${onlyPy.join('|')}`);
                    }
                })
                .catch((err) => console.warn('[m4a/shadow] bridge.legalMoves error:', err));
        }

        let isValidMove = possibleMoves.some(move =>
            move.x === x1 && move.y === y1 && move.z === z1 && move.w === w1
        );
        if (!isValidMove) {
            console.error('❌ Move not in possible moves list');
            return;
        }
        
        // Check if trying to capture own piece
        const targetPiece = gameBoard.pieces[x1][y1][z1][w1];
        if (targetPiece && targetPiece.type && targetPiece.team === sourcePiece.team) {
            console.error('❌ Cannot capture own piece');
            return;
        }
        
        // CRITICAL: Filter out illegal moves (moves that leave own king in check)
        const legalMoves = filterIllegalMoves(
            gameBoard,
            x0, y0, z0, w0,
            possibleMoves,
            sourcePiece.team
        );
        
        // Check if the selected move is still in the legal moves after filtering
        isValidMove = legalMoves.some(move => 
            move.x === x1 && move.y === y1 && move.z === z1 && move.w === w1
        );
        if (!isValidMove) {
            const isInCheck = gameBoard.inCheck(sourcePiece.team);
            if (isInCheck) {
                console.error('❌ Move is illegal - you are in check and must escape check!');
            } else {
                console.error('❌ Move is illegal - would leave own king in check!');
            }
            // Deselect piece to force player to reselect and see updated legal moves
            deselectPiece();
            return;
        }
        
        // Use moveManager to handle the move (this will call gameBoard.move internally)
        try {
            moveManager.move(x0, y0, z0, w0, x1, y1, z1, w1);
            success = true;
            
            // Move completed - deselect piece and update UI
            console.log('✅ Move completed via moveManager');
            
            // Deselect piece first (removes blue highlight) - IMPORTANT: This ensures
            // that if opponent is now in check, their selected piece (if any) is deselected
            // and they must reselect to see only legal escape moves
            deselectPiece();
            
            // Update piece counts
            if (gameBoard && gameBoard.pieces) {
                updatePieceCounts();
            }
            
            // Update move history display
            if (moveManager && typeof updateMoveHistoryDisplay === 'function') {
                updateMoveHistoryDisplay(moveManager);
            }
            
            // Note: moveManager.move() already calls updateUI() at the end,
            // which updates the turn-text, turn-icon, turn-number, current-player, etc.
            
            // CRITICAL: Check win condition immediately after move completes
            // After move() completes, the turn has switched to the opponent
            // We need to check the current team (opponent) to see if they're in checkmate
            // Also check the team that just moved to see if they put themselves in checkmate (illegal!)
            const currentTeam = moveManager.whoseTurn(); // Team whose turn it is now (opponent)
            const previousTeam = (currentTeam + 1) % 2; // Team that just moved
            
            // Check immediately - no delay needed for checkmate detection
            const winStatus = gameBoard.winCondition();
            
            if (winStatus !== -1) {
                // Game is over (checkmate or stalemate) - show modal immediately
                console.log(`🛑 Game over detected! Win status: ${winStatus}`);
                checkWinCondition();
            } else {
                // Game continues - check if current team is in check (but not checkmate yet)
                // This will be handled by the UI update
                
                // Schedule bot move if needed
                setTimeout(() => {
                    const winStatusAfter = gameBoard.winCondition();
                    if (winStatusAfter === -1) {
                        // Game still continues, schedule bot move if needed
                        scheduleBotMove();
                    } else {
                        // Game ended while we waited - show modal
                        checkWinCondition();
                    }
                }, 100);
            }
        } catch (error) {
            console.error('❌ Error executing move via moveManager:', error);
            success = false;
        }
    } else {
        // Fallback: Use PieceMovement directly (without turn management)
        success = PieceMovement.executeMove(
            gameBoard,
            x0, y0, z0, w0,
            x1, y1, z1, w1,
            function(metadata) {
                console.log('✅ Move completed with metadata:', metadata);
                deselectPiece();
                if (gameBoard && gameBoard.pieces) {
                    updatePieceCounts();
                }
            },
            currentTeam
        );
    }
    
    if (!success) {
        console.warn('⚠️ Move execution failed');
        // Don't deselect on failed move - let user try again
    }
}

function updatePieceCounts() {
    if (!gameBoard || !gameBoard.pieces) return;
    
    let whiteCount = 0;
    let blackCount = 0;
    
    for (let x = 0; x < gameBoard.n; x++) {
        for (let y = 0; y < gameBoard.n; y++) {
            for (let z = 0; z < gameBoard.n; z++) {
                for (let w = 0; w < gameBoard.n; w++) {
                    const piece = gameBoard.pieces[x][y][z][w];
                    if (piece && piece.type) {
                        if (piece.team === 0) whiteCount++;
                        else if (piece.team === 1) blackCount++;
                    }
                }
            }
        }
    }
    
    const whiteCountEl = document.getElementById('white-count');
    const blackCountEl = document.getElementById('black-count');
    if (whiteCountEl) whiteCountEl.textContent = whiteCount;
    if (blackCountEl) blackCountEl.textContent = blackCount;
}

/* ============================================
   THREE.JS SETUP
   ============================================ */

function setupThreeJS() {
    // Create scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0e27); // Dark blue background
    // PERFORMANCE: Slightly reduce fog distance (minimal visual impact, better culling)
    scene.fog = new THREE.Fog(0x0a0e27, 800, 2500); // Reduced from 1000-3000 to 800-2500
    
    // Create camera
    const aspect = window.innerWidth / window.innerHeight;
    // PERFORMANCE: Slightly reduce FOV and far plane (minimal visual impact)
    camera = new THREE.PerspectiveCamera(58, aspect, 1, 4000); // FOV: 60→58, far: 10000→4000
    
    // Initial camera position (will be adjusted after board is created)
    camera.position.set(0, 1500, 0);
    
    // Create renderer
    renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: false, // Disable antialiasing for better performance
        alpha: false,
        powerPreference: "high-performance" // Prefer performance over quality
    });
    renderer.setSize(window.innerWidth - 560, window.innerHeight - 60); // Minus panels width
    // PERFORMANCE: Cap pixel ratio at 1.5 for better performance while maintaining quality
    // (1.5 is a good balance - looks great but much faster than 2.0 or 3.0)
    // VISUAL: Slightly increase pixel ratio for better quality (minimal performance impact)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    // Disable shadows for better performance (very expensive with 896 pieces + 4096 squares)
    renderer.shadowMap.enabled = false;
    // PERFORMANCE: Additional renderer optimizations
    renderer.sortObjects = false; // Disable sorting (not needed for opaque objects)
    renderer.precision = "mediump"; // Use medium precision (faster than highp, still looks great)
    renderer.stencil = false; // Disable stencil buffer (not needed)
    renderer.logarithmicDepthBuffer = false; // Disable logarithmic depth (faster)
    
    // Add orbit controls (CAD-style)
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 0);  // Will be updated after board is created
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.screenSpacePanning = true;  // Enable vertical panning (like CAD)
    controls.minDistance = 200;
    controls.maxDistance = 5000;
    controls.maxPolarAngle = Math.PI; // Allow full rotation
    
    // Mouse button configuration (CAD-style)
    controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,    // Left mouse: rotate
        MIDDLE: THREE.MOUSE.DOLLY,   // Middle mouse (wheel): zoom
        RIGHT: THREE.MOUSE.PAN       // Right mouse: pan (move horizontally & vertically)
    };
    
    // Adjust speeds for better control
    controls.panSpeed = 1.0;         // Pan speed
    controls.rotateSpeed = 1.0;      // Rotation speed
    controls.zoomSpeed = 1.2;        // Zoom speed
    
    // Enable zoom to cursor behavior (zoom towards mouse pointer)
    if (controls.hasOwnProperty('zoomToCursor')) {
        controls.zoomToCursor = true;
    }
    
    // Add lights
    setupLights();
    
    // Add grid helper (position will be adjusted after board is created)
    // Reduced grid size and divisions for better performance
    const gridHelper = new THREE.GridHelper(4000, 40, 0x444464, 0x1e2746); // Reduced from 80 to 40 divisions
    gridHelper.position.set(0, 0, 0);
    scene.add(gridHelper);
    
    // Store grid helper reference for later positioning
    window.gridHelper = gridHelper;
    
    // Handle window resize
    window.addEventListener('resize', onWindowResize, false);
    
    console.log('✅ Three.js setup complete');
}

function setupLights() {
    // VISUAL: Optimized lighting for better piece appearance
    // Stronger ambient light for even illumination (no shadows needed)
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.75);
    scene.add(ambientLight);
    
    // Main directional light - primary light source
    const mainLight = new THREE.DirectionalLight(0xffffff, 0.7);
    mainLight.position.set(500, 1000, 500);
    mainLight.castShadow = false; // Shadows disabled for performance
    scene.add(mainLight);
    
    // VISUAL: Add subtle fill light from opposite side for depth (low intensity)
    // This adds minimal performance cost but significantly improves piece appearance
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.2);
    fillLight.position.set(-400, 300, -400);
    scene.add(fillLight);
    
    // VISUAL: Add subtle rim light for edge definition
    const rimLight = new THREE.DirectionalLight(0xffffff, 0.15);
    rimLight.position.set(0, -500, 0);
    scene.add(rimLight);
}

/* ============================================
   NAVIGATION CONTROLS SETUP
   ============================================ */

function setupNavigationControls() {
    if (!controls) {
        console.warn('⚠️ Controls not initialized yet, cannot setup navigation controls');
        return;
    }
    
    // Freeze/Unfreeze button
    const freezeBtn = document.getElementById('nav-freeze');
    if (freezeBtn) {
        let isFrozen = false;
        freezeBtn.addEventListener('click', () => {
            isFrozen = !isFrozen;
            controls.enabled = !isFrozen;
            freezeBtn.classList.toggle('frozen', isFrozen);
            freezeBtn.querySelector('.nav-label').textContent = isFrozen ? 'Unfreeze' : 'Freeze';
            
            // If unfreezing, stop any ongoing rotation
            if (!isFrozen) {
                controls.enableDamping = true;
            } else {
                controls.enableDamping = false;
                controls.update();
            }
        });
    }
    
    // Pan controls (directional arrows)
    const panSpeed = 50; // Pan distance per click
    
    const setupPanButton = (id, direction) => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.addEventListener('click', () => {
                if (controls && controls.enabled) {
                    // Use OrbitControls pan method for proper screen-space panning
                    const panVector = new THREE.Vector3();
                    
                    switch(direction) {
                        case 'up':
                            panVector.set(0, panSpeed, 0);
                            break;
                        case 'down':
                            panVector.set(0, -panSpeed, 0);
                            break;
                        case 'left':
                            panVector.set(-panSpeed, 0, 0);
                            break;
                        case 'right':
                            panVector.set(panSpeed, 0, 0);
                            break;
                    }
                    
                    // Pan in camera's local space (screen space)
                    panVector.applyQuaternion(camera.quaternion);
                    controls.target.add(panVector);
                    camera.position.add(panVector);
                    controls.update();
                }
            });
        }
    };
    
    setupPanButton('nav-up', 'up');
    setupPanButton('nav-down', 'down');
    setupPanButton('nav-left', 'left');
    setupPanButton('nav-right', 'right');
    
    // Reset view function
    const resetView = () => {
        if (gameBoard && gameBoard.graphics) {
            const boardCenter = gameBoard.graphics.getCenter();
            const newCameraPos = {
                x: 800,
                y: 600,
                z: boardCenter.z + 800
            };
            
            camera.position.set(newCameraPos.x, newCameraPos.y, newCameraPos.z);
            controls.target.set(boardCenter.x, boardCenter.y, boardCenter.z);
            controls.update();
        }
    };
    
    // Reset view button (in pan controls)
    const resetBtn = document.getElementById('nav-reset-view');
    if (resetBtn) {
        resetBtn.addEventListener('click', resetView);
    }
    
    // Reset view button (in rotate controls)
    const resetRotateBtn = document.getElementById('nav-reset-rotate');
    if (resetRotateBtn) {
        resetRotateBtn.addEventListener('click', resetView);
    }
    
    // Zoom controls
    const zoomAmount = 100; // Zoom distance per click
    
    const zoomInBtn = document.getElementById('nav-zoom-in');
    if (zoomInBtn) {
        zoomInBtn.addEventListener('click', () => {
            if (controls && controls.enabled) {
                const direction = new THREE.Vector3(0, 0, -1);
                direction.applyQuaternion(camera.quaternion);
                camera.position.add(direction.multiplyScalar(zoomAmount));
                controls.update();
            }
        });
    }
    
    const zoomOutBtn = document.getElementById('nav-zoom-out');
    if (zoomOutBtn) {
        zoomOutBtn.addEventListener('click', () => {
            if (controls && controls.enabled) {
                const direction = new THREE.Vector3(0, 0, 1);
                direction.applyQuaternion(camera.quaternion);
                camera.position.add(direction.multiplyScalar(zoomAmount));
                controls.update();
            }
        });
    }
    
    // Rotation controls (sphere navigation)
    const rotationAmount = Math.PI / 12; // 15 degrees
    
    const setupRotationButton = (id, rotationType) => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.addEventListener('click', () => {
                if (controls && controls.enabled) {
                    const spherical = new THREE.Spherical();
                    spherical.setFromVector3(camera.position.clone().sub(controls.target));
                    
                    switch(rotationType) {
                        case 'left':
                            spherical.theta -= rotationAmount;
                            break;
                        case 'right':
                            spherical.theta += rotationAmount;
                            break;
                        case 'up':
                            spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, spherical.phi - rotationAmount));
                            break;
                        case 'down':
                            spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, spherical.phi + rotationAmount));
                            break;
                    }
                    
                    const newPosition = new THREE.Vector3();
                    newPosition.setFromSpherical(spherical);
                    newPosition.add(controls.target);
                    camera.position.copy(newPosition);
                    camera.lookAt(controls.target);
                    controls.update();
                }
            });
        }
    };
    
    setupRotationButton('nav-rotate-left', 'left');
    setupRotationButton('nav-rotate-right', 'right');
    setupRotationButton('nav-rotate-up', 'up');
    setupRotationButton('nav-rotate-down', 'down');
    
    console.log('✅ Navigation controls setup complete');
}

/* ============================================
   GAME INITIALIZATION
   ============================================ */

function initializeGame() {
    updateLoadingText('Loading chess piece models...');
    
    // Load 3D models (.obj files)
    Models.loadModels()
        .then(() => {
            updateLoadingText('Creating 4D game board...');
            console.log('🎮 Creating game board...');
            
            // Create game board (n=8 for 8x8x8x8 = 4096 positions)
            gameBoard = new GameBoard(8, BoardGraphics);
            
            // Wait a bit for board to render
            setTimeout(() => {
                updateLoadingText('Placing 896 chess pieces...');
                console.log('♟️ Placing pieces...');
                
                // Initialize starting positions (896 pieces: 448 white + 448 black)
                gameBoard.initializeStartingPositions();
                
                setTimeout(() => {
                    updateLoadingText('Initializing game manager...');
                    
                    // Create move manager
                    moveManager = new MoveManager(gameBoard, 0, LocalMode);
                    
                    // Expose moveManager globally for GameBoard.js checkmate detection
                    if (typeof window !== 'undefined') {
                        window.moveManager = moveManager;
                    }
                    
                    // Initialize move history display
                    if (typeof updateMoveHistoryDisplay === 'function') {
                        updateMoveHistoryDisplay(moveManager);
                    }
                    
                    // Start game timer
                    startGameTimer();
                    
                    // Position camera based on actual board center (like the example game does!)
                    const boardCenter = gameBoard.graphics.getCenter();
                    console.log('📐 Board center calculated:', {
                        x: boardCenter.x,
                        y: boardCenter.y,
                        z: boardCenter.z
                    });
                    
                    const newCameraPos = {
                        x: 800,
                        y: 600,
                        z: boardCenter.z + 800
                    };
                    
                    console.log('📷 Setting camera to:', newCameraPos);
                    console.log('🎯 Setting camera target to:', {
                        x: boardCenter.x,
                        y: boardCenter.y,
                        z: boardCenter.z
                    });
                    
                    camera.position.set(newCameraPos.x, newCameraPos.y, newCameraPos.z);
                    controls.target.set(boardCenter.x, boardCenter.y, boardCenter.z);
                    controls.update();
                    
                    console.log('✅ Camera updated. Current position:', {
                        x: camera.position.x,
                        y: camera.position.y,
                        z: camera.position.z
                    });
                    console.log('✅ Camera target:', {
                        x: controls.target.x,
                        y: controls.target.y,
                        z: controls.target.z
                    });
                    
                    // Position grid helper under board center
                    if (window.gridHelper) {
                        window.gridHelper.position.set(boardCenter.x, 0, boardCenter.z);
                    }
                    
                    // Setup navigation controls (after camera is positioned)
                    setupNavigationControls();
                    
                    setTimeout(() => {
                        updateLoadingText('Ready!');
                        
                        // Hide loading screen
                        setTimeout(() => {
                            loadingScreen.style.display = 'none';
                            console.log('✅ 4D Chess is ready to play!');
                            console.log('📊 Total pieces: 896 (448 white + 448 black)');
                            
                            // Initialize tutorial system now that models are loaded
                            if (typeof initTutorial === 'function') {
                                console.log('🎓 Calling initTutorial()...');
                                try {
                                    initTutorial();
                                    console.log('✅ initTutorial() completed');
                                } catch (error) {
                                    console.error('❌ Error initializing tutorial:', error);
                                }
                            } else {
                                console.warn('⚠️ initTutorial function not available');
                            }
                            console.log('📐 Board size: 8×8×8×8 = 4,096 positions');
                            
                            // Debug scene structure
                            console.log('🔍 Scene children:', scene.children.map(c => c.name || c.type));
                            if (gameBoard && gameBoard.graphics) {
                                console.log('🔍 Board graphics mesh children:', {
                                    boardContainer: gameBoard.graphics.boardContainer ? gameBoard.graphics.boardContainer.children.length : 'none',
                                    piecesContainer: gameBoard.graphics.piecesContainer ? gameBoard.graphics.piecesContainer.children.length : 'none',
                                    meshInScene: scene.children.includes(gameBoard.graphics.mesh)
                                });
                            }
                            
                            // Update UI
                            updateStatus('Game ready', 1, 'White', 'No check');
                            
                            // Initialize game mode selectability
                            if (moveManager) {
                                if (currentGameMode === GAME_MODES.SINGLEPLAYER) {
                                    moveManager.setSelectability(0, true);
                                    moveManager.setSelectability(1, true);
                                } else if (currentGameMode === GAME_MODES.VS_BOT) {
                                    moveManager.setSelectability(0, true);
                                    moveManager.setSelectability(1, false);
                                } else if (currentGameMode === GAME_MODES.BOT_VS_BOT) {
                                    moveManager.setSelectability(0, false);
                                    moveManager.setSelectability(1, false);
                                    // Start bot vs bot after a short delay
                                    setTimeout(() => {
                                        startBotVsBot();
                                    }, 2000);
                                }
                            }
                        }, 500);
                    }, 500);
                }, 1000);
            }, 1000);
        })
        .catch((error) => {
            console.error('❌ Error loading models:', error);
            updateLoadingText('Error loading models. Check console for details.');
        });
}

function updateLoadingText(text) {
    const loadingText = document.getElementById('loading-text');
    if (loadingText) {
        loadingText.textContent = text;
    }
}

/* ============================================
   UI EVENT HANDLERS
   ============================================ */

function setupUIEvents() {
    // Game mode buttons
    const modeButtons = document.querySelectorAll('.mode-btn');
    modeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.getAttribute('data-mode');
            setGameMode(mode);
        });
    });
    
    // New Game button
    const newGameBtn = document.getElementById('new-game-btn');
    if (newGameBtn) {
        newGameBtn.addEventListener('click', () => {
            if (confirm('Start a new game? Current game will be lost.')) {
                resetGame();
            }
        });
    }
    
    // Undo button (check moveManager at click time)
    const undoBtn = document.getElementById('undo-btn');
    if (undoBtn) {
        undoBtn.addEventListener('click', () => {
            if (moveManager && typeof moveManager.undo === 'function') {
                moveManager.undo();
            } else {
                console.warn('⚠️ MoveManager not available for undo');
            }
        });
    }
    
    // Redo button (check moveManager at click time)
    const redoBtn = document.getElementById('redo-btn');
    if (redoBtn) {
        redoBtn.addEventListener('click', () => {
            if (moveManager && typeof moveManager.redo === 'function') {
                moveManager.redo();
            } else {
                console.warn('⚠️ MoveManager not available for redo');
            }
        });
    }
    
    document.getElementById('new-game-modal-btn').addEventListener('click', () => {
        resetGame();
        document.getElementById('game-over-modal').style.display = 'none';
    });
    
    // Undo/Redo buttons
    document.getElementById('undo-btn').addEventListener('click', undoMove);
    document.getElementById('redo-btn').addEventListener('click', redoMove);
    
    
    // Opacity slider
    const opacitySlider = document.getElementById('opacity-slider');
    opacitySlider.addEventListener('input', (e) => {
        gameState.boardOpacity = parseInt(e.target.value) / 100;
        document.getElementById('opacity-value').textContent = e.target.value + '%';
        updateBoardOpacity();
    });
    
    // View options checkboxes (removed from UI, but keep functionality for keyboard shortcuts)
    const showGridCheckbox = document.getElementById('show-grid');
    if (showGridCheckbox) {
        showGridCheckbox.addEventListener('change', (e) => {
            gameState.showGrid = e.target.checked;
            toggleGrid(gameState.showGrid);
        });
    }
    
    const highlightMovesCheckbox = document.getElementById('highlight-moves');
    if (highlightMovesCheckbox) {
        highlightMovesCheckbox.addEventListener('change', (e) => {
            gameState.highlightMoves = e.target.checked;
        });
    }
    
    const showCoordsCheckbox = document.getElementById('show-coords');
    if (showCoordsCheckbox) {
        showCoordsCheckbox.addEventListener('change', (e) => {
            gameState.showCoords = e.target.checked;
            toggleCoordinates(gameState.showCoords);
        });
    }
    
    const animatePiecesCheckbox = document.getElementById('animate-pieces');
    if (animatePiecesCheckbox) {
        animatePiecesCheckbox.addEventListener('change', (e) => {
            gameState.animatePieces = e.target.checked;
        });
    }
    
    const showAllBoardsCheckbox = document.getElementById('show-all-boards');
    if (showAllBoardsCheckbox) {
        showAllBoardsCheckbox.addEventListener('change', (e) => {
            gameState.showAllBoards = e.target.checked;
            updateBoardVisibility();
        });
    }
    
    // Camera controls
    document.getElementById('reset-camera').addEventListener('click', resetCamera);
    document.getElementById('top-view').addEventListener('click', setTopView);
    document.getElementById('side-view').addEventListener('click', setSideView);
    
    console.log('✅ UI events setup complete');
}

/* ============================================
   KEYBOARD SHORTCUTS
   ============================================ */

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Navigation
        if (e.key === 'w' || e.key === 'W') {
            if (gameState.currentW < 7) {
                gameState.currentW++;
                document.getElementById('w-slider').value = gameState.currentW;
                updateAxisDisplay('w', gameState.currentW);
                updateBoardVisibility();
            }
        } else if (e.key === 's' || e.key === 'S') {
            if (gameState.currentW > 0) {
                gameState.currentW--;
                document.getElementById('w-slider').value = gameState.currentW;
                updateAxisDisplay('w', gameState.currentW);
                updateBoardVisibility();
            }
        } else if (e.key === 'q' || e.key === 'Q') {
            if (gameState.currentY < 7) {
                gameState.currentY++;
                document.getElementById('y-slider').value = gameState.currentY;
                updateAxisDisplay('y', gameState.currentY);
                updateBoardVisibility();
            }
        } else if (e.key === 'e' || e.key === 'E') {
            if (gameState.currentY > 0) {
                gameState.currentY--;
                document.getElementById('y-slider').value = gameState.currentY;
                updateAxisDisplay('y', gameState.currentY);
                updateBoardVisibility();
            }
        }
        
        // Camera
        else if (e.key === 'r' || e.key === 'R') {
            resetCamera();
        }
        
        // Game actions
        else if (e.key === 'Escape') {
            deselectPiece();
        } else if (e.ctrlKey && e.key === 'z') {
            e.preventDefault();
            undoMove();
        } else if (e.ctrlKey && e.key === 'y') {
            e.preventDefault();
            redoMove();
        }
        
        // View toggles
        else if (e.key === 'g' || e.key === 'G') {
            gameState.showGrid = !gameState.showGrid;
            const showGridCheckbox = document.getElementById('show-grid');
            if (showGridCheckbox) showGridCheckbox.checked = gameState.showGrid;
            toggleGrid(gameState.showGrid);
        } else if (e.key === 'h' || e.key === 'H') {
            gameState.highlightMoves = !gameState.highlightMoves;
            const highlightMovesCheckbox = document.getElementById('highlight-moves');
            if (highlightMovesCheckbox) highlightMovesCheckbox.checked = gameState.highlightMoves;
        } else if (e.key === 'c' || e.key === 'C') {
            gameState.showCoords = !gameState.showCoords;
            const showCoordsCheckbox = document.getElementById('show-coords');
            if (showCoordsCheckbox) showCoordsCheckbox.checked = gameState.showCoords;
            toggleCoordinates(gameState.showCoords);
        }
    });
    
    console.log('✅ Keyboard shortcuts setup complete');
}

/* ============================================
   GAME FUNCTIONS
   ============================================ */

function resetGame() {
    console.log('🔄 Resetting game...');
    
    // Stop bot moves
    stopBotMoveInterval();
    
    // Hide game over modal if it's open
    const gameOverModal = document.getElementById('game-over-modal');
    if (gameOverModal) {
        gameOverModal.style.display = 'none';
    }
    
    // Deselect any selected piece
    deselectPiece();
    
    // Stop timer
    stopGameTimer();
    
    // Reset game board
    if (gameBoard) {
        // CRITICAL: Remove all existing piece meshes from the scene first
        if (gameBoard.graphics && gameBoard.graphics.piecesContainer) {
            const piecesContainer = gameBoard.graphics.piecesContainer;
            const meshCount = piecesContainer.children.length;
            
            // Remove all children and dispose of their resources
            while (piecesContainer.children.length > 0) {
                const mesh = piecesContainer.children[0];
                
                // Dispose of material (geometry is shared and shouldn't be disposed)
                if (mesh.material) {
                    mesh.material.dispose();
                }
                
                // Remove from container (which removes from scene)
                piecesContainer.remove(mesh);
            }
            
            console.log(`🧹 Cleared ${meshCount} meshes from piecesContainer`);
        }
        
        // Clear possible moves previews
        if (gameBoard.graphics && gameBoard.graphics.hidePossibleMoves) {
            gameBoard.graphics.hidePossibleMoves();
        }
        
        // Reinitialize pieces array
        gameBoard.pieces = gameBoard.initPieces();
        
        // Place pieces at starting positions (this will create new meshes)
        gameBoard.initializeStartingPositions();
    }
    
    // Reset move manager - IMPORTANT: reassign the global variable
    moveManager = new MoveManager(gameBoard, 0, LocalMode);
    
    // Expose moveManager globally
    if (typeof window !== 'undefined') {
        window.moveManager = moveManager;
    }
    
    // Reset UI
    if (moveManager) {
        moveManager.updateUI();
        updateMoveHistoryDisplay(moveManager);
        updatePieceCounts();
    } else {
        updateStatus('Game reset', 1, 'White', 'No check');
    }
    
    // Update selectability based on current game mode
    if (moveManager) {
        if (currentGameMode === GAME_MODES.SINGLEPLAYER) {
            moveManager.setSelectability(0, true);
            moveManager.setSelectability(1, true);
        } else if (currentGameMode === GAME_MODES.VS_BOT) {
            moveManager.setSelectability(0, true);
            moveManager.setSelectability(1, false);
        } else if (currentGameMode === GAME_MODES.BOT_VS_BOT) {
            moveManager.setSelectability(0, false);
            moveManager.setSelectability(1, false);
        }
    }
    
    // Restart timer
    startGameTimer();
    
    // Start bot vs bot if needed
    if (currentGameMode === GAME_MODES.BOT_VS_BOT) {
        startBotVsBot();
    }
}

function undoMove() {
    console.log('↶ Undo move');
    // TODO: Implement undo
}

function redoMove() {
    console.log('↷ Redo move');
    // TODO: Implement redo
}

function saveGame() {
    console.log('💾 Saving game...');
    // TODO: Implement save
    alert('Save feature coming soon!');
}

function loadGame() {
    console.log('📂 Loading game...');
    // TODO: Implement load
    alert('Load feature coming soon!');
}

/* ============================================
   UI UPDATE FUNCTIONS
   ============================================ */

function updateAxisDisplay(axis, value) {
    document.getElementById(`${axis}-value`).textContent = `${value}/7`;
}

function updateBoardVisibility() {
    console.log(`Viewing W=${gameState.currentW}, Y=${gameState.currentY}`);
    // TODO: Update board visibility based on current W and Y
}

function updateBoardOpacity() {
    console.log(`Board opacity: ${gameState.boardOpacity}`);
    
    if (!gameBoard || !gameBoard.graphics || !gameBoard.graphics.boardContainer) {
        return;
    }
    
    // Update all board squares
    gameBoard.graphics.boardContainer.traverse((object) => {
        if (object instanceof THREE.Mesh && object.material) {
            object.material.opacity = gameState.boardOpacity;
            object.material.transparent = gameState.boardOpacity < 1.0;
            object.material.needsUpdate = true;
        }
    });
}

function toggleGrid(show) {
    scene.traverse((object) => {
        if (object instanceof THREE.GridHelper) {
            object.visible = show;
        }
    });
}

function toggleCoordinates(show) {
    console.log(`Coordinates ${show ? 'shown' : 'hidden'}`);
    // TODO: Toggle coordinate labels
}

function resetCamera() {
    if (gameBoard && gameBoard.graphics) {
        const center = gameBoard.graphics.getCenter();
        camera.position.set(800, 600, center.z + 800);
        controls.target.set(center.x, center.y, center.z);
        controls.update();
    }
}

function setTopView() {
    if (gameBoard && gameBoard.graphics) {
        const center = gameBoard.graphics.getCenter();
        camera.position.set(center.x, 3000, center.z);
        controls.target.set(center.x, center.y, center.z);
        controls.update();
    }
}

function setSideView() {
    if (gameBoard && gameBoard.graphics) {
        const center = gameBoard.graphics.getCenter();
        camera.position.set(center.x + 2000, center.y + 500, center.z);
        controls.target.set(center.x, center.y, center.z);
        controls.update();
    }
}

function updateStatus(message, turn, player, checkStatus) {
    document.getElementById('turn-number').textContent = turn;
    document.getElementById('current-player').textContent = player;
    document.getElementById('check-status').textContent = checkStatus;
    
    // Update turn indicator
    const turnIcon = document.getElementById('turn-icon');
    const turnText = document.getElementById('turn-text');
    turnIcon.textContent = player === 'White' ? '♔' : '♚';
    turnText.textContent = `${player} to move`;
    
    // Update check indicator
    const checkIndicator = document.getElementById('check-indicator');
    if (checkStatus !== 'No check') {
        checkIndicator.style.display = 'flex';
    } else {
        checkIndicator.style.display = 'none';
    }
}

function addMoveToHistory(moveManager, x0, y0, z0, w0, x1, y1, z1, w1, metadata) {
    const historyDiv = document.getElementById('move-history');
    if (!historyDiv) return;
    
    // Get move count (after move was added)
    const moveCount = moveManager.size();
    const moveNum = Math.ceil(moveCount / 2);
    
    // Get the team that made this move: (moveCount - 1) % 2
    // Move 0 (white): size = 1, (1-1) % 2 = 0 (white)
    // Move 1 (black): size = 2, (2-1) % 2 = 1 (black)
    const moveTeam = (moveCount - 1) % 2;
    const teamName = moveTeam === 0 ? 'White' : 'Black';
    const moveText = `${moveNum}. ${teamName}: (${x0},${y0},${z0},${w0}) → (${x1},${y1},${z1},${w1})`;
    
    // Clear "Game started..." message if it's the first move
    if (moveCount === 1 && historyDiv.children.length === 1 && historyDiv.children[0].textContent.includes('Game started')) {
        historyDiv.innerHTML = '';
    }
    
    const moveItem = document.createElement('div');
    moveItem.className = 'move-item';
    moveItem.textContent = moveText;
    
    // Add capture indicator if applicable
    if (metadata && metadata.capturedPiece) {
        const captureSpan = document.createElement('span');
        captureSpan.className = 'capture-indicator';
        captureSpan.textContent = ' [capture]';
        moveItem.appendChild(captureSpan);
    }
    
    historyDiv.appendChild(moveItem);
    
    // Auto-scroll to bottom
    historyDiv.scrollTop = historyDiv.scrollHeight;
}

function updatePieceCount(white, black) {
    const whiteEl = document.getElementById('white-count');
    const blackEl = document.getElementById('black-count');
    if (whiteEl) whiteEl.textContent = white;
    if (blackEl) blackEl.textContent = black;
}

function updateMoveHistoryDisplay(moveManager) {
    const historyDiv = document.getElementById('move-history');
    if (!historyDiv || !moveManager || !moveManager.moveHistory) return;
    
    // Clear existing history
    historyDiv.innerHTML = '';
    
    // Get moves up to and including current position
    const moveHistory = moveManager.moveHistory;
    const moves = [];
    let curr = moveHistory.root;
    
    // Traverse from root to current position (including curr itself)
    while (curr !== null) {
        // Include the current node if it has a valid move
        if (curr.move && curr.move.x0 !== undefined) {
            moves.push(curr.move);
        }
        // Stop after we've added the current position
        if (curr === moveHistory.curr) {
            break;
        }
        curr = curr.next;
    }
    
    // If we're at the root (no moves made), show "Game started..."
    if (moves.length === 0) {
        const emptyItem = document.createElement('div');
        emptyItem.className = 'move-item';
        emptyItem.textContent = 'Game started...';
        historyDiv.appendChild(emptyItem);
        return;
    }
    
    // Display moves up to current position
    moves.forEach((move, index) => {
        // Skip if move is invalid
        if (!move || move.x0 === undefined) return;
        
        const moveNum = Math.ceil((index + 1) / 2);
        const team = index % 2 === 0 ? 'White' : 'Black';
        const moveText = `${moveNum}. ${team}: (${move.x0},${move.y0},${move.z0},${move.w0}) → (${move.x1},${move.y1},${move.z1},${move.w1})`;
        
        const moveItem = document.createElement('div');
        moveItem.className = 'move-item';
        moveItem.textContent = moveText;
        
        if (move.metaData && move.metaData.capturedPiece) {
            const captureSpan = document.createElement('span');
            captureSpan.className = 'capture-indicator';
            captureSpan.textContent = ' [capture]';
            moveItem.appendChild(captureSpan);
        }
        
        historyDiv.appendChild(moveItem);
    });
    
    // Auto-scroll to bottom
    historyDiv.scrollTop = historyDiv.scrollHeight;
}

// Game timer
let gameStartTime = null;
let gameTimerInterval = null;

function startGameTimer() {
    gameStartTime = Date.now();
    
    if (gameTimerInterval) {
        clearInterval(gameTimerInterval);
    }
    
    gameTimerInterval = setInterval(() => {
        if (gameStartTime) {
            const elapsed = Math.floor((Date.now() - gameStartTime) / 1000);
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            const timeStr = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
            
            const timeEl = document.getElementById('game-time');
            if (timeEl) {
                timeEl.textContent = timeStr;
            }
        }
    }, 1000);
}

function stopGameTimer() {
    if (gameTimerInterval) {
        clearInterval(gameTimerInterval);
        gameTimerInterval = null;
    }
}

/* ============================================
   2D GIZMO VISUALIZATION
   ============================================ */

function update2DGizmo() {
    const canvas = document.getElementById('axes-gizmo-canvas');
    if (!canvas || !camera) return;
    
    const ctx = canvas.getContext('2d');
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const axisLength = 60;
    const arrowSize = 14; // Larger arrows for better visibility
    
    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Get camera's local axes in world space (these represent how camera sees the world)
    const cameraRight = new THREE.Vector3(1, 0, 0);
    cameraRight.applyQuaternion(camera.quaternion);
    
    const cameraUp = new THREE.Vector3(0, 1, 0);
    cameraUp.applyQuaternion(camera.quaternion);
    
    const cameraForward = new THREE.Vector3(0, 0, -1);
    cameraForward.applyQuaternion(camera.quaternion);
    
    // Project world axes onto camera's view plane
    // World X axis (red) - projects along camera's right vector
    const worldX = new THREE.Vector3(1, 0, 0);
    const worldXScreenX = worldX.dot(cameraRight) * axisLength;
    const worldXScreenY = -worldX.dot(cameraUp) * axisLength;
    drawAxisWithArrow(ctx, centerX, centerY, worldXScreenX, worldXScreenY, '#ff0000', 'X', arrowSize);
    
    // World Y axis (green) - projects along camera's up vector  
    const worldY = new THREE.Vector3(0, 1, 0);
    const worldYScreenX = worldY.dot(cameraRight) * axisLength;
    const worldYScreenY = -worldY.dot(cameraUp) * axisLength;
    drawAxisWithArrow(ctx, centerX, centerY, worldYScreenX, worldYScreenY, '#00ff00', 'Y', arrowSize);
    
    // World Z axis (blue) - projects along camera's forward vector
    const worldZ = new THREE.Vector3(0, 0, 1);
    const worldZScreenX = worldZ.dot(cameraRight) * axisLength;
    const worldZScreenY = -worldZ.dot(cameraUp) * axisLength;
    drawAxisWithArrow(ctx, centerX, centerY, worldZScreenX, worldZScreenY, '#0000ff', 'Z', arrowSize);
    
    // W Axis (Cyan) - 4th dimension shown as diamond/square indicator
    const wPosX = centerX + (worldXScreenX + worldYScreenX + worldZScreenX) * 0.25;
    const wPosY = centerY + (worldXScreenY + worldYScreenY + worldZScreenY) * 0.25;
    const wSize = 10;
    
    // Draw diamond shape (rotated square) for W axis
    ctx.strokeStyle = '#00ffff';
    ctx.fillStyle = '#00ffff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(wPosX, wPosY - wSize); // Top
    ctx.lineTo(wPosX + wSize, wPosY); // Right
    ctx.lineTo(wPosX, wPosY + wSize); // Bottom
    ctx.lineTo(wPosX - wSize, wPosY); // Left
    ctx.closePath();
    ctx.fill();
    
    // Outline for visibility
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.stroke();
    
    // W label with shadow
    const labelX = wPosX;
    const labelY = wPosY - wSize - 14;
    ctx.font = 'bold 12px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Text shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillText('W', labelX + 1, labelY + 1);
    
    // Text
    ctx.fillStyle = '#00ffff';
    ctx.fillText('W', labelX, labelY);
}

function drawAxisWithArrow(ctx, x1, y1, dx, dy, color, label, arrowSize) {
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length < 0.1) return; // Skip if axis is too short
    
    const unitX = dx / length;
    const unitY = dy / length;
    const tipX = x1 + dx;
    const tipY = y1 + dy;
    
    // Draw axis line with thicker stroke
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();
    
    // Draw arrowhead (larger and more visible)
    const arrowAngle = Math.PI / 5; // 36 degrees for wider arrow
    const arrowLength = arrowSize;
    
    // Calculate arrow points
    const angle = Math.atan2(dy, dx);
    const arrowX1 = tipX - arrowLength * Math.cos(angle - arrowAngle);
    const arrowY1 = tipY - arrowLength * Math.sin(angle - arrowAngle);
    const arrowX2 = tipX - arrowLength * Math.cos(angle + arrowAngle);
    const arrowY2 = tipY - arrowLength * Math.sin(angle + arrowAngle);
    
    // Draw filled arrowhead with outline for visibility
    ctx.fillStyle = color;
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(arrowX1, arrowY1);
    ctx.lineTo(arrowX2, arrowY2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke(); // Outline for better visibility
    
    // Draw label with shadow for readability
    ctx.font = 'bold 13px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const labelOffset = 22;
    const labelX = tipX + unitX * labelOffset;
    const labelY = tipY + unitY * labelOffset;
    
    // Text shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillText(label, labelX + 1, labelY + 1);
    
    // Text
    ctx.fillStyle = color;
    ctx.fillText(label, labelX, labelY);
}

/* ============================================
   ANIMATION LOOP
   ============================================ */

// Performance optimization: Throttle expensive operations
let lastHoverUpdate = 0;
let lastGizmoUpdate = 0;
let lastRenderTime = 0;
let frameSkipCount = 0;
const HOVER_UPDATE_INTERVAL = 100; // Update hover every 100ms (10 FPS)
const GIZMO_UPDATE_INTERVAL = 50; // Update gizmo every 50ms (20 FPS)
const MAX_FPS = 60; // Cap frame rate to 60 FPS
const TARGET_FRAME_TIME = 1000 / MAX_FPS; // ~16.67ms per frame

function animate() {
    requestAnimationFrame(animate);
    
    const now = performance.now();
    const deltaTime = now - lastRenderTime;
    
    // PERFORMANCE: Skip rendering if too soon (cap at 60 FPS)
    if (deltaTime < TARGET_FRAME_TIME) {
        frameSkipCount++;
        return; // Skip this frame
    }
    
    lastRenderTime = now;
    
    // Update controls
    controls.update();
    
    // Throttle raycasting for piece selection (hover) - only update every 100ms
    if (now - lastHoverUpdate >= HOVER_UPDATE_INTERVAL) {
        updatePieceHover();
        lastHoverUpdate = now;
    }
    
    // Throttle 2D gizmo visualization - only update every 50ms
    if (now - lastGizmoUpdate >= GIZMO_UPDATE_INTERVAL) {
        update2DGizmo();
        lastGizmoUpdate = now;
    }
    
    // Process animation queue (piece movements)
    if (typeof Animation !== 'undefined' && Animation.processQueue) {
        Animation.processQueue();
    }
    
    // Render scene
    renderer.render(scene, camera);
}

/* ============================================
   PIECE SELECTION SYSTEM
   ============================================ */

function updatePieceHover() {
    if (!gameBoard || !gameBoard.graphics) return;
    
    // Only update hover if no piece is selected
    if (selectionSystem.selectedPiece) return;
    
    // Get current team (only hover pieces from current player)
    let currentTeam = null;
    if (moveManager && typeof moveManager.whoseTurn === 'function') {
        currentTeam = moveManager.whoseTurn();
    }
    
    // PERFORMANCE: Get all selectable pieces (only from current team)
    // Skip expensive frustum culling - Three.js handles this automatically during rendering
    const pieces = gameBoard.graphics.piecesContainer.children.filter(p => {
        if (!p.canRayCast) return false;
        if (p.selectable === false) return false;
        
        // Only hover pieces from current player's team
        if (currentTeam !== null) {
            const worldPos = p.position;
            const boardCoords = gameBoard.graphics.worldCoordinates(worldPos);
            const piece = gameBoard.pieces[boardCoords.x][boardCoords.y][boardCoords.z][boardCoords.w];
            if (piece && piece.team !== currentTeam) {
                return false; // Not current player's piece
            }
        }
        
        return true;
    });
    
    if (pieces.length === 0) {
        // Unhighlight if no pieces are available
        if (selectionSystem.hoveredPiece) {
            selectionSystem.unhighlight(selectionSystem.hoveredPiece);
            selectionSystem.hoveredPiece = null;
        }
        return;
    }
    
    // PERFORMANCE: Limit number of pieces to raycast (max 100 pieces for hover)
    // This prevents expensive raycasting when there are many pieces on screen
    const piecesToRaycast = pieces.length > 100 ? pieces.slice(0, 100) : pieces;
    
    // Update raycasting
    selectionSystem.raycaster.setFromCamera(selectionSystem.mouse, camera);
    const intersects = selectionSystem.raycaster.intersectObjects(piecesToRaycast);
    
    // Get closest intersection
    const closest = intersects.length > 0 ? intersects[0].object : null;
    
    // Update hover highlight
    if (closest !== selectionSystem.hoveredPiece) {
        // Unhighlight previous hover
        if (selectionSystem.hoveredPiece) {
            selectionSystem.unhighlight(selectionSystem.hoveredPiece);
        }
        
        // Highlight new hover (only if it's selectable and from current team)
        selectionSystem.hoveredPiece = closest;
        if (selectionSystem.hoveredPiece && selectionSystem.hoveredPiece.selectable !== false) {
            // Double-check it's from current team
            if (currentTeam !== null) {
                const worldPos = selectionSystem.hoveredPiece.position;
                const boardCoords = gameBoard.graphics.worldCoordinates(worldPos);
                const piece = gameBoard.pieces[boardCoords.x][boardCoords.y][boardCoords.z][boardCoords.w];
                if (piece && piece.team === currentTeam) {
                    selectionSystem.highlight(selectionSystem.hoveredPiece, selectionSystem.HOVER_COLOR);
                } else {
                    selectionSystem.hoveredPiece = null;
                }
            } else {
                selectionSystem.highlight(selectionSystem.hoveredPiece, selectionSystem.HOVER_COLOR);
            }
        }
    }
}

/**
 * Filter out illegal moves (moves that leave own king in check)
 * @param {GameBoard} gameBoard - The game board
 * @param {number} x0, y0, z0, w0 - Source position
 * @param {Array} possibleMoves - Array of possible moves
 * @param {number} team - Team making the move
 * @returns {Array} - Filtered array of legal moves
 */
function filterIllegalMoves(gameBoard, x0, y0, z0, w0, possibleMoves, team) {
    if (!possibleMoves || possibleMoves.length === 0) {
        return [];
    }
    
    const legalMoves = [];
    const isInCheck = gameBoard.inCheck(team);
    
    for (const move of possibleMoves) {
        // Simulate the move
        const sourcePiece = gameBoard.pieces[x0][y0][z0][w0];
        const targetPiece = gameBoard.pieces[move.x][move.y][move.z][move.w];
        
        // Make the move
        gameBoard.pieces[move.x][move.y][move.z][move.w] = sourcePiece;
        // Create empty piece (same structure as GameBoard.js createEmptyPiece)
        gameBoard.pieces[x0][y0][z0][w0] = {
            type: null,
            team: null,
            mesh: null,
            hasMoved: false,
            position: {x: 0, y: 0, z: 0, w: 0},
            getPossibleMoves: function() { return []; }
        };
        
        // Check if move leaves own king in check
        const stillInCheck = gameBoard.inCheck(team);
        
        // Restore board
        gameBoard.pieces[x0][y0][z0][w0] = sourcePiece;
        gameBoard.pieces[move.x][move.y][move.z][move.w] = targetPiece;
        
        // If in check, only allow moves that get out of check
        if (isInCheck) {
            if (!stillInCheck) {
                // This move gets us out of check - it's legal
                legalMoves.push(move);
            }
            // Otherwise, skip this move (still in check)
        } else {
            // Not in check - don't allow moves that put us in check
            if (!stillInCheck) {
                legalMoves.push(move);
            }
            // Otherwise, skip this move (would leave us in check)
        }
    }
    
    return legalMoves;
}


function selectPiece(mesh) {
    if (!mesh || !gameBoard) return;
    
    // Deselect previous piece
    if (selectionSystem.selectedPiece && selectionSystem.selectedPiece !== mesh) {
        selectionSystem.unhighlight(selectionSystem.selectedPiece);
        gameBoard.graphics.hidePossibleMoves();
    }
    
    // Get piece data from board coordinates
    const worldPos = mesh.position;
    const boardCoords = gameBoard.graphics.worldCoordinates(worldPos);
    const piece = gameBoard.pieces[boardCoords.x][boardCoords.y][boardCoords.z][boardCoords.w];
    
    if (!piece || !piece.type) {
        // Empty square clicked, deselect
        if (selectionSystem.selectedPiece) {
            selectionSystem.unhighlight(selectionSystem.selectedPiece);
            selectionSystem.selectedPiece = null;
            gameState.selectedPiece = null;
            gameState.selectedPieceData = null;
            gameState.possibleMoves = null;
            gameBoard.graphics.hidePossibleMoves();
        }
        return;
    }
    
    // Check if piece is selectable
    if (mesh.selectable === false) {
        return; // Cannot select this piece
    }
    
    // CRITICAL: Check if it's the current player's turn
    let currentTeam = null;
    if (moveManager && typeof moveManager.whoseTurn === 'function') {
        currentTeam = moveManager.whoseTurn();
    }
    
    // Only allow selecting pieces from the current player's team
    if (currentTeam !== null && piece.team !== currentTeam) {
        console.log(`⛔ Cannot select opponent's piece (team ${piece.team}, current team ${currentTeam})`);
        return; // Cannot select opponent's piece
    }
    
    // Select the piece
    selectionSystem.selectedPiece = mesh;
    selectionSystem.highlight(mesh, selectionSystem.SELECT_COLOR);
    
    // Update game state
    gameState.selectedPiece = mesh;
    gameState.selectedPieceData = piece;
    
    // Get possible moves
    let possibleMoves = piece.getPossibleMoves(
        gameBoard.pieces,
        boardCoords.x,
        boardCoords.y,
        boardCoords.z,
        boardCoords.w
    );
    
    // Filter out illegal moves (moves that leave own king in check)
    possibleMoves = filterIllegalMoves(
        gameBoard,
        boardCoords.x,
        boardCoords.y,
        boardCoords.z,
        boardCoords.w,
        possibleMoves,
        piece.team
    );
    
    gameState.possibleMoves = possibleMoves;
    
    // Check for checkmate/stalemate after filtering moves
    // This is especially important when a player has no legal moves and is in check
    // PERFORMANCE: Only check if we have very few moves to avoid expensive computation
    if (possibleMoves.length === 0) {
        // No legal moves for this piece - but don't immediately check all pieces (expensive!)
        // Instead, just note it and let the move completion handler check
        const isInCheck = gameBoard.inCheck(piece.team);
        
        if (isInCheck) {
            console.log(`⚠️ Selected piece has no legal moves and team ${piece.team} is in check - checking checkmate...`);
            // Use a small delay and check win condition (which will check hasLegalMoves)
            setTimeout(() => {
                if (typeof checkWinCondition === 'function') {
                    checkWinCondition();
                }
            }, 100); // Reduced delay
        }
    }
    
    // Show possible moves (with canRayCast=true so they can be clicked)
    if (possibleMoves && possibleMoves.length > 0) {
        gameBoard.graphics.showPossibleMoves(possibleMoves, piece, {}, true);
        // M5: fire spectral preview for the selected origin. Re-tints the
        // already-rendered destinations once intensities arrive. Falls
        // back silently when the encoder isn't installed.
        if (window.SpectralOverlay && typeof window.SpectralOverlay.onPieceSelected === 'function') {
            window.SpectralOverlay.onPieceSelected({
                x: boardCoords.x,
                y: boardCoords.y,
                z: boardCoords.z,
                w: boardCoords.w,
            });
        }
    } else {
        gameBoard.graphics.hidePossibleMoves();
    }
    
    // Update piece info display in Game Status
    updatePieceInfoDisplay(piece, boardCoords, possibleMoves);
    
    console.log(`✅ Selected ${piece.type} at (${boardCoords.x},${boardCoords.y},${boardCoords.z},${boardCoords.w}), ${possibleMoves.length} legal moves`);
}

function deselectPiece() {
    // Unhighlight the selected piece (restore original color)
    if (selectionSystem.selectedPiece) {
        selectionSystem.unhighlight(selectionSystem.selectedPiece);
    }
    
    // Clear selection state
    selectionSystem.selectedPiece = null;
    gameState.selectedPiece = null;
    gameState.selectedPieceData = null;
    gameState.possibleMoves = null;
    
    // Hide possible moves visualization
    if (gameBoard && gameBoard.graphics) {
        gameBoard.graphics.hidePossibleMoves();
    }
    
    // Hide piece info display
    hidePieceInfoDisplay();
}

function updatePieceInfoDisplay(piece, position, possibleMoves) {
    const container = document.getElementById('piece-info-container');
    if (!container) return;
    
    // Show container
    container.style.display = 'flex';
    
    // Update piece name
    const pieceName = document.getElementById('piece-info-name');
    if (pieceName) {
        const teamName = piece.team === 0 ? 'White' : 'Black';
        const typeName = piece.type.charAt(0).toUpperCase() + piece.type.slice(1);
        pieceName.textContent = `${teamName} ${typeName}`;
    }
    
    // Update position
    document.getElementById('piece-info-x').textContent = position.x;
    document.getElementById('piece-info-y').textContent = position.y;
    document.getElementById('piece-info-z').textContent = position.z;
    document.getElementById('piece-info-w').textContent = position.w;
    
    // Update moves list
    const movesList = document.getElementById('piece-info-moves-list');
    if (movesList && possibleMoves) {
        movesList.innerHTML = '';
        
        if (possibleMoves.length === 0) {
            const emptyItem = document.createElement('div');
            emptyItem.className = 'piece-move-item';
            emptyItem.textContent = 'No moves available';
            emptyItem.style.color = 'var(--text-tertiary)';
            movesList.appendChild(emptyItem);
        } else {
            possibleMoves.forEach(move => {
                const moveItem = document.createElement('div');
                moveItem.className = 'piece-move-item' + (move.possibleCapture ? ' capture' : '') + ' clickable';
                const captureMarker = move.possibleCapture ? ' [capture]' : '';
                moveItem.textContent = `(${move.x}, ${move.y}, ${move.z}, ${move.w})${captureMarker}`;
                
                // Store move coordinates as data attributes for click handler
                moveItem.dataset.moveX = move.x;
                moveItem.dataset.moveY = move.y;
                moveItem.dataset.moveZ = move.z;
                moveItem.dataset.moveW = move.w;
                
                // Add click handler to execute the move
                moveItem.addEventListener('click', function(e) {
                    e.stopPropagation(); // Prevent event bubbling
                    
                    // Get the currently selected piece
                    if (!gameState.selectedPieceData || !gameState.selectedPiece) {
                        console.warn('⚠️ No piece selected - cannot execute move from list');
                        return;
                    }
                    
                    // Get piece position from the piece info display
                    const pieceX = parseInt(document.getElementById('piece-info-x').textContent);
                    const pieceY = parseInt(document.getElementById('piece-info-y').textContent);
                    const pieceZ = parseInt(document.getElementById('piece-info-z').textContent);
                    const pieceW = parseInt(document.getElementById('piece-info-w').textContent);
                    
                    // Get target coordinates from the clicked item
                    const targetX = parseInt(moveItem.dataset.moveX);
                    const targetY = parseInt(moveItem.dataset.moveY);
                    const targetZ = parseInt(moveItem.dataset.moveZ);
                    const targetW = parseInt(moveItem.dataset.moveW);
                    
                    console.log(`🎯 Executing move from UI list: (${pieceX},${pieceY},${pieceZ},${pieceW}) → (${targetX},${targetY},${targetZ},${targetW})`);
                    
                    // Execute the move
                    executeMove(pieceX, pieceY, pieceZ, pieceW, targetX, targetY, targetZ, targetW);
                });
                
                movesList.appendChild(moveItem);
            });
        }
    }
}

function hidePieceInfoDisplay() {
    const container = document.getElementById('piece-info-container');
    if (container) {
        container.style.display = 'none';
    }
}

function checkWinCondition() {
    if (!gameBoard || !moveManager) return;
    
    const winStatus = gameBoard.winCondition();
    const modal = document.getElementById('game-over-modal');
    const modalTitle = document.getElementById('game-over-title');
    const modalMessage = document.getElementById('game-over-message');
    
    if (!modal || !modalTitle || !modalMessage) return;
    
    if (winStatus === 0) {
        // White wins
        modalTitle.textContent = 'Checkmate!';
        modalMessage.textContent = 'White wins the game!';
        modal.style.display = 'flex';
        stopBotMoveInterval(); // Stop bot moves if game is over
    } else if (winStatus === 1) {
        // Black wins
        modalTitle.textContent = 'Checkmate!';
        modalMessage.textContent = 'Black wins the game!';
        modal.style.display = 'flex';
        stopBotMoveInterval(); // Stop bot moves if game is over
    } else if (winStatus === 2) {
        // Stalemate
        modalTitle.textContent = 'Stalemate!';
        modalMessage.textContent = 'The game ends in a draw.';
        modal.style.display = 'flex';
        stopBotMoveInterval(); // Stop bot moves if game is over
    } else {
        // Game continues
        modal.style.display = 'none';
    }
}

function setGameMode(mode) {
    console.log(`🎮 Switching to game mode: ${mode}`);
    
    // Stop any running bot interval
    stopBotMoveInterval();
    
    // Update current mode
    currentGameMode = mode;
    
    // Update button states
    document.querySelectorAll('.mode-btn').forEach(btn => {
        if (btn.getAttribute('data-mode') === mode) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
    
    // Update piece selectability based on mode
    if (moveManager) {
        if (mode === GAME_MODES.SINGLEPLAYER) {
            // Both teams can be selected manually
            moveManager.setSelectability(0, true);
            moveManager.setSelectability(1, true);
        } else if (mode === GAME_MODES.VS_BOT) {
            // Only white (player) can be selected, black is bot
            moveManager.setSelectability(0, true);
            moveManager.setSelectability(1, false);
        } else if (mode === GAME_MODES.BOT_VS_BOT) {
            // Neither team can be selected (both are bots)
            moveManager.setSelectability(0, false);
            moveManager.setSelectability(1, false);
        }
    }
    
    // Deselect current piece
    deselectPiece();
    
    // Check if game is already over before starting bot mode
    if (gameBoard && moveManager) {
        const winStatus = gameBoard.winCondition();
        if (winStatus !== -1) {
            // Game is already over, show modal and don't start bots
            console.log(`🛑 Game is already over (winStatus: ${winStatus}), cannot start bot mode`);
            checkWinCondition();
            return;
        }
    }
    
    // Start bot vs bot if needed
    if (mode === GAME_MODES.BOT_VS_BOT && gameBoard && moveManager) {
        startBotVsBot();
    }
}

function scheduleBotMove() {
    // Clear any pending bot move
    if (botMoveInterval) {
        clearTimeout(botMoveInterval);
        botMoveInterval = null;
    }
    
    // Check if bot should move
    if (!gameBoard || !moveManager) return;
    
    const currentTeam = moveManager.whoseTurn();
    
    // CRITICAL: Check if game is over (checkmate/stalemate) before scheduling bot move
    const winStatus = gameBoard.winCondition();
    if (winStatus !== -1) {
        // Game is over - don't schedule bot move
        console.log(`🛑 Game is over (winStatus: ${winStatus}), bot will not move`);
        checkWinCondition(); // Ensure modal is shown
        return;
    }
    
    // CRITICAL: Check if current team is in checkmate (has no legal moves)
    const isInCheck = gameBoard.inCheck(currentTeam);
    const hasLegalMoves = gameBoard.hasLegalMoves(currentTeam);
    
    if (isInCheck && !hasLegalMoves) {
        // Team is in checkmate - game should be over, don't let bot move
        console.log(`🛑 Team ${currentTeam} is in CHECKMATE - bot will not move`);
        checkWinCondition(); // Trigger win condition check and modal
        return;
    }
    
    if (!isInCheck && !hasLegalMoves) {
        // Team is in stalemate - game should be over
        console.log(`🛑 Team ${currentTeam} is in STALEMATE - bot will not move`);
        checkWinCondition(); // Trigger win condition check and modal
        return;
    }
    
    // Check if current team should be controlled by bot
    let shouldBotMove = false;
    
    if (currentGameMode === GAME_MODES.VS_BOT) {
        // Bot plays black (team 1), player plays white (team 0)
        shouldBotMove = (currentTeam === 1);
    } else if (currentGameMode === GAME_MODES.BOT_VS_BOT) {
        // Both teams are bots
        shouldBotMove = true;
    }
    
    if (shouldBotMove && Bot) {
        // Schedule bot move after a short delay (to allow animation to complete)
        botMoveInterval = setTimeout(() => {
            // Bot.makeMove now returns a Promise and includes visual feedback
            Bot.makeMove(gameBoard, moveManager, currentTeam).then((success) => {
                if (success) {
                    // Bot move completed, will check again after move completes
                } else {
                    // Bot couldn't make a move - check if it's checkmate
                    const winStatusAfter = gameBoard.winCondition();
                    if (winStatusAfter !== -1) {
                        checkWinCondition();
                    }
                }
            });
        }, 1500); // 1.5 second delay for visual effect
    }
}

function startBotVsBot() {
    console.log('🤖 Starting Bot vs Bot mode');
    
    // Check if game is already over before starting
    if (!gameBoard || !moveManager) {
        console.warn('⚠️ Cannot start Bot vs Bot: gameBoard or moveManager not available');
        return;
    }
    
    const winStatus = gameBoard.winCondition();
    if (winStatus !== -1) {
        console.log(`🛑 Cannot start Bot vs Bot: Game is already over (winStatus: ${winStatus})`);
        checkWinCondition(); // Show modal
        return;
    }
    
    // Check if current team is in checkmate/stalemate
    const currentTeam = moveManager.whoseTurn();
    const isInCheck = gameBoard.inCheck(currentTeam);
    const hasLegalMoves = gameBoard.hasLegalMoves(currentTeam);
    
    if (isInCheck && !hasLegalMoves) {
        console.log(`🛑 Cannot start Bot vs Bot: Team ${currentTeam} is in CHECKMATE`);
        checkWinCondition(); // Show modal
        return;
    }
    
    if (!isInCheck && !hasLegalMoves) {
        console.log(`🛑 Cannot start Bot vs Bot: Team ${currentTeam} is in STALEMATE`);
        checkWinCondition(); // Show modal
        return;
    }
    
    // First move will be scheduled by scheduleBotMove after setup
    scheduleBotMove();
}

function stopBotMoveInterval() {
    if (botMoveInterval) {
        clearTimeout(botMoveInterval);
        botMoveInterval = null;
    }
}

/* ============================================
   WINDOW RESIZE HANDLER
   ============================================ */

function onWindowResize() {
    const width = window.innerWidth - 560; // Minus panels
    const height = window.innerHeight - 60; // Minus header
    
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    
    renderer.setSize(width, height);
}

/* ============================================
   START THE GAME
   ============================================ */

// Wait for DOM to be ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

