---
name: object-to-threejs-procedural
description: >-
  Turn a reference image of an object into a procedural Three.js model: validate the image, extract a
  structured sculpt spec (geometry / material / lighting / animation / destruction), and implement or
  guide a code-native 3D reconstruction. Use when the user provides or references an object image and
  wants a 3D model, procedural geometry, PBR materials, a game prop, hero render, low-poly prop,
  destructible or animated object, or a sculpt/build plan. Triggers on: three.js, threejs, procedural
  modeling, object reconstruction, 3d from photo, image to 3d, 图片转3D, 三维建模, 模型重建, 照片建模,
  程序化建模, 3d模型, PBR, 材质, 灯光, sculpt spec, mesh generation, game prop, hero render.
---

# Object To Three.js Procedural

> Adapted for pi from [Three.js Object Sculptor](https://github.com/vinhhien112/Three.js-Object-Sculptor-Codex-Plugin) (MIT, (c) 2026 Vinh Hiển). See `LICENSE` in this folder.

Use this skill when the user wants to turn a reference image of an object into a procedural Three.js model, visual spec, reconstruction plan, animation plan, destruction plan, or code implementation. This skill is for code-native reconstruction, not photogrammetry or exact mesh extraction.

## Core Promise

Treat the task like sculpting from a photo:

1. Validate whether the image contains a suitable 3D object target.
2. Extract the object as a structured visual and physical description.
3. Decompose it from coarse forms to small features.
4. Rebuild it with procedural Three.js geometry, generated materials, lighting, and optional animation/destruction.
5. Verify visually and technically before calling it done.

Do not pretend a single image can produce an exact production mesh. Be explicit when the output will be an approximate, stylized, low-poly, or physically simplified reconstruction.

## Quick Reference

| Concern | Reference |
| --- | --- |
| Suitability decision (pass / conditional / reject) | [validation-rubric.md](references/validation-rubric.md) |
| Pre-spec assessment & quality contract | [pre-spec-assessment.md](references/pre-spec-assessment.md) |
| `ObjectSculptSpec` schema & component fields | [spec-schema.md](references/spec-schema.md) |
| Helper scripts (full list) | [helper-scripts.md](references/helper-scripts.md) |
| Build pass order & locked gates | [build-passes.md](references/build-passes.md) |
| Implementation rules & action-ready contract | [implementation-rules.md](references/implementation-rules.md) |
| Self-correction loop | [self-correction-loop.md](references/self-correction-loop.md) |
| Screenshot feedback checklist | [browser-screenshot-feedback.md](references/browser-screenshot-feedback.md) |
| Material / lighting realism | [material-lighting-realism.md](references/material-lighting-realism.md) |
| Attachment / joint correctness | [attachment-joint-correctness.md](references/attachment-joint-correctness.md) |
| 3D terminology discipline | [3d-graphics-terminology.md](references/3d-graphics-terminology.md) |
| Procedural patterns | [procedural-patterns.md](references/procedural-patterns.md) |

## Required Inputs

At minimum: one image path, screenshot, URL, or attached image; and the intended use (standalone model, game prop, scene dressing, hero render, playable object, destructible object, or animation rig).

If the image is missing or unreadable, ask for it. If the intended use is missing, assume a browser-real-time Three.js prop with performance suitable for interactive use.

## Workflow Loop

Prefer this loop for implementation tasks:

1. Probe the image if it is local (`./scripts/probe_reference_image.py`).
2. Run the **Pre-Spec Assessment Gate**: classify the object softly, score complexity, and write the quality contract before authoring the full spec. See [pre-spec-assessment.md](references/pre-spec-assessment.md).
3. Create or revise `ObjectSculptSpec` from the completed assessment and quality contract. See [spec-schema.md](references/spec-schema.md).
4. When material fidelity matters and a source image is available, run `extract_reference_pbr.py` for each important material crop/region before material-pass. Treat confidence below `0.7` as a stop/refine-input signal.
5. Validate the spec normally, then run `--strict-quality` before code generation.
6. Generate a factory skeleton only after the strict quality gate passes or after explicitly documenting accepted fidelity limits.
7. Hand-refine geometry, materials, animation anchors, and destruction anchors one pass at a time. Do not generate a deeper pass until `sculpt_pass_orchestrator.py check` passes. See [build-passes.md](references/build-passes.md).
8. After each visual pass, capture a browser screenshot, create one full reference/render comparison pair, inspect it once with AI vision, then update `reviewHistory` with overall, layer, and semantic feature scores. See [self-correction-loop.md](references/self-correction-loop.md).
9. Run project typecheck/build and browser visual review. Capture screenshots with whatever the project provides (e.g. `WebGLRenderer({preserveDrawingBuffer:true})` + `canvas.toDataURL()` saved to a file), or ask the user for a screenshot. Do not install or download Playwright/Chromium just for this skill unless the user explicitly requests that route.

## Image Validation Gate

Before planning or coding, inspect the image and return a suitability verdict: `pass`, `conditional`, or `reject`. Score 0-3 on `object_isolation`, `silhouette_readability`, `depth_inference`, `primitive_decomposition`, `material_procedurality`, `occlusion_risk`, and `interaction_fit`. See [validation-rubric.md](references/validation-rubric.md) for the full pass/conditional/reject rules.

Reject or ask for another image when the target object is not identifiable, multiple objects compete, the object is heavily cropped or hidden, the goal requires exact likeness from a single image, or the subject is mostly text, transparent glass, fur, smoke, liquids, or fine fabric where procedural approximation would dominate the result.

## Terminology Discipline

Descriptions must be clear, concrete, and compatible with real-time 3D graphics language. Prefer terms from [3d-graphics-terminology.md](references/3d-graphics-terminology.md).

Do not rely on vague descriptions such as "nice", "realistic", "smooth", "rough", "bumpy", "shiny", "dark", or "dirty" unless translated into technical terms:

- geometry: silhouette, topology intent, primitive family, bevel radius, chamfer, taper, bend, twist, boolean cut, edge loop, local deformation, displacement amplitude
- material/PBR: albedo/baseColor, roughness, metalness, normal map, bump map, displacement map, ambient occlusion, cavity dirt, edge wear, clearcoat, transmission, alpha
- surface locality: local mask, procedural noise scale, scratch cluster, chip, dent, seam, recessed groove, raised ridge, stain, dirt accumulation, contact wear
- lighting/rendering: key/fill/rim light, environment reflection, contact shadow, shadow softness, color temperature, exposure, tone mapping
- animation/destruction: pivot, hinge, joint, socket, collider, rigid body, fracture seam, detachable fragment, impulse direction

## Output Format

For analysis-only requests, return:

1. Suitability verdict and scores.
2. Target object extraction.
3. Component hierarchy from macro to micro.
4. Geometry strategy.
5. Material and lighting recipe.
6. Animation/destruction feasibility.
7. Implementation plan and risks.

For implementation requests, do the same briefly, then edit code. Verify with typecheck/build and, when a browser scene exists, inspect screenshots or render output.

## Failure Handling

If reconstruction is not feasible from the provided image, do not fake confidence. Explain the blocker and ask for one of: front/side/back reference images; a cleaner isolated image; acceptance of a stylized approximation; permission to use a generated placeholder; or a narrower target (silhouette only, material study only, or animation/destruction design only).

The agent should be willing to say: "This cannot reach the requested fidelity from the current image." That is a valid self-correction result.
