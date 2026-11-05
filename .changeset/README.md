# Changesets

Run `pnpm changeset` for a user-visible CLI change, select `uptimer-cli`, and choose patch, minor, or major. Commit the generated Markdown file with the change. Private web, Worker, and shared packages are not published.

Merging changesets to `master` updates the release PR. Merging that PR publishes the new CLI version and creates its GitHub Release. See [CLI releases](../docs/cli-releases.md) for setup, authentication, and local package verification.
