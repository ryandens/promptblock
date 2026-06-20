# Build and run the promptblock Probot app.
# @stackone/defender bundles a ~22MB ONNX model, so no model download is needed
# at runtime — but the image is correspondingly larger.
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/lib ./lib
# Probot reads APP_ID / PRIVATE_KEY / WEBHOOK_SECRET from the environment.
EXPOSE 3000
CMD ["npm", "start"]
