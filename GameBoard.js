/*

    Board Scale: 3 --> 300 x 300
    Piece Scale: 9
    Vertical Increment: 600 / (n=6) = 100
    Horizontal Increment: 450, but Space between boards: 150

*/

// Helper function to rotate objects
function rotateObject(object, x, y, z) {
    object.rotation.x = x * Math.PI / 180;
    object.rotation.y = y * Math.PI / 180;
    object.rotation.z = z * Math.PI / 180;
}

// Helper function to create empty piece (compatible with Piece class)
function createEmptyPiece() {
    return {
        type: null,
        team: null,
        mesh: null,
        hasMoved: false,
        position: {x: 0, y: 0, z: 0, w: 0},
        getPossibleMoves: function() { return []; }
    };
}



GameBoard.prototype = {
    
    initPieces: function(){
        //
        // Logic
        //
        
        // Instantiate empty pieces (4D array)
        const range = n => [...Array(n)].map((_, i) => i);
        const rangeIn = dims => {
          if (!dims.length) {
              return createEmptyPiece();
          }
          return range(dims[0]).map(_ => rangeIn(dims.slice(1)));
        };
        
        const pieces = rangeIn([this.n, this.n, this.n, this.n])
        
        //
        // Graphics
        //
		return pieces;
    },
    
	// GameBoard.move should only be called from MoveManager. All move data received from server should pass through MoveManager.
    move: function(x0, y0, z0, w0, x1, y1, z1, w1){
		this.graphics.hidePossibleMoves(); // TODO: replace with pointer deselection
		const metaData = {}
		
		const targetPiece = this.pieces[x1][y1][z1][w1];
		if(targetPiece.type){
			Object.assign(metaData, {capturedPiece: targetPiece});
		}
        const piece = this.pieces[x0][y0][z0][w0];
		
		this.graphics.moveMesh(piece, x1, y1, z1, w1);
        
		this.pieces[x0][y0][z0][w0] = createEmptyPiece(); // Remove game object from board
		this.removePiece(x1, y1, z1, w1); // Immediately remove target game object and sprite (do nothing if square is empty)
        this.pieces[x1][y1][z1][w1] = piece; // Replace object in target square with moved piece
        Object.assign(metaData, piece.update(this.pieces, x0, y0, z0, w0, x1, y1, z1, w1));
		
		if(piece.type === 'pawn' && this.isOnPromotionSquare(x1, y1, z1, w1)){
			// Normal capture logic and animation is still executed,
			// but here we replace the pawn's game object with a Queen game object
			// Notice that we do not use GameObject.removePiece() method because
			// it will also remove its mesh, which we only want once the animation
			// finishes
			
			// The following 2 lines were causing bugs when spamming redo after a pawn promotion. Error was that the queen's mesh is undefined. The queen's .mesh property was not being set until the animation was complete. The fix was to create the mesh and set the queen's .mesh property immediately in the promotion logic, and only make it appear (add it to piecesContainer) when the animation is finished.
//			queen = new Queen(piece.team);
//			this.pieces[x1][y1][z1][w1] = queen;
			let queen = this.spawnPiece(Queen, piece.team, x1, y1, z1, w1, false);
			piece.descendant = queen;
			
			Object.assign(metaData, {promotion: true, newPiece: queen, oldPiece: piece});
		}

		// M4a: keep Python state in sync with JS state. Fire-and-forget so we
		// never block the move execution; errors logged but not surfaced.
		// Disabled when ?legalityEngine=js (default in production until M4b).
		if (typeof window !== 'undefined' && window.SpectralBridge && window.__LEGALITY_ENGINE__ !== 'js') {
			try {
				window.SpectralBridge.applyMove(
					{x: x0, y: y0, z: z0, w: w0},
					{x: x1, y: y1, z: z1, w: w1}
				).then((res) => {
					if (!res || !res.ok) {
						console.warn('[m4a] bridge.applyMove rejected', res);
					} else {
						// M10: refresh board overlays after Python state advances.
						// (No-ops when overlays are disabled.)
						if (window.SpectralHeatmap) window.SpectralHeatmap.refresh();
						if (window.SpectralFilaments) window.SpectralFilaments.refresh();
						// M11.3.6: tinted board cells overlay
						if (window.SpectralBoardTint) window.SpectralBoardTint.refresh();
						// M11.3.1: nested isosurface shells
						if (window.SpectralIsosurfaces) window.SpectralIsosurfaces.refresh();
					}
				}).catch((err) => {
					console.warn('[m4a] bridge.applyMove error', err);
				});
			} catch (err) {
				console.warn('[m4a] bridge.applyMove threw synchronously', err);
			}
		} else if (typeof window !== 'undefined') {
			// M10: even when ?legalityEngine=js (Python isn't tracking state),
			// the heat map/filaments still need a refresh trigger. Apply the
			// JS move to the Python state too (fire-and-forget) so the
			// overlay reflects what just happened on screen. Without this
			// guard, overlays stay frozen at initial position.
			if (window.SpectralBridge && (
					window.SpectralHeatmap || window.SpectralFilaments ||
					window.SpectralBoardTint || window.SpectralIsosurfaces
				)) {
				try {
					window.SpectralBridge.applyMove(
						{x: x0, y: y0, z: z0, w: w0},
						{x: x1, y: y1, z: z1, w: w1}
					).then((res) => {
						if (res && res.ok) {
							if (window.SpectralHeatmap) window.SpectralHeatmap.refresh();
							if (window.SpectralFilaments) window.SpectralFilaments.refresh();
							if (window.SpectralBoardTint) window.SpectralBoardTint.refresh();
							if (window.SpectralIsosurfaces) window.SpectralIsosurfaces.refresh();
						}
					}).catch((err) => {
						console.warn('[m10] bridge.applyMove error', err);
					});
				} catch (err) { /* ignore */ }
			}
		}

        return metaData;
    },

	undo: function(move){
		this.graphics.hidePossibleMoves(); // TODO: replace with pointer deselection
		const pieceInOriginalLoc = this.pieces[move.x0][move.y0][move.z0][move.w0];
		if(pieceInOriginalLoc.type){
			console.error('Unknown error. A piece is already located in original location')
		}
		const originalPiece = move.metaData.promotion ? move.metaData.oldPiece : this.pieces[move.x1][move.y1][move.z1][move.w1];
		this.pieces[move.x0][move.y0][move.z0][move.w0] = originalPiece;
		
		const capturedPiece = move.metaData.capturedPiece || createEmptyPiece();
		if(move.metaData.promotion){
			this.graphics.respawnMesh(originalPiece, move.x1, move.y1, move.z1, move.w1);
			this.removePiece(move.x1, move.y1, move.z1, move.w1); // TODO: THIS IS SCARY. If bugs occur separate the graphics component of removePiece into a new method. The current implementaiton might cause errors...
		}
		this.pieces[move.x1][move.y1][move.z1][move.w1] = capturedPiece;
		
		if (move.metaData.capturedPiece) {
			this.graphics.respawnMesh(capturedPiece, move.x1, move.y1, move.z1, move.w1); 
		}
		if (move.metaData.justMoved) {
			originalPiece.hasMoved = false;
		}
		this.graphics.moveMesh(originalPiece, move.x0, move.y0, move.z0, move.w0);

		// M4a: keep Python state in sync with JS state on undo.
		if (typeof window !== 'undefined' && window.SpectralBridge && window.__LEGALITY_ENGINE__ !== 'js') {
			try {
				window.SpectralBridge.undo().then((res) => {
					if (!res || !res.ok) {
						console.warn('[m4a] bridge.undo rejected', res);
					}
				}).catch((err) => {
					console.warn('[m4a] bridge.undo error', err);
				});
			} catch (err) {
				console.warn('[m4a] bridge.undo threw synchronously', err);
			}
		}
	},
	
	inCheck: function(team) {
		let attackers = Piece.inCheck(this.pieces, team);
		return attackers.length > 0;
	},
	
	winCondition: function() {
		// Check if white is in checkmate (white in check + no legal moves)
		const whiteInCheck = this.inCheck(0);
		if (whiteInCheck) {
			const whiteHasLegalMoves = this.hasLegalMoves(0);
			if (!whiteHasLegalMoves) {
				return 1; // Black wins
			}
		}
		
		// Check if black is in checkmate (black in check + no legal moves)
		const blackInCheck = this.inCheck(1);
		if (blackInCheck) {
			const blackHasLegalMoves = this.hasLegalMoves(1);
			if (!blackHasLegalMoves) {
				return 0; // White wins
			}
		}
		
		// Check for stalemate (not in check but no legal moves)
		// Get current team from global moveManager if available
		let currentTeam = 0;
		if (typeof window !== 'undefined' && window.moveManager) {
			currentTeam = window.moveManager.whoseTurn();
		}
		
		const currentNotInCheck = !this.inCheck(currentTeam);
		if (currentNotInCheck && !this.hasLegalMoves(currentTeam)) {
			return 2; // Stalemate
		}
		
		return -1; // Game continues
	},
	
	hasLegalMoves: function(team) {
		// M4b: full check across all of `team`'s pieces, no caps. Earlier
		// the function bailed at MAX_PIECES_TO_CHECK=50 and
		// MAX_MOVES_TO_CHECK=20 to avoid freezing the page on win-condition
		// checks — but those caps SILENTLY LIED about stalemate / checkmate
		// on full 4D positions (~448 pieces per side) and shipped the
		// upstream's "false-stalemate" bug into chess4D-OC. We accept the
		// occasional ~hundreds-of-ms freeze on the unhappy path (real
		// stalemate or checkmate) in exchange for correct results.
		//
		// Future M4b.1: route this through SpectralBridge.legalMoves once
		// the call chain is async-friendly; chess4d's legality is much
		// faster than the JS clone-and-test path (~50ms vs ~hundreds).
		// For now, the bound on this function is 448 pieces × ~80 moves
		// × isMoveLegal cost (~448 iterations for inCheck), worst case.
		// The first legal move found triggers early-exit so the happy
		// path stays cheap.
		for (let x = 0; x < this.n; x++) {
			for (let y = 0; y < this.n; y++) {
				for (let z = 0; z < this.n; z++) {
					for (let w = 0; w < this.n; w++) {
						const piece = this.pieces[x][y][z][w];
						if (!piece || !piece.type || piece.team !== team) continue;
						try {
							const possibleMoves = piece.getPossibleMoves(this.pieces, x, y, z, w);
							if (!possibleMoves || possibleMoves.length === 0) continue;
							for (const move of possibleMoves) {
								if (this.isMoveLegal(x, y, z, w, move.x, move.y, move.z, move.w, team)) {
									return true; // Early exit — at least one legal move exists.
								}
							}
						} catch (error) {
							// Skip a piece whose generator throws; treat as "no moves"
							// rather than letting the error abort the entire scan.
							continue;
						}
					}
				}
			}
		}

		return false;
	},
	
	isMoveLegal: function(x0, y0, z0, w0, x1, y1, z1, w1, team) {
		// Simulate the move
		const sourcePiece = this.pieces[x0][y0][z0][w0];
		const targetPiece = this.pieces[x1][y1][z1][w1];
		
		// Make the move temporarily
		this.pieces[x1][y1][z1][w1] = sourcePiece;
		this.pieces[x0][y0][z0][w0] = createEmptyPiece();
		
		// Check if still in check after move
		const stillInCheck = this.inCheck(team);
		
		// Restore board
		this.pieces[x0][y0][z0][w0] = sourcePiece;
		this.pieces[x1][y1][z1][w1] = targetPiece;
		
		// Move is legal if it doesn't leave us in check (or gets us out of check)
		return !stillInCheck;
	},
	
	applyToAll: function(f){
		for(let x = 0; x < this.pieces.length; x++){
			for(let y = 0; y < this.pieces[0].length; y++){
				for(let z = 0; z < this.pieces[0][0].length; z++){
					for(let w = 0; w < this.pieces[0][0][0].length; w++){
						const piece = this.pieces[x][y][z][w]
						f(piece)
					}
				}
			}
		}
	},
	
	applyToPieces: function(f){
		function onlyPieces(piece){
			if(piece.type)
				f(piece)
		}
		this.applyToAll(onlyPieces)
	},
	
	applyToTeam: function(f, team){
		function onlyTeam(piece){
			if(piece.team === team){
				f(piece)
			}
		}
		this.applyToPieces(onlyTeam)
	},
    
	
	
    isOnPromotionSquare: function(x, y, z, w){
		const piece = this.pieces[x][y][z][w]
		const promotionLoc = piece.team > 0 ? 0 : this.n - 1
		return z === promotionLoc && w === promotionLoc
    },
    
    spawnPiece: function(PieceConstructor, team, x, y, z, w, addToContainer=true){
        const piece = new PieceConstructor(team)
        this.pieces[x][y][z][w] = piece
		this.graphics.setMesh(piece, x, y, z, w, addToContainer);
        
        // Debug: Log first piece
        if (x === 0 && y === 0 && z === 0 && w === 4) {
            console.log('🔍 First white piece spawned:', {
                type: piece.type,
                team: piece.team,
                position: {x, y, z, w},
                hasMesh: !!piece.mesh,
                meshPosition: piece.mesh ? piece.mesh.position : null
            });
        }
        
		return piece;
    },
	
	removePiece: function(x, y, z, w){
		const piece = this.pieces[x][y][z][w]
		this.graphics.removeMesh(piece);
		this.pieces[x][y][z][w] = createEmptyPiece();
	},
    
    inBounds: function(x, y, z, w) {
        return x >= 0 && x < this.n && y >= 0 && y < this.n && z >=0 && z < this.n && w >=0 && w < this.n;
    },
	
	package: function() {
		const x = this.pieces;
		const pieces = x.map(y => 
			y.map(z => 
				z.map(w => 
					w.map(piece => piece.package())
				)
			)
		);
		return pieces;
	},
	
	loadPieces: function(piecesArr) {
		this.graphics.abandon(); // remove all meshes from scene
		const Graphics = (this.graphics instanceof BoardGraphics) ? BoardGraphics : EmptyBoardGraphics;
		this.graphics = new Graphics(this) // create new graphics
		
		this.pieces = this.initPieces();
		for (let x = 0; x < this.n; x++) {
			for (let y = 0; y < this.n; y++) {
				for(let z = 0; z < this.n; z++) {
					for(let w = 0; w < this.n; w++) {
						const read = piecesArr[x][y][z][w];
						if (read.type) {
							const PieceConstructor = Piece.typeToConstructor[read.type];
							let piece = this.spawnPiece(PieceConstructor, read.team, x, y, z, w);
							Object.assign(piece, read);
						}
						
					}
				}
			}
		}
	},
    
    initializeStartingPositions: function(){
        /*
         * Initialize pieces for 8x8x8x8 4D chess with mirrored distribution
         * 
         * Bottom layers (Y=0,1,2):
         * - WHITE (Team 0): W=0,1,2,3 (12 boards × 16 pieces = 192 pieces)
         * - BLACK (Team 1): W=4,5,6,7 (12 boards × 16 pieces = 192 pieces)
         * 
         * Center boards (Y=3 & Y=4, traditional chess-style):
         * - Y=3: 2 boards at W=3,4 (centered, perfectly neutral)
         * - Y=4: 2 boards at W=3,4 (centered, perfectly neutral)
         * - Each board: 16 white pieces + 16 black pieces = 32 pieces
         * - Total: 128 pieces (64 per team) - evenly split across 2 layers, perfectly centered
         * 
         * Top layers (Y=5,6,7 - MIRRORED):
         * - BLACK (Team 1): W=0,1,2,3 (12 boards × 16 pieces = 192 pieces) - swapped!
         * - WHITE (Team 0): W=4,5,6,7 (12 boards × 16 pieces = 192 pieces) - swapped!
         * 
         * Grand total: 384 + 128 + 384 = 896 pieces (448 per team)
         * All Y layers (0-7) now have pieces - no empty layers!
         */
        
        // Main distribution: WHITE pieces (Y=0,1,2 × W=0,1,2,3) - reduced to 3 Y layers
        for (let y = 0; y <= 2; y++) {
            for (let w = 0; w <= 3; w++) {
                this.placeTeamPieces(0, w, y); // team 0 (white)
            }
        }
        
        // Main distribution: BLACK pieces (Y=0,1,2 × W=4,5,6,7) - reduced to 3 Y layers
        for (let y = 0; y <= 2; y++) {
            for (let w = 4; w <= 7; w++) {
                this.placeTeamPieces(1, w, y); // team 1 (black)
            }
        }
        
        // Center boards: Traditional chess-style with pieces facing each other
        // Split between Y=3 and Y=4, perfectly centered at W=3,4 (middle of 0-7)
        // Y=3: 2 boards at W=3,4 (centered)
        for (let w = 3; w <= 4; w++) {
            // White pieces on one side of the board (Z=0,1)
            this.placeTeamPieces(0, w, 3);
            // Black pieces on the other side of the same boards (Z=6,7)
            this.placeTeamPieces(1, w, 3);
        }
        // Y=4: 2 boards at W=3,4 (centered, same W positions)
        for (let w = 3; w <= 4; w++) {
            // White pieces on one side of the board (Z=0,1)
            this.placeTeamPieces(0, w, 4);
            // Black pieces on the other side of the same boards (Z=6,7)
            this.placeTeamPieces(1, w, 4);
        }
        
        // Top layers: Mirrored color pattern (swapped W positions)
        // Y=5,6,7: Black gets W=0-3 (where white was on bottom), White gets W=4-7 (where black was on bottom)
        for (let y = 5; y <= 7; y++) {
            // Black pieces on W=0,1,2,3 (mirroring white's bottom position)
            for (let w = 0; w <= 3; w++) {
                this.placeTeamPieces(1, w, y); // team 1 (black)
            }
            // White pieces on W=4,5,6,7 (mirroring black's bottom position)
            for (let w = 4; w <= 7; w++) {
                this.placeTeamPieces(0, w, y); // team 0 (white)
            }
        }
        
        console.log('✅ Placed 896 pieces: 448 White + 448 Black');
        console.log('   - Bottom (Y=0-2): 192 White (W=0-3) + 192 Black (W=4-7)');
        console.log('   - Center (Y=3): 32 White + 32 Black on 2 shared boards (W=3,4) - CENTERED');
        console.log('   - Center (Y=4): 32 White + 32 Black on 2 shared boards (W=3,4) - CENTERED');
        console.log('   - Top (Y=5-7): 192 Black (W=0-3) + 192 White (W=4-7) - MIRRORED');
        console.log('   ✓ All 8 Y layers now have pieces!');
        console.log(`📦 Pieces container has ${this.graphics.piecesContainer.children.length} meshes`);
        
        // Check square colors for white's right corner on each board
        console.log('🎨 Square colors (light=even sum):');
        for (let w = 0; w <= 3; w++) {
            const x = 7, z = 0; // White's back-right square
            const sum = x + z + 0 + w; // y=0 for first level
            const isLight = sum % 2 === 0;
            console.log(`  W=${w}: Square (${x},0,${z},${w}) is ${isLight ? 'LIGHT ⬜' : 'DARK ⬛'} (sum=${sum})`);
        }
        
        // Verify some pieces
        let whitePieces = 0, blackPieces = 0;
        this.applyToAll(piece => {
            if (piece.type && piece.mesh) {
                if (piece.team === 0) whitePieces++;
                else if (piece.team === 1) blackPieces++;
            }
        });
        console.log(`🔍 Verification: ${whitePieces} white pieces, ${blackPieces} black pieces with meshes`);
        
        // Debug first piece details
        if (this.graphics.piecesContainer.children.length > 0) {
            const firstMesh = this.graphics.piecesContainer.children[0];
            
            // Calculate piece height
            const bbox = new THREE.Box3().setFromObject(firstMesh);
            const pieceHeight = bbox.max.y - bbox.min.y;
            const pieceBottom = bbox.min.y;
            const pieceTop = bbox.max.y;
            
            console.log('🔬 First mesh details:', {
                position: {x: firstMesh.position.x, y: firstMesh.position.y, z: firstMesh.position.z},
                scale: {x: firstMesh.scale.x, y: firstMesh.scale.y, z: firstMesh.scale.z},
                height: pieceHeight,
                bottom: pieceBottom,
                top: pieceTop,
                visible: firstMesh.visible,
                material: {
                    color: '#' + firstMesh.material.color.getHexString(),
                    opacity: firstMesh.material.opacity,
                    transparent: firstMesh.material.transparent
                },
                geometry: {
                    vertices: firstMesh.geometry.attributes.position.count
                }
            });
            
            // Log square center for first piece position (0,0,0,4)
            const firstSquareCenter = this.graphics.boardCoordinates(0, 0, 0, 4);
            console.log('📍 First square (0,0,0,4) center:', {
                x: firstSquareCenter.x,
                y: firstSquareCenter.y,
                z: firstSquareCenter.z
            });
            
            console.log('🎯 Camera looking at pieces from:', {
                cameraPos: {x: camera.position.x, y: camera.position.y, z: camera.position.z},
                cameraTarget: {x: controls.target.x, y: controls.target.y, z: controls.target.z},
                piecePos: {x: firstMesh.position.x, y: firstMesh.position.y, z: firstMesh.position.z}
            });
        }
    },
    
    placeTeamPieces: function(team, w, y){
        /*
         * Place all pieces for one team on a single 8x8 board at position (w, y)
         * 
         * team: 0 (white) or 1 (black)
         * w: W-axis position (0-7)
         * y: Y-axis position (0-7)
         */
        
        const backRank = (team === 0) ? 0 : 7;  // Z position for major pieces
        const pawnRank = (team === 0) ? 1 : 6;  // Z position for pawns
        
        // Back rank: Rook, Knight, Bishop, Queen, King, Bishop, Knight, Rook
        this.spawnPiece(window.Rook, team, 0, y, backRank, w);
        this.spawnPiece(window.Knight, team, 1, y, backRank, w);
        this.spawnPiece(window.Bishop, team, 2, y, backRank, w);
        this.spawnPiece(window.Queen, team, 3, y, backRank, w);
        this.spawnPiece(window.King, team, 4, y, backRank, w);
        this.spawnPiece(window.Bishop, team, 5, y, backRank, w);
        this.spawnPiece(window.Knight, team, 6, y, backRank, w);
        this.spawnPiece(window.Rook, team, 7, y, backRank, w);
        
        // Pawns row
        for (let x = 0; x < 8; x++) {
            this.spawnPiece(window.Pawn, team, x, y, pawnRank, w);
        }
    },
    
    test: function(x, y, z, w){
        
        if(x == null) x = getRandomInteger(0, this.n)
        if(y == null) y = getRandomInteger(0, this.n)
        if(z == null) z = getRandomInteger(0, this.n)
        if(w == null) w = getRandomInteger(0, this.n)
		
        this.spawnPiece(Rook, 0, 0, 0, 0, 0)
        this.spawnPiece(Knight, 0, 1, 0, 0, 0)
        this.spawnPiece(Knight, 0, 2, 0, 0, 0)
        this.spawnPiece(Rook, 0, 3, 0, 0, 0)
        this.spawnPiece(Bishop, 0, 0, 1, 0, 0)
        this.spawnPiece(Pawn, 0, 1, 1, 0, 0)
        this.spawnPiece(Pawn, 0, 2, 1, 0, 0)
        this.spawnPiece(Bishop, 0, 3, 1, 0, 0)
        this.spawnPiece(Bishop, 0, 0, 2, 0, 0)
        this.spawnPiece(Queen, 0, 1, 2, 0, 0)
        this.spawnPiece(King, 0, 2, 2, 0, 0)
        this.spawnPiece(Bishop, 0, 3, 2, 0, 0)
        this.spawnPiece(Rook, 0, 0, 3, 0, 0)
        this.spawnPiece(Knight, 0, 1, 3, 0, 0)
        this.spawnPiece(Knight, 0, 2, 3, 0, 0)
        this.spawnPiece(Rook, 0, 3, 3, 0, 0)
        
        this.spawnPiece(Pawn, 0, 0, 0, 1, 0)
        this.spawnPiece(Pawn, 0, 1, 0, 1, 0)
        this.spawnPiece(Pawn, 0, 2, 0, 1, 0)
        this.spawnPiece(Pawn, 0, 3, 0, 1, 0)
        this.spawnPiece(Pawn, 0, 0, 1, 1, 0)
        this.spawnPiece(Pawn, 0, 1, 1, 1, 0)
        this.spawnPiece(Pawn, 0, 2, 1, 1, 0)
        this.spawnPiece(Pawn, 0, 3, 1, 1, 0)
        this.spawnPiece(Pawn, 0, 0, 2, 1, 0)
        this.spawnPiece(Pawn, 0, 1, 2, 1, 0)
        this.spawnPiece(Pawn, 0, 2, 2, 1, 0)
        this.spawnPiece(Pawn, 0, 3, 2, 1, 0)
        this.spawnPiece(Pawn, 0, 0, 3, 1, 0)
        this.spawnPiece(Pawn, 0, 1, 3, 1, 0)
        this.spawnPiece(Pawn, 0, 2, 3, 1, 0)
        this.spawnPiece(Pawn, 0, 3, 3, 1, 0)
        
        this.spawnPiece(Pawn, 0, 0, 0, 0, 1)
        this.spawnPiece(Pawn, 0, 1, 0, 0, 1)
        this.spawnPiece(Pawn, 0, 2, 0, 0, 1)
        this.spawnPiece(Pawn, 0, 3, 0, 0, 1)
        this.spawnPiece(Pawn, 0, 0, 1, 0, 1)
        this.spawnPiece(Pawn, 0, 1, 1, 0, 1)
        this.spawnPiece(Pawn, 0, 2, 1, 0, 1)
        this.spawnPiece(Pawn, 0, 3, 1, 0, 1)
        this.spawnPiece(Pawn, 0, 0, 2, 0, 1)
        this.spawnPiece(Pawn, 0, 1, 2, 0, 1)
        this.spawnPiece(Pawn, 0, 2, 2, 0, 1)
        this.spawnPiece(Pawn, 0, 3, 2, 0, 1)
        this.spawnPiece(Pawn, 0, 0, 3, 0, 1)
        this.spawnPiece(Pawn, 0, 1, 3, 0, 1)
        this.spawnPiece(Pawn, 0, 2, 3, 0, 1)
        this.spawnPiece(Pawn, 0, 3, 3, 0, 1)
        
        this.spawnPiece(Pawn, 0, 0, 0, 1, 1)
        this.spawnPiece(Pawn, 0, 1, 0, 1, 1)
        this.spawnPiece(Pawn, 0, 2, 0, 1, 1)
        this.spawnPiece(Pawn, 0, 3, 0, 1, 1)
        this.spawnPiece(Pawn, 0, 0, 1, 1, 1)
        this.spawnPiece(Pawn, 0, 1, 1, 1, 1)
        this.spawnPiece(Pawn, 0, 2, 1, 1, 1)
        this.spawnPiece(Pawn, 0, 3, 1, 1, 1)
        this.spawnPiece(Pawn, 0, 0, 2, 1, 1)
        this.spawnPiece(Pawn, 0, 1, 2, 1, 1)
        this.spawnPiece(Pawn, 0, 2, 2, 1, 1)
        this.spawnPiece(Pawn, 0, 3, 2, 1, 1)
        this.spawnPiece(Pawn, 0, 0, 3, 1, 1)
        this.spawnPiece(Pawn, 0, 1, 3, 1, 1)
        this.spawnPiece(Pawn, 0, 2, 3, 1, 1)
        this.spawnPiece(Pawn, 0, 3, 3, 1, 1)
        
        const l = this.n - 1 // Back row (black)
        const m = l - 1 // Front Row (black)
        
        this.spawnPiece(Rook, 1, 0, 0, l, l)
        this.spawnPiece(Knight, 1, 1, 0, l, l)
        this.spawnPiece(Knight, 1, 2, 0, l, l)
        this.spawnPiece(Rook, 1, 3, 0, l, l)
        this.spawnPiece(Bishop, 1, 0, 1, l, l)
        this.spawnPiece(Pawn, 1, 1, 1, l, l)
        this.spawnPiece(Pawn, 1, 2, 1, l, l)
        this.spawnPiece(Bishop, 1, 3, 1, l, l)
        this.spawnPiece(Bishop, 1, 0, 2, l, l)
        this.spawnPiece(Queen, 1, 1, 2, l, l)
        this.spawnPiece(King, 1, 2, 2, l, l)
        this.spawnPiece(Bishop, 1, 3, 2, l, l)
        this.spawnPiece(Rook, 1, 0, 3, l, l)
        this.spawnPiece(Knight, 1, 1, 3, l, l)
        this.spawnPiece(Knight, 1, 2, 3, l, l)
        this.spawnPiece(Rook, 1, 3, 3, l, l)
        
        this.spawnPiece(Pawn, 1, 0, 0, m, l)
        this.spawnPiece(Pawn, 1, 1, 0, m, l)
        this.spawnPiece(Pawn, 1, 2, 0, m, l)
        this.spawnPiece(Pawn, 1, 3, 0, m, l)
        this.spawnPiece(Pawn, 1, 0, 1, m, l)
        this.spawnPiece(Pawn, 1, 1, 1, m, l)
        this.spawnPiece(Pawn, 1, 2, 1, m, l)
        this.spawnPiece(Pawn, 1, 3, 1, m, l)
        this.spawnPiece(Pawn, 1, 0, 2, m, l)
        this.spawnPiece(Pawn, 1, 1, 2, m, l)
        this.spawnPiece(Pawn, 1, 2, 2, m, l)
        this.spawnPiece(Pawn, 1, 3, 2, m, l)
        this.spawnPiece(Pawn, 1, 0, 3, m, l)
        this.spawnPiece(Pawn, 1, 1, 3, m, l)
        this.spawnPiece(Pawn, 1, 2, 3, m, l)
        this.spawnPiece(Pawn, 1, 3, 3, m, l)
        
        this.spawnPiece(Pawn, 1, 0, 0, l, m)
        this.spawnPiece(Pawn, 1, 1, 0, l, m)
        this.spawnPiece(Pawn, 1, 2, 0, l, m)
        this.spawnPiece(Pawn, 1, 3, 0, l, m)
        this.spawnPiece(Pawn, 1, 0, 1, l, m)
        this.spawnPiece(Pawn, 1, 1, 1, l, m)
        this.spawnPiece(Pawn, 1, 2, 1, l, m)
        this.spawnPiece(Pawn, 1, 3, 1, l, m)
        this.spawnPiece(Pawn, 1, 0, 2, l, m)
        this.spawnPiece(Pawn, 1, 1, 2, l, m)
        this.spawnPiece(Pawn, 1, 2, 2, l, m)
        this.spawnPiece(Pawn, 1, 3, 2, l, m)
        this.spawnPiece(Pawn, 1, 0, 3, l, m)
        this.spawnPiece(Pawn, 1, 1, 3, l, m)
        this.spawnPiece(Pawn, 1, 2, 3, l, m)
        this.spawnPiece(Pawn, 1, 3, 3, l, m)
        
        this.spawnPiece(Pawn, 1, 0, 0, m, m)
        this.spawnPiece(Pawn, 1, 1, 0, m, m)
        this.spawnPiece(Pawn, 1, 2, 0, m, m)
        this.spawnPiece(Pawn, 1, 3, 0, m, m)
        this.spawnPiece(Pawn, 1, 0, 1, m, m)
        this.spawnPiece(Pawn, 1, 1, 1, m, m)
        this.spawnPiece(Pawn, 1, 2, 1, m, m)
        this.spawnPiece(Pawn, 1, 3, 1, m, m)
        this.spawnPiece(Pawn, 1, 0, 2, m, m)
        this.spawnPiece(Pawn, 1, 1, 2, m, m)
        this.spawnPiece(Pawn, 1, 2, 2, m, m)
        this.spawnPiece(Pawn, 1, 3, 2, m, m)
        this.spawnPiece(Pawn, 1, 0, 3, m, m)
        this.spawnPiece(Pawn, 1, 1, 3, m, m)
        this.spawnPiece(Pawn, 1, 2, 3, m, m)
        this.spawnPiece(Pawn, 1, 3, 3, m, m)
        
    }
    
}


