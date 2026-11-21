{
  description = "laravel-query: database-aware completion for the Laravel query builder in Zed";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      # `nix develop`: rustup builds the Zed extension (toolchain + wasm32-wasip2 target come from
      # rust-toolchain.toml and are installed into ~/.rustup on first use — the same toolchain Zed
      # uses for `zed: install dev extension`); node/npm build and run the language server.
      # Formatters/linters (`make fmt`, `make lint`): rustfmt + clippy (rustup components),
      # Biome for TypeScript/JSON (from nixpkgs: the npm package ships glibc binaries that do not
      # run on NixOS), tsc (npm), nixfmt. Versions are pinned by flake.lock / rust-toolchain.toml.
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.rustup
            pkgs.nodejs
            pkgs.biome
            pkgs.nixfmt
            pkgs.gnumake
          ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
