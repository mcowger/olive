# syntax=docker/dockerfile:1

# Stage 1: Isolated Model Pre-caching & Llama.cpp Vulkan Binary Stage
# This stage ONLY depends on the model downloader script and transformers package.
# It is completely decoupled from application code, package.json, and bun.lock changes.
FROM oven/bun:1.3.14 AS model-downloader
WORKDIR /models

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates tar && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /models/bin && \
    curl -sL "https://github.com/ggml-org/llama.cpp/releases/download/b10453/llama-b10453-bin-ubuntu-vulkan-x64.tar.gz" -o /models/llama.tar.gz && \
    tar -xzf /models/llama.tar.gz -C /models/bin --strip-components=1 && \
    rm /models/llama.tar.gz

RUN bun add @huggingface/transformers@4.2.0

ENV HF_HOME=/models/.cache/huggingface \
    TRANSFORMERS_CACHE=/models/.cache/huggingface \
    OLIVE_CONFIG_DIR=/models/data/config

COPY scripts/download-models.ts ./scripts/
RUN bun run scripts/download-models.ts

# Stage 2: Application Dependencies and Web Build
FROM oven/bun:1.3.14 AS app-builder
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/

RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
COPY packages/web ./packages/web

RUN bun run build:web

# Stage 3: Production Runtime
FROM oven/bun:1.3.14 AS runner
WORKDIR /app

# Install runtime system utilities, audio processing, and Vulkan / Mesa GPU drivers
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    curl \
    ca-certificates \
    mesa-vulkan-drivers \
    libvulkan1 \
    vulkan-tools \
    libva-drm2 \
    libdrm2 \
    && rm -rf /var/lib/apt/lists/*

# Copy built application and node_modules
COPY --from=app-builder /app /app

# Copy cached model weights and offline catalog from the model-downloader stage
COPY --from=model-downloader /models/.cache/huggingface /app/.cache/huggingface
COPY --from=model-downloader /models/data/config /app/data/config

# Copy llama.cpp Vulkan binary suite
COPY --from=model-downloader /models/bin /usr/local/llama
ENV PATH="/usr/local/llama:${PATH}" \
    LD_LIBRARY_PATH="/usr/local/llama:${LD_LIBRARY_PATH}" \
    LLAMA_SERVER_BIN="/usr/local/llama/llama-server"

ENV NODE_ENV=production \
    PORT=4470 \
    OLIVE_DATA_DIR=/app/data \
    OLIVE_CONFIG_DIR=/app/data/config \
    OLIVE_MEETINGS_DIR=/app/data/meetings \
    HF_HOME=/app/.cache/huggingface \
    TRANSFORMERS_CACHE=/app/.cache/huggingface

EXPOSE 4470
VOLUME ["/app/data"]

CMD ["bun", "run", "packages/server/src/index.ts"]
