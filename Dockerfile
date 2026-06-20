# Build and run the promptblock app.
# The prompt-injection scanner bundles a ~22MB ONNX model, so no model download
# is needed at runtime — but the image is correspondingly larger.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
# pnpm-workspace.yaml carries the build-script allowlist and supply-chain policy.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/lib ./lib
# The app reads APP_ID / PRIVATE_KEY / WEBHOOK_SECRET from the environment.
EXPOSE 3000
CMD ["pnpm", "start"]