EmptyBoardGraphics.prototype = {
	
	getBoundingBox: function() {},
	
	getCenter: function(){},
	
	boardCoordinates: function(x, y, z, w){},
	
	worldCoordinates: function(pos){},
	
	showPossibleMoves: function(locations, piece, materialScheme={}, canRayCast){},
    
    showPossibleMoves2: function(x, y, z, w, materialScheme){},
    
    hidePossibleMoves: function(objectName='possibleMoves'){},
	
	moveMesh: function(piece, x1, y1, z1, w1){},
	
	createMesh: function(typeString, team, x, y, z, w, addToContainer=true){},
	
	setMesh: function(piece, x, y, z, w, addToContainer=true){},
	
	removeMesh: function(piece){},
	
	respawnMesh: function(piece){},
	
	setSelectability: function(piece, canMove) {},
	
	addToPiecesContainer: function(mesh) {},
	
	abandon: function() {}
	
}





BoardGraphics.prototype = {
	
	getBoundingBox: function() {
		const offset = this.boardSize / 2;
		const originOffset = new THREE.Vector3(offset, 0, -offset);
		const logicalLocalOrigin = originOffset.clone().multiplyScalar(-1);
		const globalLLO = logicalLocalOrigin.clone().add(this.mesh.position);
		
		const globalBottomLeft = logicalLocalOrigin.clone().add(this.mesh.position);
		const halfDiagonal = this.getCenter().sub(globalLLO);
		const extraHeight = new THREE.Vector3(0, this.verticalIncrement, 0);
		const globalTopRight = this.getCenter().clone().add(halfDiagonal).clone().add(extraHeight);
		
		const extraSpace = new THREE.Vector3(this.squareSize * 0, 0, -this.squareSize)
		
		return {
			bottomLeft: globalBottomLeft.sub(extraSpace),
			topRight: globalTopRight.add(extraSpace)
		};
	},
	
	getCenter: function(){
		const numHalfBoards = (this.n - 1) / 2;
		const localZ = -(this.boardSize + this.horizontalGap) * numHalfBoards;
		const localY = this.verticalIncrement * numHalfBoards;
		const localCenter = new THREE.Vector3(0, localY, localZ);
		return localCenter.add(this.mesh.position);
	},
	
	boardCoordinates: function(x, y, z, w){
        
        // Get world coordinates from board coordinates
        // NOTE: Returns position in world space (relative to piecesContainer since pieces are added there)
        
        const zero = new THREE.Vector3((0.5 * this.squareSize) - (0.5 * this.squareSize * this.n), 0, (0.5 * this.squareSize * this.n) - (0.5 * this.squareSize))
        
        const xShift = x * this.squareSize
        const yShift = y * this.verticalIncrement + this.EPSILON
        const zShift = -(z * this.squareSize + w * this.horizontalIncrement)
        const translation = new THREE.Vector3(xShift, yShift, zShift)
        
        // Don't add container positions since pieces/boards are in separate containers at same origin
        return zero.add(translation)
        
    },
	
	worldCoordinates: function(pos){
        
        // Get board coordinates from world coordinates
        const zero = new THREE.Vector3((0.5 * this.squareSize) - (0.5 * this.squareSize * this.n), 0, (0.5 * this.squareSize * this.n) - (0.5 * this.squareSize))
        pos = pos.clone().sub(zero)  // Don't subtract container position
        
        let x = Math.floor(pos.x / this.squareSize)
        let y = Math.floor(pos.y / this.verticalIncrement)
        let numGaps = Math.floor(-pos.z / this.horizontalIncrement)
        let z = Math.floor((-pos.z - (numGaps * this.horizontalIncrement)) / this.squareSize)
        let w = numGaps
        
        return new THREE.Vector4(x, y, z, w)
    },
	
    showPossibleMoves: function(locations, piece, materialScheme={}, canRayCast=false){
		// Default material scheme: transparent green for moves, transparent pieces for captures
		materialScheme = Object.assign({
			0: {
				moveMaterial: {
					color: 0x90EE90, // Light green
					transparent: true,
					opacity: 0.5
				},
				attackMaterial: {
					color: 0xeeeefe, // White piece color, transparent
					transparent: true,
					opacity: 0.5
				}
			},
			1: {
				moveMaterial: {
					color: 0x90EE90, // Light green
					transparent: true,
					opacity: 0.5
				},
				attackMaterial: {
					color: 0x3b3f63, // Black piece color, transparent
					transparent: true,
					opacity: 0.5
				}
			},
		}, materialScheme)
		
        this.hidePossibleMoves();
		
        if (!locations || locations.length === 0) {
			return;
		}
		
		// Track pieces that will be captured (to highlight them in red)
		const capturedPieces = [];
		
        locations.forEach(pos => {
			const coordinates = this.boardCoordinates(pos.x, pos.y, pos.z, pos.w);
			let material;
			let shadowPiece;
			let pieceType;
			
			if(pos.possibleCapture){
				// Show transparent version of the piece being captured
				const attackedPiece = this.gameBoard.pieces[pos.x][pos.y][pos.z][pos.w];
				if (!attackedPiece || !attackedPiece.type) {
					return; // Skip if no piece to capture
				}
				
				// Highlight the actual piece that will be captured in red.
				// M7c: pieces now use shared materials, so we must NOT mutate
				// material.color in place (it would bleed across all pieces of
				// the same color). Instead clone the material, mutate the
				// clone, swap it in, and restore on hidePossibleMoves.
				if (attackedPiece.mesh && attackedPiece.mesh.material) {
					if (!attackedPiece.mesh.userData.__capturedHighlight) {
						const original = attackedPiece.mesh.material;
						const highlight = original.clone();
						highlight.color.setHex(0xff0000);
						attackedPiece.mesh.userData.__originalMaterial = original;
						attackedPiece.mesh.userData.__capturedHighlight = highlight;
						attackedPiece.mesh.material = highlight;
					}
					capturedPieces.push(attackedPiece.mesh);
				}
				
				material = materialScheme[piece.team].attackMaterial;
				pieceType = attackedPiece.type;
				shadowPiece = Models.createMesh(pieceType, material, coordinates.x, coordinates.y, coordinates.z, 1, canRayCast);
				
				// Apply rotation if needed (white pieces face opposite direction)
				if (attackedPiece.team === 0) {
					rotateObject(shadowPiece, 0, 180, 0);
				}
			} else {
				// Show transparent version of the moving piece
				material = materialScheme[piece.team].moveMaterial;
				pieceType = piece.type;
				shadowPiece = Models.createMesh(pieceType, material, coordinates.x, coordinates.y, coordinates.z, 1, canRayCast);
				
				// Apply rotation if needed
				if (piece.team === 0) {
					rotateObject(shadowPiece, 0, 180, 0);
				}
			}
			
			if (shadowPiece) {
				// Make preview pieces clickable for move execution
				shadowPiece.canRayCast = canRayCast;
				this.possibleMovesContainer.add(shadowPiece);
			}
        });
        
		// Store captured pieces list so we can restore them later
		this.capturedPiecesHighlighted = capturedPieces;
    },
    
    showPossibleMoves2: function(x, y, z, w, materialScheme){
      
        const locations = this.pieces[x][y][z][w].getPossibleMoves(this.pieces, x, y, z, w)
        
        this.showPossibleMoves(locations, piece, materialScheme, true)
        
    },
    
    hidePossibleMoves: function(){
        // Restore original (shared) materials on captured pieces. M7c uses
        // a per-mesh clone for the red highlight; swap it back and dispose.
        if (this.capturedPiecesHighlighted) {
            this.capturedPiecesHighlighted.forEach(mesh => {
                if (!mesh || !mesh.userData) return;
                if (mesh.userData.__originalMaterial) {
                    const cloned = mesh.userData.__capturedHighlight;
                    mesh.material = mesh.userData.__originalMaterial;
                    delete mesh.userData.__originalMaterial;
                    delete mesh.userData.__capturedHighlight;
                    if (cloned && typeof cloned.dispose === 'function') cloned.dispose();
                }
            });
            this.capturedPiecesHighlighted = [];
        }
        
        // Remove preview meshes
        while(this.possibleMovesContainer.children.length){
			const mesh = this.possibleMovesContainer.children[0];
			// Dispose of geometry and material to prevent memory leaks
			if (mesh.geometry) {
				// Don't dispose if it's a shared geometry
			}
			if (mesh.material) {
				mesh.material.dispose();
			}
            this.possibleMovesContainer.remove(mesh);
        }
    },
	
	moveMesh: function(piece, x1, y1, z1, w1){
		const currentMeshCoords = piece.mesh.position
        const newMeshCoords = this.boardCoordinates(x1, y1, z1, w1)
        
        const frames = 12
        const interpolatedCoords = Animation.linearInterpolate(currentMeshCoords, newMeshCoords, frames)
        Animation.addToQueue(animationQueue, piece.mesh, interpolatedCoords)
        piece.mesh.canRayCast = false // temporarily disable piece's ability to be found in rayCast
        
        animationQueue[animationQueue.length - 1].onAnimate = function(){
            piece.mesh.canRayCast = true // re-enable piece's ability to be found in rayCast
            
            // Deselect the piece after animation completes (remove blue highlight)
            if (typeof window !== 'undefined' && window.deselectPiece && window.selectionSystem) {
                // Check if this mesh was selected
                if (window.selectionSystem.selectedPiece === piece.mesh) {
                    window.deselectPiece();
                }
            }
            
            if(piece.type === 'pawn' && this.isOnPromotionSquare(x1, y1, z1, w1)){
				// Normal capture logic and animation is still executed,
				// but here we remove the pawn's sprite and spawn in a queen
				// Notice that we do not use GameObject.removePiece() method because
				// it will also remove its game object, which is logic that should 
				// be separate from graphics
				this.graphics.removeMesh(piece)
				this.graphics.addToPiecesContainer(piece.descendant.mesh); // Only add mesh to scene when animation is finished
//				this.graphics.piecesContainer.add(queen.mesh); 
            }
        }.bind(this.gameBoard)
	},
	
	createMesh: function(typeString, team, x, y, z, w, addToContainer=true){ 
		
		// Create mesh (without game object), add it to the scene, and return the mesh
		const worldPos = this.boardCoordinates(x, y, z, w)
		const material = team === 0 ? Models.materials.white : Models.materials.black
		
		
		const mesh = Models.createMesh(typeString, material, worldPos.x, worldPos.y, worldPos.z)
		
		if (!mesh) {
			console.error(`❌ Models.createMesh returned null for ${typeString}`);
			return null;
		}
		
		if(team === 0) rotateObject(mesh, 0, 180, 0)
		
		if(addToContainer){
			this.piecesContainer.add(mesh)
		}
		
		return mesh
		
	},
	
	setMesh: function(piece, x, y, z, w, addToContainer=true){
		const mesh = this.createMesh(piece.type, piece.team, x, y, z, w, addToContainer);
        if (mesh) {
            // Make piece selectable by default
            mesh.selectable = true;
            // Stamp a back-reference so raycaster hits and highlights can
            // resolve mesh->piece without a separate lookup table.
            mesh.userData.piece = piece;
            piece.setMesh(mesh);
            // M7d: when ?renderer=instanced, allocate a slot in the matching
            // InstancedMesh, hide the regular mesh (still used for transform
            // bookkeeping), and add the InstancedMesh objects to the
            // piecesContainer on first allocation.
            if (typeof window !== 'undefined' && window.__RENDERER__ === 'instanced') {
                Models.ensureInstancedMeshes(this.piecesContainer);
                const rotateY = (piece.team === 0) ? Math.PI : 0;
                const slot = Models.allocInstanceSlot(piece, mesh.position.x, mesh.position.y, mesh.position.z, rotateY);
                if (slot) {
                    piece.instanceSlot = slot;
                    mesh.visible = false;
                }
            }
        } else {
            console.error(`❌ Failed to create mesh for ${piece.type} at (${x},${y},${z},${w})`);
        }
	},

	removeMesh: function(piece){
		this.piecesContainer.remove(piece.mesh);
		// M7d: zero the instance matrix so the InstancedMesh draws nothing
		// at this slot. We deliberately leak the slot (don't reclaim) since
		// 1000-cap >> 896 pieces leaves plenty of headroom for promotions.
		if (typeof window !== 'undefined' && window.__RENDERER__ === 'instanced' && piece.instanceSlot) {
			const zero = new THREE.Matrix4().makeScale(0, 0, 0);
			piece.instanceSlot.im.setMatrixAt(piece.instanceSlot.id, zero);
			piece.instanceSlot.im.instanceMatrix.needsUpdate = true;
		}
	},

	respawnMesh: function(piece, x, y, z, w){
		if (piece.mesh) {
			this.piecesContainer.add(piece.mesh);
		} else {
			piece.mesh = this.createMesh(piece.type, piece.team, x, y, z, w, true);
		}
		// M7d: restore the instance matrix from the regular mesh's transform.
		if (typeof window !== 'undefined' && window.__RENDERER__ === 'instanced' && piece.instanceSlot) {
			Models.syncInstanceMatrix(piece);
		}
		
	},
	
	setSelectability: function(piece, canMove) {
		piece.mesh.selectable = canMove;
	},
	
	addToPiecesContainer: function(mesh) {
		this.piecesContainer.add(mesh); 
	},
	
	abandon: function() {
		scene.remove(this.mesh)
	}
	
}


