#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  stop-compose-instance.sh <instance>

Behavior:
  - Expects an existing Docker Compose instance under /opt/deepflow-singularity/<instance>
  - Stops compose services for that instance
  - Preserves checkout, containers, and host data directories

Env overrides:
  DEPLOY_BASE_DIR=/opt/deepflow-singularity
EOF
}

run_privileged() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi

  echo "This action requires root privileges or sudo: $*" >&2
  exit 1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command is missing: $1" >&2
    exit 1
  fi
}

validate_instance_name() {
  local instance="$1"
  if [[ ! "$instance" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    echo "Invalid instance name: $instance" >&2
    echo "Allowed pattern: [A-Za-z0-9][A-Za-z0-9._-]*" >&2
    exit 1
  fi
}

docker_compose_cmd() {
  if docker info >/dev/null 2>&1; then
    docker compose "$@"
    return
  fi

  run_privileged docker compose "$@"
}

INSTANCE="${1:-}"

if [[ -z "$INSTANCE" || "$INSTANCE" == "-h" || "$INSTANCE" == "--help" ]]; then
  usage
  exit 0
fi
validate_instance_name "$INSTANCE"

BASE_DIR="${DEPLOY_BASE_DIR:-/opt/deepflow-singularity}"
TARGET_DIR="${BASE_DIR%/}/$INSTANCE"

require_cmd docker

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin is required for stop." >&2
  exit 1
fi

if [[ ! -d "$TARGET_DIR" ]]; then
  echo "Missing existing instance directory: $TARGET_DIR" >&2
  exit 1
fi

cd "$TARGET_DIR"

# stop 只停服务，不移除容器和网络，方便后续快速重新启动。
docker_compose_cmd -p "$INSTANCE" stop

echo "instance=$INSTANCE"
echo "target_dir=$TARGET_DIR"
echo "action=stopped"
