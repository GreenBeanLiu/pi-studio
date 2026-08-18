# Helper Scripts

Scripts live in `./scripts/` inside this skill folder and only need the Python 3 standard library (no pip installs). If no `python`/`python3` is available, skip the scripts and follow the documented process manually.

All scripts use `<image>` for the source image path and `object-sculpt-spec.json` for the spec file unless noted.

## Image and PBR extraction

- `./scripts/probe_reference_image.py <image>` checks image type, dimensions, aspect ratio, and obvious technical issues. It does not replace visual inspection.
- `./scripts/extract_reference_pbr.py <image> --out-dir <dir> --material-id <id> --target-threshold 0.7` extracts reference-derived albedo, roughness, height, normal, and AO maps from image pixels. It exits non-zero when confidence is below the target threshold.
- `./scripts/extract_reference_pbr.py <image> --out-dir <dir> --material-id <id> --spec object-sculpt-spec.json --in-place` patches a material with usable `referencePbr` maps only when the confidence gate passes, unless `--allow-low-confidence` is explicitly used.

## Spec authoring and validation

- `./scripts/new_pre_spec_assessment.py "Object Name" --image <path> --complexity <simple|moderate|complex|ultra-complex> --out assessment.json` creates a pre-spec complexity assessment and quality contract skeleton.
- `./scripts/new_sculpt_spec.py "Object Name" --image <path> --out object-sculpt-spec.json` creates a starter spec.
- `./scripts/new_sculpt_spec.py "Object Name" --image <path> --assessment assessment.json --out object-sculpt-spec.json` creates a starter spec from a completed pre-spec assessment.
- `./scripts/validate_sculpt_spec.py object-sculpt-spec.json` validates required fields, score ranges, material references, component IDs, parent links, transforms, and primitive names.
- `./scripts/validate_sculpt_spec.py object-sculpt-spec.json --strict-quality` fails when the spec is structurally valid but too shallow for its quality contract.

## Pass orchestration and code generation

- `./scripts/sculpt_pass_orchestrator.py status object-sculpt-spec.json` reports the current locked build pass and required evidence.
- `./scripts/sculpt_pass_orchestrator.py check object-sculpt-spec.json --pass-id blockout` fails unless that pass is currently unlocked or already completed.
- `./scripts/sculpt_pass_orchestrator.py sync object-sculpt-spec.json --in-place` refreshes `sculptPipeline` from `reviewHistory`.
- `./scripts/generate_threejs_factory.py object-sculpt-spec.json --out src/createObjectModel.ts` creates a TypeScript Three.js factory for the current unlocked build pass only.
- `./scripts/generate_threejs_factory.py object-sculpt-spec.json --pass-id structural-pass --out src/createObjectModel.ts` creates a deeper pass only after earlier passes were reviewed with `action=continue`.

## Review evidence

- `./scripts/make_visual_comparison_sheet.py --reference <image> --render <screenshot> --out <comparison.png> --json` creates one full reference/render comparison pair. AI vision scores the global result and every selected semantic feature from this same pair.
- `./scripts/append_sculpt_review.py object-sculpt-spec.json --pass-id <pass> --fidelity <0-1> --action <continue|refine-spec|refine-code|request-input|stop> --summary "..." --render-screenshot <path> --comparison-image <path> --ai-vision-score <0-1> --layer-scores-json '{"silhouetteProportion":0.8}' --feature-reviews-json <reviews.json> --ai-vision-notes "..." --camera-view <view> --in-place` records each self-correction review plus global and feature-level AI vision evidence.
