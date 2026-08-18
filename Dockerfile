FROM node:20-bookworm-slim

# Install system dependencies, ffmpeg, ca-certificates, and curl
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    ca-certificates \
    python3 \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application files
COPY . .

# Expose default port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
