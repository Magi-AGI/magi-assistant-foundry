# The sidecar, plus the headless GM browser (scripts/headless-gm.mjs) for a
# Foundry server nobody sits at. One image, two commands:
#   docker run … magi-foundry                              # the sidecar
#   docker run … magi-foundry node scripts/headless-gm.mjs # the headless GM
FROM mcr.microsoft.com/playwright:v1.59.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build
CMD ["node", "dist/index.js"]
