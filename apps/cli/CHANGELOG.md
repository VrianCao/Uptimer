# uptimer-cli

## 0.2.1

### Patch Changes

- bc089e6: Publish through the CI trusted publisher with npm provenance attestations, so the released tarball is verifiably built from this repository by the tagged workflow run.

## 0.2.0

### Minor Changes

- Add `uptimer skill install`, which copies the bundled agent skill into a local directory (`./skills` by default, `--dir` to override, `--force` to replace) without requiring an instance URL or token.

### Patch Changes

- d44b001: Package the Uptimer CLI as a standalone JavaScript executable and automate npm publishing and GitHub Releases with Changesets.
- Fix configuration output safety and input handling: redact `http_headers_json` and notification `config_json` payloads and reflected token keys, stop echoing payload fragments and transport messages in errors, bound timeout cleanup, accept a null `group_name` from group unassignment, and reject repeated options. Help payload examples now match the Admin API fields.
