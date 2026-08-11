flake:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.tmuxdeck;
  bridgeCfg = cfg.bridge;
  inherit (pkgs.stdenv.hostPlatform) isDarwin isLinux;

  # Build environment variables for the server
  serverEnv = [
    "HOST=${cfg.host}"
    "PORT=${toString cfg.port}"
    "DATA_DIR=${cfg.dataDir}"
    "DOCKER_SOCKET=${cfg.dockerSocket}"
  ] ++ lib.optional (cfg.hostTmuxSocket != "") "HOST_TMUX_SOCKET=${cfg.hostTmuxSocket}";

  serverEnvAttrs = {
    HOST = cfg.host;
    PORT = toString cfg.port;
    DATA_DIR = cfg.dataDir;
    DOCKER_SOCKET = cfg.dockerSocket;
  } // lib.optionalAttrs (cfg.hostTmuxSocket != "") {
    HOST_TMUX_SOCKET = cfg.hostTmuxSocket;
  };

  # Bridge agent command line arguments
  bridgeArgs = lib.concatStringsSep " " ([
    "--url ${bridgeCfg.url}"
    "--token ${bridgeCfg.token}"
    "--name ${bridgeCfg.name}"
  ] ++ lib.optional (!bridgeCfg.local) "--no-local"
    ++ lib.optional (bridgeCfg.hostTmuxSocket != "") "--host-tmux-socket ${bridgeCfg.hostTmuxSocket}"
    ++ lib.optional (bridgeCfg.dockerSocket != "") "--docker-socket ${bridgeCfg.dockerSocket}"
    ++ lib.optional bridgeCfg.ipv6 "--ipv6");
in
{
  options.services.tmuxdeck = {
    enable = lib.mkEnableOption "TmuxDeck service";

    package = lib.mkOption {
      type = lib.types.package;
      default = flake.packages.${pkgs.stdenv.hostPlatform.system}.default;
      description = "The TmuxDeck package to use.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8000;
      description = "Port to listen on.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Host/address to bind to.";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.home.homeDirectory}/.local/share/tmuxdeck";
      description = "Directory for TmuxDeck persistent data.";
    };

    dockerSocket = lib.mkOption {
      type = lib.types.str;
      default = "/var/run/docker.sock";
      description = "Path to the Docker socket.";
    };

    hostTmuxSocket = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Path to the host tmux socket for host-mode session access.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Path to an environment file with secrets (e.g. Telegram tokens).";
    };

    bridge = {
      enable = lib.mkEnableOption "TmuxDeck bridge agent";

      package = lib.mkOption {
        type = lib.types.package;
        default = flake.packages.${pkgs.stdenv.hostPlatform.system}.bridge or (throw "tmuxdeck bridge package not available");
        description = "The TmuxDeck bridge agent package.";
      };

      url = lib.mkOption {
        type = lib.types.str;
        default = "";
        example = "ws://localhost:8000/ws/bridge";
        description = "WebSocket URL of the TmuxDeck server to connect to.";
      };

      token = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "Authentication token for the bridge connection. Use environmentFile for secrets.";
      };

      name = lib.mkOption {
        type = lib.types.str;
        default = "bridge";
        description = "Display name for this bridge in the TmuxDeck UI.";
      };

      local = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Discover local tmux sessions on this machine.";
      };

      hostTmuxSocket = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "Path to host tmux socket for host-mode access via bridge.";
      };

      dockerSocket = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "Path to Docker socket for container tmux discovery via bridge.";
      };

      ipv6 = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Use IPv6 instead of IPv4 for the bridge connection.";
      };

      environmentFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        description = "Path to an environment file with bridge secrets (BRIDGE_TOKEN, etc).";
      };
    };
  };

  config = lib.mkMerge [
    # --- TmuxDeck server ---
    (lib.mkIf cfg.enable {
      # Ensure data directory exists
      home.activation.tmuxdeckDataDir = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        mkdir -p "${cfg.dataDir}"
      '';

      # Linux: systemd user service
      systemd.user.services.tmuxdeck = lib.mkIf isLinux {
        Unit = {
          Description = "TmuxDeck — Docker + tmux session manager";
          After = [ "network.target" ];
        };
        Service = {
          Type = "simple";
          ExecStart = "${cfg.package}/bin/tmuxdeck";
          Restart = "on-failure";
          RestartSec = 5;
          Environment = serverEnv;
        } // lib.optionalAttrs (cfg.environmentFile != null) {
          EnvironmentFile = cfg.environmentFile;
        };
        Install.WantedBy = [ "default.target" ];
      };

      # macOS: launchd agent
      launchd.agents.tmuxdeck = lib.mkIf isDarwin {
        enable = true;
        config = {
          Label = "com.tmuxdeck.server";
          ProgramArguments = [ "${cfg.package}/bin/tmuxdeck" ];
          EnvironmentVariables = serverEnvAttrs;
          RunAtLoad = true;
          KeepAlive = true;
          StandardOutPath = "${cfg.dataDir}/tmuxdeck.log";
          StandardErrorPath = "${cfg.dataDir}/tmuxdeck.err.log";
        };
      };
    })

    # --- TmuxDeck bridge agent ---
    (lib.mkIf bridgeCfg.enable {
      # Linux: systemd user service for bridge
      systemd.user.services.tmuxdeck-bridge = lib.mkIf isLinux {
        Unit = {
          Description = "TmuxDeck bridge agent";
          After = [ "network.target" ];
        };
        Service = {
          Type = "simple";
          ExecStart = "${bridgeCfg.package}/bin/tmuxdeck-bridge ${bridgeArgs}";
          Restart = "on-failure";
          RestartSec = 5;
        } // lib.optionalAttrs (bridgeCfg.environmentFile != null) {
          EnvironmentFile = bridgeCfg.environmentFile;
        };
        Install.WantedBy = [ "default.target" ];
      };

      # macOS: launchd agent for bridge
      launchd.agents.tmuxdeck-bridge = lib.mkIf isDarwin {
        enable = true;
        config = {
          Label = "com.tmuxdeck.bridge";
          ProgramArguments = [ "${bridgeCfg.package}/bin/tmuxdeck-bridge" ] ++ lib.splitString " " bridgeArgs;
          RunAtLoad = true;
          KeepAlive = true;
          StandardOutPath = "${cfg.dataDir}/tmuxdeck-bridge.log";
          StandardErrorPath = "${cfg.dataDir}/tmuxdeck-bridge.err.log";
        };
      };
    })
  ];
}
