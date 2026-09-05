#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

if systemctl is-active --quiet docker 2>/dev/null && command -v /usr/bin/dockerd >/dev/null 2>&1; then
  echo "docker already active"
  /usr/bin/docker --version
  exit 0
fi

apt-get update -qq
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
fi
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
usermod -aG docker gxg || true
systemctl enable --now docker
# Prefer native docker over Windows Docker Desktop path
if [[ -x /usr/bin/docker ]]; then
  /usr/bin/docker --version
fi
systemctl is-active docker
