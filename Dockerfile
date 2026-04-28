FROM node:24.14.0

WORKDIR /app
COPY . ./

RUN apt-get update && apt-get install -y --no-install-recommends awscli git supervisor tini && rm -rf /var/lib/apt/lists/*
RUN corepack enable
RUN npm i -g clawchef openclaw@2026.4.1
RUN npm i -g @openai/codex
RUN npm install
RUN npm run build
RUN chmod +x /app/deploy/start-container.sh

ENTRYPOINT ["tini", "--"]
CMD ["/app/deploy/start-container.sh"]
