#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  light-deploy-compose-instance.sh <instance> [branch]

Behavior:
  - Pulls latest code for an existing instance checkout from origin (or DEPLOY_REPO_URL)
  - Rejects image-level changes that require a full rebuild
  - Stages the new repo contents inside the running container
  - Rebuilds /app/dist inside the container
  - Replaces /app and restarts the container so OpenClaw services reload

Env overrides:
  DEPLOY_BASE_DIR=/opt/deepflow-singularity
  DEPLOY_REPO_URL=<git remote url>
  DEPLOY_NOTIFY_CHAT_ID=-1001234567890
  DEPLOY_NOTIFY_ACCOUNT=singularity-main
  DEPLOY_NOTIFY_MESSAGE="轻部署完成"
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

apt_install() {
  run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
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

ensure_base_tools() {
  local missing=()

  command -v git >/dev/null 2>&1 || missing+=("git")
  command -v curl >/dev/null 2>&1 || missing+=("curl")

  if [[ "${#missing[@]}" -eq 0 ]]; then
    return
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Missing required tools (${missing[*]}) and apt-get is unavailable for automatic install." >&2
    exit 1
  fi

  run_privileged apt-get update
  apt_install ca-certificates "${missing[@]}"
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    return
  fi

  echo "docker is required for light deploy." >&2
  exit 1
}

docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
    return
  fi

  run_privileged docker "$@"
}

INSTANCE="${1:-}"
BRANCH="${2:-main}"

if [[ -z "$INSTANCE" || "$INSTANCE" == "-h" || "$INSTANCE" == "--help" ]]; then
  usage
  exit 0
fi

validate_instance_name "$INSTANCE"

BASE_DIR="${DEPLOY_BASE_DIR:-/opt/deepflow-singularity}"
REPO_URL="${DEPLOY_REPO_URL:-}"
NOTIFY_CHAT_ID="${DEPLOY_NOTIFY_CHAT_ID:-}"
NOTIFY_ACCOUNT="${DEPLOY_NOTIFY_ACCOUNT:-singularity-main}"
NOTIFY_MESSAGE="${DEPLOY_NOTIFY_MESSAGE:-}"
TARGET_DIR="${BASE_DIR%/}/$INSTANCE"
TARGET_ENV="$TARGET_DIR/.env"
CONTAINER_NAME="${INSTANCE}-deepflow-singularity-1"
STAGE_DIR="/tmp/lightdeploy-app"

ensure_base_tools
ensure_docker

if [[ ! -d "$TARGET_DIR/.git" ]]; then
  echo "Light deploy requires an existing instance checkout at $TARGET_DIR" >&2
  echo "Use the full deploy script first." >&2
  exit 1
fi

if [[ ! -f "$TARGET_ENV" ]]; then
  echo "Missing $TARGET_ENV for $INSTANCE" >&2
  exit 1
fi

if ! docker_cmd ps --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
  echo "Container is not running: $CONTAINER_NAME" >&2
  echo "Use the full deploy script first." >&2
  exit 1
fi

if [[ -z "$REPO_URL" ]]; then
  REPO_URL="$(resolve_origin_remote "$TARGET_DIR")"
fi

if [[ -z "$REPO_URL" ]]; then
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    REPO_URL="$(git config --get remote.origin.url 2>/dev/null || true)"
  fi
fi

if [[ -z "$REPO_URL" ]]; then
  echo "Unable to determine deploy source; configure origin or set DEPLOY_REPO_URL." >&2
  exit 1
fi

validate_git_remote_url "$REPO_URL"
git config --global --add safe.directory "$TARGET_DIR" >/dev/null 2>&1 || true

cd "$TARGET_DIR"
OLD_HEAD="$(git rev-parse HEAD)"
if [[ -n "${DEPLOY_REPO_URL:-}" ]] || ! git remote get-url origin >/dev/null 2>&1; then
  ensure_origin_remote "$TARGET_DIR" "$REPO_URL"
