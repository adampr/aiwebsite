#!/usr/bin/env bash
#
# Install and configure the Cloudflare tunnel for ai.xl.net.
# Modeled on itsupportchicago/deploy/setup-cloudflared.sh.
#
# Run on the VM as root:
#   sudo bash /var/www/aiwebsite/deploy/setup-cloudflared.sh
#
# Two modes:
#   1. Pre-provisioned (preferred, what deploy.sh does): the tunnel was
#      already created on the dev box and its credentials JSON copied to
#      /etc/cloudflared/aiwebsite-tunnel.json. No browser login needed.
#   2. Fresh: no credentials present — falls back to interactive
#      `cloudflared tunnel login` + `tunnel create` (needs a browser).
#
set -euo pipefail

TUNNEL_NAME="aiwebsite"
HOSTNAME_ROOT="ai.xl.net"
CONFIG_DIR="/etc/cloudflared"
PREPROVISIONED_CRED="$CONFIG_DIR/aiwebsite-tunnel.json"
CRED_DIR="/root/.cloudflared"

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

mkdir -p "$CONFIG_DIR"

# ── 2. Locate or create tunnel credentials ──────────────────────
if [ -f "$PREPROVISIONED_CRED" ]; then
    echo ">>> Using pre-provisioned tunnel credentials: $PREPROVISIONED_CRED"
    TUNNEL_ID=$(python3 -c "import json;print(json.load(open('$PREPROVISIONED_CRED'))['TunnelID'])")
    CRED_FILE="$PREPROVISIONED_CRED"
else
    echo ">>> No pre-provisioned credentials — interactive setup."
    if [ ! -f "$CRED_DIR/cert.pem" ]; then
        cloudflared tunnel login
    fi
    if cloudflared tunnel list | grep -q "$TUNNEL_NAME"; then
        TUNNEL_ID=$(cloudflared tunnel list -o json | jq -r ".[] | select(.name==\"$TUNNEL_NAME\") | .id")
    else
        cloudflared tunnel create "$TUNNEL_NAME"
        TUNNEL_ID=$(cloudflared tunnel list -o json | jq -r ".[] | select(.name==\"$TUNNEL_NAME\") | .id")
    fi
    CRED_FILE="$CRED_DIR/${TUNNEL_ID}.json"
    # DNS route only needed in fresh mode (pre-provisioned mode routes on the dev box)
    cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME_ROOT" 2>&1 || echo "  DNS route may already exist"
fi

if [ -z "${TUNNEL_ID:-}" ]; then
    echo "ERROR: could not determine tunnel ID"; exit 1
fi
echo "  Tunnel: $TUNNEL_NAME ($TUNNEL_ID)"

# ── 3. Write config ─────────────────────────────────────────────
cat > "$CONFIG_DIR/config.yml" <<YAML
tunnel: ${TUNNEL_ID}
credentials-file: ${CRED_FILE}

ingress:
  - hostname: ${HOSTNAME_ROOT}
    service: http://127.0.0.1:80
  - service: http_status:404
YAML
chmod 600 "$CRED_FILE"
echo "  Config written to $CONFIG_DIR/config.yml"

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