function GameBoard(n=8, Graphics=BoardGraphics){
	
    this.n = n;
    
	this.graphics = new Graphics(this);
    this.pieces = this.initPieces();
    
    // Initialize starting positions for 4D chess (256 pieces)
    // Call this manually when ready: this.initializeStartingPositions();
	
	this.setSelectability = function(team, canMove){
		// Enable/Disable piece rayCasting (block user interaction)
		this.applyToTeam(function(piece){
			this.graphics.setSelectability(piece, canMove);
//			piece.mesh.selectable = canMove
		}.bind(this), team)
	};
}

function BoardGraphics(gameBoard) {
//	EmptyBoardGraphics.call(this, gameBoard);
	this.gameBoard = gameBoard;
	this.n = gameBoard.n;
	this.squareSize = 50
	this.boardSize = this.squareSize * this.n;
    this.verticalIncrement = 100 * 1.75
    this.horizontalGap = this.squareSize * 1.6
    this.horizontalIncrement = this.n * this.squareSize + this.horizontalGap
    this.globalLength = this.horizontalIncrement * (this.n - 1)
    this.globalHeight = this.verticalIncrement * this.n
	this.boardHeight = 5;
    this.EPSILON = 1  // Small offset to place pieces just above board surface
	
	this.mesh = new THREE.Object3D();
	this.boardContainer = new THREE.Object3D();
    this.piecesContainer = new THREE.Object3D();
    this.possibleMovesContainer = new THREE.Object3D();
	this.boardContainer.name = 'boardContainer';
	this.piecesContainer.name = 'piecesContaier';
	this.possibleMovesContainer.name = 'possibleMovesContainer';
	this.mesh.add(this.boardContainer)
	this.mesh.add(this.piecesContainer)
	this.mesh.add(this.possibleMovesContainer)
	scene.add(this.mesh);
	
	// Log container positions
	console.log('🎨 Container positions:', {
		mesh: this.mesh.position,
		boardContainer: this.boardContainer.position,
		piecesContainer: this.piecesContainer.position
	});
	
	let bottom = 0;
	let left = 0;
	
	// PERFORMANCE: Store board references for potential distance-based culling later
	if (!this.boardRefs) {
		this.boardRefs = [];
	}
	
	for (let w = 0; w < this.n; w++){
		for(let i = 0; i < this.n; i++){
			let checker = BoardGraphics.checkerboard3d(this.n, this.n * this.squareSize, z=i, w, opacity=0.8, this.boardHeight) // Construct 2D checkerboard planes
			checker.position.set(0, bottom + i*this.verticalIncrement, left - w*this.horizontalIncrement)
			rotateObject(checker, -90, 0, 0)
			this.boardContainer.add(checker)
			this.boardRefs.push(checker); // Store for potential culling optimizations
			
			// Log first board (y=0, w=0) square positions
			if (i === 0 && w === 0) {
				console.log('📐 First board (y=0, w=0) created at:', {
					boardPosition: checker.position,
					boardHeight: this.boardHeight,
					topSurface: checker.position.y + this.boardHeight/2
				});
			}
		}
	}
	
	// Note: 2D gizmo is now in the UI panel, not in 3D space
	
}

