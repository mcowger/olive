# syntax=docker/dockerfile:1

# Stage 1: Fetch Llama.cpp Vulkan Binaries (~30MB archive)
FROM oven/bun:1.3.14 AS llama-fetcher
WORKDIR /llama

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates tar && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /llama/bin && \
    curl -sL "https://github.com/ggml-org/llama.cpp/releases/download/b10453/llama-b10453-bin-ubuntu-vulkan-x64.tar.gz" -o /llama/llama.tar.gz && \
    tar -xzf /llama/llama.tar.gz -C /llama/bin --strip-components=1 && \
    rm /llama/llama.tar.gz

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

# Copy llama.cpp Vulkan binary suite
COPY --from=llama-fetcher /llama/bin /usr/local/llama

ENV PATH="/usr/local/llama:${PATH}" \
    LD_LIBRARY_PATH="/usr/local/llama:${LD_LIBRARY_PATH}" \
    LLAMA_SERVER_BIN="/usr/local/llama/llama-server" \
    NODE_ENV=production \
    PORT=4470 \
    OLIVE_DATA_DIR=/app/data \
    OLIVE_CONFIG_DIR=/app/data/config \
    OLIVE_MEETINGS_DIR=/app/data/meetings \
    OLIVE_MODELS_DIR=/app/data/models \
    HF_HOME=/app/data/models/huggingface \
    TRANSFORMERS_CACHE=/app/data/models/huggingface

EXPOSE 4470
VOLUME ["/app/data"]

CMD ["bun", "run", "packages/server/src/index.ts"]
