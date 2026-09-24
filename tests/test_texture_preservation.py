#!/usr/bin/env python3
"""Verify source texel density and exact RGB after repacking and disk eviction."""
import math
from pathlib import Path
import random
import struct
import subprocess
import sys
import tempfile

from PIL import Image
from test_missing_textures import Nxs, fixture


def verify(path, source, side, multilevel, lossless):
    mesh = Nxs(path)
    samples = parents = leaves = 0
    for tid in range(mesh.textures_count - 1):
        start = mesh.u32(mesh.texture_base + tid * 68) * 256
        expected = b'\x89PNG\r\n\x1a\n' if lossless else b'\xff\xd8'
        assert mesh.data[start:start + len(expected)] == expected, 'Wrong texture encoding'
    if not lossless:
        return 'legacy JPEG encoding retained'
    for index, positions, uvs, colors, triangles, patches in mesh.nodes():
        first = 0
        for patch in patches:
            child, last, texture = struct.unpack_from('<III', mesh.data, mesh.patch_base + patch * 12)
            if child != mesh.nodes_count - 1:
                parents += last - first
                first = last
                continue  # Deliberately smaller streaming previews.
            image = mesh.image(texture)
            for triangle in triangles[first:last]:
                leaves += 1
                translations = []
                for v in triangle:
                    x, y, _ = positions[v]
                    sx = (0.1 + 0.8 * (x + side / 2) / side) * source.width
                    sy = (0.1 + 0.8 * (y + side / 2) / side) * source.height
                    dx, dy = uvs[v][0] * image.width - sx, uvs[v][1] * image.height - sy
                    translations.append((dx, dy))
                # Packing may translate source rectangles by whole pixels only.
                # A resize, including the former 4K cap, changes these slopes.
                ox, oy = (round(c) for c in translations[0])
                assert all(abs(dx - ox) < 0.01 and abs(dy - oy) < 0.01 for dx, dy in translations), 'Source texel density changed'
                for weights in ((1/3, 1/3, 1/3), (0.6, 0.2, 0.2), (0.2, 0.6, 0.2)):
                    ax = math.floor(sum(uvs[v][0] * w for v, w in zip(triangle, weights)) * image.width)
                    ay = math.floor(sum(uvs[v][1] * w for v, w in zip(triangle, weights)) * image.height)
                    for dx, dy in ((0, 0), (1, 0), (0, 1)):
                        x, y = ax + dx, ay + dy
                        if not (0 <= x < image.width and 0 <= y < image.height):
                            continue
                        sx, sy = x - ox, y - oy
                        if not (0 <= sx < source.width and 0 <= sy < source.height):
                            continue
                        actual = image.getpixel((x, image.height - 1 - y))
                        expected = source.getpixel((sx, source.height - 1 - sy))
                        assert actual == expected, f'RGB changed in node {index}: {actual} != {expected}'
                        samples += 1
            first = last
    assert samples > 20000 and leaves == 2 * side * side
    if multilevel:
        assert parents > 0, 'No preview LODs exercised'
    return f'{samples} exact RGB samples, {leaves} full-detail and {parents} preview triangles'


def main():
    executable = str(Path(sys.argv[1]).resolve())
    # Non-square, crosses the 4096px tile boundary, and contains single-pixel
    # variation in all channels so resizing/JPEG cannot accidentally pass.
    texture = Image.frombytes('RGB', (6144, 192), random.Random(624).randbytes(6144 * 192 * 3))
    cases = [('full-resolution', False, False, True), ('evicted-cache', False, True, True),
             ('multiple-lods', True, False, True), ('lods-evicted-cache', True, True, True),
             ('legacy-jpeg', False, False, False), ('large-source', False, False, True)]
    with tempfile.TemporaryDirectory(prefix='nexus-lossless-test-') as temp:
        for name, multilevel, evict, lossless in cases:
            directory = Path(temp) / name
            directory.mkdir()
            side = 96 if multilevel else 40
            obj = fixture(directory, 'control', side)
            source_texture = Image.new('RGB', (8193, 8193), (7, 31, 211)) if name == 'large-source' else texture
            source_texture.save(directory / 'texture.png')
            output = directory / 'output.nxs'
            command = [executable, str(obj), '-o', str(output), '-G', '-C', '-F', '0',
                       '-f', '1024' if multilevel else '32768', '-t', '128' if multilevel else '4096', '-w', '2']
            if lossless:
                command += ['-L']
            if evict:
                command += ['-r', '4']  # Cache limit 1MiB: smaller than one base tile.
            result = subprocess.run(command, cwd=directory, capture_output=True, text=True, timeout=180)
            try:
                assert result.returncode == 0 and output.is_file(), 'Conversion failed'
                summary = verify(output, source_texture, side, multilevel, lossless)
            except Exception:
                print(result.stdout[-6000:], result.stderr[-6000:], file=sys.stderr)
                raise
            print(f'PASS {name}: {summary}', flush=True)
    print(f'All {len(cases)} texture preservation cases passed.')


if __name__ == '__main__':
    main()
