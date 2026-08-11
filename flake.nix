{
  description = "TmuxDeck — Docker + tmux session manager";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    let
      # Home Manager module (system-independent)
      hmModule = import ./nix/hm-module.nix self;
    in
    {
      homeManagerModules.default = hmModule;
    }
    //
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        python = pkgs.python312;

        # Runtime Python packages (no dev tools)
        pythonRuntime = python.withPackages (ps: with ps; [
          fastapi
          uvicorn
          uvloop
          httptools
          websockets
          aiohttp
          docker
          pydantic-settings
          python-multipart
          webauthn
          # python-telegram-bot has a broken test in nixpkgs, skip checks
          (python-telegram-bot.overridePythonAttrs { doCheck = false; })
        ]);

        # Backend Python environment with all dependencies (dev included)
        pythonEnv = python.withPackages (ps: with ps; [
          fastapi
          uvicorn
          docker
          pydantic-settings
          python-multipart

          # Dev tools
          ruff
          mypy
          pytest
          pytest-asyncio
          httpx
        ]);

        # --- Packages ---

        frontend = pkgs.buildNpmPackage {
          pname = "tmuxdeck-frontend";
          version = "0.1.0";
          src = ./frontend;
          npmDepsHash = "sha256-BtvKFGlb6emAIQTeH2Z/p3v4RKz1GrwH0TOxhzR7POE=";
          npmBuildScript = "build";
          installPhase = ''
            runHook preInstall
            cp -r dist $out
            runHook postInstall
          '';
        };

        backend = pkgs.stdenv.mkDerivation {
          pname = "tmuxdeck-backend";
          version = "0.1.0";
          src = ./backend;
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/tmuxdeck-backend
            cp -r . $out/lib/tmuxdeck-backend/
            runHook postInstall
          '';
        };

        tmuxdeck = pkgs.writeShellApplication {
          name = "tmuxdeck";
          runtimeInputs = [ pythonRuntime ];
          text = ''
            export STATIC_DIR="''${STATIC_DIR:-${frontend}}"
            export PYTHONPATH="${backend}/lib/tmuxdeck-backend"
            export DATA_DIR="''${DATA_DIR:-''${XDG_DATA_HOME:-$HOME/.local/share}/tmuxdeck}"
            mkdir -p "$DATA_DIR"
            exec uvicorn app.main:app \
              --host "''${HOST:-127.0.0.1}" \
              --port "''${PORT:-8000}" \
          '';
        };

        # Bridge agent — connects remote tmux to TmuxDeck server
        bridgeSrc = pkgs.stdenv.mkDerivation {
          pname = "tmuxdeck-bridge-src";
          version = "0.1.0";
          src = ./bridge;
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/tmuxdeck-bridge
            cp -r . $out/lib/tmuxdeck-bridge/
            runHook postInstall
          '';
        };

        bridgePython = python.withPackages (ps: with ps; [
          websockets
          docker
          uvloop
        ]);

        bridge = pkgs.writeShellApplication {
          name = "tmuxdeck-bridge";
          runtimeInputs = [ bridgePython pkgs.tmux ];
          text = ''
            export PYTHONPATH="${bridgeSrc}/lib/tmuxdeck-bridge"
            exec python -m tmuxdeck_bridge "$@"
          '';
        };

      in
      {
        packages = {
          inherit frontend backend tmuxdeck bridge;
          default = tmuxdeck;
        };

        devShells = {
          default = pkgs.mkShell {
            packages = [
              # Backend
              pythonEnv
              pkgs.uv
              pkgs.ruff

              # Frontend
              pkgs.nodejs_22
              pkgs.nodePackages.npm

              # Runtime dependencies
              pkgs.tmux
              pkgs.docker-client

              # Dev tools
              pkgs.just
            ];

            shellHook = ''
              echo "TmuxDeck dev shell"
              echo ""
              echo "  Backend:  cd backend && uv run uvicorn app.main:app --reload --port 8000"
              echo "  Frontend: cd frontend && npm run dev"
              echo "  Tests:    cd backend && uv run pytest"
              echo "            cd frontend && npm test"
              echo ""
            '';

            env = {
              DATA_DIR = "./backend/data";
              TEMPLATES_DIR = "./docker/templates";
            };
          };

          backend = pkgs.mkShell {
            packages = [
              pythonEnv
              pkgs.uv
              pkgs.ruff
              pkgs.tmux
              pkgs.docker-client
            ];

            shellHook = ''
              echo "TmuxDeck backend dev shell"
              echo "  Run: uv run uvicorn app.main:app --reload --port 8000"
            '';

            env = {
              DATA_DIR = "./data";
              TEMPLATES_DIR = "../docker/templates";
            };
          };

          frontend = pkgs.mkShell {
            packages = [
              pkgs.nodejs_22
              pkgs.nodePackages.npm
            ];

            shellHook = ''
              echo "TmuxDeck frontend dev shell"
              echo "  Run: npm install && npm run dev"
            '';
          };
        };
      }
    );
}
