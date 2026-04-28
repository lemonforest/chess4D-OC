"""Decimate the chess piece OBJ models in js/pieces/obj_pieces/ to ~20% of
their original triangle count using fast-simplification (pybind11 wrapper
around fastquadricmeshsimplification). Originals are not modified —
outputs go to js/pieces/obj_pieces_lowpoly/.

Run from the repo root:
    pip install fast-simplification trimesh
    python tools/decimate_obj.py

Idempotent: re-running re-decimates from the originals (output dir is
cleared first). Prints before/after triangle and file-size stats.

Why this exists: original OBJs are 4.7 MB to 17 MB each (~600 k triangles
for King). With 896 pieces on the 4D board that's ~45 M triangles in
memory — enough to crash Chrome (and the OS) on older laptops in M5/M6
testing. 80 % decimation is visually imperceptible at play distance.

History: an earlier draft used pymeshlab. Its quadric edge-collapse filter
hit "bad allocation" on save with the larger pieces on Windows; switched
to fast-simplification (lighter, native C++, handles big meshes cleanly).
"""

from __future__ import annotations

import gc
import shutil
import sys
import time
from pathlib import Path

# Pieces actually loaded by Models.js (Models.pieceData). Knight V1.obj is
# the active model; Knight V2.obj was deleted in M3 (over CF's per-file limit).
PIECE_FILES = [
    "Pawn.obj",
    "Rook.obj",
    "Bishop.obj",
    "Knight V1.obj",
    "Queen.obj",
    "King.obj",
]

# Drop 80%, keep 20% of triangles. Tuned for chess pieces at play distance —
# silhouettes intact, fine surface detail (not visible at scale) discarded.
TARGET_RATIO = 0.20


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    src_dir = repo_root / "js" / "pieces" / "obj_pieces"
    dst_dir = repo_root / "js" / "pieces" / "obj_pieces_lowpoly"

    if not src_dir.is_dir():
        print(f"ERROR: source dir missing: {src_dir}", file=sys.stderr)
        return 1

    if dst_dir.exists():
        shutil.rmtree(dst_dir)
    dst_dir.mkdir(parents=True, exist_ok=True)

    try:
        import fast_simplification  # type: ignore
        import trimesh  # type: ignore
    except ImportError as e:
        print(
            f"ERROR: missing dependency ({e.name}). "
            "Run: pip install fast-simplification trimesh",
            file=sys.stderr,
        )
        return 2

    print(
        f"Decimating {len(PIECE_FILES)} OBJ files "
        f"to ~{int(TARGET_RATIO*100)}% triangles via fast-simplification"
    )
    print(f"  source: {src_dir}")
    print(f"  output: {dst_dir}")
    print()
    print(f"{'piece':<14} {'in MB':>8} {'in tris':>10} {'out MB':>8} {'out tris':>10} {'time s':>7}")
    print("-" * 64)

    total_in_bytes = 0
    total_out_bytes = 0
    total_in_tris = 0
    total_out_tris = 0

    for fname in PIECE_FILES:
        src_path = src_dir / fname
        dst_path = dst_dir / fname
        if not src_path.is_file():
            print(f"WARN: {src_path} missing, skipping", file=sys.stderr)
            continue

        # trimesh.load returns a Scene if the OBJ has multiple geometries;
        # we want a single Trimesh, so concat if needed.
        loaded = trimesh.load(str(src_path), force="mesh", process=False)
        if not hasattr(loaded, "faces"):
            print(f"WARN: {fname} loaded as non-mesh ({type(loaded).__name__}), skipping",
                  file=sys.stderr)
            continue

        in_tris = len(loaded.faces)
        in_bytes = src_path.stat().st_size

        # fast_simplification.simplify takes (vertices, faces, target_reduction)
        # where target_reduction is the FRACTION TO REMOVE (so 0.8 keeps 20%).
        target_reduction = 1.0 - TARGET_RATIO
        t0 = time.perf_counter()
        try:
            v_out, f_out = fast_simplification.simplify(
                loaded.vertices, loaded.faces, target_reduction
            )
        except Exception as e:
            print(f"ERROR on {fname}: {type(e).__name__}: {e}", file=sys.stderr)
            continue
        elapsed = time.perf_counter() - t0

        out_mesh = trimesh.Trimesh(vertices=v_out, faces=f_out, process=False)
        out_mesh.export(str(dst_path), file_type="obj", include_normals=True)
        out_tris = len(f_out)
        out_bytes = dst_path.stat().st_size

        total_in_bytes += in_bytes
        total_out_bytes += out_bytes
        total_in_tris += in_tris
        total_out_tris += out_tris

        print(
            f"{fname:<14} {in_bytes/1_048_576:>8.2f} {in_tris:>10} "
            f"{out_bytes/1_048_576:>8.2f} {out_tris:>10} {elapsed:>7.1f}"
        )

        # Free memory between pieces — King + Queen at full poly are big.
        del loaded, out_mesh, v_out, f_out
        gc.collect()

    print("-" * 64)
    print(
        f"{'TOTAL':<14} {total_in_bytes/1_048_576:>8.2f} {total_in_tris:>10} "
        f"{total_out_bytes/1_048_576:>8.2f} {total_out_tris:>10}"
    )

    if total_in_bytes > 0:
        ratio_b = total_out_bytes / total_in_bytes
        ratio_t = total_out_tris / total_in_tris if total_in_tris else 1.0
        print(
            f"\nReduction: {(1-ratio_b)*100:.1f}% on disk, "
            f"{(1-ratio_t)*100:.1f}% on triangle count."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
