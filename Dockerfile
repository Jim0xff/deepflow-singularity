FROM node:24.14.0

WORKDIR /app
COPY . ./

RUN apt-get update && apt-get install -y --no-install-recommends awscli git supervisor tini && rm -rf /var/lib/apt/lists/*
RUN corepack enable
RUN npm i -g clawchef openclaw@2026.3.2
RUN npm i -g @openai/codex
RUN npm install
RUN npm run build

ENTRYPOINT ["tini", "--"]
CMD ["supervisord", "-c", "/app/deploy/supervisord.conf"]
