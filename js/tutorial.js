/* ============================================
   4D CHESS PIECE TUTORIAL SYSTEM
   ============================================ */

// Tutorial data for each piece
const tutorialData = {
    rook: {
        name: 'Rook',
        description: `
            <strong>Linear Movement:</strong> The Rook moves in straight lines along any of the 4 axes (X, Y, Z, W).
            <br><br>
            <strong>Directions:</strong> 8 total - forward/backward on each axis.
            <br><br>
            <strong>Range:</strong> Unlimited distance until blocked by another piece or board edge.
            <br><br>
            <strong>Captures:</strong> Can capture enemy pieces by moving onto their square.
        `,
        examples: [
            {
                title: 'X-Axis Movement',
                text: 'From (3,2,3,1) can move to any square on the same X=3 line: (3,0,3,1), (3,7,3,1), (3,2,3,1), etc.'
            },
            {
                title: 'W-Axis Movement (4D)',
                text: 'From (3,2,3,1) can move across parallel boards: (3,2,3,0), (3,2,3,2), (3,2,3,7)...'
            },
            {
                title: 'Combined Movement',
                text: 'Can move to (5,2,3,1) by moving 2 steps along X-axis, or to (3,2,3,4) by moving 3 steps along W-axis.'
            }
        ]
    },
    bishop: {
        name: 'Bishop',
        description: `
            <strong>Diagonal Movement:</strong> The Bishop moves diagonally within any 2D plane formed by 2 axes.
            <br><br>
            <strong>Planes:</strong> 6 possible 2D planes (XY, XZ, XW, YZ, YW, ZW).
            <br><br>
            <strong>Directions:</strong> 24 total - 4 diagonal directions per plane.
            <br><br>
            <strong>Example:</strong> In the XY plane, moves like (1,1), (-1,1), (1,-1), (-1,-1) while keeping Z and W constant.
        `,
        examples: [
            {
                title: 'XY Plane Diagonal',
                text: 'From (3,3,2,1): Can move to (4,4,2,1), (2,2,2,1), (4,2,2,1), (2,4,2,1)...'
            },
            {
                title: 'XW Plane (4D Diagonal)',
                text: 'From (3,2,3,3): Can move diagonally in X-W space: (4,2,3,4), (2,2,3,2)...'
            },
            {
                title: 'Multi-Plane Movement',
                text: 'Can switch between planes by moving in different diagonal combinations.'
            }
        ]
    },
    knight: {
        name: 'Knight',
        description: `
            <strong>L-Shape Movement:</strong> The Knight moves in an "L" shape: 2 steps on one axis, 1 step on another.
            <br><br>
            <strong>4D Extension:</strong> With 4 axes, picks 2 axes and moves 2+1 on them.
            <br><br>
            <strong>Total Moves:</strong> 48 possible knight moves (6 axis pairs × 2 ways × 4 direction combinations).
            <br><br>
            <strong>Special:</strong> Only piece that can "jump over" other pieces.
        `,
        examples: [
            {
                title: 'XY Plane L-Move',
                text: 'From (3,3,2,1): Can move to (5,4,2,1) [2X + 1Y], (1,4,2,1) [-2X + 1Y], (5,2,2,1) [2X - 1Y]...'
            },
            {
                title: 'XW Plane (4D L-Move)',
                text: 'From (3,2,3,1): Can move to (5,2,3,2) [2X + 1W], allowing movement across boards!'
            },
            {
                title: 'Cross-Plane Movement',
                text: 'Can combine movements: (2X, 1Z) moves both horizontally and in depth simultaneously.'
            }
        ]
    },
    queen: {
        name: 'Queen',
        description: `
            <strong>Combined Power:</strong> The Queen combines Rook + Bishop movements.
            <br><br>
            <strong>Linear:</strong> 8 directions (like Rook) - along any single axis.
            <br><br>
            <strong>Diagonal:</strong> 24 directions (like Bishop) - in any 2D plane.
            <br><br>
            <strong>Total:</strong> 32 movement directions, making it the most powerful piece.
            <br><br>
            <strong>Range:</strong> Unlimited distance in all directions until blocked.
        `,
        examples: [
            {
                title: 'Linear + Diagonal',
                text: 'From (3,3,3,1): Can move linearly to (7,3,3,1) or diagonally to (6,6,3,1) in XY plane.'
            },
            {
                title: '4D Movement',
                text: 'Can move along W-axis to (3,3,3,5), or diagonally across XW: (5,3,3,3).'
            },
            {
                title: 'Maximum Flexibility',
                text: 'Has access to all movement patterns of both Rook and Bishop simultaneously.'
            }
        ]
    },
    king: {
        name: 'King',
        description: `
            <strong>One Step Anywhere:</strong> The King can move exactly 1 step in ANY direction.
            <br><br>
            <strong>Directions:</strong> 80 possible adjacent positions (3^4 - 1 = 80 combinations).
            <br><br>
            <strong>Types:</strong> Linear (8), Diagonal in 2D (24), Diagonal in 3D (32), Diagonal in 4D (16).
            <br><br>
            <strong>Special:</strong> Cannot move into check. Most important piece - if captured, you lose.
        `,
        examples: [
            {
                title: 'Adjacent Squares',
                text: 'From (3,3,3,1): Can move to any of the 80 adjacent positions, like (4,3,3,1), (3,4,3,1), (4,4,3,1)...'
            },
            {
                title: '4D Adjacent',
                text: 'Can move to (3,3,3,2) or (3,3,3,0) - one step along W-axis (across boards).'
            },
            {
                title: 'Multi-Axis Movement',
                text: 'Can move to (4,4,4,2) - moving simultaneously on X, Y, Z, and W axes.'
            }
        ]
    },
    pawn: {
        name: 'Pawn',
        description: `
            <strong>Forward Movement:</strong> Pawns move forward on Z-axis (like regular chess) and Y-axis (4D extension).
            <br><br>
            <strong>Forward Moves:</strong> 1 square forward, or 2 squares on first move (on both Z and Y axes).
            <br><br>
            <strong>Captures:</strong> Diagonal captures in XZ, XY, and YZ planes - only when enemy piece is present.
            <br><br>
            <strong>Promotion:</strong> When reaching the end of any board, promotes to Queen.
        `,
        examples: [
            {
                title: 'Forward Movement',
                text: 'White pawn at (3,1,1,1) can move forward to (3,1,2,1) or double-move to (3,1,3,1).'
            },
            {
                title: '4D Forward (Y-axis)',
                text: 'Can also move "up" layers: (3,1,1,1) → (3,2,1,1) - moving to a higher board layer.'
            },
            {
                title: 'Diagonal Capture',
                text: 'From (3,2,2,1): Can capture diagonally at (4,2,3,1) or (4,3,2,1) if enemy piece is there.'
            }
        ]
    }
};

