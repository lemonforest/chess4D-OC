# 🎮 4D Chess - Four-Dimensional Chess Game

A mathematically rigorous implementation of four-dimensional chess on the discrete hypercubic lattice **{1,…,8}⁴**, built with **JavaScript** and **Three.js**.

> **Fork notice — chess4D-OC**: this repository is a fork of [oanaunc/4d_chess](https://github.com/oanaunc/4d_chess) extending the upstream project with a Pyodide-driven spectral move visualizer (powered by [`chess-spectral`](https://pypi.org/project/chess-spectral/) and [`python-chess4d-oana-chiru`](https://pypi.org/project/python-chess4d-oana-chiru/), loaded at runtime from PyPI in the user's browser). See [LICENSE](LICENSE), [NOTICE](NOTICE), and [CLAUDE.md](CLAUDE.md) for licensing posture and contributor orientation.

## 📖 Overview

This project implements a complete framework for four-dimensional chess, extending classical chess mechanics into a 4D space. The system includes:

- **Mathematical formalization** using displacement sets in Z⁴ and Chebyshev adjacency
- **Complete game engine** with move generation, legality checking, and multi-king checkmate detection
- **Interactive 3D visualization** rendering all 64 (z,w)-slices simultaneously
- **Generalized chess rules** including castling, en passant, and promotion adapted for 4D

This implementation is based on the research paper: *"A Mathematical Framework for Four-Dimensional Chess"* by Rinaldi (Unciuleanu) Oana and Costin-Gabriel Chiru.

**Live Demo**: [https://oanarinaldi.com/4d_chess/](https://oanarinaldi.com/4d_chess/)

---

## 🎯 Mathematical Framework

### Board Structure

The 4D chessboard is defined as the set of integer lattice points **B = {1,…,8}⁴ ⊂ Z⁴**, where each coordinate axis corresponds to an independent spatial dimension:

- **Total positions**: 8 × 8 × 8 × 8 = **4,096 cells**
- **Total pieces**: **896 pieces** (448 per player) in the standard initial configuration
- **Visualization**: The 4D board is rendered as **64 distinct 8×8 boards**, each representing a fixed (z,w) slice

### Coordinate System

```javascript
Position = (x, y, z, w)
- X: Horizontal axis (0-7 in UI, 1-8 in theory)
- Y: Vertical axis (0-7 in UI, 1-8 in theory)  
- Z: Depth axis (0-7 in UI, 1-8 in theory)
- W: Fourth dimension (0-7 in UI, 1-8 in theory)
```

**Note**: The implementation uses 0-based indexing for UI convenience, while the mathematical framework uses 1-based indexing. Theoretical coordinates (x,y,z,w) correspond to UI coordinates (x-1, y-1, z-1, w-1).

### Initial Position

The standard starting configuration uses a quadrant-based layout across 64 (z,w)-slices:

- **Central boards** (4 slices): Both colors present, full 2D starting position
- **White-only boards** (24 slices): 16 white pieces per slice
- **Black-only boards** (24 slices): 16 black pieces per slice  
- **Empty boards** (12 slices): No pieces initially

This yields **448 pieces per side** (28 kings per side), distributed across multiple slices. Each slice containing a full 2D starting position includes one king per color.

### Adjacency and Movement

Two cells **p** and **q** are adjacent if their **Chebyshev distance** equals 1:

```
d∞(p,q) = max{|x-x'|, |y-y'|, |z-z'|, |w-w'|} = 1
```

An interior cell (not on any boundary) has exactly **3⁴ - 1 = 80 adjacent neighbors**.

---

## 📐 Piece Movement Rules in 4D

### Rook
- **Mobility**: Uniformly **28 moves** on an empty board (7 moves per axis)
- **Movement**: Linear along any single axis: (±d, 0, 0, 0), (0, ±d, 0, 0), (0, 0, ±d, 0), (0, 0, 0, ±d)
- **Graph structure**: Forms the Hamming graph H(4,8) with diameter 4

### Bishop
- **Mobility**: Position-dependent, up to **24 directions** in 6 coordinate planes
- **Movement**: Diagonal in any 2D coordinate plane (XY, XZ, XW, YZ, YW, ZW)
- **Parity invariant**: Preserves (x+y+z+w) mod 2, creating two connected components

### Knight
- **Mobility**: **48 moves** in the strict interior, reduced near boundaries
- **Movement**: Permutations of (±2, ±1, 0, 0) - "L-shaped" jumps in any 2-axis combination
- **Boundary sensitivity**: Degree depends on distance from board boundaries

### Queen
- **Mobility**: Union of rook and bishop moves
- **Movement**: Any rook move or any bishop move (32 total directions)
- **Restriction**: Deliberately limited to 1-axis and 2-axis moves (not 3-axis or 4-axis diagonals)

### King
- **Mobility**: **80 adjacent positions** in the interior
- **Movement**: One step in any direction: all cells with Chebyshev distance 1
- **Multi-king rules**: Each king is fully royal; losing any king ends the game

### Pawn
- **Orientation**: Each pawn has orientation **r ∈ {Y, W}** (forward axis)
- **Y-oriented pawns**: Move forward along Y-axis, capture in XY-plane
- **W-oriented pawns**: Move forward along W-axis, capture in XW-plane
- **Promotion**: Occurs at terminal boundary of forward axis (y=8 or w=8 for White)

---

## 🚀 Getting Started

### Prerequisites

- Modern web browser (Chrome 90+, Firefox 88+, Edge 90+, Safari 14+)
- Local web server (required due to CORS restrictions)

### Running Locally

#### Method 1: Python HTTP Server

```bash
cd /path/to/4d_chess
python3 -m http.server 8000
```

Then open: `http://localhost:8000`

#### Method 2: Node.js HTTP Server

```bash
npm install -g http-server
cd /path/to/4d_chess
http-server -p 8000
```

Then open: `http://localhost:8000`

#### Method 3: Direct File (Limited)

Some browsers may block local file access. A local server is recommended.

---

## 🎮 Controls and Interface

### 4D Navigation

| Control | Action |
|---------|--------|
| **W / S** | Navigate W-axis (±1) |
| **Q / E** | Navigate Y-axis (±1) |
| **W-axis Slider** | Select W coordinate (0-7) |
| **Y-axis Slider** | Select Y coordinate (0-7) |

### Camera Controls

| Control | Action |
|---------|--------|
| **Mouse Drag** | Rotate camera (orbit) |
| **Scroll Wheel** | Zoom in/out |
| **Right Click + Drag** | Pan camera |
| **R Key** | Reset camera to default position |

### Gameplay

| Control | Action |
|---------|--------|
| **Click Piece** | Select piece (highlights legal moves) |
| **Click Highlighted Square** | Execute move |
| **ESC** | Deselect piece |
| **Ctrl + Z** | Undo move |
| **Ctrl + Y** | Redo move |

### Visualization Features

- **64-slice rendering**: All (z,w) boards visible simultaneously
- **Transparency controls**: Adjust board opacity to reduce visual clutter
- **Move highlighting**: Legal moves displayed across all relevant slices
- **4D coordinate display**: Hover tooltips show exact (x,y,z,w) coordinates
- **Quaternion-based camera**: Smooth rotation without gimbal lock

---

## 📂 Project Structure

```
4d_chess/
├── index.html              # Entry point and UI
├── README.md              # This file
│
├── css/
│   └── main.css           # Dark mode styling
│
├── js/
│   ├── main.js            # Game initialization and loop
│   ├── Bot.js             # AI opponent implementation
│   ├── tutorial.js        # Interactive tutorial system
│   │
│   └── pieces/            # Piece classes
│       ├── Piece.js       # Base piece class
│       ├── Pawn.js        # 4D pawn with Y/W orientation
│       ├── Rook.js        # 4D rook (28 moves)
│       ├── Bishop.js      # 4D bishop (parity-preserving)
│       ├── Knight.js      # 4D knight (48 moves interior)
│       ├── Queen.js       # 4D queen (rook + bishop)
│       └── King.js         # 4D king (80 neighbors)
│
├── GameBoard.js           # 4D board logic and state
├── MoveManager.js          # Move validation and history
├── Models.js               # 3D model loader (OBJ format)
│
└── models/                # 3D piece models
    ├── *.obj              # OBJ model files
    └── *.model.json       # Model metadata
```

---

## 🔧 Technical Implementation

### Game Engine Features

- ✅ **Complete move generation** for all piece types
- ✅ **Pseudo-legal and legal move filtering** with multi-king support
- ✅ **Attack-map construction** for check detection
- ✅ **Multi-king checkmate detection** (any king in unavoidable check)
- ✅ **Generalized castling** (X-axis only, within fixed (z,w) slice)
- ✅ **Generalized en passant** (separate for Y-oriented and W-oriented pawns)
- ✅ **Pawn promotion** at terminal boundaries
- ✅ **Repetition detection** (threefold repetition)
- ✅ **50-move rule** implementation
- ✅ **Zobrist-style hashing** for position comparison

### Visualization Architecture

- **Three.js r128**: 3D rendering engine
- **OrbitControls**: Camera navigation
- **OBJLoader**: 3D model loading
- **Slice-based projection**: All 64 (z,w) boards rendered as 3D planes
- **Layered transparency**: Occlusion management for dense scenes
- **Quaternion interpolation**: Smooth camera rotation

### Performance Characteristics

- **Branching factor**: Mean ~74 legal moves in midgame positions
- **State space**: 4,096 board positions, 896 pieces in initial setup
- **Move generation**: Optimized with piece-lists and early termination
- **Attack-map construction**: O(P × M_max) where P is piece count, M_max ≈ 80

---

## 📊 Mathematical Results

This implementation validates several theoretical results:

### Rook Mobility
- **Uniform degree**: All squares yield exactly 28 moves
- **Graph structure**: Hamming graph H(4,8) with diameter 4

### Bishop Connectivity  
- **Parity decomposition**: Two connected components based on (x+y+z+w) mod 2
- **Reachability**: Constructive proof that each parity class is connected

### Knight Mobility
- **Interior degree**: Exactly 48 moves in {3,4,5,6}⁴
- **Boundary stratification**: Complete enumeration across all 4,096 squares

### King Adjacency
- **Interior degree**: Exactly 80 neighbors (3⁴ - 1)
- **Graph structure**: Strong product P₈ ⊠ P₈ ⊠ P₈ ⊠ P₈

---

## 🎨 UI Design

### Color Scheme (Dark Mode)

| Element | Color | Hex |
|---------|-------|-----|
| Background Primary | Very Dark Blue | `#0a0e27` |
| Background Secondary | Dark Navy | `#141933` |
| Accent Primary | Cyan | `#00d4ff` |
| Accent Secondary | Purple | `#7b2ff7` |
| Success | Green | `#00ff88` |
| Danger | Red | `#ff3366` |
| Warning | Orange | `#ffaa00` |

---

## 📚 Academic Context

This implementation accompanies the research paper:

> **"A Mathematical Framework for Four-Dimensional Chess"**  
> Rinaldi (Unciuleanu) Oana, Costin-Gabriel Chiru  
> Department of Computer Science, National University of Science and Technology POLITEHNICA Bucharest

The paper provides:
- Formal mathematical definitions of 4D chess rules
- Proofs of mobility formulas and connectivity properties
- Analysis of move graphs on Z⁴
- Exploratory user study (N=18) on visualization accessibility
- Computational complexity analysis

**Key Contributions**:
1. Rigorous Z⁴ displacement-based ruleset
2. Boundary-sensitive mobility analysis
3. Multi-king legality semantics
4. Reproducible engine and visualization
5. Complete enumeration and empirical validation

---

## 🔬 Research Applications

Beyond gameplay, this framework serves as:

- **Computational testbed** for high-dimensional search algorithms
- **Educational tool** for 4D geometry visualization
- **Research platform** for symmetry-aware evaluation methods
- **Experimental environment** for hierarchical planning in large action spaces

---

## 🐛 Known Limitations

- **Performance**: Large branching factors (60-100 moves) limit deep search
- **Visualization**: 64 simultaneous boards create visual density challenges
- **Cognitive load**: Tracking 4D moves requires spatial reasoning skills
- **AI strength**: Current bot uses basic minimax with material/mobility heuristic

---

## 🚧 Future Work

### Algorithmic Improvements
- Hierarchical search with slice-based abstraction
- Symmetry-aware position caching
- Learning-based evaluation functions
- Improved pruning techniques

### Visualization Enhancements
- VR/AR support for immersive 4D exploration
- Alternative projection methods
- Enhanced filtering and highlighting
- Interactive 4D rotation (SO(4) group)

### Feature Additions
- Online multiplayer support
- Advanced AI opponents
- Game analysis and review tools
- Custom starting positions
- Tournament mode

---

## 📄 License

This project is for personal and educational use.

---

## 👥 Authors

**Oana Rinaldi (Unciuleanu)** - Concept, mathematical framework, and specifications  
**Costin-Gabriel Chiru** - Academic supervision and mathematical contributions  
**AI Assistant** - Implementation and code development

**Project Start**: October 30, 2025  
**Status**: ✅ Fully functional implementation

---

## 📖 References

For detailed mathematical proofs, move graph analysis, and theoretical foundations, see the accompanying research paper. The paper includes:

- Complete formal definitions of all piece movements
- Proofs of mobility formulas and connectivity
- Analysis of parity invariants and boundary effects
- User study results on visualization accessibility
- Computational complexity discussion

---

## 🌐 Links

- **Live Demo**: [https://oanarinaldi.com/4d_chess/](https://oanarinaldi.com/4d_chess/)
- **GitHub Repository**: [https://github.com/oanaunc/4d_chess](https://github.com/oanaunc/4d_chess)
- **Feedback Form**: Available in-game via the "Feedback" button

---

**🎮 Explore the fourth dimension through chess! 🚀**
