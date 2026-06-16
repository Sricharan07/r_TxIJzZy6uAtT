#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${KILN_APP_DIR:-$(pwd)}"
ENV_FILE="${KILN_ENV_FILE:-$APP_DIR/.env}"
FC_DIR="${KILN_FIRECRACKER_DIR:-/opt/kiln/firecracker}"
WORK_DIR="${KILN_FIRECRACKER_WORK_DIR:-/var/lib/kiln/firecracker}"
SYSTEMD_DIR="${KILN_SYSTEMD_DIR:-/etc/systemd/system}"
S3="https://s3.amazonaws.com/spec.ccfc.min"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Firecracker host bootstrap must run on Linux with KVM." >&2
  exit 1
fi

if [[ ! -e /dev/kvm ]]; then
  echo "/dev/kvm is missing. Use a bare-metal/nested-virtualization Linux host with KVM enabled." >&2
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root; Firecracker networking requires tap, sysctl, and iptables access." >&2
  exit 1
fi

if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates curl e2fsprogs grep iproute2 iptables openssh-client python3 squashfs-tools tar wget
fi

mkdir -p "$FC_DIR/bin" "$WORK_DIR" /etc/kiln

if ! command -v node >/dev/null 2>&1 || ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 20 && minor >= 19) || (major === 22 && minor >= 13) || major >= 24 ? 0 : 1)' ; then
  echo "Node ^20.19.0, ^22.13.0, or >=24.0.0 is required on the Firecracker host." >&2
  exit 1
fi

if command -v npm >/dev/null 2>&1; then
  (cd "$APP_DIR" && npm ci --ignore-scripts && npm run build --workspace=packages/shared && npm run build --workspace=packages/grader && npm run build --workspace=packages/runner)
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|aarch64) ;;
  *) echo "Unsupported Firecracker architecture: $ARCH" >&2; exit 1 ;;
esac

release_url="https://github.com/firecracker-microvm/firecracker/releases"
latest="$(basename "$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$release_url/latest")")"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$release_url/download/$latest/firecracker-$latest-$ARCH.tgz" | tar -xz -C "$tmp"
fc_bin="$(find "$tmp" -type f -name "firecracker-$latest-$ARCH" | head -1)"
if [[ -z "$fc_bin" ]]; then
  echo "Could not find firecracker binary in release archive." >&2
  exit 1
fi
install -m 0755 "$fc_bin" "$FC_DIR/bin/firecracker"

python3 - "$S3" "$ARCH" "$tmp" <<'PY'
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

s3, arch, tmp = sys.argv[1:]
tmp = Path(tmp)

def list_keys(prefix):
    url = f"{s3}?list-type=2&prefix={prefix}"
    with urllib.request.urlopen(url) as response:
        root = ET.fromstring(response.read())
    ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
    return [node.text for node in root.findall("s3:Contents/s3:Key", ns) if node.text]

def list_prefixes(prefix):
    url = f"{s3}?list-type=2&prefix={prefix}&delimiter=/"
    with urllib.request.urlopen(url) as response:
        root = ET.fromstring(response.read())
    ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
    return [node.text for node in root.findall("s3:CommonPrefixes/s3:Prefix", ns) if node.text]

prefixes = sorted(list_prefixes("firecracker-ci/"))
if not prefixes:
    raise SystemExit("No Firecracker CI artifact prefixes found.")
prefix = prefixes[-1]
kernels = sorted(
    [key for key in list_keys(f"{prefix}{arch}/vmlinux-") if re.search(r"/vmlinux-\d+\.\d+\.\d+$", key)],
    key=lambda key: [int(part) for part in key.rsplit("-", 1)[-1].split(".")],
)
roots = sorted([key for key in list_keys(f"{prefix}{arch}/ubuntu-") if key.endswith(".squashfs")])
if not kernels or not roots:
    raise SystemExit(f"No kernel/rootfs artifacts found under {prefix}{arch}/")
for key, name in [(kernels[-1], "vmlinux.bin"), (roots[-1], "ubuntu.squashfs.upstream")]:
    urllib.request.urlretrieve(f"{s3}/{key}", tmp / name)
PY

if [[ ! -f "$FC_DIR/id_rsa" ]]; then
  ssh-keygen -q -t ed25519 -f "$FC_DIR/id_rsa" -N ""
fi

rm -rf "$tmp/squashfs-root"
unsquashfs -d "$tmp/squashfs-root" "$tmp/ubuntu.squashfs.upstream" >/dev/null
install -d -m 0700 "$tmp/squashfs-root/root/.ssh"
install -m 0600 "$FC_DIR/id_rsa.pub" "$tmp/squashfs-root/root/.ssh/authorized_keys"
chown -R root:root "$tmp/squashfs-root"
truncate -s 8G "$FC_DIR/rootfs.ext4"
mkfs.ext4 -F -d "$tmp/squashfs-root" "$FC_DIR/rootfs.ext4" >/dev/null
install -m 0644 "$tmp/vmlinux.bin" "$FC_DIR/vmlinux.bin"

escaped_app_dir="${APP_DIR//&/\\&}"
sed "s#__KILN_APP_DIR__#$escaped_app_dir#g" "$APP_DIR/infra/systemd/kiln-firecracker-host-manager.service" > "$SYSTEMD_DIR/kiln-firecracker-host-manager.service"
sed "s#__KILN_APP_DIR__#$escaped_app_dir#g" "$APP_DIR/infra/systemd/kiln-runner-worker.service" > "$SYSTEMD_DIR/kiln-runner-worker.service"
chmod 0644 "$SYSTEMD_DIR/kiln-firecracker-host-manager.service" "$SYSTEMD_DIR/kiln-runner-worker.service"
cp "$ENV_FILE" /etc/kiln/app.env

systemctl daemon-reload
systemctl enable kiln-firecracker-host-manager.service kiln-runner-worker.service

echo "Firecracker host assets are installed under $FC_DIR."
echo "Start services with: systemctl start kiln-firecracker-host-manager kiln-runner-worker"