// Tutorial state
let tutorialState = {
    currentPiece: 0,
    pieces: ['rook', 'bishop', 'knight', 'queen', 'king', 'pawn'],
    scene: null,
    camera: null,
    renderer: null,
    controls: null,
    currentMesh: null
};

/* ============================================
   TUTORIAL INITIALIZATION
   ============================================ */

function initTutorial() {
    console.log('🎓 Initializing piece tutorial system...');
    const canvas = document.getElementById('tutorial-piece-canvas');
    if (!canvas) {
        console.error('❌ Tutorial canvas not found!');
        return;
    }
    
    console.log('✅ Tutorial canvas found, creating Three.js scene...');
    
    // Create mini Three.js scene for piece viewer
    tutorialState.scene = new THREE.Scene();
    tutorialState.scene.background = new THREE.Color(0x0a0e27);
    
    const aspect = 280 / 200; // Fixed aspect ratio for the viewer
    tutorialState.camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 1000);
    tutorialState.camera.position.set(0, 8, 20); // Further back to see pieces better
    tutorialState.camera.lookAt(0, 0, 0);
    
    tutorialState.renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: true,
        alpha: false
    });
    tutorialState.renderer.setSize(280, 200);
    console.log('✅ Tutorial renderer created');
    
    // Simple orbit controls for rotation. r184: addons aren't on THREE
    // namespace; OrbitControls is a global from the index.html module loader.
    if (typeof OrbitControls !== 'undefined') {
        tutorialState.controls = new OrbitControls(tutorialState.camera, canvas);
        tutorialState.controls.enableZoom = false;
        tutorialState.controls.enablePan = false;
        tutorialState.controls.minDistance = 10;
        tutorialState.controls.maxDistance = 30;
        tutorialState.controls.target.set(0, 0, 0);
        tutorialState.controls.enableDamping = true;
        tutorialState.controls.dampingFactor = 0.05;
    }
    
    // Add lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    tutorialState.scene.add(ambientLight);
    
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 10, 5);
    tutorialState.scene.add(directionalLight);
    
    // Setup navigation buttons
    const prevBtn = document.getElementById('tutorial-prev');
    const nextBtn = document.getElementById('tutorial-next');
    
    if (prevBtn && nextBtn) {
        prevBtn.addEventListener('click', () => {
            tutorialState.currentPiece = (tutorialState.currentPiece - 1 + 6) % 6;
            updatePieceTutorialDisplay();
        });
        
        nextBtn.addEventListener('click', () => {
            tutorialState.currentPiece = (tutorialState.currentPiece + 1) % 6;
            updatePieceTutorialDisplay();
        });
    } else {
        console.warn('⚠️ Tutorial navigation buttons not found');
    }
    
    // Initial display - ALWAYS call this even if buttons are missing
    console.log('📝 About to call updatePieceTutorialDisplay()...');
    console.log('📊 Current tutorial state:', {
        currentPiece: tutorialState.currentPiece,
        pieceType: tutorialState.pieces[tutorialState.currentPiece],
        sceneExists: !!tutorialState.scene
    });
    
    // Use setTimeout to ensure DOM is ready
    setTimeout(() => {
        console.log('⏰ Calling updatePieceTutorialDisplay() after delay...');
        updatePieceTutorialDisplay();
        console.log('✅ updatePieceTutorialDisplay() completed');
    }, 100);
    
    // Fallback: Try again after a longer delay in case DOM wasn't ready
    setTimeout(() => {
        const testEl = document.getElementById('tutorial-piece-name');
        if (testEl && !testEl.textContent.includes('Rook')) {
            console.log('🔄 DOM elements ready, retrying updatePieceTutorialDisplay()...');
            updatePieceTutorialDisplay();
        }
    }, 500);
    
    // Start animation loop
    console.log('🎬 Starting animation loop...');
    animateTutorial();
    
    console.log('✅ Tutorial system initialized');
}

