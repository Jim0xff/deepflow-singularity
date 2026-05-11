#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  delete-compose-instance.sh <instance>

Behavior:
  - Expects an existing Docker Compose instance under /opt/deepflow-singularity/<instance>
  - Removes compose resources for that instance
  - Removes the instance checkout
  - Removes the instance nginx conf when present
  - Removes the host data directories configured in that instance's .env

Env overrides:
  DEPLOY_BASE_DIR=/opt/deepflow-singularity
  DEPLOY_NGINX_CONF_DIR=/etc/nginx/conf.d/deepflow-singularity
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

safe_remove_dir() {
  local target="$1"
  if [[ -z "$target" || "$target" == "/" || "$target" == "." ]]; then
    echo "skip_remove_dir=$target"
    return
  fi

  if [[ ! -e "$target" ]]; then
    echo "already_missing=$target"
    return
  fi

  run_privileged rm -rf -- "$target"
  echo "removed_dir=$target"
}

cleanup_orphaned_compose_resources_by_label() {
  local instance="$1"
  local container_ids
  local network_ids

  container_ids="$(docker_cmd ps -aq --filter "label=com.docker.compose.project=$instance" || true)"
  if [[ -n "$container_ids" ]]; then
    # checkout 丢失时仍要按 compose project label 清理残留容器，避免误报“已删除”。
    docker_cmd rm -f $container_ids >/dev/null
    echo "removed_project_labeled_containers=true"
  fi

  network_ids="$(docker_cmd network ls -q --filter "label=com.docker.compose.project=$instance" || true)"
  if [[ -n "$network_ids" ]]; then
    docker_cmd network rm $network_ids >/dev/null || true
    echo "removed_project_labeled_networks=true"
  fi
}

read_env_value() {
  local key="$1"
  local file="$2"
  if [[ ! -f "$file" ]]; then
    return
  fi
  grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- || true
}

remove_nginx_conf() {
  local instance="$1"
  local conf_dir="$2"
  local target_conf="$conf_dir/$instance.conf"

  if [[ ! -f "$target_conf" ]]; then
    return
  fi

  run_privileged rm -f -- "$target_conf"
  echo "removed_nginx_conf=$target_conf"

  if command -v nginx >/dev/null 2>&1; then
    run_privileged nginx -t
    run_privileged nginx -s reload
    echo "reloaded_nginx=true"
  fi
}

maybe_remove_instance_data_dir() {
  local label="$1"
  local target="$2"

  case "$target" in
    "")
      echo "skipped_${label}=missing"
      return
      ;;
  esac

  # 当前部署模型约定每个实例都有自己独立的 host 挂载目录，因此这里直接信任实例 .env 中的路径。
  safe_remove_dir "$target"
}

INSTANCE="${1:-}"

if [[ -z "$INSTANCE" || "$INSTANCE" == "-h" || "$INSTANCE" == "--help" ]]; then
  usage
  exit 0
fi
validate_instance_name "$INSTANCE"

BASE_DIR="${DEPLOY_BASE_DIR:-/opt/deepflow-singularity}"
NGINX_CONF_DIR="${DEPLOY_NGINX_CONF_DIR:-/etc/nginx/conf.d/deepflow-singularity}"
TARGET_DIR="${BASE_DIR%/}/$INSTANCE"
TARGET_ENV="$TARGET_DIR/.env"

require_cmd docker

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin is required for delete." >&2
  exit 1
fi

if [[ ! -d "$TARGET_DIR" ]]; then
  cleanup_orphaned_compose_resources_by_label "$INSTANCE"
  remove_nginx_conf "$INSTANCE" "$NGINX_CONF_DIR"
  echo "instance=$INSTANCE"
  echo "action=deleted"
  echo "target_dir_missing=true"
  echo "cleanup_mode=project-label"
  exit 0
fi

HOST_DEEPFLOW_ASSETS_DIR="$(read_env_value HOST_DEEPFLOW_ASSETS_DIR "$TARGET_ENV")"
HOST_OPENCLAW_DEV_SHARED_DIR="$(read_env_value HOST_OPENCLAW_DEV_SHARED_DIR "$TARGET_ENV")"
HOST_CODEX_DIR="$(read_env_value HOST_CODEX_DIR "$TARGET_ENV")"

cd "$TARGET_DIR"

# delete 语义是“把实例运行时资源清干净”，因此这里直接 down 并清理孤儿容器。
docker_compose_cmd -p "$INSTANCE" down --remove-orphans
cleanup_orphaned_compose_resources_by_label "$INSTANCE"

remove_nginx_conf "$INSTANCE" "$NGINX_CONF_DIR"
maybe_remove_instance_data_dir "assets_dir" "$HOST_DEEPFLOW_ASSETS_DIR"
maybe_remove_instance_data_dir "shared_dir" "$HOST_OPENCLAW_DEV_SHARED_DIR"
maybe_remove_instance_data_dir "codex_dir" "$HOST_CODEX_DIR"
# checkout 放最后删，重试时才能继续从 .env 恢复实例数据目录并完成剩余清理。
safe_remove_dir "$TARGET_DIR"

echo "instance=$INSTANCE"
echo "action=deleted"
