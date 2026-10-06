"""Builds every low-poly game model into the scene "CottonFarmAssets".

Run inside Blender:  exec(open('tools/blender/build_models.py').read())
Then run tools/blender/export_models.py to validate and export public/models/assets.glb.

Conventions (Blender is Z-up; glTF export converts to three.js Y-up):
  * Each asset is a root Empty named "<asset>" with mesh children "<asset>_<part>".
  * Animated parts are separate children with their pivot at the object origin.
  * Characters face -Y in Blender, which becomes +Z (the game's forward) in three.js.
  * Material names are stable; "land_top" and "petal" are recoloured at runtime.
"""
import math
import random

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

SCENE_NAME = 'CottonFarmAssets'
rng = random.Random(7)


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def material(name, hex_color):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    rgb = [srgb_to_linear(int(hex_color[i:i + 2], 16) / 255) for i in (1, 3, 5)]
    mat.diffuse_color = (*rgb, 1)
    if mat.node_tree is None:
        try:
            mat.use_nodes = True
        except AttributeError:
            pass
    bsdf = mat.node_tree.nodes.get('Principled BSDF') if mat.node_tree else None
    if bsdf:
        bsdf.inputs['Base Color'].default_value = (*rgb, 1)
        bsdf.inputs['Roughness'].default_value = 0.9
        bsdf.inputs['Metallic'].default_value = 0.0
    return mat


# Palette lifted from the game's existing toon colours.
M = {k: material(k, v) for k, v in {
    'goblin_skin': '#77a85a', 'orc_skin': '#5f9f5a', 'bat_fur': '#76518e', 'bat_wing': '#5b3d70',
    'cream': '#fff5df', 'pupil': '#3b2d24', 'cloth': '#9a6b45', 'cloth_dark': '#6f4a31',
    'belt': '#5a3d29', 'tusk': '#f5e3b0', 'metal': '#7d7d7d', 'metal_dark': '#4d4d4d',
    'iron': '#2f2f2f', 'wood': '#8f5e42', 'wood_light': '#a9794f', 'wood_dark': '#5a4a3a',
    'hay': '#d9a83f', 'hay_light': '#ecc260', 'rope': '#c79a5a', 'leaf': '#4f7f46',
    'leaf_light': '#79a64d', 'stem': '#578341', 'trunk': '#8f6245', 'pot': '#c75e42',
    'pot_rim': '#e48a4c', 'soup': '#a94835', 'beet': '#7a2747', 'dill': '#668c4f',
    'star': '#ffe98a', 'sky_blue': '#75b4cf', 'sky_dark': '#4f87a0', 'cotton': '#fff5db',
    'land_top': '#84a567', 'dirt': '#8f6245', 'dirt_dark': '#6e4c36', 'stone': '#9a948a',
    'thatch': '#c9a24f', 'flag_goblin': '#77a85a', 'flag_orc': '#b5483a', 'hide': '#7b5a44',
    'petal': '#f6c85f', 'petal_center': '#f0e2b6', 'red': '#d0563f',
}.items()}


