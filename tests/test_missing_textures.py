#!/usr/bin/env python3
"""Build synthetic OBJ fixtures and verify the actual geometry and lossless textures in NXS.

Usage: python3 test_missing_textures.py /path/to/nxsbuild
Requires Pillow. No application services or real customer models are used.
"""
import io
import math
from pathlib import Path
import struct
import subprocess
import sys
import tempfile

from PIL import Image

GRAY = (127, 127, 127)
TEXTURE = (240, 20, 160)
PATTERN = ((TEXTURE, (20, 210, 40)), ((20, 40, 230), (230, 140, 20)))


def rgb_at(x, y, side, rgb):
    if rgb in ("partial", "invalid") and x < side / 2:
        return GRAY
    if rgb == "white":
        return (255, 255, 255)
    if rgb == "black":
        return (0, 0, 0)
    if rgb == "gradient":
        return tuple(round(c * 255) for c in (0.2 + 0.6*x/side, 0.2 + 0.6*y/side, 0.35))
    return (64, 128, 191)


def fixture(directory, mode, side, rgb=None):
    texture = Image.new("RGB", (128, 128), TEXTURE)
    if mode == "patterned":
        for y in range(2):
            for x in range(2):
                texture.paste(PATTERN[y][x], (x * 64, y * 64, (x + 1) * 64, (y + 1) * 64))
    texture.save(directory / "texture.png")
    Image.new("RGBA", (1, 1), (0, 0, 0, 0)).save(directory / "transparent.png")
    (directory / "model.mtl").write_text(
        "newmtl textured\nKd 1 1 1\nmap_Kd texture.png\n"
        "newmtl blank\nKd 1 1 1\n"
        "newmtl transparent\nKd 1 1 1\nmap_Kd transparent.png\n"
    )
    if mode == "no_material":
        (directory / "model.mtl").unlink()  # Nexus also probes the OBJ basename.
    lines = ["mtllib model.mtl"] if mode != "no_material" else []
    for y in range(side + 1):
        for x in range(side + 1):
            vertex = f"v {x} {y} {0.1 * math.sin(x / 5) * math.cos(y / 5)}"
            if rgb:
                if rgb == "partial" and x < side / 2:
                    pass
                elif rgb == "invalid" and x < side / 2:
                    vertex += " nan 0.5 0.5"
                else:
                    vertex += " " + " ".join(str(c / 255) for c in rgb_at(x, y, side, rgb))
            lines.extend((vertex, f"vt {0.1 + 0.8 * x / side} {0.1 + 0.8 * y / side}"))
    special = (side + 1) ** 2 + 1
    lines.append("vt nan 0.5" if mode == "nonfinite" else "vt 0.5 0.5" if mode == "transparent" else "vt 0 0")
    for y in range(side):
        for x in range(side):
            blank = mode == "all_blank" or (side / 4 <= x < 3 * side / 4
                                             and side / 4 <= y < 3 * side / 4)
            material = "blank" if blank and mode in ("mixed", "mixed_uv", "all_blank", "patterned") else "textured"
            if blank and mode == "transparent":
                material = "transparent"
            if mode != "no_material":
                lines.append(f"usemtl {material}")
            a = y * (side + 1) + x + 1
            for triangle in ((a, a + 1, a + side + 2), (a, a + side + 2, a + side + 1)):
                indices = []
                for corner, vertex in enumerate(triangle):
                    if mode == "no_material" or (blank and mode in ("mixed", "missing_uv", "all_blank", "patterned")):
                        indices.append(str(vertex))
                    elif blank and mode == "partial_uv" and corner == 0:
                        indices.append(str(vertex))
                    elif blank and mode == "out_of_range" and corner == 0:
                        indices.append(f"{vertex}/{special + 1000}")
                    elif blank and mode == "nonfinite" and corner == 0:
                        indices.append(f"{vertex}/{special}")
                    elif blank and mode == "transparent":
                        indices.append(f"{vertex}/{special}")
                    elif mode == "zero_uv":
                        indices.append(f"{vertex}/{special}")
                    else:
                        indices.append(f"{vertex}/{vertex}")
                lines.append("f " + " ".join(indices))
    path = directory / "model.obj"
    path.write_text("\n".join(lines) + "\n")
    return path


