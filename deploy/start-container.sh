#!/bin/sh
set -eu

echo "[container-start] running clawchef cook"
clawchef cook . -s --gateway-mode none

shared_root="/.openclaw/shared"
legacy_shared="/root/.openclaw/shared"

mkdir -p "$shared_root"
if [ -d "$legacy_shared" ] && [ ! -L "$legacy_shared" ]; then
  if find "$legacy_shared" -mindepth 1 -maxdepth 1 | read -r _; then
    cp -a "$legacy_shared"/. "$shared_root"/
    echo "[container-start] migrated legacy shared state to $shared_root"
  fi
  rm -rf "$legacy_shared"
fi
if [ ! -e "$legacy_shared" ]; then
  ln -s "$shared_root" "$legacy_shared"
  echo "[container-start] linked legacy shared path to $shared_root"
fi

for workspace in singularity-main singularity-reviewer singularity-writer singularity-video; do
  asset_dir="/app/assets/$workspace"
  workspace_dir="/root/.openclaw/workspace-$workspace"

  if [ -d "$asset_dir" ]; then
    mkdir -p "$workspace_dir"
    cp -R "$asset_dir"/. "$workspace_dir"/
    echo "[container-start] workspace asset overlay applied: $workspace"
  fi
done

video_workspace_dir="/root/.openclaw/workspace-singularity-video"
if [ -d "$video_workspace_dir" ]; then
  mkdir -p "$video_workspace_dir/config" "$video_workspace_dir/runtime"
  cat > "$video_workspace_dir/config/video-agent-config.json" <<EOF
{
  "generateVideo": {
    "baseUrl": "${VIDEO_AGENT_GENERATE_VIDEO_BASE_URL:-https://generate-video-gamma.vercel.app}",
    "agentApiToken": "${VIDEO_AGENT_GENERATE_VIDEO_AGENT_API_TOKEN:-}",
    "websiteUrl": "${VIDEO_AGENT_GENERATE_VIDEO_WEBSITE_URL:-https://generate-video-gamma.vercel.app/}",
    "publicCallbackUrl": "${VIDEO_AGENT_PUBLIC_CALLBACK_URL:-}",
    "callbackToken": "${VIDEO_AGENT_CALLBACK_TOKEN:-}"
  },
  "callbackServer": {
    "host": "${VIDEO_AGENT_CALLBACK_HOST:-0.0.0.0}",
    "port": ${VIDEO_AGENT_CALLBACK_PORT:-9000},
    "path": "${VIDEO_AGENT_CALLBACK_PATH:-/hooks/video-job}"
  },
  "scriptSource": {
    "type": "",
    "value": ""
  },
  "telegram": {
    "accountId": "singularity-video",
    "botToken": "${CLAWCHEF_VAR_SINGULARITY_VIDEO_TELEGRAM_BOT_KEY:-}"
  }
}
EOF
  touch "$video_workspace_dir/drafts.json"
  if [ ! -s "$video_workspace_dir/drafts.json" ]; then
    printf '{}\n' > "$video_workspace_dir/drafts.json"
  fi
  echo "[container-start] video-agent runtime config generated"
fi

echo "[container-start] starting openclaw gateway"
openclaw gateway run &

exec supervisord -c /app/deploy/supervisord.conf
