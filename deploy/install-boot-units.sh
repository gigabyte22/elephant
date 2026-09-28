#!/usr/bin/env bash
# Install boot-time units: elephant-neo4j (recreates the Neo4j container on
# every reboot), elephant (the memory service, which waits for Neo4j) and
# elephant-backup.timer (a daily online Neo4j dump).
#
# Run with: sudo bash deploy/install-boot-units.sh
#
# The unit files contain __ELEPHANT_USER__ / __ELEPHANT_GROUP__ /
# __ELEPHANT_DIR__ placeholders. By default they resolve to the user who
# invoked sudo and this repo's root; override via environment:
#   sudo ELEPHANT_USER=svc ELEPHANT_DIR=/opt/elephant bash deploy/install-boot-units.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$HERE")"

if [[ $EUID -ne 0 ]]; then
  echo "Must run as root: sudo bash $0" >&2
  exit 1
fi

ELEPHANT_USER="${ELEPHANT_USER:-${SUDO_USER:?Set ELEPHANT_USER (could not infer from SUDO_USER)}}"
ELEPHANT_GROUP="${ELEPHANT_GROUP:-$ELEPHANT_USER}"
ELEPHANT_DIR="${ELEPHANT_DIR:-$REPO_ROOT}"

echo "Installing units for user=$ELEPHANT_USER group=$ELEPHANT_GROUP dir=$ELEPHANT_DIR"

render() {
  sed -e "s|__ELEPHANT_USER__|$ELEPHANT_USER|g" \
      -e "s|__ELEPHANT_GROUP__|$ELEPHANT_GROUP|g" \
      -e "s|__ELEPHANT_DIR__|$ELEPHANT_DIR|g" "$1"
}

echo "Installing elephant-neo4j.service ..."
render "$HERE/elephant-neo4j.service" > /etc/systemd/system/elephant-neo4j.service
chmod 0644 /etc/systemd/system/elephant-neo4j.service

echo "Installing elephant.service ..."
render "$HERE/elephant.service" > /etc/systemd/system/elephant.service
chmod 0644 /etc/systemd/system/elephant.service

echo "Installing elephant-backup.service + elephant-backup.timer ..."
render "$HERE/elephant-backup.service" > /etc/systemd/system/elephant-backup.service
chmod 0644 /etc/systemd/system/elephant-backup.service
install -m 0644 "$HERE/elephant-backup.timer" /etc/systemd/system/elephant-backup.timer

echo "Installing elephant drop-in ..."
install -d -m 0755 /etc/systemd/system/elephant.service.d
install -m 0644 "$HERE/elephant.service.d/neo4j.conf" /etc/systemd/system/elephant.service.d/neo4j.conf

echo "Reloading systemd ..."
systemctl daemon-reload

echo "Enabling elephant-neo4j.service ..."
systemctl enable elephant-neo4j.service

echo "Enabling elephant.service ..."
systemctl enable elephant.service

echo "Enabling elephant-backup.timer ..."
systemctl enable --now elephant-backup.timer

echo
echo "Done. Test now without rebooting with:"
echo "  sudo systemctl restart elephant-neo4j.service && systemctl status elephant-neo4j.service --no-pager"
echo "Run a backup immediately with:"
echo "  sudo systemctl start elephant-backup.service && journalctl -u elephant-backup.service -n 5 --no-pager"