// Helper function to create a 4D coordinate axes gizmo (3DS Max style - top-right corner)
BoardGraphics.prototype.createAxesGizmo = function() {
	const gizmoSize = 120; // Length of axes
	const gizmoGroup = new THREE.Group();
	
	// X Axis (Red) - horizontal within each board (left-right on the 2D board)
	const xGeometry = new THREE.CylinderGeometry(2.5, 2.5, gizmoSize, 8);
	const xMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
	const xAxis = new THREE.Mesh(xGeometry, xMaterial);
	xAxis.rotation.z = Math.PI / 2;
	xAxis.position.set(gizmoSize / 2, 0, 0);
	gizmoGroup.add(xAxis);
	
	// Add X label with description
	const xLabel = this.createAxisLabel('X', 0xff0000);
	xLabel.position.set(gizmoSize + 20, 0, 0);
	gizmoGroup.add(xLabel);
	
	// Y Axis (Green) - height/layer dimension (vertical stacking)
	const yGeometry = new THREE.CylinderGeometry(2.5, 2.5, gizmoSize, 8);
	const yMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
	const yAxis = new THREE.Mesh(yGeometry, yMaterial);
	yAxis.position.set(0, gizmoSize / 2, 0);
	gizmoGroup.add(yAxis);
	
	// Add Y label with description
	const yLabel = this.createAxisLabel('Y', 0x00ff00);
	yLabel.position.set(0, gizmoSize + 20, 0);
	gizmoGroup.add(yLabel);
	
	// Z Axis (Blue) - depth within each board (forward-back on the 2D board)
	const zGeometry = new THREE.CylinderGeometry(2.5, 2.5, gizmoSize, 8);
	const zMaterial = new THREE.MeshBasicMaterial({ color: 0x0000ff });
	const zAxis = new THREE.Mesh(zGeometry, zMaterial);
	zAxis.rotation.x = Math.PI / 2;
	zAxis.position.set(0, 0, gizmoSize / 2);
	gizmoGroup.add(zAxis);
	
	// Add Z label with description
	const zLabel = this.createAxisLabel('Z', 0x0000ff);
	zLabel.position.set(0, 0, gizmoSize + 20);
	gizmoGroup.add(zLabel);
	
	// W Axis (Cyan) - 4th dimension (different parallel boards)
	// Show as a separate indicator since it can't be visualized in 3D
	const wSphereGeometry = new THREE.SphereGeometry(7, 16, 16);
	const wMaterial = new THREE.MeshBasicMaterial({ color: 0x00ffff, emissive: 0x00ffff, emissiveIntensity: 0.5 });
	const wIndicator = new THREE.Mesh(wSphereGeometry, wMaterial);
	wIndicator.position.set(gizmoSize * 0.3, gizmoSize * 0.3, gizmoSize * 0.3);
	gizmoGroup.add(wIndicator);
	
	// Connect W with line to show it's a 4th dimension
	const wLineGeometry = new THREE.BufferGeometry().setFromPoints([
		new THREE.Vector3(0, 0, 0),
		new THREE.Vector3(gizmoSize * 0.3, gizmoSize * 0.3, gizmoSize * 0.3)
	]);
	const wLineMaterial = new THREE.LineBasicMaterial({ color: 0x00ffff, linewidth: 2 });
	const wLine = new THREE.Line(wLineGeometry, wLineMaterial);
	gizmoGroup.add(wLine);
	
	// Add W label
	const wLabel = this.createAxisLabel('W', 0x00ffff);
	wLabel.position.set(gizmoSize * 0.45, gizmoSize * 0.45, gizmoSize * 0.45);
	gizmoGroup.add(wLabel);
	
	// Add gizmo to scene (will be positioned in animation loop)
	scene.add(gizmoGroup);
	this.axesGizmo = gizmoGroup;
	this.gizmoDistance = 200; // Distance from camera
	
	console.log('🎯 4D Axes Gizmo created (3DS Max style)');
}

