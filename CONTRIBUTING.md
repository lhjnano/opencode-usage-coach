# Contributing

Thanks for helping improve opencode-usage-coach! TypeScript + [Bun](https://bun.sh) + [tsup](https://tsup.egoist.dev).

## Setup

```bash
git clone <repo> && cd opencode-usage-coach
bun install
```

## Develop

```bash
bun run build        # tsup -> dist/index.js, dist/tui.js (solid external)
bun run typecheck    # tsc --noEmit
```

No automated test suite yet — link the build into your opencode config and run a real
session. See [README.md](./README.md#troubleshooting) for gotchas.

## Submitting changes

1. Open an issue first for anything beyond a small fix — align on approach.
2. Branch from `main`, keep commits focused.
3. Ensure `bun run build` and `bun run typecheck` pass clean.
4. Update [CHANGELOG.md](./CHANGELOG.md) under an unreleased entry.
5. Open a PR describing the **what** and **why**; link the issue.

License: MIT — contributions come in under the same terms.
