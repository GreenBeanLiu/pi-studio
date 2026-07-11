# Local Release Flow

Use the local release script instead of `electron-builder --publish always` when publishing from this Windows machine.

```powershell
pnpm.cmd run release:local
```

The script:

1. Reads `version`, `productName`, and GitHub publish config from `package.json`.
2. Requires a clean working tree unless `--allow-dirty` is passed.
3. Runs the full `pnpm run verify` gate (encoding, typecheck, tests, lint, and build), then packages with `electron-builder --win --publish never`.
4. Verifies `dist/latest.yml` matches the generated setup exe size and SHA-512.
5. Copies the setup exe and blockmap to the dash-named filenames referenced by `latest.yml`.
6. Creates the `vX.Y.Z` tag, pushes `HEAD` and the tag.
7. Creates or updates the GitHub Release with the setup exe, blockmap, and `latest.yml`.
8. Verifies the uploaded release assets.

Useful commands:

```powershell
pnpm.cmd run release:dry
node scripts/release-local.mjs --install
node scripts/release-local.mjs --skip-build
```

`--skip-build` reuses existing release artifacts but still runs `pnpm run check`; it never bypasses the encoding, typecheck, test, or lint gates.

Before running a real release, bump `package.json` version, commit it, and make sure `gh` is logged in.
