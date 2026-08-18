# Build Passes And Gates

Use this reference when starting or advancing construction. The loop is sequential: do not jump from a completed spec directly to a polished model.

## Reconstruction strategy (coarse to fine)

1. `blockout`: build the silhouette with simple primitives and correct proportions.
2. `structural pass`: add child components, sockets, supports, hinges, handles, legs, branches, fins, or ribs.
3. `form refinement`: bevel hard edges, taper cylinders, bend tubes, add curve sweeps, add organic noise, and break perfect symmetry where the image demands it.
4. `surface pass`: add generated normal maps, procedural noise, vertex colors, bark/stone/metal/plastic/cloth patterns, scratches, wetness, dirt, edge highlights, and small repeated geometry only where it matters.
5. `material pass`: tune roughness/metalness/clearcoat/transmission/alpha so surfaces do not look like plastic unless they should.
6. `lighting pass`: separate actual object material from photo lighting; create a neutral turntable light plus optional reference-matching light.
7. `interaction pass`: add pivots, bones, colliders, animation handles, break points, and detachable fragments only when the user needs motion or destruction.
8. `optimization pass`: instance repeated details, merge static pieces where safe, cap geometry density, and preserve FPS targets.

## Locked build pass gate

Before each implementation pass:

1. Run `./scripts/sculpt_pass_orchestrator.py status object-sculpt-spec.json`.
2. Run `./scripts/sculpt_pass_orchestrator.py check object-sculpt-spec.json --pass-id <pass>`.
3. Generate or edit only the unlocked pass.
4. Render the scene in a browser and capture screenshot evidence.
5. Build one full reference/render comparison sheet with `./scripts/make_visual_comparison_sheet.py`.
6. Inspect it once with AI vision and record overall, layer, and critical semantic feature scores plus concrete mismatch notes.
7. Append review with `./scripts/append_sculpt_review.py ... --pass-id <pass> --action continue --render-screenshot <path> --comparison-image <path> --ai-vision-score <0-1> --layer-scores-json '<json>' --feature-reviews-json <reviews.json> --ai-vision-notes "..." --camera-view <view> --in-place`.
8. Run `./scripts/sculpt_pass_orchestrator.py sync object-sculpt-spec.json --in-place` when review history was edited manually.

The default generator is pass-gated. Calling `generate_threejs_factory.py` without `--pass-id` uses `sculptPipeline.currentPass`. Calling it with a future `--pass-id` must fail until prior passes are completed. This is intentional: first sculpt the blockout, then structure, then form, then material and surface detail.

## Material and lighting look-dev gates

`material-pass` must not proceed with only flat base colors; it needs palette, roughness variation, normal/bump/displacement intent, and local masks.

`lighting-pass` must not proceed with ambient-only lighting; it needs key/fill/rim or environment light, exposure, tone mapping, background, shadow softness, and contact shadow behavior.

When `lookDevTargets.qualityPriority` is `reference-fidelity`, apply the quality-first gate:

- important close-up materials use independent albedo, roughness, height/normal, and AO channels
- surface response is decomposed into macro, meso, and micro frequency bands
- important procedural maps are at least 1024px, preferably 2048px
- if a source image exists, important close-up materials have usable `referencePbr` pixel extraction with confidence >= the configured target threshold, default `0.7`
- UV/projection and texel-density intent are explicit
- silhouette-affecting relief uses geometry or displacement-capable topology
- material review includes neutral, grazing-light close-up, and reference-matched screenshots
- optimization happens after fidelity is accepted; do not remove reference-critical geometry merely to hit an arbitrary polygon floor

Reference PBR extraction is an inference gate, not a magic guarantee. From one photo, no model can uniquely recover true physical albedo, roughness, height, normal, and AO. If the extractor confidence is below the target threshold or the rendered material still fails screenshot review, choose `request-input`, `refine-spec`, or `refine-code` instead of pretending the material reached the requested fidelity.

## Attachment gate (structural and form passes)

Child appendages such as branches, limbs, handles, legs, horns, wings, tubes, cables, connectors, and hinged parts must include `attachment.parentSocket`, `localStart`, `localEnd`, `contactType`, `embedDepth` or `overlap`, and `gapTolerance`. The generator should build these parts from root endpoint to tip endpoint instead of centering them at an arbitrary transform.

See `references/attachment-joint-correctness.md` for the full rules.

## Minimum screenshot gates per pass

1. `blockout`: screenshot proves silhouette, proportions, primitive family, and coordinate frame.
2. `structural-pass`: screenshot proves component hierarchy, parent/child placement, joints, seams, repeated systems, and stable action-ready node boundaries.
3. `form-refinement`: screenshot proves bevel/chamfer/taper/bend/deformation, local geometry features, and no floating child joints.
4. `material-pass`: screenshot proves albedo, roughness, metalness, normal/bump/displacement, AO, dirt, wear, local overrides.
5. `lighting-pass`: screenshot proves reference-independent material readability plus optional reference lighting match.
6. `interaction-pass`: screenshot or short render capture proves pivots, sockets, colliders, animation anchors, fracture seams, detachable fragments, and runtime metadata.
7. `optimization-pass`: triangle budget, draw calls, instancing, LOD, and FPS target.
