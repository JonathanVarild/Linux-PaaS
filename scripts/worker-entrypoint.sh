#!/usr/bin/env sh
rm -f /var/run/docker.pid
dockerd >/var/log/dockerd.log 2>&1 &

until docker info >/dev/null 2>&1; do
  sleep 1
done

exec "$@"