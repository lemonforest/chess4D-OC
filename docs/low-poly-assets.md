# Low-Poly Asset Toggle (M7a)

The chess piece OBJ models in this repo come in two flavors:

| Directory                              | Triangles total | Disk size | When to use |
|----------------------------------------|-----------------|-----------|-------------|
| `js/pieces/obj_pieces/` (originals)    | ~1.05 M         | ~74 MB    | Hi-fi screenshots / promo only |
| `js/pieces/obj_pieces_lowpoly/` (M7a)  | ~210 K (-80%)   | ~15 MB    | **Default — playable on commodity hardware** |

The originals crashed Chrome (and the host OS) under M5/M6 test loads. With 896 pieces on the 4D board, ~45 M triangles in memory was unmanageable on older laptops. The decimated set is visually indistinguishable at play distance.

## Selecting at runtime

`Models.js` reads a URL flag at boot:

| URL                          | Loaded directory                   |
|------------------------------|------------------------------------|
| `index.html` *(no flag)*     | `js/pieces/obj_pieces_lowpoly/` (default) |
| `index.html?quality=low`     | `js/pieces/obj_pieces_lowpoly/`    |
| `index.html?quality=high`    | `js/pieces/obj_pieces/`            |

No build step. The flag is parsed once at page load via `URLSearchParams`.

## Per-piece breakdown (from the latest decimation run)

```
piece          in MB    in tris   out MB   out tris
Pawn.obj         4.69     68 352     0.94     13 670
Rook.obj        10.07    142 080     2.01     28 414
Bishop.obj       9.74    139 200     1.99     27 838
Knight V1.obj   17.46    259 328     3.78     51 864
Queen.obj       16.47    226 624     3.35     45 324
King.obj        15.18    215 808     3.13     43 160
TOTAL           73.61  1 051 392    15.19    210 270   (-79.4 % / -80.0 %)
```

## Regenerating

If we ever update the source models (e.g., upstream replaces Knight V1 with a new file), regenerate the low-poly set:

```bash
pip install fast-simplification trimesh Pillow
python tools/decimate_obj.py
```

The script:

- Reads each piece in `js/pieces/obj_pieces/`
- Decimates to ~20 % of original triangles via `fast-simplification` (pybind11 wrapper around fastquadricmeshsimplification)
- Writes to `js/pieces/obj_pieces_lowpoly/` (the dir is wiped and recreated each run, so the script is idempotent)
- Prints before/after stats

`fast-simplification` is the chosen library because:

- Lighter than `pymeshlab` (which OOM'd on Windows during save with the larger pieces)
- Native C++, handles hundreds of thousands of triangles in under a second per piece
- Pip-installable on all three desktop OSes

It's a build-time tool only; not a runtime dependency. `package.json` does not list it.

## When to flip the default back

If a future milestone (M7d's `InstancedMesh` pass, or a WebGPU renderer in M7e) makes high-poly playable, re-evaluate the default. For now, low is the safer floor.
