# Two stages: compile with the dev toolchain, run with production deps only.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src src
COPY web web
RUN npx tsc -p tsconfig.build.json \
 && npx esbuild web/app.ts --bundle --outfile=web/app.js --log-level=warning

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist dist
COPY --from=build /app/web/login.html web/login.html
COPY --from=build /app/web/game.html web/game.html
COPY --from=build /app/web/app.js web/app.js
COPY decks decks
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/server.js"]
