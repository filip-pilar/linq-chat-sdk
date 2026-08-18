# Releasing

Releases are proposed by [changesets](https://github.com/changesets/changesets)
and published by `publish.yml` over OIDC. Nothing reads commit messages; the
version that ships is the one in `packages/adapter-linq/package.json`.

## Normal flow

1. **Add a changeset in the PR that makes the change.**

   ```bash
   pnpm changeset
   ```

   Pick the package, pick `patch` / `minor` / `major`, and write the line users
   will read in the changelog. Commit the generated file under `.changeset/`.
   A PR with no user-visible change needs no changeset.

2. **Merge to `main`.** The Version workflow opens or updates a
   **Version Packages** PR that applies every accumulated changeset: it bumps
   `packages/adapter-linq/package.json` and writes `CHANGELOG.md`. Changesets
   accumulate, so several merges produce one release PR rather than several.

3. **Merge the Version Packages PR.** That edits the adapter's `package.json`,
   which is what `publish.yml` triggers on — it publishes to npm, tags the
   commit, and cuts a GitHub release.

Nothing publishes until step 3, so the Version Packages PR is the release gate:
review the version and the changelog there.

### Why changesets does not publish

`changesets/action` can publish, but it spawns the publish command as a child
process without passing the OIDC request token through, so `npm publish` fails
`ENEEDAUTH` ([npm/cli#8976](https://github.com/npm/cli/issues/8976)). Publishing
stays in `publish.yml`, where `npm publish` runs as a top-level step and
inherits the OIDC environment cleanly.

### Bumping by hand

The version is just a field, so nothing stops you editing it directly — useful
for a one-off or if changesets is unavailable:

```bash
pnpm version:adapter patch   # or minor / major
```

Open that as a PR. Merging it publishes exactly as above.

## One-time setup

No npm token is required. `@linqapp/chat-sdk-adapter` publishes through npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers): the package is
configured on npm to trust this repository's `publish.yml` workflow, and the
workflow authenticates over OIDC.

Deliberately no `NODE_AUTH_TOKEN` is set on the publish step. The npm CLI
prefers OIDC when it detects the environment and falls back to a token
otherwise, so setting one would shadow trusted publishing.

`GITHUB_TOKEN` is provided by Actions; the workflow requests `contents: write`
(tag + release) and `id-token: write` (the OIDC token npm exchanges for
publish rights). Provenance is generated automatically under trusted
publishing, so the workflow does not pass `--provenance`.

Changing the workflow's filename or path breaks publishing until the trusted
publisher entry on npm is updated to match.

## Publishing by hand

Only needed if Actions is down or trusted publishing is misconfigured:

```bash
pnpm install --frozen-lockfile
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build

cd packages/adapter-linq
npm publish --access public

git tag "v$(node -p 'require("./package.json").version')"
git push origin --tags
```

## If we outgrow this

The current setup deliberately has no changelog tooling. If release notes per
change become important, [Changesets](https://github.com/changesets/changesets)
drops in cleanly: it would own the version bump and `CHANGELOG.md`, and
`publish.yml` would trigger off the changesets release PR instead of the
`package.json` path filter.
