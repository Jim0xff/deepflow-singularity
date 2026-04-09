#!/bin/sh
set -eu

echo "[container-start] running clawchef cook"
clawchef cook . -s --gateway-mode none

for workspace in singularity-main singularity-reviewer singularity-writer; do
  asset_dir="/app/assets/$workspace"
  workspace_dir="/root/.openclaw/workspace-$workspace"

  if [ -d "$asset_dir" ]; then
    mkdir -p "$workspace_dir"
    cp -R "$asset_dir"/. "$workspace_dir"/
    echo "[container-start] workspace asset overlay applied: $workspace"
  fi
done

echo "[container-start] starting openclaw gateway"
openclaw gateway run &

exec supervisord -c /app/deploy/supervisord.conf
