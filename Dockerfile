FROM node:24-bookworm-slim AS node-runtime

FROM ubuntu:24.04 AS environment
COPY --from=node-runtime /usr/local/ /usr/local/
ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ pkg-config xvfb xauth libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libatk-bridge2.0-0t64 libdrm2 libxkbcommon0 libcups2t64 fonts-dejavu-core dbus
RUN useradd --create-home --uid 1001 validation && mkdir -p /work && chown validation:validation /work
WORKDIR /work
USER validation

FROM environment AS dependencies
COPY --chown=validation:validation package.json package-lock.json ./
RUN npm ci

FROM dependencies AS application
COPY --chown=validation:validation . .
RUN npm run check && npm run test:unit && npm run pack:linux
CMD ["xvfb-run", "-a", "sh", "-c", "npm run test:packaged && npm run test:extraction && npm run test:import && npm run test:documents && npm run test:ui-import"]