class Nxs:
    def __init__(self, path):
        self.data = path.read_bytes()
        assert self.u32(0) == 0x4E787320, "Missing/corrupt NXS header"
        assert self.u32(56) == 0, "Test expects uncompressed NXS"
        self.nodes_count, self.patches_count, self.textures_count = struct.unpack_from("<III", self.data, 60)
        self.normals, self.colors, self.uvs = (bool(self.data[i]) for i in (27, 29, 31))
        self.vertex_size = 12 + 6 * self.normals + 4 * self.colors + 8 * self.uvs
        self.patch_base = 88 + self.nodes_count * 44
        self.texture_base = self.patch_base + self.patches_count * 12
        self.textures = {}

    def u32(self, offset):
        return struct.unpack_from("<I", self.data, offset)[0]

    def image(self, texture):
        if texture not in self.textures:
            begin = self.u32(self.texture_base + texture * 68) * 256
            end = self.u32(self.texture_base + (texture + 1) * 68) * 256
            self.textures[texture] = Image.open(io.BytesIO(self.data[begin:end])).convert("RGB")
        return self.textures[texture]

    def nodes(self):
        for index in range(self.nodes_count - 1):
            base = 88 + index * 44
            offset = self.u32(base) * 256
            nv, nf = struct.unpack_from("<HH", self.data, base + 4)
            first_patch = self.u32(base + 40)
            last_patch = self.u32(base + 44 + 40)
            positions = [struct.unpack_from("<fff", self.data, offset + i * 12) for i in range(nv)]
            uv_offset = offset + nv * 12
            uvs = [struct.unpack_from("<ff", self.data, uv_offset + i * 8) for i in range(nv)] if self.uvs else []
            color_offset = offset + nv * (12 + 8 * self.uvs + 6 * self.normals)
            colors = [tuple(self.data[color_offset + i * 4:color_offset + i * 4 + 4]) for i in range(nv)] if self.colors else []
            face_offset = offset + nv * self.vertex_size
            triangles = [struct.unpack_from("<HHH", self.data, face_offset + i * 6) for i in range(nf)]
            assert all(math.isfinite(c) for p in positions for c in p)
            assert all(math.isfinite(c) and -1e-6 <= c <= 1 + 1e-6 for uv in uvs for c in uv), "Invalid output UV"
            assert all(v < nv for triangle in triangles for v in triangle), "Invalid output triangle"
            yield index, positions, uvs, colors, triangles, range(first_patch, last_patch)


def sample(image, uv):
    # Match LINEAR + CLAMP_TO_EDGE and the viewer's UNPACK_FLIP_Y_WEBGL.
    x = max(0, min(image.width - 1, uv[0] * image.width - 0.5))
    y = max(0, min(image.height - 1, (1 - uv[1]) * image.height - 0.5))
    x0, y0 = math.floor(x), math.floor(y)
    x1, y1 = min(x0 + 1, image.width - 1), min(y0 + 1, image.height - 1)
    dx, dy = x - x0, y - y0
    pixels = [image.getpixel(p) for p in ((x0, y0), (x1, y0), (x0, y1), (x1, y1))]
    return tuple((1 - dy) * ((1 - dx) * pixels[0][c] + dx * pixels[1][c]) +
                 dy * ((1 - dx) * pixels[2][c] + dx * pixels[3][c]) for c in range(3))


def close(actual, expected, context, tolerance=4):
    assert max(abs(a - b) for a, b in zip(actual, expected)) <= tolerance, f"{context}: expected {expected}, got {actual}"