// Update gizmo position to stay in top-right corner (3DS Max style)
BoardGraphics.prototype.updateGizmoPosition = function(camera) {
	if (!this.axesGizmo) return;
	
	// Calculate viewport corners in world space
	// We want top-right corner, which is: right on X, top on Y
	const aspect = window.innerWidth / window.innerHeight;
	const fov = camera.fov * (Math.PI / 180);
	const distance = this.gizmoDistance;
	
	// Calculate viewport dimensions at the gizmo distance
	const height = 2 * Math.tan(fov / 2) * distance;
	const width = height * aspect;
	
	// Position in camera-relative space (top-right corner)
	// In camera space: +X is right, +Y is up, -Z is forward
	const rightOffset = width * 0.35;  // 35% from center to right edge
	const topOffset = height * 0.35;    // 35% from center to top edge
	
	// Get camera's local axes in world space
	// Camera's local X axis (right) in world space
	const cameraRight = new THREE.Vector3(1, 0, 0);
	cameraRight.applyQuaternion(camera.quaternion);
	
	// Camera's local Y axis (up) in world space
	const cameraUp = new THREE.Vector3(0, 1, 0);
	cameraUp.applyQuaternion(camera.quaternion);
	
	// Camera's local -Z axis (forward) in world space
	const cameraForward = new THREE.Vector3(0, 0, -1);
	cameraForward.applyQuaternion(camera.quaternion);
	
	// Position gizmo in front of camera, offset to top-right
	const gizmoPosition = camera.position.clone();
	gizmoPosition.add(cameraForward.multiplyScalar(distance));
	gizmoPosition.add(cameraRight.multiplyScalar(rightOffset));
	gizmoPosition.add(cameraUp.multiplyScalar(topOffset));
	
	this.axesGizmo.position.copy(gizmoPosition);
	
	// Make gizmo rotate with camera (align with camera's orientation)
	this.axesGizmo.quaternion.copy(camera.quaternion);
}

