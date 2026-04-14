#!/bin/sh
set -eu

echo "[container-start] running clawchef cook"
clawchef cook . -s --gateway-mode none

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
    "baseUrl": "${VIDEO_AGENT_GENERATE_VIDEO_BASE_URL:-https://ai-video-generator-git-dev-ainur.vercel.app}",
    "agentApiToken": "${VIDEO_AGENT_GENERATE_VIDEO_AGENT_API_TOKEN:-}",
    "websiteUrl": "${VIDEO_AGENT_GENERATE_VIDEO_WEBSITE_URL:-https://ai-video-generator-git-dev-ainur.vercel.app/}",
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
