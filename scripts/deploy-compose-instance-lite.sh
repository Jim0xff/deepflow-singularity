#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  deploy-compose-instance-lite.sh <instance> [branch]

Behavior:
  - Expects an existing Docker Compose instance under /opt/deepflow-singularity/<instance>
  - Pulls code from the existing instance checkout's origin remote by default (or DEPLOY_REPO_URL)
  - Resets code to origin/<branch>
  - Reuses the instance's existing .env by default
  - If /opt/deepflow-singularity-config/config.yaml contains environments.<instance>,
    regenerates .env from that config first
  - Rebuilds and restarts only the deepflow-singularity service

Env overrides:
  DEPLOY_BASE_DIR=/opt/deepflow-singularity
  DEPLOY_CONFIG_PATH=/opt/deepflow-singularity-config/config.yaml
  DEPLOY_REPO_URL=<git remote url>
  DEPLOY_LIGHT_RUN_NGINX=true
  DEPLOY_NOTIFY_CHAT_ID=-1001234567890
  DEPLOY_NOTIFY_ACCOUNT=singularity-main
  DEPLOY_NOTIFY_MESSAGE="轻量部署完成"
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

resolve_origin_remote() {
  local repo_dir="$1"
  if [[ ! -d "$repo_dir/.git" ]]; then
    return 0
  fi
  git -C "$repo_dir" config --get remote.origin.url 2>/dev/null || true
}

validate_git_remote_url() {
  local repo_url="$1"
  case "$repo_url" in
    https://*|http://*|git@*:*|ssh://*)
      ;;
    *)
      echo "DEPLOY_REPO_URL must be a git remote URL, not a local path: $repo_url" >&2
      exit 1
      ;;
  esac
}

ensure_origin_remote() {
  local repo_dir="$1"
  local repo_url="$2"
  if git -C "$repo_dir" remote get-url origin >/dev/null 2>&1; then
    git -C "$repo_dir" remote set-url origin "$repo_url"
  else
    git -C "$repo_dir" remote add origin "$repo_url"
  fi
}

docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
    return
  fi

  run_privileged docker "$@"
}

docker_compose_cmd() {
  if docker info >/dev/null 2>&1; then
    docker compose "$@"
    return
  fi

  run_privileged docker compose "$@"
}

INSTANCE="${1:-}"
BRANCH="${2:-main}"

if [[ -z "$INSTANCE" || "$INSTANCE" == "-h" || "$INSTANCE" == "--help" ]]; then
  usage
  exit 0
fi
validate_instance_name "$INSTANCE"

BASE_DIR="${DEPLOY_BASE_DIR:-/opt/deepflow-singularity}"
CONFIG_PATH="${DEPLOY_CONFIG_PATH:-/opt/deepflow-singularity-config/config.yaml}"
REPO_URL="${DEPLOY_REPO_URL:-}"
LIGHT_RUN_NGINX="${DEPLOY_LIGHT_RUN_NGINX:-false}"
NOTIFY_CHAT_ID="${DEPLOY_NOTIFY_CHAT_ID:-}"
NOTIFY_ACCOUNT="${DEPLOY_NOTIFY_ACCOUNT:-singularity-main}"
NOTIFY_MESSAGE="${DEPLOY_NOTIFY_MESSAGE:-}"
TARGET_DIR="${BASE_DIR%/}/$INSTANCE"
TARGET_ENV="$TARGET_DIR/.env"

require_cmd git
require_cmd curl
require_cmd docker

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin is required for lightweight deploy." >&2
  exit 1
fi

if [[ ! -d "$TARGET_DIR/.git" ]]; then
  echo "Missing existing instance checkout: $TARGET_DIR/.git" >&2
  echo "Use the full deploy flow first, then run the lightweight deploy API." >&2
  exit 1
fi

if [[ -z "$REPO_URL" ]]; then
  REPO_URL="$(resolve_origin_remote "$TARGET_DIR")"
fi

if [[ -z "$REPO_URL" ]]; then
  echo "Unable to determine deploy source from $TARGET_DIR/.git; set DEPLOY_REPO_URL." >&2
  exit 1
fi

validate_git_remote_url "$REPO_URL"
HAS_CONFIG_ENV=false

git config --global --add safe.directory "$TARGET_DIR" >/dev/null 2>&1 || true

cd "$TARGET_DIR"
if [[ -n "${DEPLOY_REPO_URL:-}" ]] || ! git remote get-url origin >/dev/null 2>&1; then
  ensure_origin_remote "$TARGET_DIR" "$REPO_URL"
fi
git fetch origin
git checkout -B "$BRANCH" "origin/$BRANCH"

