FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    git tmux curl wget vim less \
    build-essential \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

CMD ["tmux", "new-session", "-s", "main"]
