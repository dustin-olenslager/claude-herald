# Example target container for herald.
# Build:  docker build -t my-claude-rc -f claude-container.Dockerfile .
# Then connect to the herald network:
#   docker network connect herald-net my-claude-rc

FROM node:22-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      bash curl git openssh-client ca-certificates ripgrep jq nano less procps && \
    rm -rf /var/lib/apt/lists/* && \
    (getent group 100 || groupadd -g 100 users) && \
    useradd -u 1000 -g 100 -m -s /bin/bash cc && \
    mkdir -p /home/cc/.npm-global && \
    chown -R 1000:100 /home/cc

ENV PATH=/home/cc/.npm-global/bin:$PATH
USER cc
RUN npm config set prefix /home/cc/.npm-global && \
    npm install -g @anthropic-ai/claude-code

WORKDIR /workspace
CMD ["sleep", "infinity"]

# After first run, auth claude:
#   docker exec -it -u cc <container> claude
# (follow the device-flow prompts once; token persists in ~/.claude)
