# Changesets

This directory holds [changesets](https://github.com/changesets/changesets) — one
markdown file per user-visible change, recording which packages it affects and
whether it is a patch, minor, or major.

Add one in the same PR as the change:

```bash
pnpm changeset
```

Merging to `main` opens (or updates) a **Version Packages** pull request that
applies the accumulated changesets: it bumps `packages/adapter-linq/package.json`
and writes `CHANGELOG.md`. Merging *that* PR is what releases — it changes the
adapter's `package.json`, which is what `publish.yml` triggers on.

Changesets never publishes here. It only proposes the version bump; publishing
stays with `publish.yml` over OIDC. See [RELEASING.md](../RELEASING.md).

`nitro-starter` (`apps/api`) is ignored — it is an example app, not a published
package.