def check(path, mode, side, colors, multilevel, pow2, rgb=None):
    mesh = Nxs(path)
    assert mesh.colors == colors
    if multilevel:
        assert mesh.nodes_count > 4, "Fixture did not create multiple nodes"
        children = [mesh.u32(mesh.patch_base + p * 12) for p in range(mesh.patches_count)]
        assert any(c != mesh.nodes_count - 1 for c in children), "Fixture did not create parent LODs"
    checked_gray = checked_texture = blank_nodes = parent_fallback = 0
    for index, positions, uvs, vertex_colors, triangles, patches in mesh.nodes():
        if colors:
            assert all(c[3] == 255 for c in vertex_colors), "Unexpected vertex alpha"
            if not rgb:
                assert all(c == (255, 255, 255, 255) for c in vertex_colors), "Unexpected/uninitialized vertex colors"
        if mode == "no_material":
            assert not mesh.uvs
            if rgb and colors:
                for pos, color in zip(positions, vertex_colors):
                    close(color[:3], rgb_at(pos[0]+side/2, pos[1]+side/2, side, rgb), "untextured RGB", tolerance=2)
            continue
        assert mesh.uvs
        first_face = 0
        node_gray = node_texture = 0
        for p in patches:
            child, last_face, texture = struct.unpack_from("<III", mesh.data, mesh.patch_base + p * 12)
            image = mesh.image(texture)
            if pow2:
                assert image.width & (image.width - 1) == 0 and image.height & (image.height - 1) == 0
            for triangle in triangles[first_face:last_face]:
                pts = [positions[v] for v in triangle]
                coords = [uvs[v] for v in triangle]
                # Leave a wide margin around the material seam: coarse LODs can
                # move geometry across the original boundary.
                interior = all(abs(p[0]) < side / 8 and abs(p[1]) < side / 8 for p in pts)
                exterior = any(all(sign * p[axis] > 3 * side / 8 for p in pts)
                               for sign in (-1, 1) for axis in (0, 1))
                fallback = mode == "all_blank" or (interior and mode not in ("control", "zero_uv"))
                textured = mode in ("control", "zero_uv") or exterior
                if not (fallback or textured):
                    continue
                uv = tuple(sum(v[c] for v in coords) / 3 for c in (0, 1))
                context = f"{mode}, node {index}, child {child}, uv {uv}"
                if fallback:
                    assert coords[0] == coords[1] == coords[2], f"{context}: fallback face must use constant UVs"
                    swatch = (255, 255, 255) if rgb and colors else GRAY
                    close(sample(image, uv), swatch, context)
                    if rgb and colors:
                        for vertex in triangle:
                            pos, color = positions[vertex], vertex_colors[vertex]
                            expected_color = rgb_at(pos[0]+side/2, pos[1]+side/2, side, rgb)
                            # Keep strict original-color checks at leaves; parents are
                            # resampled by geometric simplification.
                            if not multilevel or child == mesh.nodes_count - 1 or rgb != "gradient":
                                if rgb not in ("partial", "invalid") or abs(pos[0]) > 2:
                                    close(color[:3], expected_color, context + " vertex RGB", tolerance=2)
                            else:
                                assert 49 <= color[0] <= 206 and 49 <= color[1] <= 206
                                close((color[2],), (89,), context + " parent RGB", tolerance=2)
                    # Check a neighborhood around the sample, not just one lucky texel.
                    for dx, dy in ((-2, -2), (2, 2), (-2, 2), (2, -2)):
                        close(sample(image, (uv[0] + dx / image.width, uv[1] + dy / image.height)), swatch, context)
                    checked_gray += 1
                    parent_fallback += child != mesh.nodes_count - 1
                    node_gray += 1
                else:
                    if rgb and colors:
                        assert all(vertex_colors[v] == (255, 255, 255, 255) for v in triangle), context + ": vertex RGB tinted a photograph"
                    expected = TEXTURE
                    if mode == "patterned":
                        # Parent LODs may reduce the entire 128px source to a few
                        # pixels, legitimately averaging quadrants together. Check
                        # source quadrant identity at the full-detail leaves instead.
                        # Gray fallback checks above still cover every parent LOD.
                        if multilevel and child != mesh.nodes_count - 1:
                            continue
                        x = sum(p[0] for p in pts) / 3
                        y = sum(p[1] for p in pts) / 3
                        if abs(x) < 3 or abs(y) < 3:
                            continue  # Exclude filtering across source quadrant borders.
                        expected = PATTERN[int(y < 0)][int(x > 0)]
                    actual = sample(image, uv)
                    if mode == "patterned" and multilevel:
                        # JPEG blends adjacent colors in small atlas rectangles.
                        # Verify quadrant identity without requiring lossless RGB.
                        palette = [color for row in PATTERN for color in row]
                        nearest = min(palette, key=lambda color: sum((a - b) ** 2 for a, b in zip(actual, color)))
                        assert nearest == expected, f"{context}: quadrant changed: {actual}, expected {expected}"
                    else:
                        close(actual, expected, context, tolerance=10)
                    checked_texture += 1
                    node_texture += 1
            first_face = last_face
        if node_gray and not node_texture:
            blank_nodes += 1
    if mode not in ("control", "zero_uv", "no_material"):
        assert checked_gray > 0, "No fallback triangles checked"
    if mode not in ("all_blank", "no_material"):
        assert checked_texture > 0, "No textured triangles checked"
    if multilevel:
        assert parent_fallback > 0, "No reduced-detail fallback triangles checked"
    if mode == "all_blank":
        assert blank_nodes > 0
    return f"{mesh.nodes_count - 1} nodes; {checked_gray} gray / {checked_texture} textured triangles"


