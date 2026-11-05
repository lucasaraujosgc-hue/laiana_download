FROM node:22-alpine

WORKDIR /app

# Dependências (inclui as de build: vite, tailwind)
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Código e build do frontend
COPY . .
RUN npm run build

ARG GIT_SHA=desconhecida
ENV GIT_SHA=$GIT_SHA
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