function updatePieceTutorialDisplay() {
    console.log('🎯 updatePieceTutorialDisplay() CALLED');
    
    const pieceType = tutorialState.pieces[tutorialState.currentPiece];
    const data = tutorialData[pieceType];
    
    if (!data) {
        console.warn('⚠️ No tutorial data for piece:', pieceType);
        return;
    }
    
    console.log('📝 Updating tutorial display for:', pieceType);
    console.log('📊 Tutorial data available:', {
        hasName: !!data.name,
        name: data.name,
        hasDescription: !!data.description,
        descriptionLength: data.description ? data.description.length : 0,
        hasExamples: !!data.examples,
        examplesCount: data.examples ? data.examples.length : 0
    });
    
    // Always update text content, even if 3D scene isn't ready
    
    // Update page number
    const pageNumberEl = document.getElementById('tutorial-page-number');
    if (pageNumberEl) {
        pageNumberEl.textContent = tutorialState.currentPiece + 1;
    } else {
        console.warn('⚠️ Tutorial page number element not found');
    }
    
    // Update piece name
    const pieceNameEl = document.getElementById('tutorial-piece-name');
    if (pieceNameEl) {
        pieceNameEl.textContent = data.name;
        console.log('✅ Updated piece name to:', data.name);
    } else {
        console.warn('⚠️ Tutorial piece name element not found');
    }
    
    // Update description - CRITICAL: Must find and update this element
    const descriptionEl = document.getElementById('tutorial-description');
    
    if (descriptionEl) {
        // Clear any existing content first
        descriptionEl.innerHTML = '';
        
        // Set content directly - use innerHTML to preserve HTML formatting
        descriptionEl.innerHTML = data.description || 'No description available';
        
        // Force visibility with inline styles (overrides CSS) - use explicit colors
        descriptionEl.style.display = 'block';
        descriptionEl.style.visibility = 'visible';
        descriptionEl.style.opacity = '1';
        descriptionEl.style.minHeight = '50px';
        descriptionEl.style.padding = '8px';
        descriptionEl.style.background = '#1e2746'; // Explicit background color
        descriptionEl.style.color = '#b4b4d4'; // Explicit text color
        descriptionEl.style.fontSize = '12px';
        descriptionEl.style.lineHeight = '1.6';
        descriptionEl.style.borderRadius = '8px';
        descriptionEl.style.marginBottom = '16px';
    } else {
        // Element not found - this is a critical error
        console.error('❌ CRITICAL: tutorial-description element NOT FOUND!');
    }
    
    // Update examples - CRITICAL: Must find and update this element
    const examplesContainer = document.getElementById('tutorial-examples');
    
    if (examplesContainer) {
        // Clear existing content
        examplesContainer.innerHTML = '';
        
        // Force visibility with explicit styles
        examplesContainer.style.display = 'block';
        examplesContainer.style.visibility = 'visible';
        examplesContainer.style.opacity = '1';
        examplesContainer.style.minHeight = '30px';
        examplesContainer.style.color = '#7878a3'; // Explicit text color
        examplesContainer.style.fontSize = '11px';
        
        if (data.examples && data.examples.length > 0) {
            data.examples.forEach((example) => {
                const exampleDiv = document.createElement('div');
                exampleDiv.style.marginBottom = '8px';
                exampleDiv.style.padding = '8px';
                exampleDiv.style.background = '#1e2746';
                exampleDiv.style.borderLeft = '3px solid #00d4ff';
                exampleDiv.style.borderRadius = '4px';
                exampleDiv.innerHTML = `
                    <div style="font-weight: bold; color: #00d4ff; margin-bottom: 4px;">${example.title}</div>
                    <div style="color: #b4b4d4; line-height: 1.5;">${example.text}</div>
                `;
                examplesContainer.appendChild(exampleDiv);
            });
        } else {
            // Fallback if no examples
            examplesContainer.innerHTML = '<div style="padding: 8px; background: #1e2746; color: #b4b4d4;">No examples available</div>';
        }
    } else {
        // Element not found - critical error
        console.error('❌ CRITICAL: tutorial-examples element NOT FOUND!');
    }
    
    // Load and display 3D model (only if scene is ready)
    if (tutorialState.scene) {
        loadTutorialPiece(pieceType);
    } else {
        console.warn('⚠️ Tutorial scene not ready, skipping 3D model load');
    }
}

