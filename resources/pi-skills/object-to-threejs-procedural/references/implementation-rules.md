# Implementation Rules And Action-Ready Contract

Use this reference when generating or editing Three.js code.

## Action-Ready Model Contract

Build every generated model as if the user may later ask for animation, transformation, physics, or destruction. Do not generate a beautiful but inert lump of meshes.

See `references/action-ready-models.md` for pivot, socket, collider, and destruction hierarchy rules.

The spec should include `actionReadiness`, and every macro/meso component should include `actionProfile`:

- `animationRole`: root, static, articulated, deformable, detachable, breakable, effect-emitter, or socket-only.
- `pivot`: mode, local position, axis, and confidence. Use a semantic pivot such as base, hinge, joint, center of mass, branch root, handle socket, or custom.
- `transformChannels`: whether translate, rotate, scale, bend, twist, detach, visibility, or material-state changes are expected.
- `sockets`: named attachment points for hands, tools, branches, wheels, lids, projectiles, effects, or later child objects.
- `collider`: simplified runtime proxy such as box, sphere, capsule, cylinder, convex hull, compound, trigger, or none.
- `constraints`: hinge limits, slide limits, bend limits, spring behavior, parent locks, or physics constraints.
- `destruction`: breakable flag, fracture group, seam refs, detachable fragments, break impulse, debris material, and effect anchors.

Generation rules:

- Put each independently transformable part under a stable `THREE.Group` pivot node; put the visual mesh as its child.
- Store runtime maps in `root.userData.sculptRuntime`: `nodes`, `meshes`, `sockets`, `colliders`, and `destructionGroups`.
- Avoid merging parts that may move, detach, bend, break, swap materials, or receive independent collision later.
- Use procedural seams and component boundaries as future break lines; do not rely on random explosions.
- If the object truly has no moving parts, still include a root pivot, whole-object collider, and destruction policy so later whole-object actions remain easy.

## Three.js implementation rules

- Prefer TypeScript and plain Three.js unless the existing project uses another Three wrapper.
- Use `Group` factories such as `createObjectNameModel(spec, options)` rather than scattered mesh creation.
- Keep reconstruction data separate from renderer objects so the spec can be revised without rewriting the scene.
- Use deterministic seeds for procedural noise, surface variation, and repeated details.
- Generate unrelated PBR channels from independent deterministic fields. Never alias the albedo texture into roughness, height, normal, or AO.
- Use macro/meso/micro frequency bands for tactile materials; single-frequency random marks usually read as synthetic.
- For quality-first targets, spend polygons on silhouette-affecting relief and use 1024-2048px maps for close-up materials before reducing quality for performance.
- Preserve local material traits in code metadata (`userData`) even when the first generated geometry is only a blockout.
- For real-time scenes, prioritize silhouette and material believability over hidden micro-geometry.
- Use geometry primitives, `Shape` extrusions, curve/tube geometry, instancing, displacement/noise, and generated canvas textures before importing external art.
- Use mesh hierarchy for future animation: body root, movable limbs, hinged parts, detachable pieces, and effect emitters.
- For attached children, place the pivot at the attachment root/socket and orient geometry from `attachment.localStart` to `attachment.localEnd`.
- For destruction, define fracture groups and seams explicitly instead of randomly exploding the entire object.
- Add a simple reference camera/turntable or screenshot angle for visual comparison.

## Lessons from the Pine Forest prototype

- Vague "make it better" feedback is weak. Convert visual critique into named resets: `Material Realism Reset`, `Silhouette Reset`, `Water Surface Reset`, `Vegetation Structure Reset`, etc.
- A believable model needs geometry, material, lighting, and scale to agree. Fixing only one layer usually makes the result look artificial.
- Avoid perfect procedural smoothness. Add controlled unevenness: bevel variation, color mottling, roughness variation, micro normals, dirt at seams, edge wear, and asymmetry.
- Keep visual progress visible in the browser. Small loops beat large invisible rewrites.
- Protect performance: instance repeated details, keep collision simplified, and avoid geometry that only exists to hide a bad material.
- When the user compares against a reference image, explicitly name the mismatch before changing code.
