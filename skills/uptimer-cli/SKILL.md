---
name: uptimer-cli
description: Install and use the Uptimer CLI to inspect or change monitors, notification channels, status pages, and global settings on an existing Uptimer instance.
---

# Uptimer CLI

The npm package is `uptimer-cli`; the executable is `uptimer`. This skill configures an existing Uptimer instance through its Admin API.

## 1. Select a working CLI

Run `uptimer --help` if the executable is installed. If installation is requested and an npm release is available, use `npm install --global uptimer-cli`. For a requested pinned release, use `npx --yes uptimer-cli@<version>` in place of `uptimer`, substituting an actual published version.

If npm returns 404 before the first release, use a checkout of `nexttylabs/Uptimer` containing `apps/cli`:

```sh
pnpm install --frozen-lockfile
pnpm --silent --filter uptimer-cli start --help
```

For later commands in that checkout, replace `uptimer` with `pnpm --silent --filter uptimer-cli start`. CLI support starts at Node 22.14.0. The separate Skills installer requires Node 22.20 or newer; Node 24 supports both.

Continue when help exits 0 and lists the expected resource commands. Help covers command syntax and payload examples for every resource; [commands.md](references/commands.md) adds field detail and edge cases.

When this skill has been installed once, `uptimer skill install --dir <dir> --force` refreshes it from the installed CLI package; the default directory is `./skills`.

## 2. Connect to the intended instance

Use `UPTIMER_URL` and `UPTIMER_ADMIN_TOKEN` from the invoking process environment or the host's credential configuration. Ask for a missing instance URL; have the administrator inject a missing token through the host's secret mechanism, rather than posting it in chat. The CLI does not load `.env` automatically or store a login profile.

The URL is an HTTPS origin, without `/api/v1`, userinfo, query, fragment, or subpath. Explicit loopback HTTP origins, such as `http://localhost:8787`, are supported for development.

Run `uptimer settings get` to check connectivity and authentication. Output is redacted, but returned configuration is still administrative data: report only the non-secret fields relevant to the request instead of pasting whole resource payloads.

Continue when the configured instance returns a successful JSON response. An HTTP 401 requires correcting the supplied credential; it is not a reason to change the instance or authentication settings.

## 3. Perform the requested operation

Read the relevant resource section in [commands.md](references/commands.md) before constructing a payload. Use actual IDs returned by the selected instance, and keep changes within the user's authorized resource and fields. An unchanged authorization needs no second confirmation.

For a write, provide one UTF-8 JSON object through exactly one `--file path.json` or `--file -`. Keep omitted PATCH fields omitted; use `null` only where that field supports clearing. Validate JSON locally before invoking the CLI to catch syntax errors early; the CLI reports only a parse position. Keep credential-bearing payload files private and remove task-created temporary files when finished.

List commands for monitors and notification channels return at most 50 records by default, or 200 with `--limit 200`. A resource missing from a bounded list is not proof that it does not exist. The CLI has no cursor, per-ID get command, or complete export.

A 409 conflict is a request to explain the conflicting state. Unlink or delete other resources only when that additional change is authorized. This CLI does not provision Worker secrets, deploy Cloudflare resources, manage incidents or maintenance windows, or synchronize a declarative configuration file.

## 4. Verify and report

Check the exit status and JSON result, then query the affected list or settings resource and compare the requested fields. If the item is outside the bounded listing, report that readback could not be completed rather than claiming it was verified.

- Exit 0: success; stdout is JSON, except for help.
- Exit 2: local input, usage, or environment problem; correct it before retrying.
- Exit 1: HTTP, transport, deadline, or response-contract failure. A write may already have succeeded. Query its state before considering a retry, especially after interruption or timeout; never automatically repeat a mutation.

A response body that stops streaming is cut off at the deadline, and the CLI exits without retrying the write. Treat an externally interrupted write as uncertain even when the CLI reports a timeout.

Finish with the instance, operation, resource IDs, changed non-secret fields, and readback outcome. Name any conflict, incomplete verification, or uncertain write result explicitly.
