# ObjectSculptSpec Schema

Use this reference when authoring or revising the `ObjectSculptSpec`. Pass the pre-spec assessment gate (`references/pre-spec-assessment.md`) before writing the full spec.

For a simple object the spec can stay compact. For a complex object, use schema v2:

```ts
type ObjectSculptSpec = {
  targetName: string;
  schemaVersion: "2.0";
  terminologyProfile: TerminologyProfile;
  suitability: "pass" | "conditional" | "reject";
  assumptions: string[];
  preSpecAssessment: PreSpecAssessment;
  qualityContract: QualityContract;
  coordinateFrame: {
    front: string;
    up: string;
    scaleReference: string;
  };
  silhouette: {
    boundingShape: string;
    aspectRatios: string[];
    symmetry: string;
    dominantCurves: string[];
  };
  viewEvidence: ViewEvidence[];
  componentTree: SculptComponent[];
  materials: SculptMaterial[];
  qualityTargets: QualityTargets;
  selfCorrectLoop: SelfCorrectLoop;
  sculptPipeline: SculptPipeline;
  actionReadiness: ActionReadiness;
  repetitionSystems: RepetitionSystem[];
  buildPasses: BuildPass[];
  visualEvidence: VisualEvidence[];
  reviewHistory: SculptReview[];
  lodPlan: LodPlan[];
  performanceBudget: PerformanceBudget;
  lightingFromPhoto: string[];
  proceduralStrategy: string[];
  animationAnchors: string[];
  destructionAnchors: string[];
  risks: string[];
};
```

## Per-component fields

For every major component, capture:

- role: body, base, limb, handle, cap, shell, ornament, connector, surface detail
- level: macro, meso, or micro
- importance and confidence from 0 to 1
- primitive base: box, sphere, cylinder, cone, torus, capsule, tube, lathe, extrude, curve sweep, plane cards, instanced cluster
- geometry descriptor: topology intent, edge treatment, bevel radius, deformation stack, UV strategy, normal strategy
- dimensions: width, height, depth, radius, length, taper ratios, and confidence
- transforms: position, rotation, scale, taper, bend, twist, bevel, boolean cut, noise displacement
- joints: parent component, overlap, seam, hinge, socket, embedded, glued, floating
- action profile: animation role, pivot mode/local position/axis, transform channels, sockets, collider proxy, constraints, destruction behavior
- material layers: base color, palette variation, roughness, metalness, normal, bump, displacement, transparency, edge wear, dirt, moss, scratches, chips, wetness, grain
- local features: per-region marks, dents, holes, seams, stains, ridges, raised details, carved lines, decals, chips, and wear patches
- evidence refs: which image region supports this component or local feature
- fidelity tier: blockout, mid detail, close-up detail

## For complex objects

Do not flatten everything into one `details` string. Use:

- `viewEvidence` to record image regions and observed local traits.
- `terminologyProfile` to keep descriptions aligned with 3D graphics vocabulary.
- `material.localOverrides` to describe local color/roughness/bump differences.
- `component.localFeatures` for geometry-visible details.
- `component.surfaceDetail` for macro roughness, micro roughness, bump amplitude, normal pattern, and displacement pattern.
- `repetitionSystems` for repeated screws, leaves, scales, teeth, beads, panels, rivets, holes, or stitches.
- `buildPasses` to state the sculpt order and acceptance criteria from coarse to fine.

Every important visual claim should name the layer it belongs to: geometry, topology, material, texture, shader parameter, lighting, animation, collision, or destruction. For complex objects, include `terminologyProfile` in the spec and keep local details attached to `viewEvidence`.

## Anti-shallow rule

A complex object with only one root component, no repetition systems, no material local overrides, and no micro feature groups is not implementation-ready even if the JSON schema validates. Replace generic starter `featureReviewTargets` with the object's actual identity-defining semantic systems before strict validation. Keep at most five critical and three important targets per pass.
