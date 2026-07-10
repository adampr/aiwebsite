#!/usr/bin/env bash
# aicompany-template: setup-cloudflared.sh.tpl@4b406a20491ca4c7bbf60e2d51d2fdb0c9b0de496f0f9e493fcabb15beac4dc2
#
# Install and configure the Cloudflare tunnel for ai.xl.net.
#
# Run on the VM as root (setup-vm.sh does):
#   sudo bash /var/www/aiwebsite/deploy/setup-cloudflared.sh
#
# Two modes:
#   1. Pre-provisioned (preferred, what deploy.sh does): the tunnel was
#      already created on the dev box and its credentials JSON copied to
#      /etc/cloudflared/aiwebsite-tunnel.json. No browser login needed.
#   2. Fresh: no credentials present — falls back to interactive
#      `cloudflared tunnel login` + `tunnel create` (needs a browser).
#
# DNS is always a human step: CNAME <sub> → <tunnel-id>.cfargotunnel.com,
# Proxied (§9.6). The fresh-mode `tunnel route dns` below only works when the
# login had zone scope; verify the record in the Cloudflare dashboard.
#
set -euo pipefail

tunnel_name="aiwebsite"
hostname_root="ai.xl.net"
config_dir="/etc/cloudflared"
preprovisioned_cred="$config_dir/aiwebsite-tunnel.json"
cred_dir="/root/.cloudflared"

echo "=== Cloudflare Tunnel Setup (ai.xl.net) ==="

# ── 1. Install cloudflared ───────────────────────────────────────
if ! command -v cloudflared &>/dev/null; then
    echo ">>> Installing cloudflared..."
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
        | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
        | tee /etc/apt/sources.list.d/cloudflared.list
    apt-get update -qq
    apt-get install -y -qq cloudflared
fi
echo "  cloudflared: $(cloudflared --version)"

mkdir -p "$config_dir"

# ── 2. Locate or create tunnel credentials ──────────────────────
if [ -f "$preprovisioned_cred" ]; then
    echo ">>> Using pre-provisioned tunnel credentials: $preprovisioned_cred"
    tunnel_id=$(python3 -c "import json;print(json.load(open('$preprovisioned_cred'))['TunnelID'])")
    cred_file="$preprovisioned_cred"
else
    echo ">>> No pre-provisioned credentials — interactive setup."
    if [ ! -f "$cred_dir/cert.pem" ]; then
        cloudflared tunnel login
    fi
    if cloudflared tunnel list | grep -q "$tunnel_name"; then
        tunnel_id=$(cloudflared tunnel list -o json | jq -r ".[] | select(.name==\"$tunnel_name\") | .id")
    else
        cloudflared tunnel create "$tunnel_name"
        tunnel_id=$(cloudflared tunnel list -o json | jq -r ".[] | select(.name==\"$tunnel_name\") | .id")
    fi
    cred_file="$cred_dir/$tunnel_id.json"
    # DNS route only needed in fresh mode (pre-provisioned mode routes on the dev box)
    cloudflared tunnel route dns "$tunnel_name" "$hostname_root" 2>&1 || echo "  DNS route may already exist"
fi

if [ -z "${tunnel_id:-}" ]; then
    echo "ERROR: could not determine tunnel ID"; exit 1
fi
echo "  Tunnel: $tunnel_name ($tunnel_id)"

# ── 3. Write config ─────────────────────────────────────────────
cat > "$config_dir/config.yml" <<YAML
tunnel: $tunnel_id
credentials-file: $cred_file

ingress:
  - hostname: $hostname_root
    service: http://127.0.0.1:80
  - service: http_status:404
YAML
chmod 600 "$cred_file"
echo "  Config written to $config_dir/config.yml"

# ── 4. Install and start systemd service ────────────────────────
cloudflared service install 2>/dev/null || echo "  Service already installed"
systemctl enable cloudflared
systemctl restart cloudflared

sleep 3
if systemctl is-active --quiet cloudflared; then
    echo "  cloudflared service is running"
else
    echo "  WARNING: cloudflared failed to start. Check: journalctl -u cloudflared -n 20"
fi

echo ""
echo "=== Done. Verify: ==="
echo "  curl -fsS -H 'Host: ai.xl.net' http://127.0.0.1/api/health   # local nginx"
echo "  curl -fsS https://ai.xl.net/api/health                        # via tunnel"
echo "  journalctl -u cloudflared -f"
