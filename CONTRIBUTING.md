# Contributing

## Layout

| Path                   | What                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `extension.toml`       | Zed manifest (id `laravel-query`): registers the `laravel-query` server for `PHP`, `Blade` |
| `src/lib.rs`           | The extension (Rust → wasm32-wasip2): downloads the server of its version, renders labels  |
| `server/src/php/`      | PHP tokenizer, Blade → PHP masking, document structure (imports, classes, closures)        |
| `server/src/analysis/` | Call sites and chains, scope inference (tables of a query), the context of a string        |
| `server/src/laravel/`  | Method catalogs, the Eloquent name inflector, models/relations/migrations via PSR-4        |
| `server/src/db/`       | Connection discovery (PHP, `.env`, settings), drivers, schema index and disk cache         |
| `server/src/features/` | Completion, hover, definition, diagnostics                                                 |
| `server/src/usage.ts`  | Usage statistics (frecency, trends)                                                        |
| `server/test/`         | Unit and feature tests, end-to-end tests of the bundle (SQLite), driver integration tests  |
| `server/bench/`        | Completion latency on a real project and database                                          |
| `server/dist/`         | The bundle (`make server`), not committed: a GitHub release asset                          |
| `scripts/version.mjs`  | One version in extension.toml, Cargo.toml/.lock and server/package(-lock).json             |

How it works: for a string under the cursor, `analysis/chain.ts` finds the call it is an argument
of (through arrays) and `analysis/context.ts` looks the method up in `laravel/methods.ts` (which
arguments are tables, columns, relations…). `analysis/scope.ts` evaluates the receiver chain back
to its root — the `DB` facade, a model, a variable, a closure parameter (resolved through the
call the closure is passed to) — and forward through later joins, giving the query's tables with
their aliases. `features/completion.ts` turns that into items against the schema index.

## Environment

Everything runs in the flake dev shell: `nix develop`, or automatically with direnv
(`direnv allow` once). It provides rustup, Node.js, Biome, nixfmt and make; the Rust toolchain
and the `wasm32-wasip2` target come from `rust-toolchain.toml`.

```sh
make setup     # rustup toolchain + npm ci
make fmt       # rustfmt, Biome (format, imports, safe fixes), nixfmt
make lint      # formatting check, clippy (-D warnings), Biome lint, tsc, nixfmt --check, versions
make test      # cargo test + server unit, feature and end-to-end tests
make db-up     # MySQL 8.4, MariaDB 11.8, PostgreSQL 17 in docker (ports 53306, 53307, 55432)
make test-db   # driver tests against them (LQ_TEST_MYSQL / LQ_TEST_MARIADB / LQ_TEST_PGSQL)
make bench     # completion latency (LQ_BENCH_* variables, see server/bench/completion.bench.ts)
make build     # server bundle + extension wasm
make check     # what CI runs besides test-db: lint and test
```

### Trying a change in Zed

`zed: install dev extension` and pick this directory (Zed needs `rustup` on its `PATH`). The
extension downloads the server from the GitHub release of its version; to run your local build
instead, `make server` and point Zed at it (user settings, absolute path):

```jsonc
"lsp": {
  "laravel-query": {
    "binary": { "arguments": ["/path/to/zed-laravel-query/server/dist/laravel-query-server.cjs", "--stdio"] }
  }
}
```

After server changes: `make server` and `editor: restart language server`; after extension
(Rust) changes: **Rebuild** in the extensions page. Server logs: `dev: open language server
logs` → `laravel-query` (connection discovery, schema reads with their timing, errors).

## Workflow

- Every change goes through a branch and a pull request; nobody commits or pushes to `main`
  directly. Branch names follow the commit type: `feat/…`, `fix/…`, `ci/…`, `docs/…`.
- Commits and pull request titles follow [Conventional Commits](https://www.conventionalcommits.org/):
  `<type>(<scope>): <short description>`, e.g. `fix(server): complete columns of aliased joins`.
  Scopes: `server`, `extension`, `ci`, `nix`, `deps`. Formatting-only changes go in their own
  `style:` commit.
- One concern per pull request. Every commit should make sense on its own: pull requests are
  usually merged with **Rebase**, which keeps them; a branch with fix-up commits is squashed.
- `main` is protected by two rulesets: a pull request gets in only when the **CI result** check
  passed (linear history, no force pushes or deletion), and only the owner merges.
  Documentation-only changes skip the heavy CI job; CI result still reports.

## Releases

The extension downloads the server from the GitHub release of its own version, so a version is
released by a tag, never by hand:

1. Pull request `chore(release): x.y.z` that only runs `make version VERSION=x.y.z` (all five
   version files; `make check` fails while they differ). Merge it.
2. Tag the merged commit on `main` and push the tag:
   `git fetch origin && git tag vx.y.z origin/main && git push origin vx.y.z`.
3. `.github/workflows/release.yml` checks the tag against the version files, runs the checks,
   builds the bundle and creates the GitHub release with `laravel-query-server.cjs` (+ `.sha256`).
4. Zed registry ([zed-industries/extensions](https://github.com/zed-industries/extensions)):
   - first version: a manual pull request that adds this repository as the submodule
     `extensions/laravel-query` (HTTPS URL) at the tagged commit, plus
     `[laravel-query] submodule = "extensions/laravel-query"`, `version = "x.y.z"` in
     `extensions.toml`, then `pnpm sort-extensions`;
   - later versions: the release workflow opens that pull request itself
     ([zed-extension-action](https://github.com/huacnlee/zed-extension-action)) once the
     repository variable `ZED_REGISTRY_PUBLISHED` is `true` and the `COMMITTER_TOKEN` secret
     (classic PAT, scopes `repo` + `workflow`) is set; it pushes to the owner's fork of
     `zed-industries/extensions`.

Versions follow semver; while on 0.x, a breaking change of settings bumps the minor version.

## Definition of done

Always: `make check` and `make build`; `make test-db` when a driver changed. A change to what
users see in Zed is also tried there with the dev extension. A change that can affect latency
(tokenizer, analysis, completion building) comes with `make bench` numbers before/after, and the
[Performance](README.md#performance) table is updated when they move.

## Tests

- Tokenizer, document structure and Blade masking: `server/test/php.test.ts`.
- Inflector, settings, connection discovery, schema store and cache, usage statistics:
  `server/test/units.test.ts`.
- Completion contexts and ordering: `server/test/completion.test.ts` (a fixture project with
  models and an in-memory schema, see `server/test/helpers.ts`; `|` or `‸` marks the cursor).
- Diagnostics, hover, definition, code actions: `server/test/features.test.ts`.
- The bundle over stdio with a real SQLite database: `server/test/server.e2e.test.ts`; when the
  LSP wiring changes.
- Drivers: `server/test/drivers.integration.test.ts` (`make db-up && make test-db`; CI runs the
  databases as service containers).
- A test for a bug should fail without the fix; say in the pull request that you checked.

## Pull requests

Opening a pull request fills in [the template](.github/pull_request_template.md). Keep its
sections, and fill in **AI assistance** every time:

- whether an AI tool wrote or changed any part of the pull request (code, tests, docs, the
  description itself);
- if so, the tool and the exact model (e.g. Claude Code, `claude-opus-5-5`), and what it did.

No "Generated with …" lines or AI co-author trailers in commits or descriptions: the AI section
says it once, in a form every pull request shares.

Comments in code say why, never the history.
