// spectral_isosurfaces.js — M11.3.1 nested marching-cubes shells.
//
// User reference image (Mathematica-style ListContourPlot3D[Mesh→All]):
// translucent rainbow nested shells at 2-3 percentile thresholds, with
// the data structure visible AS the shape of each shell. We implement
// per-w-slice marching cubes (8 slabs × 3 percentile thresholds = 24
// meshes) so the user sees the iso-shape at each "page" of the 4D
// volume.
//
// Why not three.js's THREE.MarchingCubes? That addon is built for
// metaball animation — its API centers on `addBall` / `addPlane`
// procedural sources and computes the field implicitly. We want to
// SUPPLY field values directly from the chess-spectral encoding. A
// minimal hand-rolled marching cubes (~150 LOC) is cleaner than
// fighting the addon's metaball assumptions, and gives us per-vertex
// color from the field value (the rainbow translucent look in the
// reference image).
//
// API:
//   SpectralIsosurfaces.init(scene, gameBoard)
//   SpectralIsosurfaces.setEnabled(bool)
//   SpectralIsosurfaces.setChannel(name)
//   SpectralIsosurfaces.setStackScale(s)   // M11.3.5 stack-height hook
//   SpectralIsosurfaces.refresh()           // called after each applyMove
//   SpectralIsosurfaces.getEnabled()
//   SpectralIsosurfaces.getChannel()

