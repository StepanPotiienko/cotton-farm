"""Validates the CottonFarmAssets scene, then exports public/models/assets.glb.

Run inside Blender after build_models.py:
    exec(open('tools/blender/export_models.py').read()); export('<repo>/public/models/assets.glb')
The export is refused when any structural check fails. After export the GLB is
re-imported into a scratch scene and validated again, so the file on disk is
what was checked.
"""
import math
import os

import bmesh
import bpy

SCENE_NAME = 'CottonFarmAssets'

# Generous upper bounds (Blender X, Y, Z metres) that catch scale/units mistakes.
MAX_DIMS = {
    'goblin': (0.95, 0.65, 1.1), 'orc': (0.9, 0.7, 1.15), 'bat': (1.25, 0.5, 0.6), 'star': (0.35, 0.1, 0.35),
    'rake': (0.5, 0.4, 1.0), 'haystack_plate': (0.6, 0.6, 0.3), 'haystack': (1.0, 1.0, 0.95),
    'pan_arm': (1.05, 0.55, 1.2), 'pan': (0.85, 0.15, 0.5), 'air_defence_mast': (0.7, 0.7, 1.2),
    'air_defence_radar': (0.85, 0.7, 0.85), 'base_goblin': (1.3, 1.3, 1.6), 'base_orc': (1.45, 1.3, 1.4),
    'fence': (1.1, 0.2, 0.75), 'tree_pine': (0.7, 0.7, 0.9), 'tree_round': (0.6, 0.6, 0.8),
    'flower': (0.15, 0.15, 0.16), 'pot': (1.3, 1.3, 1.0), 'cotton_plant': (0.4, 0.4, 0.5),
    'cotton_ball': (0.7, 0.7, 0.6), 'land': (1.01, 1.01, 0.63), 'bridge_plank': (0.55, 0.25, 0.06),
}
REQUIRED_PARTS = {
    'goblin': ['body'], 'orc': ['body'], 'bat': ['body', 'wing_l', 'wing_r'], 'rake': ['handle', 'base'],
    'pot': ['body', 'detail'], 'cotton_plant': ['mesh', 'boll'],
}
RECOLOURED = {'land': 'land_top', 'flower': 'petal'}


def islands(bm):
    seen, out = set(), []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, island = [f], []
        seen.add(f.index)
        while stack:
            cur = stack.pop()
            island.append(cur)
            for e in cur.edges:
                for nb in e.link_faces:
                    if nb.index not in seen:
                        seen.add(nb.index)
                        stack.append(nb)
        out.append(island)
    return out


def check_mesh(obj, weld=False):
    errs = []
    if any(abs(s - 1) > 1e-6 for s in obj.scale) or any(abs(r) > 1e-6 for r in obj.rotation_euler):
        errs.append('unapplied rotation/scale')
    me = obj.data
    if not me.materials or any(m is None for m in me.materials):
        errs.append('missing material slot')
    bm = bmesh.new()
    bm.from_mesh(me)
    if weld:  # glTF splits flat-shaded vertices per face; weld before topology checks
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.faces.ensure_lookup_table()
    bm.faces.index_update()
    if any(not all(math.isfinite(c) for c in v.co) for v in bm.verts):
        errs.append('non-finite vertex')
    loose = sum(1 for v in bm.verts if not v.link_faces)
    wire = sum(1 for e in bm.edges if not e.link_faces)
    nonman = sum(1 for e in bm.edges if not e.is_manifold)
    degenerate = sum(1 for f in bm.faces if f.calc_area() < 1e-9)
    bad_mi = sum(1 for f in bm.faces if f.material_index >= max(1, len(me.materials)))
    inverted = 0
    for island in islands(bm):
        vol = 0.0
        for f in island:
            vs = [l.vert.co for l in f.loops]
            for i in range(1, len(vs) - 1):
                vol += vs[0].dot(vs[i].cross(vs[i + 1])) / 6
        if vol <= 0:
            inverted += 1
    tris = sum(len(f.verts) - 2 for f in bm.faces)
    bm.free()
    for label, n in (('loose verts', loose), ('wire edges', wire), ('non-manifold edges', nonman),
                     ('degenerate faces', degenerate), ('bad material index', bad_mi), ('inside-out islands', inverted)):
        if n:
            errs.append(f'{n} {label}')
    return errs, tris