// Helper to create axis label (simplified for corner gizmo)
BoardGraphics.prototype.createAxisLabel = function(text, color) {
	const canvas = document.createElement('canvas');
	const context = canvas.getContext('2d');
	canvas.width = 128;
	canvas.height = 64;
	
	context.fillStyle = 'rgba(0,0,0,0.85)';
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.font = 'bold 40px Arial';
	context.fillStyle = '#' + color.toString(16).padStart(6, '0');
	context.textAlign = 'center';
	context.textBaseline = 'middle';
	context.fillText(text, canvas.width / 2, canvas.height / 2);
	
	const texture = new THREE.CanvasTexture(canvas);
	texture.needsUpdate = true;
	const spriteMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true });
	const sprite = new THREE.Sprite(spriteMaterial);
	sprite.scale.set(40, 20, 1);
	return sprite;
}

// Helper to create legend label
BoardGraphics.prototype.createLegendLabel = function(text) {
	const lines = text.split('\n');
	const canvas = document.createElement('canvas');
	const context = canvas.getContext('2d');
	canvas.width = 300;
	canvas.height = lines.length * 40 + 20;
	
	context.fillStyle = 'rgba(0,0,0,0.9)';
	context.fillRect(0, 0, canvas.width, canvas.height);
	context.font = 'bold 32px Arial';
	context.fillStyle = '#ffffff';
	context.textAlign = 'left';
	context.textBaseline = 'top';
	
	lines.forEach((line, index) => {
		context.fillText(line, 10, 10 + index * 40);
	});
	
	const texture = new THREE.CanvasTexture(canvas);
	texture.needsUpdate = true;
	const spriteMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true });
	const sprite = new THREE.Sprite(spriteMaterial);
	sprite.scale.set(90, lines.length * 12 + 6, 1);
	return sprite;
}


