
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
    
    // M7c: shared materials for the long-lived board pieces. The 896 pieces
    // each used to allocate their own MeshStandardMaterial (~896 GPU state
    // changes per frame); now they share four cached instances keyed on
    // (team, side). Transient preview/overlay meshes (red, green, darkGreen
    // configs from showPossibleMoves) keep per-instance materials so the
    // M5 spectral overlay can mutate opacity per dest mesh without
    // bleeding into other pieces.
    _sharedMaterialCache: null,

    _getSharedMaterial: function (materialConfig, isDoubleSide) {
        // Lazy-init the cache on first call (after Models.materials is set up).
        if (!Models._sharedMaterialCache) {
            const enhance = function (cfg) {
                return Object.assign({}, cfg, {
                    roughness: 0.4,
                    metalness: 0.1,
                    envMapIntensity: 0.3,
                });
            };
            const make = function (cfg, ds) {
                const m = new THREE.MeshStandardMaterial(enhance(cfg));
                if (ds) m.side = THREE.DoubleSide;
                return m;
            };
            Models._sharedMaterialCache = {
                black_front:  make(Models.materials.black, false),
                black_double: make(Models.materials.black, true),
                white_front:  make(Models.materials.white, false),
                white_double: make(Models.materials.white, true),
            };
        }
        // Identity-match against canonical configs.
        if (materialConfig === Models.materials.black) {
            return isDoubleSide
                ? Models._sharedMaterialCache.black_double
                : Models._sharedMaterialCache.black_front;
        }
        if (materialConfig === Models.materials.white) {
            return isDoubleSide
                ? Models._sharedMaterialCache.white_double
                : Models._sharedMaterialCache.white_front;
        }
        return null; // signal: caller should allocate a per-instance material
    },

    // M7d: per-(type, team) InstancedMesh. Lazy-built on first piece spawn;
    // legacy renderer path leaves this untouched. With ?renderer=instanced
    // the 896 long-lived pieces are drawn from these 12 InstancedMesh
    // objects (instead of 896 individual Mesh children of piecesContainer),
    // collapsing draw calls from ~896 to 12 per frame.
    _instancedMeshes: null,
    _instanceLookup: null, // Map<typeKey-id, Piece> — reverse map for raycast hits

    ensureInstancedMeshes: function (parentObject3D) {
        if (Models._instancedMeshes) return Models._instancedMeshes;
        const out = {};
        const lookup = new Map();
        const MAX_INSTANCES = 1000; // 896 pieces + headroom for promotions
        const isDoubleSide = (n) => n === 'pawn' || n === 'bishop' || n === 'queen';

        for (const pdata of Models.pieceData) {
            const geom = Models.geometries[pdata.name];
            if (!geom) continue;
            for (const team of [0, 1]) {
                const teamCfg = team === 0 ? Models.materials.white : Models.materials.black;
                const sharedMat = Models._getSharedMaterial(teamCfg, isDoubleSide(pdata.name));
                if (!sharedMat) continue;
                const im = new THREE.InstancedMesh(geom, sharedMat, MAX_INSTANCES);
                im.count = 0; // start empty; spawnPiece will increment
                im.frustumCulled = false; // pieces span 64 slices; no useful single bbox
                im.castShadow = false;
                im.receiveShadow = false;
                im.userData.typeKey = pdata.name;
                im.userData.team = team;
                // Per-instance color attribute for hover/select highlight (M7d).
                // Default color is white (1,1,1) which multiplies the shared
                // material color by identity (no tint).
                const colors = new Float32Array(MAX_INSTANCES * 3);
                for (let i = 0; i < colors.length; i++) colors[i] = 1.0;
                im.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
                im.instanceColor.setUsage(THREE.DynamicDrawUsage);
                if (parentObject3D) parentObject3D.add(im);
                out[`${pdata.name}-${team}`] = im;
            }
        }
        Models._instancedMeshes = out;
        Models._instanceLookup = lookup;
        return out;
    },

    // M7d: allocate a slot in the appropriate InstancedMesh for `piece`,
    // write its initial transform, register the reverse-lookup. Returns
    // {im, id} or null if allocation failed.
    allocInstanceSlot: function (piece, x, y, z, rotateY) {
        if (!Models._instancedMeshes) return null;
        const typeKey = `${piece.type}-${piece.team}`;
        const im = Models._instancedMeshes[typeKey];
        if (!im) return null;
        if (im.count >= im.instanceMatrix.count) {
            console.warn('[m7d] InstancedMesh full for', typeKey);
            return null;
        }
        const id = im.count++;
        const matrix = new THREE.Matrix4();
        const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rotateY || 0, 0));
        const scl = new THREE.Vector3(Models.SCALE_FACTOR, Models.SCALE_FACTOR, Models.SCALE_FACTOR);
        matrix.compose(new THREE.Vector3(x, y, z), rot, scl);
        im.setMatrixAt(id, matrix);
        im.instanceMatrix.needsUpdate = true;
        Models._instanceLookup.set(`${typeKey}-${id}`, piece);
        return { im, id, typeKey };
    },

    // M7d: write the piece's current mesh.matrixWorld into its instance slot.
    // Called from animate() each dirty frame to sync animations / moves /
    // capture-hide into the InstancedMesh transforms.
    syncInstanceMatrix: function (piece) {
        if (!piece || !piece.instanceSlot || !piece.mesh) return;
        piece.mesh.updateMatrixWorld();
        piece.instanceSlot.im.setMatrixAt(piece.instanceSlot.id, piece.mesh.matrixWorld);
        piece.instanceSlot.im.instanceMatrix.needsUpdate = true;
    },

    // M7d: highlight tint via per-instance color. Setting (1,1,1) restores
    // the shared material's base color; any other RGB tints multiplicatively.
    setInstanceColor: function (piece, r, g, b) {
        if (!piece || !piece.instanceSlot) return;
        const im = piece.instanceSlot.im;
        if (!im.instanceColor) return;
        im.instanceColor.setXYZ(piece.instanceSlot.id, r, g, b);
        im.instanceColor.needsUpdate = true;
    },

    createMesh: function(piece, material, x=0, y=0, z=0, scale=1, canRayCast=true){

        const pieceData = Models.pieceData[Models.pieceIndices[piece]]
        const geometry = Models.geometries[piece]

        if (!geometry) {
            console.error(`❌ No geometry found for piece: ${piece}`);
            return null;
        }

        const isDoubleSide = (piece === 'pawn' || piece === 'bishop' || piece === 'queen');
        let meshMaterial = Models._getSharedMaterial(material, isDoubleSide);
        if (!meshMaterial) {
            // Per-instance path for previews / custom configs (transparent overlays,
            // spectral channels that need per-mesh opacity, etc.). Cheap because
            // these meshes are short-lived (created and disposed per hover).
            const enhancedMaterial = Object.assign({}, material, {
                roughness: 0.4,
                metalness: 0.1,
                envMapIntensity: 0.3
            });
            meshMaterial = new THREE.MeshStandardMaterial(enhancedMaterial);
            if (isDoubleSide) {
                meshMaterial.side = THREE.DoubleSide;
            }
        }

        // REUSE geometry instead of cloning - saves massive amounts of memory!
        // Only compute normals once if not already done.
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

        // Per-piece DoubleSide is now set on the shared material at cache
        // creation time (and on the per-instance material above), so we
        // don't mutate mesh.material.side here — that would bleed across
        // shared-material users.

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