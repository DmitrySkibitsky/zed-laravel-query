# Development tasks. Run inside the dev shell (`nix develop`, or automatically via direnv).
#
#   make setup            install toolchains/dependencies (rustup toolchain from rust-toolchain.toml, npm ci)
#   make fmt              format everything (rustfmt, Biome, nixfmt)
#   make lint             check formatting + linters + types + versions (no changes)
#   make test             Rust unit tests + server unit and end-to-end tests
#   make test-db          driver tests against real databases (LQ_TEST_MYSQL / LQ_TEST_MARIADB / LQ_TEST_PGSQL)
#   make db-up / db-down  start / stop MySQL, MariaDB and PostgreSQL containers for test-db (docker)
#   make bench            completion latency on a real project (see server/bench/completion.bench.ts)
#   make build            server bundle (the release asset) + extension wasm
#   make check            everything CI runs: lint and test
#   make version VERSION=x.y.z   set the release version in every file (see CONTRIBUTING.md)

SERVER := server
WASM_TARGET := wasm32-wasip2

# Databases started by `make db-up` (CI runs the same images as service containers); only
# `make test-db` uses them, `make test` runs without databases.
LQ_TEST_MYSQL ?= mysql://root:root@127.0.0.1:53306
LQ_TEST_MARIADB ?= mariadb://root:root@127.0.0.1:53307
LQ_TEST_PGSQL ?= postgres://postgres:postgres@127.0.0.1:55432/postgres

.DEFAULT_GOAL := help

.PHONY: help setup fmt lint lint-rust lint-server lint-nix version-check version test test-rust test-server test-db db-up db-down bench build server wasm check clean

# `make` alone prints the list above instead of running the first target.
help:
	@sed -n '3,/^$$/{s/^# \{0,1\}//;p}' $(firstword $(MAKEFILE_LIST))

setup:
	rustup toolchain install
	cd $(SERVER) && npm ci

fmt:
	cargo fmt
	biome check --write .
	nixfmt flake.nix

lint: lint-rust lint-server lint-nix version-check

lint-rust:
	cargo fmt --check
	cargo clippy --target $(WASM_TARGET) -- -D warnings
	cargo clippy --all-targets -- -D warnings

lint-server:
	biome ci .
	cd $(SERVER) && npm run typecheck

lint-nix:
	nixfmt --check flake.nix

# The extension downloads the server from the release of its own version: all files must agree.
version-check:
	node scripts/version.mjs check

version:
	@test -n "$(VERSION)" || { echo "usage: make version VERSION=x.y.z"; exit 1; }
	node scripts/version.mjs set $(VERSION)

test: test-rust test-server

test-rust:
	cargo test

test-server:
	cd $(SERVER) && npm test

test-db:
	cd $(SERVER) && LQ_TEST_MYSQL='$(LQ_TEST_MYSQL)' LQ_TEST_MARIADB='$(LQ_TEST_MARIADB)' LQ_TEST_PGSQL='$(LQ_TEST_PGSQL)' \
		node --test test/drivers.integration.test.ts

db-up:
	docker run -d --rm --name lq-test-mysql -p 53306:3306 -e MYSQL_ROOT_PASSWORD=root mysql:8.4
	docker run -d --rm --name lq-test-mariadb -p 53307:3306 -e MARIADB_ROOT_PASSWORD=root mariadb:11.8
	docker run -d --rm --name lq-test-pgsql -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:17-alpine

db-down:
	-docker stop lq-test-mysql lq-test-mariadb lq-test-pgsql

bench:
	cd $(SERVER) && npm run bench

# server/dist/laravel-query-server.cjs: attached to the GitHub release by .github/workflows/release.yml
server:
	cd $(SERVER) && npm run build

wasm:
	cargo build --release --target $(WASM_TARGET)

build: server wasm

check: lint test

clean:
	cargo clean
	rm -rf $(SERVER)/node_modules $(SERVER)/dist