(function () {
  'use strict';

  // ---------- Marching Cubes lookup tables (standard, public domain) ---------
  // 256 cases, each entry is the bit-pattern of edges to triangulate.
  const EDGE_TABLE = new Int16Array([
    0x000, 0x109, 0x203, 0x30a, 0x406, 0x50f, 0x605, 0x70c,
    0x80c, 0x905, 0xa0f, 0xb06, 0xc0a, 0xd03, 0xe09, 0xf00,
    0x190, 0x099, 0x393, 0x29a, 0x596, 0x49f, 0x795, 0x69c,
    0x99c, 0x895, 0xb9f, 0xa96, 0xd9a, 0xc93, 0xf99, 0xe90,
    0x230, 0x339, 0x033, 0x13a, 0x636, 0x73f, 0x435, 0x53c,
    0xa3c, 0xb35, 0x83f, 0x936, 0xe3a, 0xf33, 0xc39, 0xd30,
    0x3a0, 0x2a9, 0x1a3, 0x0aa, 0x7a6, 0x6af, 0x5a5, 0x4ac,
    0xbac, 0xaa5, 0x9af, 0x8a6, 0xfaa, 0xea3, 0xda9, 0xca0,
    0x460, 0x569, 0x663, 0x76a, 0x066, 0x16f, 0x265, 0x36c,
    0xc6c, 0xd65, 0xe6f, 0xf66, 0x86a, 0x963, 0xa69, 0xb60,
    0x5f0, 0x4f9, 0x7f3, 0x6fa, 0x1f6, 0x0ff, 0x3f5, 0x2fc,
    0xdfc, 0xcf5, 0xfff, 0xef6, 0x9fa, 0x8f3, 0xbf9, 0xaf0,
    0x650, 0x759, 0x453, 0x55a, 0x256, 0x35f, 0x055, 0x15c,
    0xe5c, 0xf55, 0xc5f, 0xd56, 0xa5a, 0xb53, 0x859, 0x950,
    0x7c0, 0x6c9, 0x5c3, 0x4ca, 0x3c6, 0x2cf, 0x1c5, 0x0cc,
    0xfcc, 0xec5, 0xdcf, 0xcc6, 0xbca, 0xac3, 0x9c9, 0x8c0,
    0x8c0, 0x9c9, 0xac3, 0xbca, 0xcc6, 0xdcf, 0xec5, 0xfcc,
    0x0cc, 0x1c5, 0x2cf, 0x3c6, 0x4ca, 0x5c3, 0x6c9, 0x7c0,
    0x950, 0x859, 0xb53, 0xa5a, 0xd56, 0xc5f, 0xf55, 0xe5c,
    0x15c, 0x055, 0x35f, 0x256, 0x55a, 0x453, 0x759, 0x650,
    0xaf0, 0xbf9, 0x8f3, 0x9fa, 0xef6, 0xfff, 0xcf5, 0xdfc,
    0x2fc, 0x3f5, 0x0ff, 0x1f6, 0x6fa, 0x7f3, 0x4f9, 0x5f0,
    0xb60, 0xa69, 0x963, 0x86a, 0xf66, 0xe6f, 0xd65, 0xc6c,
    0x36c, 0x265, 0x16f, 0x066, 0x76a, 0x663, 0x569, 0x460,
    0xca0, 0xda9, 0xea3, 0xfaa, 0x8a6, 0x9af, 0xaa5, 0xbac,
    0x4ac, 0x5a5, 0x6af, 0x7a6, 0x0aa, 0x1a3, 0x2a9, 0x3a0,
    0xd30, 0xc39, 0xf33, 0xe3a, 0x936, 0x83f, 0xb35, 0xa3c,
    0x53c, 0x435, 0x73f, 0x636, 0x13a, 0x033, 0x339, 0x230,
    0xe90, 0xf99, 0xc93, 0xd9a, 0xa96, 0xb9f, 0x895, 0x99c,
    0x69c, 0x795, 0x49f, 0x596, 0x29a, 0x393, 0x099, 0x190,
    0xf00, 0xe09, 0xd03, 0xc0a, 0xb06, 0xa0f, 0x905, 0x80c,
    0x70c, 0x605, 0x50f, 0x406, 0x30a, 0x203, 0x109, 0x000,
  ]);

  // Triangle table: 256 × 16 entries. -1 = end of list. Up to 5 triangles
  // per cube case. Standard public-domain table from Paul Bourke.
  const TRI_TABLE = [
    [-1],[0,8,3,-1],[0,1,9,-1],[1,8,3,9,8,1,-1],[1,2,10,-1],
    [0,8,3,1,2,10,-1],[9,2,10,0,2,9,-1],[2,8,3,2,10,8,10,9,8,-1],
    [3,11,2,-1],[0,11,2,8,11,0,-1],[1,9,0,2,3,11,-1],[1,11,2,1,9,11,9,8,11,-1],
    [3,10,1,11,10,3,-1],[0,10,1,0,8,10,8,11,10,-1],[3,9,0,3,11,9,11,10,9,-1],
    [9,8,10,10,8,11,-1],[4,7,8,-1],[4,3,0,7,3,4,-1],[0,1,9,8,4,7,-1],
    [4,1,9,4,7,1,7,3,1,-1],[1,2,10,8,4,7,-1],[3,4,7,3,0,4,1,2,10,-1],
    [9,2,10,9,0,2,8,4,7,-1],[2,10,9,2,9,7,2,7,3,7,9,4,-1],
    [8,4,7,3,11,2,-1],[11,4,7,11,2,4,2,0,4,-1],[9,0,1,8,4,7,2,3,11,-1],
    [4,7,11,9,4,11,9,11,2,9,2,1,-1],[3,10,1,3,11,10,7,8,4,-1],
    [1,11,10,1,4,11,1,0,4,7,11,4,-1],[4,7,8,9,0,11,9,11,10,11,0,3,-1],
    [4,7,11,4,11,9,9,11,10,-1],[9,5,4,-1],[9,5,4,0,8,3,-1],[0,5,4,1,5,0,-1],
    [8,5,4,8,3,5,3,1,5,-1],[1,2,10,9,5,4,-1],[3,0,8,1,2,10,4,9,5,-1],
    [5,2,10,5,4,2,4,0,2,-1],[2,10,5,3,2,5,3,5,4,3,4,8,-1],
    [9,5,4,2,3,11,-1],[0,11,2,0,8,11,4,9,5,-1],[0,5,4,0,1,5,2,3,11,-1],
    [2,1,5,2,5,8,2,8,11,4,8,5,-1],[10,3,11,10,1,3,9,5,4,-1],
    [4,9,5,0,8,1,8,10,1,8,11,10,-1],[5,4,0,5,0,11,5,11,10,11,0,3,-1],
    [5,4,8,5,8,10,10,8,11,-1],[9,7,8,5,7,9,-1],[9,3,0,9,5,3,5,7,3,-1],
    [0,7,8,0,1,7,1,5,7,-1],[1,5,3,3,5,7,-1],[9,7,8,9,5,7,10,1,2,-1],
    [10,1,2,9,5,0,5,3,0,5,7,3,-1],[8,0,2,8,2,5,8,5,7,10,5,2,-1],
    [2,10,5,2,5,3,3,5,7,-1],[7,9,5,7,8,9,3,11,2,-1],
    [9,5,7,9,7,2,9,2,0,2,7,11,-1],[2,3,11,0,1,8,1,7,8,1,5,7,-1],
    [11,2,1,11,1,7,7,1,5,-1],[9,5,8,8,5,7,10,1,3,10,3,11,-1],
    [5,7,0,5,0,9,7,11,0,1,0,10,11,10,0,-1],
    [11,10,0,11,0,3,10,5,0,8,0,7,5,7,0,-1],[11,10,5,7,11,5,-1],
    [10,6,5,-1],[0,8,3,5,10,6,-1],[9,0,1,5,10,6,-1],
    [1,8,3,1,9,8,5,10,6,-1],[1,6,5,2,6,1,-1],[1,6,5,1,2,6,3,0,8,-1],
    [9,6,5,9,0,6,0,2,6,-1],[5,9,8,5,8,2,5,2,6,3,2,8,-1],
    [2,3,11,10,6,5,-1],[11,0,8,11,2,0,10,6,5,-1],[0,1,9,2,3,11,5,10,6,-1],
    [5,10,6,1,9,2,9,11,2,9,8,11,-1],[6,3,11,6,5,3,5,1,3,-1],
    [0,8,11,0,11,5,0,5,1,5,11,6,-1],[3,11,6,0,3,6,0,6,5,0,5,9,-1],
    [6,5,9,6,9,11,11,9,8,-1],[5,10,6,4,7,8,-1],[4,3,0,4,7,3,6,5,10,-1],
    [1,9,0,5,10,6,8,4,7,-1],[10,6,5,1,9,7,1,7,3,7,9,4,-1],
    [6,1,2,6,5,1,4,7,8,-1],[1,2,5,5,2,6,3,0,4,3,4,7,-1],
    [8,4,7,9,0,5,0,6,5,0,2,6,-1],[7,3,9,7,9,4,3,2,9,5,9,6,2,6,9,-1],
    [3,11,2,7,8,4,10,6,5,-1],[5,10,6,4,7,2,4,2,0,2,7,11,-1],
    [0,1,9,4,7,8,2,3,11,5,10,6,-1],
    [9,2,1,9,11,2,9,4,11,7,11,4,5,10,6,-1],
    [8,4,7,3,11,5,3,5,1,5,11,6,-1],
    [5,1,11,5,11,6,1,0,11,7,11,4,0,4,11,-1],
    [0,5,9,0,6,5,0,3,6,11,6,3,8,4,7,-1],
    [6,5,9,6,9,11,4,7,9,7,11,9,-1],[10,4,9,6,4,10,-1],
    [4,10,6,4,9,10,0,8,3,-1],[10,0,1,10,6,0,6,4,0,-1],
    [8,3,1,8,1,6,8,6,4,6,1,10,-1],[1,4,9,1,2,4,2,6,4,-1],
    [3,0,8,1,2,9,2,4,9,2,6,4,-1],[0,2,4,4,2,6,-1],
    [8,3,2,8,2,4,4,2,6,-1],[10,4,9,10,6,4,11,2,3,-1],
    [0,8,2,2,8,11,4,9,10,4,10,6,-1],
    [3,11,2,0,1,6,0,6,4,6,1,10,-1],
    [6,4,1,6,1,10,4,8,1,2,1,11,8,11,1,-1],
    [9,6,4,9,3,6,9,1,3,11,6,3,-1],
    [8,11,1,8,1,0,11,6,1,9,1,4,6,4,1,-1],
    [3,11,6,3,6,0,0,6,4,-1],[6,4,8,11,6,8,-1],
    [7,10,6,7,8,10,8,9,10,-1],[0,7,3,0,10,7,0,9,10,6,7,10,-1],
    [10,6,7,1,10,7,1,7,8,1,8,0,-1],[10,6,7,10,7,1,1,7,3,-1],
    [1,2,6,1,6,8,1,8,9,8,6,7,-1],
    [2,6,9,2,9,1,6,7,9,0,9,3,7,3,9,-1],
    [7,8,0,7,0,6,6,0,2,-1],[7,3,2,6,7,2,-1],
    [2,3,11,10,6,8,10,8,9,8,6,7,-1],
    [2,0,7,2,7,11,0,9,7,6,7,10,9,10,7,-1],
    [1,8,0,1,7,8,1,10,7,6,7,10,2,3,11,-1],
    [11,2,1,11,1,7,10,6,1,6,7,1,-1],
    [8,9,6,8,6,7,9,1,6,11,6,3,1,3,6,-1],
    [0,9,1,11,6,7,-1],
    [7,8,0,7,0,6,3,11,0,11,6,0,-1],[7,11,6,-1],
    [7,6,11,-1],[3,0,8,11,7,6,-1],[0,1,9,11,7,6,-1],
    [8,1,9,8,3,1,11,7,6,-1],[10,1,2,6,11,7,-1],
    [1,2,10,3,0,8,6,11,7,-1],[2,9,0,2,10,9,6,11,7,-1],
    [6,11,7,2,10,3,10,8,3,10,9,8,-1],
    [7,2,3,6,2,7,-1],[7,0,8,7,6,0,6,2,0,-1],
    [2,7,6,2,3,7,0,1,9,-1],[1,6,2,1,8,6,1,9,8,8,7,6,-1],
    [10,7,6,10,1,7,1,3,7,-1],[10,7,6,1,7,10,1,8,7,1,0,8,-1],
    [0,3,7,0,7,10,0,10,9,6,10,7,-1],
    [7,6,10,7,10,8,8,10,9,-1],[6,8,4,11,8,6,-1],
    [3,6,11,3,0,6,0,4,6,-1],[8,6,11,8,4,6,9,0,1,-1],
    [9,4,6,9,6,3,9,3,1,11,3,6,-1],
    [6,8,4,6,11,8,2,10,1,-1],[1,2,10,3,0,11,0,6,11,0,4,6,-1],
    [4,11,8,4,6,11,0,2,9,2,10,9,-1],
    [10,9,3,10,3,2,9,4,3,11,3,6,4,6,3,-1],
    [8,2,3,8,4,2,4,6,2,-1],[0,4,2,4,6,2,-1],
    [1,9,0,2,3,4,2,4,6,4,3,8,-1],
    [1,9,4,1,4,2,2,4,6,-1],
    [8,1,3,8,6,1,8,4,6,6,10,1,-1],
    [10,1,0,10,0,6,6,0,4,-1],
    [4,6,3,4,3,8,6,10,3,0,3,9,10,9,3,-1],
    [10,9,4,6,10,4,-1],[4,9,5,7,6,11,-1],
    [0,8,3,4,9,5,11,7,6,-1],[5,0,1,5,4,0,7,6,11,-1],
    [11,7,6,8,3,4,3,5,4,3,1,5,-1],
    [9,5,4,10,1,2,7,6,11,-1],
    [6,11,7,1,2,10,0,8,3,4,9,5,-1],
    [7,6,11,5,4,10,4,2,10,4,0,2,-1],
    [3,4,8,3,5,4,3,2,5,10,5,2,11,7,6,-1],
    [7,2,3,7,6,2,5,4,9,-1],
    [9,5,4,0,8,6,0,6,2,6,8,7,-1],
    [3,6,2,3,7,6,1,5,0,5,4,0,-1],
    [6,2,8,6,8,7,2,1,8,4,8,5,1,5,8,-1],
    [9,5,4,10,1,6,1,7,6,1,3,7,-1],
    [1,6,10,1,7,6,1,0,7,8,7,0,9,5,4,-1],
    [4,0,10,4,10,5,0,3,10,6,10,7,3,7,10,-1],
    [7,6,10,7,10,8,5,4,10,4,8,10,-1],
    [6,9,5,6,11,9,11,8,9,-1],
    [3,6,11,0,6,3,0,5,6,0,9,5,-1],
    [0,11,8,0,5,11,0,1,5,5,6,11,-1],
    [6,11,3,6,3,5,5,3,1,-1],
    [1,2,10,9,5,11,9,11,8,11,5,6,-1],
    [0,11,3,0,6,11,0,9,6,5,6,9,1,2,10,-1],
    [11,8,5,11,5,6,8,0,5,10,5,2,0,2,5,-1],
    [6,11,3,6,3,5,2,10,3,10,5,3,-1],
    [5,8,9,5,2,8,5,6,2,3,8,2,-1],
    [9,5,6,9,6,0,0,6,2,-1],
    [1,5,8,1,8,0,5,6,8,3,8,2,6,2,8,-1],
    [1,5,6,2,1,6,-1],
    [1,3,6,1,6,10,3,8,6,5,6,9,8,9,6,-1],
    [10,1,0,10,0,6,9,5,0,5,6,0,-1],
    [0,3,8,5,6,10,-1],[10,5,6,-1],
    [11,5,10,7,5,11,-1],[11,5,10,11,7,5,8,3,0,-1],
    [5,11,7,5,10,11,1,9,0,-1],
    [10,7,5,10,11,7,9,8,1,8,3,1,-1],
    [11,1,2,11,7,1,7,5,1,-1],
    [0,8,3,1,2,7,1,7,5,7,2,11,-1],
    [9,7,5,9,2,7,9,0,2,2,11,7,-1],
    [7,5,2,7,2,11,5,9,2,3,2,8,9,8,2,-1],
    [2,5,10,2,3,5,3,7,5,-1],
    [8,2,0,8,5,2,8,7,5,10,2,5,-1],
    [9,0,1,5,10,3,5,3,7,3,10,2,-1],
    [9,8,2,9,2,1,8,7,2,10,2,5,7,5,2,-1],
    [1,3,5,3,7,5,-1],[0,8,7,0,7,1,1,7,5,-1],
    [9,0,3,9,3,5,5,3,7,-1],[9,8,7,5,9,7,-1],
    [5,8,4,5,10,8,10,11,8,-1],
    [5,0,4,5,11,0,5,10,11,11,3,0,-1],
    [0,1,9,8,4,10,8,10,11,10,4,5,-1],
    [10,11,4,10,4,5,11,3,4,9,4,1,3,1,4,-1],
    [2,5,1,2,8,5,2,11,8,4,5,8,-1],
    [0,4,11,0,11,3,4,5,11,2,11,1,5,1,11,-1],
    [0,2,5,0,5,9,2,11,5,4,5,8,11,8,5,-1],
    [9,4,5,2,11,3,-1],
    [2,5,10,3,5,2,3,4,5,3,8,4,-1],
    [5,10,2,5,2,4,4,2,0,-1],
    [3,10,2,3,5,10,3,8,5,4,5,8,0,1,9,-1],
    [5,10,2,5,2,4,1,9,2,9,4,2,-1],
    [8,4,5,8,5,3,3,5,1,-1],[0,4,5,1,0,5,-1],
    [8,4,5,8,5,3,9,0,5,0,3,5,-1],[9,4,5,-1],
    [4,11,7,4,9,11,9,10,11,-1],
    [0,8,3,4,9,7,9,11,7,9,10,11,-1],
    [1,10,11,1,11,4,1,4,0,7,4,11,-1],
    [3,1,4,3,4,8,1,10,4,7,4,11,10,11,4,-1],
    [4,11,7,9,11,4,9,2,11,9,1,2,-1],
    [9,7,4,9,11,7,9,1,11,2,11,1,0,8,3,-1],
    [11,7,4,11,4,2,2,4,0,-1],
    [11,7,4,11,4,2,8,3,4,3,2,4,-1],
    [2,9,10,2,7,9,2,3,7,7,4,9,-1],
    [9,10,7,9,7,4,10,2,7,8,7,0,2,0,7,-1],
    [3,7,10,3,10,2,7,4,10,1,10,0,4,0,10,-1],
    [1,10,2,8,7,4,-1],
    [4,9,1,4,1,7,7,1,3,-1],
    [4,9,1,4,1,7,0,8,1,8,7,1,-1],
    [4,0,3,7,4,3,-1],[4,8,7,-1],
    [9,10,8,10,11,8,-1],[3,0,9,3,9,11,11,9,10,-1],
    [0,1,10,0,10,8,8,10,11,-1],[3,1,10,11,3,10,-1],
    [1,2,11,1,11,9,9,11,8,-1],
    [3,0,9,3,9,11,1,2,9,2,11,9,-1],[0,2,11,8,0,11,-1],[3,2,11,-1],
    [2,3,8,2,8,10,10,8,9,-1],[9,10,2,0,9,2,-1],
    [2,3,8,2,8,10,0,1,8,1,10,8,-1],[1,10,2,-1],
    [1,3,8,9,1,8,-1],[0,9,1,-1],[0,3,8,-1],[-1],
  ];

  // Edge → vertex pair (which two cube vertices each edge connects).
  const EDGE_VERT = [
    [0,1],[1,2],[2,3],[3,0],
    [4,5],[5,6],[6,7],[7,4],
    [0,4],[1,5],[2,6],[3,7],
  ];

  // Cube vertex offsets (8 corners of unit cube).
  const VERT_OFF = [
    [0,0,0],[1,0,0],[1,1,0],[0,1,0],
    [0,0,1],[1,0,1],[1,1,1],[0,1,1],
  ];

  // ---------- Module state ---------------------------------------------------
  let _scene = null;
  let _gameBoard = null;
  let _initRequested = false;
  let enabled = false;
  let channel = 'A1';
  // 8 w-slices × 3 shells = 24 meshes. We pre-build empty BufferGeometry
  // meshes in init() and overwrite their position/color attributes on
  // each refresh; this avoids per-refresh re-allocation.
  const SHELL_LEVELS = [
    { percentile: 0.50, color: [0.30, 0.50, 1.00], opacity: 0.10 }, // outer — light blue
    { percentile: 0.75, color: [0.40, 0.85, 0.40], opacity: 0.18 }, // mid — green
    { percentile: 0.90, color: [1.00, 0.65, 0.25], opacity: 0.32 }, // inner — orange
  ];
  const meshes = []; // { mesh, w, shellIdx }

  // ---------- public API -----------------------------------------------------
  window.SpectralIsosurfaces = {
    init(scene, gameBoard) {
      if (_initRequested) return;
      _initRequested = true;
      _scene = scene;
      _gameBoard = gameBoard;
      _buildMeshes();
      try {
        const flag = new URLSearchParams(location.search).get('isosurfaces');
        if (flag === '1' || flag === 'on') {
          enabled = true;
          for (const m of meshes) m.mesh.visible = true;
          refresh();
        }
      } catch (_) { /* leave defaults */ }
    },
    setEnabled(en) {
      if (enabled === en) return;
      enabled = en;
      for (const m of meshes) m.mesh.visible = en;
      if (en) refresh();
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    setChannel(name) {
      if (typeof name !== 'string' || name === channel) return;
      channel = name;
      if (enabled) refresh();
    },
    /** M11.3.5: stack-height slider hook */
    setStackScale(s) {
      if (!Number.isFinite(s) || s <= 0) return;
      for (const m of meshes) m.mesh.scale.y = s;
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    refresh,
    isEnabled() { return enabled; },
    getChannel() { return channel; },
  };

  // ---------- Mesh build ------------------------------------------------------
  function _buildMeshes() {
    if (!_scene || !_gameBoard) return;
    if (meshes.length) return;
    for (let w = 0; w < 8; w++) {
      for (let s = 0; s < SHELL_LEVELS.length; s++) {
        const shell = SHELL_LEVELS[s];
        const geom = new THREE.BufferGeometry();
        // Pre-allocate generously: at most 5 triangles per cell × 7^3 cells
        // = 1715 triangles = 5145 vertices per shell. Float32 × 3 = 60kB.
        // We resize via setDrawRange every refresh.
        const MAX_VERTS = 5145;
        const positions = new Float32Array(MAX_VERTS * 3);
        const normals   = new Float32Array(MAX_VERTS * 3);
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
        geom.setAttribute('normal',   new THREE.BufferAttribute(normals, 3).setUsage(THREE.DynamicDrawUsage));
        geom.setDrawRange(0, 0);
        const mat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(shell.color[0], shell.color[1], shell.color[2]),
          transparent: true,
          opacity: shell.opacity,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const mesh = new THREE.Mesh(geom, mat);
        mesh.frustumCulled = false;
        // Shell renderOrder: outer (lowest opacity) drawn first, inner last.
        // Tint = 1, cloud = 2, iso = 3 + shell index, filaments = 5.
        mesh.renderOrder = 3 + s;
        mesh.visible = false;
        mesh.userData = { w, shellIdx: s };
        _scene.add(mesh);
        meshes.push({ mesh, w, shellIdx: s, capacity: MAX_VERTS });
      }
    }
  }

  // ---------- Refresh / extract ----------------------------------------------
  // Marching cubes on 8 grid points per axis (the 8 lattice cells per axis
  // for a fixed-w slice). Produces a polyline-style triangle soup; we
  // write into the pre-allocated BufferGeometry and call setDrawRange.
  // Field is interpolated: cube corners use raw lattice values, and edge
  // intersection points use linear interpolation between the two corner
  // values to position vertices.
  async function refresh() {
    if (!enabled) return;
    if (typeof window === 'undefined' || !window.SpectralBridge) return;
    if (!window.__SPECTRAL_INFO__) return;
    if (!meshes.length) return;
    try {
      const res = await window.SpectralBridge.getBoardEncoding([channel]);
      if (!res || !res.ok) {
        console.warn('[m11.3.1/iso] getBoardEncoding failed:', res && res.reason);
        return;
      }
      const arr = res.channels && res.channels[channel];
      if (!arr || !arr.length) {
        console.warn(`[m11.3.1/iso] channel "${channel}" not in response`);
        return;
      }

      // Compute 3 percentile thresholds for the shells. Use absolute value
      // for signed channels so positive and negative magnitudes both contribute.
      const sorted = new Float32Array(arr).sort();
      const n = sorted.length;
      const thresholds = SHELL_LEVELS.map(sh =>
        sorted[Math.min(n - 1, Math.floor(sh.percentile * n))]
      );

      const gfx = _gameBoard.graphics;
      let totalTris = 0;
      for (const item of meshes) {
        const { mesh, w, shellIdx } = item;
        const iso = thresholds[shellIdx];
        const positions = mesh.geometry.attributes.position.array;
        const normals   = mesh.geometry.attributes.normal.array;
        let vi = 0;

        // Step the 7^3 unit cubes inside this w-slice's 8^3 grid.
        // Cube at (cx, cy, cz) has corners at (cx..cx+1, cy..cy+1, cz..cz+1).
        for (let cx = 0; cx < 7; cx++) {
          for (let cy = 0; cy < 7; cy++) {
            for (let cz = 0; cz < 7; cz++) {
              // 8 corner values for this cube
              let cubeIdx = 0;
              const corners = new Array(8);
              for (let v = 0; v < 8; v++) {
                const o = VERT_OFF[v];
                const lx = cx + o[0], ly = cy + o[1], lz = cz + o[2];
                const idx = (lx << 9) | (ly << 6) | (lz << 3) | w;
                corners[v] = arr[idx];
                if (corners[v] >= iso) cubeIdx |= (1 << v);
              }
              const edgeMask = EDGE_TABLE[cubeIdx];
              if (edgeMask === 0) continue;

              // Interpolate 12 edge midpoints (only those flagged).
              const edgeWorld = new Array(12);
              for (let e = 0; e < 12; e++) {
                if (!(edgeMask & (1 << e))) continue;
                const [a, b] = EDGE_VERT[e];
                const va = corners[a], vb = corners[b];
                let t = 0.5;
                if (Math.abs(vb - va) > 1e-12) t = (iso - va) / (vb - va);
                if (t < 0) t = 0; else if (t > 1) t = 1;
                const oa = VERT_OFF[a], ob = VERT_OFF[b];
                const lx = cx + oa[0] + t * (ob[0] - oa[0]);
                const ly = cy + oa[1] + t * (ob[1] - oa[1]);
                const lz = cz + oa[2] + t * (ob[2] - oa[2]);
                // Convert lattice (lx, ly, lz, w) → world via boardCoordinates.
                edgeWorld[e] = gfx.boardCoordinates(lx, ly, lz, w);
              }

              // Emit triangles for this cube.
              const tri = TRI_TABLE[cubeIdx];
              for (let t = 0; t < tri.length; t += 3) {
                if (tri[t] === -1) break;
                if (vi + 9 > positions.length) break;
                const p0 = edgeWorld[tri[t]];
                const p1 = edgeWorld[tri[t + 1]];
                const p2 = edgeWorld[tri[t + 2]];
                if (!p0 || !p1 || !p2) continue;
                positions[vi + 0] = p0.x; positions[vi + 1] = p0.y; positions[vi + 2] = p0.z;
                positions[vi + 3] = p1.x; positions[vi + 4] = p1.y; positions[vi + 5] = p1.z;
                positions[vi + 6] = p2.x; positions[vi + 7] = p2.y; positions[vi + 8] = p2.z;
                // Compute face normal (no per-vertex shading; just for FrontSide rendering correctness).
                const ax = p1.x - p0.x, ay = p1.y - p0.y, az = p1.z - p0.z;
                const bx = p2.x - p0.x, by = p2.y - p0.y, bz = p2.z - p0.z;
                let nx = ay * bz - az * by;
                let ny = az * bx - ax * bz;
                let nz = ax * by - ay * bx;
                const nl = Math.hypot(nx, ny, nz);
                if (nl > 1e-9) { nx /= nl; ny /= nl; nz /= nl; }
                normals[vi + 0] = nx; normals[vi + 1] = ny; normals[vi + 2] = nz;
                normals[vi + 3] = nx; normals[vi + 4] = ny; normals[vi + 5] = nz;
                normals[vi + 6] = nx; normals[vi + 7] = ny; normals[vi + 8] = nz;
                vi += 9;
              }
            }
          }
        }
        const triCount = vi / 9;
        totalTris += triCount;
        mesh.geometry.setDrawRange(0, vi / 3);
        mesh.geometry.attributes.position.needsUpdate = true;
        mesh.geometry.attributes.normal.needsUpdate = true;
        mesh.geometry.computeBoundingSphere();
      }
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
      console.log(
        `[m11.3.1/iso] ch=${channel} ` +
          `thresholds=[${thresholds.map(t => t.toExponential(3)).join(', ')}] ` +
          `total triangles=${totalTris} across ${meshes.length} meshes`
      );
    } catch (err) {
      console.warn('[m11.3.1/iso] refresh error:', err);
    }
  }
})();