if [[ -f "$CONFIG_PATH" ]] && command -v yq >/dev/null 2>&1; then
  if yq -e ".environments[\"$INSTANCE\"]" "$CONFIG_PATH" >/dev/null 2>&1; then
    HAS_CONFIG_ENV=true
    PORT="$(yq -r ".environments[\"$INSTANCE\"].port" "$CONFIG_PATH")"
    echo "APP_PORT=$PORT" > "$TARGET_ENV"
    yq -r '.base | to_entries[] | "\(.key)=\(.value)"' "$CONFIG_PATH" >> "$TARGET_ENV"
    yq -r ".environments[\"$INSTANCE\"].env | to_entries[] | \"\\(.key)=\\(.value)\"" "$CONFIG_PATH" >> "$TARGET_ENV"
    if [[ -z "$NOTIFY_CHAT_ID" ]]; then
      NOTIFY_CHAT_ID="$(yq -r ".environments[\"$INSTANCE\"].deploy.notify.chat_id // \"\"" "$CONFIG_PATH")"
    fi
    if [[ -z "$NOTIFY_ACCOUNT" || "$NOTIFY_ACCOUNT" == "singularity-main" ]]; then
      config_notify_account="$(yq -r ".environments[\"$INSTANCE\"].deploy.notify.account // \"\"" "$CONFIG_PATH")"
      if [[ -n "$config_notify_account" ]]; then
        NOTIFY_ACCOUNT="$config_notify_account"
      fi
    fi
    if [[ -z "$NOTIFY_MESSAGE" ]]; then
      NOTIFY_MESSAGE="$(yq -r ".environments[\"$INSTANCE\"].deploy.notify.message // \"\"" "$CONFIG_PATH")"
    fi
  fi
fi

if [[ ! -f "$TARGET_ENV" ]]; then
  echo "Missing $TARGET_ENV and no matching environments.$INSTANCE block in $CONFIG_PATH" >&2
  exit 1
fi

# 轻量模式只重建并重启 deepflow-singularity 服务，不触碰其它 compose 资源。
docker_compose_cmd -p "$INSTANCE" up -d --build --no-deps deepflow-singularity

if [[ "$LIGHT_RUN_NGINX" == "true" && "$HAS_CONFIG_ENV" == "true" ]]; then
  "$TARGET_DIR/scripts/deploy-nginx.sh" "$INSTANCE"
fi

APP_PORT="$(grep -E '^APP_PORT=' "$TARGET_ENV" | tail -n 1 | cut -d= -f2- || true)"

echo "instance=$INSTANCE"
echo "branch=$BRANCH"
echo "target_dir=$TARGET_DIR"
echo "deploy_mode=light"
echo "env_mode=$([[ "$HAS_CONFIG_ENV" == "true" ]] && echo config || echo existing-env)"
if [[ -n "$APP_PORT" ]]; then
  echo "health=http://127.0.0.1:$APP_PORT/healthz"
  echo "ready=http://127.0.0.1:$APP_PORT/openclaw-ready"
fi

if [[ -n "$NOTIFY_CHAT_ID" && -n "$APP_PORT" ]]; then
  for _ in $(seq 1 60); do
    health="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/healthz" || true)"
    ready="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/openclaw-ready" || true)"
    if [[ "$health" == "200" && "$ready" == "200" ]]; then
      break
    fi
    sleep 2
  done

  health="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/healthz" || true)"
  ready="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/openclaw-ready" || true)"
  if [[ "$health" == "200" && "$ready" == "200" ]]; then
    if [[ -z "$NOTIFY_MESSAGE" ]]; then
      NOTIFY_MESSAGE="轻量部署完成，$INSTANCE 实例已就绪。"
    fi
    docker_cmd exec \
      -e DEPLOY_NOTIFY_ACCOUNT="$NOTIFY_ACCOUNT" \
      -e DEPLOY_NOTIFY_CHAT_ID="$NOTIFY_CHAT_ID" \
      -e DEPLOY_NOTIFY_MESSAGE="$NOTIFY_MESSAGE" \
      "${INSTANCE}-deepflow-singularity-1" \
      sh -lc 'openclaw message send --channel telegram --account "$DEPLOY_NOTIFY_ACCOUNT" --target "$DEPLOY_NOTIFY_CHAT_ID" --message "$DEPLOY_NOTIFY_MESSAGE" --json' \
      >/tmp/${INSTANCE}-deploy-notify.out 2>/tmp/${INSTANCE}-deploy-notify.err || true
    echo "deploy_notify_chat_id=$NOTIFY_CHAT_ID"
    echo "deploy_notify_account=$NOTIFY_ACCOUNT"
  else
    echo "deploy_notify_skipped=service_not_ready"
  fi
fi
