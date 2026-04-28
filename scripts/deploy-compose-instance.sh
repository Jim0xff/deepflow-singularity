#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  deploy-compose-instance.sh <instance> [branch]

Behavior:
  - Full redeploys one Docker Compose instance under /opt/deepflow-singularity/<instance>
  - Resets code to origin/<branch>
  - Reuses the instance's existing .env by default
  - If /opt/deepflow-singularity-config/config.yaml contains environments.<instance>,
    regenerates .env from that config first
  - Rebuilds and force-recreates the whole Docker stack

Env overrides:
  DEPLOY_BASE_DIR=/opt/deepflow-singularity
  DEPLOY_CONFIG_PATH=/opt/deepflow-singularity-config/config.yaml
  DEPLOY_REPO_URL=<git remote url>
  DEPLOY_SKIP_NGINX=true
  DEPLOY_PRUNE_IMAGES=true
  DEPLOY_NOTIFY_CHAT_ID=-1001234567890
  DEPLOY_NOTIFY_ACCOUNT=singularity-main
  DEPLOY_NOTIFY_MESSAGE="部署完成"

Config defaults:
  environments.<instance>.deploy.notify.chat_id
  environments.<instance>.deploy.notify.account
  environments.<instance>.deploy.notify.message
EOF
}

INSTANCE="${1:-}"
BRANCH="${2:-main}"

if [[ -z "$INSTANCE" || "$INSTANCE" == "-h" || "$INSTANCE" == "--help" ]]; then
  usage
  exit 0
fi

BASE_DIR="${DEPLOY_BASE_DIR:-/opt/deepflow-singularity}"
CONFIG_PATH="${DEPLOY_CONFIG_PATH:-/opt/deepflow-singularity-config/config.yaml}"
REPO_URL="${DEPLOY_REPO_URL:-}"
SKIP_NGINX="${DEPLOY_SKIP_NGINX:-false}"
PRUNE_IMAGES="${DEPLOY_PRUNE_IMAGES:-false}"
NOTIFY_CHAT_ID="${DEPLOY_NOTIFY_CHAT_ID:-}"
NOTIFY_ACCOUNT="${DEPLOY_NOTIFY_ACCOUNT:-singularity-main}"
NOTIFY_MESSAGE="${DEPLOY_NOTIFY_MESSAGE:-}"

if [[ -z "$REPO_URL" ]] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  REPO_URL="$(git rev-parse --show-toplevel)"
fi

if [[ -z "$REPO_URL" ]]; then
  REPO_URL="$(git config --get remote.origin.url 2>/dev/null || true)"
fi

if [[ -z "$REPO_URL" ]]; then
  echo "Unable to determine deploy source; run inside a git repo or set DEPLOY_REPO_URL." >&2
  exit 1
fi

TARGET_DIR="$BASE_DIR/$INSTANCE"
TARGET_ENV="$TARGET_DIR/.env"
HAS_CONFIG_ENV=false

mkdir -p "$BASE_DIR"

if [[ ! -d "$TARGET_DIR/.git" ]]; then
  git clone "$REPO_URL" "$TARGET_DIR"
fi

if [[ -d "$REPO_URL/.git" ]]; then
  git config --global --add safe.directory "$REPO_URL" >/dev/null 2>&1 || true
  git config --global --add safe.directory "$REPO_URL/.git" >/dev/null 2>&1 || true
fi

git config --global --add safe.directory "$TARGET_DIR" >/dev/null 2>&1 || true

cd "$TARGET_DIR"
git remote set-url origin "$REPO_URL"
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

docker compose -p "$INSTANCE" up -d --build --force-recreate --remove-orphans

if [[ "$SKIP_NGINX" != "true" && "$HAS_CONFIG_ENV" == "true" ]]; then
  "$TARGET_DIR/scripts/deploy-nginx.sh" "$INSTANCE"
fi

if [[ "$PRUNE_IMAGES" == "true" ]]; then
  docker image prune -f
fi

APP_PORT="$(grep -E '^APP_PORT=' "$TARGET_ENV" | tail -n 1 | cut -d= -f2- || true)"

echo "instance=$INSTANCE"
echo "branch=$BRANCH"
echo "target_dir=$TARGET_DIR"
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
      NOTIFY_MESSAGE="部署完成，$INSTANCE 实例已就绪。"
    fi
    docker exec \
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
