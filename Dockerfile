FROM node:20-slim AS build
WORKDIR /app
# O Baileys depende do libsignal-node direto via git (não via NPM registry).
# A imagem slim não tem git, e sem essa configuração o npm tenta usar SSH
# (git+ssh://git@github.com/...) sem chave disponível e falha. Instalamos
# git e forçamos HTTPS no lugar de SSH pra esse clone funcionar sem chave.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git config --global url."https://github.com/".insteadOf "git@github.com:" \
  && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
# poppler-utils dá o comando pdftoppm, usado pra gerar a miniatura da
# primeira página de PDFs enviados como documento.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates poppler-utils \
  && rm -rf /var/lib/apt/lists/* \
  && git config --global url."https://github.com/".insteadOf "git@github.com:" \
  && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist

EXPOSE 3000
CMD ["node", "dist/server.js"]