def main():
    executable = str(Path(sys.argv[1]).resolve())
    cases = [(mode, flag, False, False) for mode in (
        "control", "mixed", "mixed_uv", "missing_uv", "partial_uv", "out_of_range",
        "nonfinite", "zero_uv", "all_blank", "no_material", "patterned", "transparent") for flag in ("-C", "-c")]
    cases += [(mode, "-C", True, False) for mode in ("mixed", "missing_uv", "all_blank", "patterned", "transparent")]
    cases += [("mixed", "-c", True, True)]
    cases = [(*case, None) for case in cases]
    cases += [(mode, "-C", multi, False, rgb) for mode in ("mixed", "transparent", "missing_uv")
              for multi in (False, True) for rgb in ("constant", "gradient")]
    cases += [("transparent", "-C", False, False, rgb) for rgb in ("partial", "invalid", "white", "black")]
    cases += [("transparent", "-c", True, False, "gradient"),
              ("transparent", "-C", True, True, "gradient"),
              ("no_material", "-C", False, False, "gradient")]
    with tempfile.TemporaryDirectory(prefix="nexus-fallback-test-") as temp:
        for i, (mode, flag, multilevel, pow2, rgb) in enumerate(cases):
            directory = Path(temp) / str(i)
            directory.mkdir()
            side = 96 if multilevel else 40
            source = fixture(directory, mode, side, rgb)
            output = directory / "output.nxs"
            command = [executable, str(source), "-o", str(output), "-G", flag, "-L",
                       "-f", "1024" if multilevel else "32768", "-t", "128" if multilevel else "4096", "-w", "2"]
            if pow2:
                command.append("-k")
            result = subprocess.run(command, cwd=directory, capture_output=True, text=True, timeout=120)
            try:
                assert result.returncode == 0 and output.is_file(), f"Conversion failed: {result.returncode}"
                summary = check(output, mode, side, flag == "-C", multilevel, pow2, rgb)
            except Exception:
                print(result.stdout[-6000:], result.stderr[-6000:], file=sys.stderr)
                raise
            print(f"PASS {mode} {flag} multi={multilevel} pow2={pow2} rgb={rgb}: {summary}", flush=True)
    print(f"All {len(cases)} Nexus texture regression cases passed.")


if __name__ == "__main__":
    main()
