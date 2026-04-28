
const Models = {
    
    SCALE_FACTOR: 1000,  // Scale pieces to 50% of previous size
    
    materials: {
        black: {
            // Bluish-purple dark gray to match board's dark squares (e.g. 0x444464)
            color: 0x3b3f63,
            specular: 0x222237,
            shininess: 25,
            flatShading: false,
            transparent: false,
            opacity: 1.0,
            // VISUAL: Subtle emissive glow for depth
            emissive: 0x1a1f35,
            emissiveIntensity: 0.15
        },
    
        white: {
            // Darker purple-lilac to match the scene's purple theme better
            color: 0xb8b0cc,  // Darker purple-tinted (more purple, less white)
            specular: 0x8888aa,
            shininess: 30,
            flatShading: false,
            transparent: false,
            opacity: 1.0,
            // VISUAL: Very subtle purple emissive (much reduced intensity)
            emissive: 0x706d85,  // Darker purple glow
            emissiveIntensity: 0.05  // Much lower - almost no glow

        },
    
        red: {
            color: 0xFF0000,
            specular: 0x444444,
            shininess: 25,
            flatShading: false,
            transparent: true,
            opacity: 0.6
        },
        
        green: {
            color: 0x90EE90,
            specular: 0x444444,
            shininess: 25,
            flatShading: false,
            transparent: true,
            opacity: 0.6
        },
        
        darkGreen: {
            color: 0x006400,
            specular: 0x222222,
            shininess: 25,
            flatShading: false,
            transparent: true,
            opacity: 0.6,
        },
		
		lightGreen: {
            color: 0x42f5aa,
            specular: 0x444444,
            shininess: 25,
            flatShading: false,
            transparent: true,
            opacity: 0.6,
        },
        
        orange: {
            color: 0xFFA500,
            specular: 0x444444,
            shininess: 25,
            flatShading: false,
            transparent: true,
            opacity: 0.4
        },
        
        blue: {
            color: 0x00B9FF,
            specular: 0x444444,
            shininess: 25,
            flatShading: false,
            transparent: true,
            opacity: 0.4
        },
        
//        black: new THREE.MeshPhongMaterial({
//            color: 0x110C11,
//            reflectivity: 0.1,
//            shininess: 20,
//            shading: THREE.SmoothShading,
//            transparent: true,
//            opacity: 1.0
//        }),
//    
//        white: new THREE.MeshPhongMaterial({
//            color: 0xFCF6E3,
//            reflectivity: 10,
//            shininess: 25,
//            shading: THREE.SmoothShading,
//            transparent: true,
//            opacity: 1.0
//
//        }),
//    
//        red: new THREE.MeshPhongMaterial({
//            color: 0xFF0000,
//            reflectivity: 10,
//            shininess: 25,
//            shading: THREE.SmoothShading,
//            transparent: true,
//            opacity: 0.4,
////            alphaTest: 0.5
//        })
        
    },
    
    // M7a: Asset quality is selectable via the ?quality= URL flag.
    // Defaults to "low" (decimated to ~20% triangles via tools/decimate_obj.py)
    // because the original ~1M-triangle models crashed Chrome and the host
    // OS on test hardware. To use the originals: append ?quality=high.
    // The two directories are siblings under js/pieces/; both contain the
    // same filenames (Pawn.obj, Rook.obj, ...). See docs/low-poly-assets.md.
    directory: (function () {
        var q = 'low';
        try {
            var p = new URLSearchParams(window.location.search).get('quality');
            if (p === 'high' || p === 'low') q = p;
        } catch (_) { /* no window — leave default */ }
        return q === 'high'
            ? 'js/pieces/obj_pieces/'
            : 'js/pieces/obj_pieces_lowpoly/';
    })(),
    
    pieceData: [
        {
            name: 'pawn',
            fileName: 'Pawn.obj',
            rotation: new THREE.Vector3(0, 0, 0)
        }, {
            name: 'rook',
            fileName: 'Rook.obj',
            rotation: new THREE.Vector3(0, 0, 0)
        }, {
            name: 'bishop',
            fileName: 'Bishop.obj',
            rotation: new THREE.Vector3(0, 0, 0)
        }, {
            name: 'knight',
            fileName: 'Knight V1.obj',
            rotation: new THREE.Vector3(0, 0, 0)
        }, {
            name: 'queen',
            fileName: 'Queen.obj',
            rotation: new THREE.Vector3(0, 0, 0)
        }, {
            name: 'king',
            fileName: 'King.obj',
            rotation: new THREE.Vector3(0, 0, 0)
        }
    ],
    
    createMesh: function(piece, material, x=0, y=0, z=0, scale=1, canRayCast=true){
        
        const pieceData = Models.pieceData[Models.pieceIndices[piece]]
        const geometry = Models.geometries[piece]
        
        if (!geometry) {
            console.error(`❌ No geometry found for piece: ${piece}`);
            return null;
        }
        
        // VISUAL: Use MeshStandardMaterial for better quality (PBR rendering)
        // StandardMaterial is slightly more expensive than Lambert but provides much better visuals
        // It's still very performant and looks professional with proper roughness/metalness
        const enhancedMaterial = Object.assign({}, material, {
            roughness: 0.4,  // Slightly glossy (0 = mirror, 1 = matte)
            metalness: 0.1,  // Slightly metallic for depth
            envMapIntensity: 0.3  // Subtle environment reflections if envMap is added
        });
        const meshMaterial = new THREE.MeshStandardMaterial(enhancedMaterial);
        
        // REUSE geometry instead of cloning - saves massive amounts of memory!
        // Three.js can efficiently render the same geometry multiple times with different transforms
        // Only compute normals once if not already done
        if (!geometry.attributes.normal || geometry.attributes.normal.count === 0) {
            geometry.computeVertexNormals();
        }
        
        let mesh = new THREE.Mesh(geometry, meshMaterial);
        
        mesh.position.set(0, 0, 0);
        mesh.rotation.set(pieceData.rotation.x, pieceData.rotation.y, pieceData.rotation.z);
        // Shadows disabled for performance
        mesh.castShadow = false;
        mesh.receiveShadow = false;

		mesh.scale.set(Models.SCALE_FACTOR, Models.SCALE_FACTOR, Models.SCALE_FACTOR)
		const height = new THREE.Box3().setFromObject(mesh).max.y;
		
		mesh.scale.multiplyScalar(scale)
        mesh.position.set(x, y, z)

        // Per-piece fixes for inverted surfaces
        if (piece === 'pawn' || piece === 'bishop' || piece === 'queen') {
            mesh.material.side = THREE.DoubleSide;
        }
        
        mesh.canRayCast = canRayCast;
        
        return mesh;
    },
    
    geometries: {},
    loadedObjects: {},
    pieceIndices: {},
    
    loadModels: function(){
		return new Promise(function(resolve, reject) {
			// Loads all chess models (.obj files) then calls init when finished
			const manager = new THREE.LoadingManager();
			manager.onLoad = function() {
                console.log('✅ All models loaded successfully!');
                console.log('📦 Loaded geometries:', Object.keys(Models.geometries));
                
                // Verify each geometry
                for (let pieceName in Models.geometries) {
                    const geom = Models.geometries[pieceName];
                    const vertexCount = geom.attributes && geom.attributes.position ? geom.attributes.position.count : 0;
                    console.log(`  ✓ ${pieceName}: ${vertexCount} vertices`);
                }
                
                resolve();
            };
            manager.onError = function(url) {
                console.error('❌ Error loading:', url);
                reject(url);
            };
            
			// r184: addons aren't attached to THREE namespace; OBJLoader is a
			// global exposed by the index.html module loader.
			const loader = new OBJLoader(manager);

			let index = 0;
			Models.pieceData.forEach(piece => {
				const path = Models.directory + piece.fileName;
                
                console.log(`📂 Loading: ${path}`);
                
				loader.load(
                    path,
                    function(object) {
                        // Successfully loaded OBJ
                        Models.loadedObjects[piece.name] = object;
                        
                        // Extract geometry from first mesh in the object
                        let foundGeometry = false;
                        object.traverse(function(child) {
                            if (child instanceof THREE.Mesh) {
                                if (!Models.geometries[piece.name]) {
                                    Models.geometries[piece.name] = child.geometry;
                                    foundGeometry = true;
                                    console.log(`  ✓ Extracted geometry from ${piece.name}`);
                                }
                            }
                        });
                        
                        if (!foundGeometry) {
                            console.warn(`⚠️ No geometry found in ${piece.name} object`);
                        }
                        
                        console.log(`✅ Loaded: ${piece.name}`);
                    },
                    function(xhr) {
                        // Progress (optional)
                    },
                    function(error) {
                        // Error
                        console.error(`❌ Error loading ${piece.name}:`, error);
                    }
                );

				Models.pieceIndices[piece.name] = index++;
			});
		});
    }
    
}