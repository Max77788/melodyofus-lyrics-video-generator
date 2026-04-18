FROM node:20-slim

# Install dependencies needed by Chromium (used by Remotion)
RUN apt-get update && apt-get install -y \
  chromium \
  fonts-liberation \
  fonts-noto \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  libcairo2 \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libglib2.0-0 \
  libgtk-3-0 \
  libnspr4 \
  libnss3 \
  libpango-1.0-0 \
  libx11-6 \
  libxcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxrandr2 \
  libxshmfence1 \
  wget \
  xdg-utils \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Install Montserrat font
RUN mkdir -p /usr/share/fonts/truetype/montserrat && \
  wget -q "https://github.com/JulietaUla/Montserrat/raw/master/fonts/ttf/Montserrat-Black.ttf" \
  -O /usr/share/fonts/truetype/montserrat/Montserrat-Black.ttf && \
  fc-cache -fv

WORKDIR /app

# Copy and install dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source files
COPY . .

# Set Chromium path for Remotion
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

EXPOSE 8080

# Pre-build the bundle at container start via the server's auto-warm
CMD ["node", "server.js"]
