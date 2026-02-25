FROM node:20-bookworm

RUN apt-get update && apt-get install -y \
    git tmux curl wget vim less \
    openssh-client \
    python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace

CMD ["tmux", "new-session", "-s", "claude"]