BoardGraphics.checkerboard = function(segments=8, boardSize=100, z=0, w=0, opacity=0.5){
    
    const squareSize = boardSize / segments;
    let boardContainer = new THREE.Group();
    
    // Create individual squares in a checkerboard pattern
    for(let x = 0; x < segments; x++){
        for(let y = 0; y < segments; y++){
            // Determine color based on checkerboard pattern
            const isLight = (x + y + z + w) % 2 === 0;
            const color = isLight ? 0xccccfc : 0x444464;
            
            // Create a plane for this square
            const geometry = new THREE.PlaneGeometry(squareSize, squareSize);
            const material = new THREE.MeshBasicMaterial({
                color: color,
                transparent: true,
                opacity: opacity,
                side: THREE.DoubleSide
            });
            
            const square = new THREE.Mesh(geometry, material);
            
            // Position the square
            const offsetX = (x - segments/2 + 0.5) * squareSize;
            const offsetY = (y - segments/2 + 0.5) * squareSize;
            square.position.set(offsetX, offsetY, 0);
            
            boardContainer.add(square);
        }
    }
    
    return boardContainer;
}

BoardGraphics.checkerboard3d = function(segments=8, boardSize=100, z=0, w=0, opacity=0.5, boardHeight=5){
	
	const BOARD_HEIGHT = boardHeight;
	const squareSize = boardSize / segments;
	// VISUAL: Add small gap between squares to prevent overlapping intersections and flickering
	// This creates a subtle gap that eliminates z-fighting issues
	const GAP_SIZE = 0.5; // Small gap in world units (adjustable)
	const adjustedSquareSize = squareSize - (GAP_SIZE * 2); // Reduce square size to create gaps
	
	// PERFORMANCE: Merge all squares of the same color into single meshes
	// Reduces draw calls from 64 per board to 2 per board (massive performance gain, zero visual change)
	const lightColor = 0xccccfc;
	const darkColor = 0x444464;
	
	// PERFORMANCE: Cache materials to reuse across all boards (only 2 materials needed total)
	// This reduces WebGL state changes significantly
	if (!BoardGraphics._cachedMaterials) {
		BoardGraphics._cachedMaterials = {};
	}
	const materialKey = `${opacity}`;
	if (!BoardGraphics._cachedMaterials[materialKey]) {
		BoardGraphics._cachedMaterials[materialKey] = {
			light: new THREE.MeshBasicMaterial({
				color: lightColor,
				transparent: true,
				opacity: opacity,
				side: THREE.DoubleSide
			}),
			dark: new THREE.MeshBasicMaterial({
				color: darkColor,
				transparent: true,
				opacity: opacity,
				side: THREE.DoubleSide
			})
		};
	}
	const materials = BoardGraphics._cachedMaterials[materialKey];
	
	// PERFORMANCE: Cache base geometry per size to avoid recreating identical geometries
	// Only create new geometry if size doesn't match cached version
	if (!BoardGraphics._baseGeometries) {
		BoardGraphics._baseGeometries = {};
	}
	
	// Collect geometries for each color
	const lightGeometries = [];
	const darkGeometries = [];
	
	for(let x = 0; x < segments; x++){
		for(let y = 0; y < segments; y++){
			// Determine color based on checkerboard pattern
			const isLight = (x + y + z + w) % 2 === 0;
			
			// PERFORMANCE: Clone cached base geometry instead of creating new one
			// Cloning is much faster than creating a new BoxGeometry
			// VISUAL: Use adjusted square size to create gaps and prevent overlapping intersections
			const gapGeometryKey = `${adjustedSquareSize}_${BOARD_HEIGHT}`;
			if (!BoardGraphics._baseGeometries[gapGeometryKey]) {
				// Create geometry with gap-adjusted size if not cached
				BoardGraphics._baseGeometries[gapGeometryKey] = new THREE.BoxGeometry(adjustedSquareSize, adjustedSquareSize, BOARD_HEIGHT);
			}
			const geometry = BoardGraphics._baseGeometries[gapGeometryKey].clone();
			
			// Position the geometry with original spacing (gaps will be created by smaller size)
			const offsetX = (x - segments/2 + 0.5) * squareSize;
			const offsetY = (y - segments/2 + 0.5) * squareSize;
			geometry.translate(offsetX, offsetY, -BOARD_HEIGHT/2);
			
			// Add to appropriate collection
			if (isLight) {
				lightGeometries.push(geometry);
			} else {
				darkGeometries.push(geometry);
			}
		}
	}
	
	// Create a container for the merged meshes
	let boardContainer = new THREE.Group();
	
	// Merge and create meshes for each color
	if (lightGeometries.length > 0) {
		// Try to use BufferGeometryUtils if available, otherwise manually merge
		let mergedLightGeometry;
		if (typeof THREE.BufferGeometryUtils !== 'undefined' && THREE.BufferGeometryUtils.mergeGeometries) {
			mergedLightGeometry = THREE.BufferGeometryUtils.mergeGeometries(lightGeometries);
		} else {
			// Manual merge fallback - properly merge geometries
			mergedLightGeometry = new THREE.BufferGeometry();
			const positions = [];
			const normals = [];
			const uvs = [];
			const indices = [];
			let vertexOffset = 0;
			
			lightGeometries.forEach(geom => {
				const pos = geom.attributes.position;
				const norm = geom.attributes.normal;
				const uv = geom.attributes.uv;
				
				// Add vertices
				for (let i = 0; i < pos.count; i++) {
					positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
					if (norm) normals.push(norm.getX(i), norm.getY(i), norm.getZ(i));
					if (uv) uvs.push(uv.getX(i), uv.getY(i));
				}
				
				// Add indices with offset
				const geomIndices = geom.index;
				if (geomIndices) {
					const indexArray = geomIndices.array;
					for (let i = 0; i < geomIndices.count; i++) {
						indices.push(vertexOffset + indexArray[i]);
					}
				} else {
					// If no index, add sequential indices
					for (let i = 0; i < pos.count; i++) {
						indices.push(vertexOffset + i);
					}
				}
				vertexOffset += pos.count;
			});
			
			mergedLightGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
			if (normals.length > 0) mergedLightGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
			if (uvs.length > 0) mergedLightGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
			mergedLightGeometry.setIndex(indices);
		}
		
		// PERFORMANCE: Use cached material instead of creating new one
		const lightMesh = new THREE.Mesh(mergedLightGeometry, materials.light);
		boardContainer.add(lightMesh);
	}
	
	if (darkGeometries.length > 0) {
		let mergedDarkGeometry;
		if (typeof THREE.BufferGeometryUtils !== 'undefined' && THREE.BufferGeometryUtils.mergeGeometries) {
			mergedDarkGeometry = THREE.BufferGeometryUtils.mergeGeometries(darkGeometries);
		} else {
			// Manual merge fallback - properly merge geometries
			mergedDarkGeometry = new THREE.BufferGeometry();
			const positions = [];
			const normals = [];
			const uvs = [];
			const indices = [];
			let vertexOffset = 0;
			
			darkGeometries.forEach(geom => {
				const pos = geom.attributes.position;
				const norm = geom.attributes.normal;
				const uv = geom.attributes.uv;
				
				// Add vertices
				for (let i = 0; i < pos.count; i++) {
					positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
					if (norm) normals.push(norm.getX(i), norm.getY(i), norm.getZ(i));
					if (uv) uvs.push(uv.getX(i), uv.getY(i));
				}
				
				// Add indices with offset
				const geomIndices = geom.index;
				if (geomIndices) {
					const indexArray = geomIndices.array;
					for (let i = 0; i < geomIndices.count; i++) {
						indices.push(vertexOffset + indexArray[i]);
					}
				} else {
					// If no index, add sequential indices
					for (let i = 0; i < pos.count; i++) {
						indices.push(vertexOffset + i);
					}
				}
				vertexOffset += pos.count;
			});
			
			mergedDarkGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
			if (normals.length > 0) mergedDarkGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
			if (uvs.length > 0) mergedDarkGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
			mergedDarkGeometry.setIndex(indices);
		}
		
		// PERFORMANCE: Use cached material instead of creating new one
		const darkMesh = new THREE.Mesh(mergedDarkGeometry, materials.dark);
		boardContainer.add(darkMesh);
	}
	
	return boardContainer;
}

function EmptyBoardGraphics(gameBoard) {

}

