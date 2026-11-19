"""The Earth's land and lakes, for the World and Globe maps: writes
src/earth.rle (land) and src/lakes.rle (lakes).

    python3 assets/earth.py ne_50m_land.geojson ne_50m_lakes.geojson

Natural Earth's 1:50m land and lakes (public domain, naturalearthdata.com;
GeoJSON copies at github.com/nvkelso/natural-earth-vector, geojson/).

The result is a grid of quarter degrees, 1440 columns from 180° west and 720
rows from 90° north, each cell land (inside a land polygon and not in a lake)
or water, judged at the cell's middle (and in lakes.rle: a lake or not).
Each is stored as runs, row by row:
little-endian u16 lengths, alternating water and land, starting with water
(so a row that starts with land starts with a run of 0). Every row's runs
add up to 1440.
"""
import json
import struct
import sys

COLS, ROWS, STEP = 1440, 720, 0.25


def rings(path):
    """Every ring (outer and holes) of every polygon in a GeoJSON file."""
    out = []
    for f in json.load(open(path, encoding="utf-8"))["features"]:
        g = f["geometry"]
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for poly in polys:
            out.extend(poly)
    return out


def raster(rs):
    """Scanline fill, even-odd over all rings: rows of booleans."""
    # Edges by the rows they cross.
    by_row = [[] for _ in range(ROWS)]
    for ring in rs:
        for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1]):
            if y0 == y1:
                continue
            lo, hi = min(y0, y1), max(y0, y1)
            # Rows whose middle latitude lies in [lo, hi).
            r_first = max(0, int((90 - hi) / STEP - 0.5) - 1)
            r_last = min(ROWS - 1, int((90 - lo) / STEP - 0.5) + 1)
            for r in range(r_first, r_last + 1):
                lat = 90 - (r + 0.5) * STEP
                if lo <= lat < hi:
                    by_row[r].append(x0 + (lat - y0) * (x1 - x0) / (y1 - y0))
    grid = []
    for r in range(ROWS):
        xs = sorted(by_row[r])
        row = [False] * COLS
        for a, b in zip(xs[0::2], xs[1::2]):
            c0 = max(0, int((a + 180) / STEP - 0.5) + 1)
            c1 = min(COLS - 1, int((b + 180) / STEP - 0.5))
            for c in range(c0, c1 + 1):
                row[c] = not row[c]
        grid.append(row)
    return grid


def write(path, grid):
    out = bytearray()
    for row in grid:
        runs, cur, n = [], False, 0
        for v in row:
            if v == cur:
                n += 1
            else:
                runs.append(n)
                cur, n = v, 1
        runs.append(n)
        assert sum(runs) == COLS
        for n in runs:
            out += struct.pack("<H", n)
    open(path, "wb").write(out)
    share = sum(sum(r) for r in grid) / (ROWS * COLS)
    print(f"{path}: {len(out)} bytes, {share:.1%} of cells")


def main():
    land = raster(rings(sys.argv[1]))
    lakes = raster(rings(sys.argv[2]))
    write("src/earth.rle", [[land[r][c] and not lakes[r][c] for c in range(COLS)] for r in range(ROWS)])
    write("src/lakes.rle", lakes)


main()