fi
git fetch origin
git checkout -B "$BRANCH" "origin/$BRANCH"
NEW_HEAD="$(git rev-parse HEAD)"

CHANGED_FILES="$(git diff --name-only "${OLD_HEAD}..${NEW_HEAD}" || true)"
BLOCKED_FILES="$(printf '%s\n' "$CHANGED_FILES" | grep -E '^(Dockerfile|docker-compose\.yml|package\.json|package-lock\.json)$' || true)"
if [[ -n "$BLOCKED_FILES" ]]; then
  echo "Light deploy blocked by image-level changes:" >&2
  printf '%s\n' "$BLOCKED_FILES" >&2
  echo "Use scripts/deploy-compose-instance.sh instead." >&2
  exit 1
fi

docker_cmd exec "$CONTAINER_NAME" sh -lc "rm -rf '$STAGE_DIR' && mkdir -p '$STAGE_DIR'"
git archive --format=tar HEAD | docker_cmd exec -i "$CONTAINER_NAME" sh -lc "tar -xf - -C '$STAGE_DIR'"
docker_cmd exec "$CONTAINER_NAME" sh -lc "ln -s /app/node_modules '$STAGE_DIR/node_modules' && cd '$STAGE_DIR' && npm run build && rm '$STAGE_DIR/node_modules'"
docker_cmd exec "$CONTAINER_NAME" sh -lc "find /app -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} + && cp -a \"$STAGE_DIR\"/. /app/ && rm -rf \"$STAGE_DIR\""
docker_cmd exec "$CONTAINER_NAME" sh -lc "chmod +x /app/deploy/start-container.sh"
docker_cmd restart "$CONTAINER_NAME" >/dev/null

APP_PORT="$(grep -E '^APP_PORT=' "$TARGET_ENV" | tail -n 1 | cut -d= -f2- || true)"

echo "instance=$INSTANCE"
echo "branch=$BRANCH"
echo "old_head=${OLD_HEAD:0:7}"
echo "new_head=${NEW_HEAD:0:7}"
if [[ -n "$APP_PORT" ]]; then
  echo "health=http://127.0.0.1:$APP_PORT/healthz"
  echo "ready=http://127.0.0.1:$APP_PORT/openclaw-ready"
fi

if [[ -n "$APP_PORT" ]]; then
  for _ in $(seq 1 90); do
    health="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/healthz" || true)"
    ready="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/openclaw-ready" || true)"
    if [[ "$health" == "200" && "$ready" == "200" ]]; then
      break
    fi
    sleep 2
  done

  health="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/healthz" || true)"
  ready="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/openclaw-ready" || true)"
  echo "final_health=$health"
  echo "final_ready=$ready"
fi

if [[ -n "$NOTIFY_CHAT_ID" && -n "$APP_PORT" && "$health" == "200" && "$ready" == "200" ]]; then
  if [[ -z "$NOTIFY_MESSAGE" ]]; then
    NOTIFY_MESSAGE="轻部署完成，$INSTANCE 实例已切到最新代码。"
  fi
  docker_cmd exec \
    -e DEPLOY_NOTIFY_ACCOUNT="$NOTIFY_ACCOUNT" \
    -e DEPLOY_NOTIFY_CHAT_ID="$NOTIFY_CHAT_ID" \
    -e DEPLOY_NOTIFY_MESSAGE="$NOTIFY_MESSAGE" \
    "$CONTAINER_NAME" \
    sh -lc 'openclaw message send --channel telegram --account "$DEPLOY_NOTIFY_ACCOUNT" --target "$DEPLOY_NOTIFY_CHAT_ID" --message "$DEPLOY_NOTIFY_MESSAGE" --json' \
    >/tmp/${INSTANCE}-light-deploy-notify.out 2>/tmp/${INSTANCE}-light-deploy-notify.err || true
  echo "deploy_notify_chat_id=$NOTIFY_CHAT_ID"
  echo "deploy_notify_account=$NOTIFY_ACCOUNT"
fi