def validate(objects):
    report, failures, total = {}, [], 0
    roots = [o for o in objects if o.parent is None]
    for root in roots:
        name = root.name.split('.')[0]
        kids = [c for c in root.children if c.type == 'MESH']
        entry = {'parts': sorted(c.name for c in kids), 'tris': 0}
        problems = []
        if not kids:
            problems.append('no mesh children')
        for part in REQUIRED_PARTS.get(name, []):
            if not any(c.name.startswith(f'{name}_{part}') for c in kids):
                problems.append(f'missing part {part}')
        lo = [math.inf] * 3
        hi = [-math.inf] * 3
        for c in kids:
            errs, tris = check_mesh(c)
            entry['tris'] += tris
            problems += [f'{c.name}: {e}' for e in errs]
            for v in c.data.vertices:
                w = c.location + v.co  # parts carry only a pivot offset
                for i in range(3):
                    lo[i] = min(lo[i], w[i]); hi[i] = max(hi[i], w[i])
        dims = [round(hi[i] - lo[i], 3) for i in range(3)]
        entry['dims'] = dims
        limit = MAX_DIMS.get(name)
        if limit is None:
            problems.append('unknown asset')
        elif any(d > m for d, m in zip(dims, limit)):
            problems.append(f'dims {dims} exceed {limit}')
        if name in RECOLOURED and not any(m and m.name.startswith(RECOLOURED[name]) for c in kids for m in c.data.materials):
            problems.append(f'missing recolour material {RECOLOURED[name]}')
        if problems:
            failures.append({name: problems})
        total += entry['tris']
        report[name] = entry
    return {'assets': len(roots), 'tris': total, 'failures': failures, 'report': report}


def export(path):
    scene = bpy.data.scenes[SCENE_NAME]
    pre = validate(list(scene.collection.all_objects))
    if pre['failures']:
        return {'exported': False, 'pre': pre}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    window = bpy.context.window
    previous = window.scene
    window.scene = scene
    saved = {r.name: tuple(r.location) for r in scene.collection.all_objects if r.parent is None}
    try:
        for obj in scene.collection.all_objects:
            obj.hide_set(False)
            obj.select_set(obj.name in saved or obj.parent is not None)
        for name in saved:  # export every root at the origin
            scene.objects[name].location = (0, 0, 0)
        bpy.ops.export_scene.gltf(
            filepath=path, export_format='GLB', use_selection=True, use_active_scene=True, export_yup=True, export_apply=True,
            export_texcoords=False, export_normals=True, export_tangents=False, export_materials='EXPORT',
            export_vertex_color='NONE', export_cameras=False, export_lights=False, export_animations=False,
            export_extras=False, export_skins=False, export_morph=False)
    finally:
        for name, loc in saved.items():
            scene.objects[name].location = loc
        window.scene = previous
    return {'exported': True, 'pre': pre, 'post': reimport_check(path, pre)}


def reimport_check(path, pre):
    scratch = bpy.data.scenes.new('GLBCheck')
    window = bpy.context.window
    previous = window.scene
    window.scene = scratch
    try:
        bpy.ops.import_scene.gltf(filepath=path)
        objects = list(scratch.collection.all_objects)
        # The importer leaves Y-up data rotated on roots; validate meshes only.
        for o in objects:
            if o.parent is None:
                o.rotation_mode = 'XYZ'
        mesh_errs = []
        tris = 0
        for o in objects:
            if o.type == 'MESH':
                errs, t = check_mesh(o, weld=True)
                tris += t
                mesh_errs += [f'{o.name}: {e}' for e in errs if 'unapplied' not in e]
        names = sorted(o.name for o in objects if o.parent is None)
        missing = sorted(set(pre['report']) - set(n.split('.')[0] for n in names))
        out = {'roots': len(names), 'tris': tris, 'missing_roots': missing, 'mesh_errors': mesh_errs,
               'size_kb': round(os.path.getsize(path) / 1024, 1), 'tris_match': tris == pre['tris']}
    finally:
        window.scene = previous
        for o in list(scratch.collection.all_objects):
            data = o.data
            bpy.data.objects.remove(o, do_unlink=True)
            if data is not None and getattr(data, 'users', 1) == 0:
                bpy.data.meshes.remove(data)
        bpy.data.scenes.remove(scratch)
    return out