def trs(loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
    s = Matrix.Diagonal((*scale, 1))
    return Matrix.Translation(loc) @ Euler(rot).to_matrix().to_4x4() @ s


class Part:
    """Accumulates primitives into one mesh with per-primitive material slots."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.mats = []

    def _commit(self, verts, mat, jitter=0.0):
        verts = list(verts)
        bmesh.ops.remove_doubles(self.bm, verts=verts, dist=1e-6)
        verts = [v for v in verts if v.is_valid]
        if jitter:
            for v in verts:
                v.co += Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))) * jitter
        if mat not in self.mats:
            self.mats.append(mat)
        index = self.mats.index(mat)
        faces = {f for v in verts for f in v.link_faces}
        for f in faces:
            f.material_index = index
        bmesh.ops.recalc_face_normals(self.bm, faces=list(faces))
        return verts

    def _poly(self, rings, mat, matrix, jitter=0.0, cap_bottom=True, cap_top=True):
        """Loft through rings of local points; a ring of one point is an apex."""
        bm = self.bm
        vrings = [[bm.verts.new(matrix @ Vector(p)) for p in ring] for ring in rings]
        for a, b in zip(vrings, vrings[1:]):
            n = max(len(a), len(b))
            for i in range(n):
                j = (i + 1) % n
                if len(a) == 1:
                    bm.faces.new((a[0], b[j], b[i]))
                elif len(b) == 1:
                    bm.faces.new((a[i], a[j], b[0]))
                else:
                    bm.faces.new((a[i], a[j], b[j], b[i]))
        if cap_bottom and len(vrings[0]) > 2:
            bm.faces.new(list(reversed(vrings[0])))
        if cap_top and len(vrings[-1]) > 2:
            bm.faces.new(vrings[-1])
        return self._commit([v for r in vrings for v in r], mat, jitter)

    def frustum(self, r1, r2, h, seg, mat, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), jitter=0.0, twist=0.0):
        """Base sits at loc; r2 == 0 makes a cone."""
        ring = lambda r, z: [(r * math.cos(2 * math.pi * i / seg + twist), r * math.sin(2 * math.pi * i / seg + twist), z) for i in range(seg)]
        top = [(0, 0, h)] if r2 == 0 else ring(r2, h)
        return self._poly([ring(r1, 0), top], mat, trs(loc, rot, scale), jitter)

    def lathe(self, profile, seg, mat, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), jitter=0.0, twist=0.0):
        """profile: [(radius, z)], radius 0 at either end becomes a pole."""
        rings = []
        for r, z in profile:
            rings.append([(0, 0, z)] if r == 0 else [(r * math.cos(2 * math.pi * i / seg + twist), r * math.sin(2 * math.pi * i / seg + twist), z) for i in range(seg)])
        return self._poly(rings, mat, trs(loc, rot, scale), jitter)

    def box(self, size, mat, loc=(0, 0, 0), rot=(0, 0, 0), jitter=0.0):
        res = bmesh.ops.create_cube(self.bm, size=1.0, matrix=trs(loc, rot, size))
        return self._commit(res['verts'], mat, jitter)

    def ball(self, radius, mat, loc=(0, 0, 0), scale=(1, 1, 1), rot=(0, 0, 0), detail=1, jitter=0.0):
        res = bmesh.ops.create_icosphere(self.bm, subdivisions=detail, radius=radius, matrix=trs(loc, rot, scale))
        return self._commit(res['verts'], mat, jitter)

    def torus(self, major, minor, seg, sides, mat, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
        bm, matrix = self.bm, trs(loc, rot, scale)
        grid = []
        for i in range(seg):
            a = 2 * math.pi * i / seg
            row = []
            for j in range(sides):
                b = 2 * math.pi * j / sides
                r = major + minor * math.cos(b)
                row.append(bm.verts.new(matrix @ Vector((r * math.cos(a), r * math.sin(a), minor * math.sin(b)))))
            grid.append(row)
        for i in range(seg):
            for j in range(sides):
                i2, j2 = (i + 1) % seg, (j + 1) % sides
                bm.faces.new((grid[i][j], grid[i2][j], grid[i2][j2], grid[i][j2]))
        return self._commit([v for r in grid for v in r], mat)

    def prism(self, outline, thickness, mat, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
        """Extrude a convex-or-star 2D outline (XY, CCW) along Z, centred on Z=0."""
        bm, matrix = self.bm, trs(loc, rot, scale)
        lo = [bm.verts.new(matrix @ Vector((x, y, -thickness / 2))) for x, y in outline]
        hi = [bm.verts.new(matrix @ Vector((x, y, thickness / 2))) for x, y in outline]
        n = len(outline)
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
        # Fan from a centre vertex so concave star outlines stay valid.
        cx = sum(p[0] for p in outline) / n
        cy = sum(p[1] for p in outline) / n
        c_lo = bm.verts.new(matrix @ Vector((cx, cy, -thickness / 2)))
        c_hi = bm.verts.new(matrix @ Vector((cx, cy, thickness / 2)))
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((c_lo, lo[j], lo[i]))
            bm.faces.new((c_hi, hi[i], hi[j]))
        return self._commit(lo + hi + [c_lo, c_hi], mat)

    def build(self, parent, collection, loc=(0, 0, 0)):
        mesh = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        for mat in self.mats:
            mesh.materials.append(mat)
        for poly in mesh.polygons:
            poly.use_smooth = False
        obj = bpy.data.objects.new(self.name, mesh)
        collection.objects.link(obj)
        obj.parent = parent
        obj.location = loc
        return obj


class Asset:
    def __init__(self, name, collection, slot):
        self.name = name
        self.collection = collection
        self.root = bpy.data.objects.new(name, None)
        self.root.empty_display_size = 0.2
        self.root.location = ((slot % 6) * 3.0, -(slot // 6) * 3.0, 0)
        collection.objects.link(self.root)

    def part(self, suffix):
        return Part(f'{self.name}_{suffix}')

    def add(self, part, loc=(0, 0, 0)):
        return part.build(self.root, self.collection, loc)


def reset_scene():
    scene = bpy.data.scenes.get(SCENE_NAME) or bpy.data.scenes.new(SCENE_NAME)
    for obj in list(scene.collection.all_objects):
        mesh = obj.data if obj.type == 'MESH' else None
        bpy.data.objects.remove(obj, do_unlink=True)
        if mesh and mesh.users == 0:
            bpy.data.meshes.remove(mesh)
    for child in list(scene.collection.children):
        bpy.data.collections.remove(child)
    collection = bpy.data.collections.new('GameAssets')
    scene.collection.children.link(collection)
    return scene, collection


# --------------------------------------------------------------------------- characters

def eyes(p, x, y, z, r=0.055):
    for sx in (-1, 1):
        p.ball(r, M['cream'], (sx * x, y, z), scale=(1, 0.7, 1.1))
        p.ball(r * 0.5, M['pupil'], (sx * x, y - r * 0.55, z - r * 0.1), scale=(1, 0.6, 1.1))


def goblin(a):
    p = a.part('body')
    for sx in (-1, 1):  # boots
        p.ball(0.085, M['belt'], (sx * 0.1, -0.03, 0.06), scale=(1, 1.35, 0.75))
        p.frustum(0.05, 0.045, 0.16, 6, M['goblin_skin'], (sx * 0.1, 0, 0.08))
    p.lathe([(0, 0.2), (0.17, 0.21), (0.22, 0.3), (0.2, 0.48), (0.15, 0.56), (0, 0.57)], 8, M['cloth'], twist=0.2)
    p.torus(0.205, 0.028, 8, 4, M['belt'], (0, 0, 0.34))
    p.box((0.06, 0.03, 0.05), M['star'], (0, -0.225, 0.34))
    for sx in (-1, 1):  # arms
        p.frustum(0.045, 0.04, 0.24, 5, M['goblin_skin'], (sx * 0.2, 0, 0.5), rot=(0, sx * 2.75, 0))
        p.ball(0.05, M['goblin_skin'], (sx * 0.29, -0.02, 0.29))
    p.ball(0.235, M['goblin_skin'], (0, 0, 0.71), scale=(1.05, 0.95, 0.92))
    for sx in (-1, 1):  # big pointy ears
        p.frustum(0.07, 0, 0.26, 4, M['goblin_skin'], (sx * 0.19, 0.02, 0.76), rot=(0, sx * 1.25, 0), scale=(1, 0.45, 1))
    eyes(p, 0.085, -0.19, 0.76)
    p.frustum(0.04, 0, 0.12, 5, M['goblin_skin'], (0, -0.2, 0.68), rot=(math.pi / 2 + 0.25, 0, 0))
    p.frustum(0.16, 0.05, 0.12, 6, M['cloth_dark'], (0, 0.04, 0.88), rot=(-0.25, 0, 0))  # floppy cap
    p.ball(0.045, M['cream'], (0, 0.1, 0.99))
    p.ball(0.12, M['cream'], (0.06, 0.2, 0.42), scale=(1, 0.8, 1.15), jitter=0.01)  # loot sack
    p.frustum(0.03, 0.04, 0.06, 5, M['rope'], (0.06, 0.2, 0.54))
    a.add(p)


def orc(a):
    p = a.part('body')
    for sx in (-1, 1):
        p.box((0.13, 0.2, 0.1), M['hide'], (sx * 0.12, -0.03, 0.05))
        p.frustum(0.07, 0.065, 0.18, 6, M['orc_skin'], (sx * 0.12, 0, 0.09))
    p.lathe([(0, 0.24), (0.22, 0.25), (0.29, 0.38), (0.28, 0.58), (0.2, 0.68), (0, 0.69)], 7, M['hide'], twist=0.3)
    p.torus(0.28, 0.035, 7, 4, M['belt'], (0, 0, 0.42))
    p.lathe([(0.3, 0.58), (0.31, 0.64), (0, 0.66)], 7, M['metal_dark'], twist=0.3)  # shoulder plate
    for sx in (-1, 1):
        p.ball(0.09, M['metal'], (sx * 0.29, 0, 0.63), scale=(1, 1, 0.75))
        p.frustum(0.065, 0.055, 0.3, 6, M['orc_skin'], (sx * 0.29, 0, 0.6), rot=(0, sx * 2.85, 0))
        p.ball(0.07, M['orc_skin'], (sx * 0.34, -0.02, 0.3))
    p.box((0.38, 0.34, 0.3), M['orc_skin'], (0, -0.02, 0.81), jitter=0.012)  # blocky head
    p.box((0.34, 0.12, 0.12), M['orc_skin'], (0, -0.17, 0.72))  # jaw
    for sx in (-1, 1):
        p.frustum(0.036, 0, 0.15, 5, M['tusk'], (sx * 0.12, -0.235, 0.72), rot=(-0.35, sx * 0.2, 0))
        p.frustum(0.06, 0, 0.13, 4, M['orc_skin'], (sx * 0.19, 0.0, 0.84), rot=(0, sx * 1.4, 0), scale=(1, 0.5, 1))
    eyes(p, 0.08, -0.18, 0.86, r=0.045)
    p.box((0.3, 0.05, 0.035), M['belt'], (0, -0.19, 0.92))  # grumpy brow
    p.lathe([(0.21, 0.92), (0.2, 1.0), (0.12, 1.06), (0, 1.07)], 7, M['metal_dark'], twist=0.3)  # helmet
    for sx in (-1, 1):
        p.frustum(0.035, 0, 0.14, 5, M['tusk'], (sx * 0.15, 0, 0.99), rot=(0, sx * 0.9, 0))
    a.add(p)


def bat(a):
    p = a.part('body')
    p.ball(0.17, M['bat_fur'], (0, 0, 0), scale=(1, 0.95, 1.1), jitter=0.008)
    for sx in (-1, 1):
        p.frustum(0.06, 0, 0.14, 4, M['bat_fur'], (sx * 0.08, 0.02, 0.13), rot=(0, sx * 0.35, 0), scale=(1, 0.5, 1))
        p.frustum(0.018, 0, 0.05, 4, M['cream'], (sx * 0.035, -0.15, -0.03), rot=(math.pi, 0, 0))  # fangs
        p.frustum(0.022, 0.018, 0.08, 4, M['pupil'], (sx * 0.06, 0, -0.2))  # dangling feet
    eyes(p, 0.06, -0.14, 0.04, r=0.045)
    a.add(p)
    wing = [(0, 0.06), (0.16, 0.12), (0.34, 0.1), (0.44, 0.02), (0.36, -0.04), (0.3, -0.13), (0.2, -0.06), (0.12, -0.14), (0.04, -0.06)]
    for side, sx in (('l', -1), ('r', 1)):
        w = a.part(f'wing_{side}')
        pts = [(sx * x, y) for x, y in wing]
        if sx < 0:
            pts = list(reversed(pts))
        w.prism(pts, 0.02, M['bat_wing'], rot=(math.pi / 2, 0, 0))
        w.frustum(0.014, 0.01, 0.42, 4, M['bat_fur'], (0, 0, 0.08), rot=(0, sx * math.pi / 2 - sx * 0.1, 0))
        a.add(w, loc=(sx * 0.14, 0.02, 0.02))


def star(a):
    p = a.part('mesh')
    outline = []
    for i in range(10):
        r = 0.15 if i % 2 == 0 else 0.065
        ang = math.pi / 2 + i * math.pi / 5
        outline.append((r * math.cos(ang), r * math.sin(ang)))
    p.prism(outline, 0.06, M['star'], rot=(math.pi / 2, 0, 0))
    a.add(p)


# --------------------------------------------------------------------------- traps

def rake(a):
    p = a.part('handle')
    p.frustum(0.035, 0.03, 0.88, 6, M['wood'], (0, 0, 0))
    p.frustum(0.042, 0.042, 0.12, 6, M['rope'], (0, 0, 0.12))  # grip wrap
    p.box((0.46, 0.06, 0.06), M['metal'], (0, 0, 0.9))
    p.frustum(0.05, 0.035, 0.06, 6, M['metal_dark'], (0, 0, 0.84))
    for i in range(6):
        x = -0.2 + i * 0.08
        p.frustum(0.014, 0.008, 0.2, 4, M['metal'], (x, 0, 0.88), rot=(math.pi - 0.25, 0, 0))
    a.add(p)
    base = a.part('base')
    base.box((0.36, 0.36, 0.04), M['wood_light'], (0, 0, -0.02), jitter=0.004)
    base.box((0.08, 0.14, 0.05), M['metal_dark'], (0, 0, 0.0))
    a.add(base)


def haystack_plate(a):
    p = a.part('mesh')
    for i, x in enumerate((-0.19, 0, 0.19)):
        p.box((0.17, 0.56, 0.035), M['wood' if i != 1 else 'wood_light'], (x, 0, 0.018), jitter=0.004)
    p.box((0.56, 0.06, 0.03), M['wood_dark'], (0, -0.2, 0.045))
    p.box((0.56, 0.06, 0.03), M['wood_dark'], (0, 0.2, 0.045))
    for k in range(3):
        p.torus(0.16 - k * 0.025, 0.022, 10, 4, M['metal'], (0, 0, 0.08 + k * 0.045))
    p.frustum(0.025, 0.025, 0.2, 6, M['metal_dark'], (0, 0, 0.04))
    p.frustum(0.06, 0.06, 0.02, 6, M['red'], (0, 0, 0.23))
    a.add(p)


def haystack(a):
    p = a.part('mesh')
    p.lathe([(0, 0), (0.44, 0), (0.47, 0.12), (0.43, 0.3), (0.33, 0.48), (0.24, 0.62), (0.1, 0.76), (0, 0.8)], 8, M['hay'], jitter=0.018, twist=0.1)
    p.torus(0.44, 0.03, 8, 4, M['rope'], (0, 0, 0.2), rot=(0.05, 0, 0))
    for i in range(9):  # straw tufts
        ang = i * 2 * math.pi / 9
        r = 0.4 if i % 2 else 0.3
        z = 0.32 if i % 2 else 0.5
        p.frustum(0.05, 0, 0.14, 3, M['hay_light'], (math.cos(ang) * r, math.sin(ang) * r, z), rot=(math.sin(ang) * 0.9, -math.cos(ang) * 0.9, 0))
    p.frustum(0.05, 0, 0.16, 4, M['hay_light'], (0, 0, 0.74), rot=(0.2, 0, 0))
    a.add(p)


def pan_arm(a):
    p = a.part('mesh')
    for ang in (0, math.pi / 2):
        p.box((0.5, 0.08, 0.06), M['wood_dark'], (0, 0, 0.03), rot=(0, 0, ang))
    p.frustum(0.04, 0.032, 1.12, 6, M['wood_dark'], (0, 0, 0.0))
    p.frustum(0.028, 0.024, 0.72, 6, M['wood_dark'], (0, 0, 1.05), rot=(0, math.pi / 2, 0))
    p.box((0.06, 0.24, 0.035), M['wood'], (0.12, 0, 0.92), rot=(0, -0.8, 0))  # brace
    p.frustum(0.045, 0.045, 0.08, 6, M['metal_dark'], (0.7, -0.04, 1.05), rot=(math.pi / 2, 0, 0))
    a.add(p)


def pan(a):
    p = a.part('mesh')
    # Pan disc faces -Y (three +Z); handle runs back toward the pivot along -X.
    p.lathe([(0, -0.02), (0.2, -0.02), (0.23, 0.035), (0.21, 0.035), (0.18, -0.005), (0, -0.005)], 10, M['iron'], rot=(math.pi / 2, 0, 0))
    p.frustum(0.022, 0.018, 0.34, 6, M['wood'], (-0.21, 0, 0), rot=(0, -math.pi / 2, 0))
    p.frustum(0.024, 0.024, 0.04, 6, M['metal'], (-0.18, 0, 0), rot=(0, -math.pi / 2, 0))
    a.add(p)


def air_defence_mast(a):
    p = a.part('mesh')
    p.frustum(0.32, 0.26, 0.14, 6, M['sky_dark'], (0, 0, 0))
    for i in range(3):
        ang = i * 2 * math.pi / 3
        p.box((0.06, 0.06, 0.5), M['wood_dark'], (math.cos(ang) * 0.14, math.sin(ang) * 0.14, 0.32), rot=(math.sin(ang) * 0.25, -math.cos(ang) * 0.25, 0))
    p.frustum(0.12, 0.08, 1.0, 6, M['sky_blue'], (0, 0, 0.12))
    p.torus(0.1, 0.025, 6, 4, M['metal_dark'], (0, 0, 0.55))
    p.frustum(0.1, 0.1, 0.06, 6, M['metal_dark'], (0, 0, 1.08))
    a.add(p)


def air_defence_radar(a):
    p = a.part('mesh')
    p.lathe([(0.04, -0.08), (0.24, 0.0), (0.38, 0.12), (0.36, 0.13), (0.22, 0.03), (0, -0.02)], 10, M['sky_blue'], rot=(math.pi / 2 - 0.35, 0, 0))
    p.torus(0.36, 0.035, 12, 4, M['cream'], (0, -0.05, 0.04), rot=(math.pi / 2 - 0.35, 0, 0))
    p.frustum(0.02, 0.012, 0.32, 5, M['metal_dark'], (0, 0, 0), rot=(math.pi / 2 + 0.35, 0, 0))
    p.ball(0.04, M['red'], (0, -0.3, 0.11))
    a.add(p)


# --------------------------------------------------------------------------- buildings & props

def base_goblin(a):
    p = a.part('mesh')
    p.frustum(0.58, 0.52, 0.12, 7, M['stone'], jitter=0.015)
    p.frustum(0.46, 0.42, 0.42, 7, M['wood'], (0, 0, 0.1), twist=0.2)
    p.lathe([(0.62, 0.48), (0.58, 0.56), (0.32, 0.86), (0.08, 1.06), (0, 1.1)], 7, M['thatch'], jitter=0.02, twist=0.2)
    p.box((0.2, 0.06, 0.3), M['wood_dark'], (0, -0.43, 0.26))  # door
    p.ball(0.022, M['star'], (0.06, -0.47, 0.26))
    p.frustum(0.02, 0.02, 0.62, 5, M['wood_dark'], (0, 0, 0.95))
    p.prism([(0, 0), (0.26, -0.05), (0, -0.14)], 0.02, M['flag_goblin'], (0.01, 0, 1.53), rot=(math.pi / 2, 0, 0))
    a.add(p)


def base_orc(a):
    p = a.part('mesh')
    p.frustum(0.6, 0.55, 0.1, 6, M['stone'], jitter=0.015)
    p.lathe([(0.55, 0.1), (0.5, 0.35), (0.3, 0.75), (0.06, 1.05), (0, 1.07)], 6, M['hide'], jitter=0.015)
    p.prism([(-0.13, 0), (0.13, 0), (0, 0.42)], 0.04, M['cloth_dark'], (0, -0.5, 0.11), rot=(math.pi / 2 - 0.42, 0, 0))
    for i in range(6):
        ang = i * math.pi / 3 + math.pi / 6
        p.frustum(0.03, 0.02, 0.5, 4, M['wood_dark'], (math.cos(ang) * 0.12, math.sin(ang) * 0.12, 0.9), rot=(math.sin(ang) * 0.5, -math.cos(ang) * 0.5, 0))
    for sx in (-1, 1):  # bone spikes
        p.frustum(0.05, 0, 0.32, 5, M['tusk'], (sx * 0.5, -0.25, 0.08), rot=(0.3, sx * 0.4, 0))
    p.frustum(0.02, 0.02, 0.6, 5, M['wood_dark'], (0.52, 0.3, 0.05))
    p.prism([(0, 0), (0.24, 0), (0.2, -0.1), (0.24, -0.2), (0, -0.2)], 0.02, M['flag_orc'], (0.53, 0.3, 0.62), rot=(math.pi / 2, 0, 0))
    a.add(p)


def fence(a):
    p = a.part('mesh')
    for x in (-0.45, 0.45):
        p.box((0.09, 0.09, 0.6), M['trunk'], (x, 0, 0.3), jitter=0.006)
        p.frustum(0.064, 0, 0.1, 4, M['trunk'], (x, 0, 0.6), twist=math.pi / 4)
    for z, tilt in ((0.2, 0.03), (0.46, -0.02)):
        p.box((1.04, 0.05, 0.08), M['wood_light'], (0, 0.055, z), rot=(0, tilt, 0), jitter=0.004)
    a.add(p)


def tree_pine(a):
    p = a.part('mesh')
    p.frustum(0.06, 0.04, 0.3, 5, M['trunk'])
    for i, (r, z, h) in enumerate(((0.3, 0.2, 0.36), (0.24, 0.4, 0.3), (0.16, 0.58, 0.26))):
        p.frustum(r, 0, h, 7, M['leaf' if i != 1 else 'leaf_light'], (0, 0, z), jitter=0.012, twist=i * 0.4)
    a.add(p)


def tree_round(a):
    p = a.part('mesh')
    p.frustum(0.045, 0.03, 0.42, 5, M['trunk'], jitter=0.004)
    p.box((0.12, 0.02, 0.02), M['trunk'], (0.05, 0, 0.3), rot=(0, -0.7, 0))
    p.ball(0.23, M['leaf'], (0, 0, 0.52), scale=(1, 1, 0.9), jitter=0.025)
    p.ball(0.14, M['leaf_light'], (0.12, -0.08, 0.6), jitter=0.015)
    a.add(p)


def flower(a):
    p = a.part('mesh')
    p.frustum(0.012, 0.01, 0.1, 4, M['stem'])
    p.box((0.06, 0.012, 0.025), M['leaf_light'], (0.03, 0, 0.04), rot=(0, -0.5, 0))
    for i in range(5):
        ang = i * 2 * math.pi / 5
        p.ball(0.035, M['petal'], (math.cos(ang) * 0.04, math.sin(ang) * 0.04, 0.11), scale=(1, 1, 0.45), detail=1)
    p.ball(0.025, M['petal_center'], (0, 0, 0.12), scale=(1, 1, 0.6))
    a.add(p)


def pot(a):
    p = a.part('body')  # outlined by the game's silhouette pass
    p.lathe([(0, -0.315), (0.4, -0.315), (0.5, -0.15), (0.54, 0.1), (0.52, 0.3), (0, 0.3)], 8, M['pot'], twist=math.pi / 8)
    a.add(p)
    d = a.part('detail')
    d.torus(0.53, 0.07, 10, 5, M['pot_rim'], (0, 0, 0.32))
    d.frustum(0.47, 0.47, 0.02, 10, M['soup'], (0, 0, 0.28))
    for sx in (-1, 1):
        d.torus(0.08, 0.025, 6, 4, M['pot_rim'], (sx * 0.56, 0, 0.12), rot=(math.pi / 2, 0, math.pi / 2))
    for i in range(5):
        ang = i * 1.3 + 0.4
        d.box((0.08, 0.08, 0.04), M['beet'], (math.cos(ang) * 0.27, math.sin(ang) * 0.27, 0.31), rot=(0, 0, ang), jitter=0.008)
    for i in range(3):
        d.box((0.1, 0.02, 0.012), M['dill'], (0.05 * i - 0.1, 0.12 - 0.08 * i, 0.31), rot=(0, 0, i))
    d.ball(0.05, M['cream'], (-0.15, -0.18, 0.31), scale=(1, 1, 0.4))  # smetana
    d.frustum(0.022, 0.018, 0.55, 5, M['wood'], (0.18, 0.12, 0.2), rot=(-0.5, 0.45, 0))  # ladle
    d.ball(0.07, M['wood'], (0.06, 0.04, 0.25), scale=(1, 1, 0.55))
    a.add(d)


def cotton_plant(a):
    p = a.part('mesh')
    p.frustum(0.028, 0.016, 0.3, 5, M['stem'])
    for sx in (-1, 1):
        p.ball(0.08, M['leaf_light'], (sx * 0.08, 0, 0.12), scale=(1.3, 0.7, 0.4), rot=(0, sx * 0.3, 0))
    p.ball(0.06, M['leaf'], (0, 0.07, 0.2), scale=(0.7, 1.3, 0.4), rot=(-0.3, 0, 0))
    a.add(p)
    b = a.part('boll')
    for i in range(4):
        ang = i * 2 * math.pi / 3
        loc = (0, 0, 0.06) if i == 3 else (math.cos(ang) * 0.055, math.sin(ang) * 0.055, (i % 2) * 0.03)
        b.ball(0.085, M['cotton'], loc, jitter=0.006)
    for i in range(3):
        ang = i * 2 * math.pi / 3 + 0.5
        b.frustum(0.04, 0, 0.07, 3, M['stem'], (math.cos(ang) * 0.06, math.sin(ang) * 0.06, -0.06), rot=(math.sin(ang) * 2.2, -math.cos(ang) * 2.2, 0))
    a.add(b, loc=(0, 0, 0.29))


def cotton_ball(a):
    p = a.part('mesh')
    p.ball(0.24, M['cotton'], jitter=0.02)
    for i in range(6):
        ang = i * math.pi / 3
        p.ball(0.13, M['cotton'], (math.cos(ang) * 0.18, math.sin(ang) * 0.18, 0.06 * (i % 2) - 0.02), jitter=0.01)
    p.ball(0.14, M['cotton'], (0, 0, 0.18), jitter=0.01)
    a.add(p)


# --------------------------------------------------------------------------- platforms

def land(a):
    """Unit footprint (scaled per slot in game). Centred vertically: top at +0.31."""
    p = a.part('mesh')
    # Square lathe: radius 0.7071 gives a 1.0 wide edge.
    p.lathe([(0.0, 0.31), (0.67, 0.31), (0.7071, 0.26), (0.7071, 0.19), (0.0, 0.19)], 4, M['land_top'], twist=math.pi / 4)
    p.lathe([(0.0, 0.2), (0.65, 0.2), (0.59, 0.02), (0.41, -0.17), (0.18, -0.3), (0.0, -0.3)], 4, M['dirt'], twist=math.pi / 4, jitter=0.008)
    for i, (x, y) in enumerate(((0.3, -0.31), (-0.33, 0.24), (0.33, 0.33), (-0.3, -0.2))):
        p.ball(0.06 + 0.015 * (i % 2), M['dirt_dark' if i % 2 else 'stone'], (x, y, -0.02 - 0.06 * i), scale=(1, 1, 0.7), jitter=0.01)
    a.add(p)


def bridge_plank(a):
    p = a.part('mesh')
    p.box((0.5, 0.19, 0.05), M['wood_light'], (0, 0, -0.025), jitter=0.006)
    for sx in (-1, 1):
        p.box((0.04, 0.2, 0.04), M['rope'], (sx * 0.2, 0, -0.025))
    a.add(p)


BUILDERS = [
    ('goblin', goblin), ('orc', orc), ('bat', bat), ('star', star),
    ('rake', rake), ('haystack_plate', haystack_plate), ('haystack', haystack),
    ('pan_arm', pan_arm), ('pan', pan), ('air_defence_mast', air_defence_mast), ('air_defence_radar', air_defence_radar),
    ('base_goblin', base_goblin), ('base_orc', base_orc), ('fence', fence), ('tree_pine', tree_pine),
    ('tree_round', tree_round), ('flower', flower), ('pot', pot), ('cotton_plant', cotton_plant),
    ('cotton_ball', cotton_ball), ('land', land), ('bridge_plank', bridge_plank),
]


def build_all():
    scene, collection = reset_scene()
    for slot, (name, fn) in enumerate(BUILDERS):
        fn(Asset(name, collection, slot))
    return scene


build_all()
