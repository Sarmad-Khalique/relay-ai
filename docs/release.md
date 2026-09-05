# Manual release checklist

ProvenWay deliberately has no hosted release workflow in v0.1.

1. Confirm the `provenway` npm organization exists and the maintainer has publish rights.
2. Run `pnpm release:check` on macOS.
3. Run `pnpm test:linux` with a working Docker daemon.
4. If provider allowance is available, run the opt-in live Codex and Cursor smoke tests in generated toy
   repositories.
5. Review the packed tarball contents with `pnpm pack --dry-run`.
6. Create the intended local Git tag.
7. Publish manually with `npm publish --access public` only after explicit maintainer authorization.

Do not publish from an unclean checkout or when the Cursor live path is described as verified without a
recorded successful smoke run.
