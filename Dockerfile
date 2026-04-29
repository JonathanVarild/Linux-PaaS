FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends iproute2 openssl wireguard-tools iputils-ping etcd-server docker.io docker-compose \
	&& rm -rf /var/lib/apt/lists/*

COPY scripts/worker-entrypoint.sh /usr/local/bin/worker-entrypoint.sh
RUN chmod +x /usr/local/bin/worker-entrypoint.sh

COPY package.json package-lock.json ./
RUN npm ci

ENV NODE_ENV=docker_dev

CMD ["worker-entrypoint.sh", "npm", "run", "dev"]