function loadTutorialPiece(pieceType) {
    if (!tutorialState.scene) {
        console.warn('⚠️ Tutorial scene not initialized');
        return;
    }
    
    // Remove previous mesh
    if (tutorialState.currentMesh) {
        tutorialState.scene.remove(tutorialState.currentMesh);
        tutorialState.currentMesh = null;
    }
    
    // Get geometry from Models
    if (!Models || !Models.geometries || !Models.geometries[pieceType]) {
        console.warn(`⚠️ Tutorial: Geometry not loaded for ${pieceType}. Models available:`, Models ? Object.keys(Models.geometries || {}) : 'Models not defined');
        // Don't return - we can still show the text even without the 3D model
        return;
    }
    
    console.log(`✅ Loading 3D model for ${pieceType}`);
    
    const geometry = Models.geometries[pieceType];
    const material = new THREE.MeshPhongMaterial({
        color: 0xeeeeee,
        specular: 0x8888aa,
        shininess: 30
    });
    
    // Create mesh
    const mesh = new THREE.Mesh(geometry, material);
    
    // Apply scale - much smaller for tutorial viewer
    // Use a fraction of the game scale factor
    const tutorialScale = Models.SCALE_FACTOR * 0.15; // 15% of game scale
    mesh.scale.set(tutorialScale, tutorialScale, tutorialScale);
    
    // Center the mesh
    const box = new THREE.Box3().setFromObject(mesh);
    const center = box.getCenter(new THREE.Vector3());
    mesh.position.sub(center);
    
    // Adjust height to sit on ground (slightly above)
    const size = box.getSize(new THREE.Vector3());
    mesh.position.y = -size.y / 2 + 1; // Slightly above ground for better visibility
    
    // Handle special pieces
    if (pieceType === 'pawn' || pieceType === 'bishop' || pieceType === 'queen') {
        mesh.material.side = THREE.DoubleSide;
    }
    
    tutorialState.scene.add(mesh);
    tutorialState.currentMesh = mesh;
    
    // Reset camera position
    if (tutorialState.controls) {
        tutorialState.controls.reset();
    }
}

function animateTutorial() {
    requestAnimationFrame(animateTutorial);
    
    if (tutorialState.controls) {
        tutorialState.controls.update();
    }
    
    if (tutorialState.renderer && tutorialState.scene && tutorialState.camera) {
        tutorialState.renderer.render(tutorialState.scene, tutorialState.camera);
    }
}

// Initialize when Models are loaded
if (typeof window !== 'undefined') {
    // Wait for Models to be available
    window.initTutorial = initTutorial;
}

