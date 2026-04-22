FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends openssl wireguard-tools \
	&& rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

ENV NODE_ENV=docker_dev

CMD ["npm", "run", "dev"]
