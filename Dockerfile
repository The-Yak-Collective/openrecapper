FROM node:20-slim

# Install native build deps for @discordjs/opus and sodium-native
RUN apt-get update && apt-get install -y \
    python3 make g++ libopus-dev libsodium-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build
RUN npx tsc

# Run
CMD ["node", "dist/index.js"]
