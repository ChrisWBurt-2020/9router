#!/usr/bin/env bash
# Install 9Router as a systemd --user service and add it to the desktop app menu.
#
# Writes (all under $HOME, nothing outside the repo is read):
#   ~/.config/systemd/user/9router.service
#   ~/.local/bin/9router-web
#   ~/.local/share/applications/9router.desktop
#   ~/.local/share/icons/hicolor/scalable/apps/9router.svg
#
# then reloads systemd, enables and (re)starts the service. Idempotent: re-run
# after a rebuild or a config change to refresh the generated files.
#
# Usage:
#   scripts/install-linux-desktop.sh [--expose MODE]   # install / update
#   scripts/install-linux-desktop.sh --uninstall       # remove service + menu entry
#   scripts/install-linux-desktop.sh --print-bind [--expose MODE]  # print bind host, exit
#
# Exposure modes (SECURITY: the default is loopback only — 9Router never binds
# to the world unless you ask for it):
#   loopback  — bind 127.0.0.1 (default). Only this machine can reach it.
#   tailnet   — bind the machine's Tailscale IPv4 (tailscale must be up).
#   lan       — bind 0.0.0.0 (any interface). Anyone who can reach this host
#               can attempt to use the gateway; pair with requireApiKey.
#
# The desktop launcher and health check run against the loopback (or, for
# tailnet mode, the tailnet) address, so they never force a broad bind.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

STANDALONE_DIR="${REPO_ROOT}/.next/standalone"
ENV_FILE="${REPO_ROOT}/.env"
ICON_SRC="${REPO_ROOT}/images/9router.svg"

UNIT_NAME="9router.service"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_PATH="${UNIT_DIR}/${UNIT_NAME}"
BIN_DIR="${HOME}/.local/bin"
LAUNCHER="${BIN_DIR}/9router-web"
APPS_DIR="${HOME}/.local/share/applications"
DESKTOP_FILE="${APPS_DIR}/9router.desktop"
ICON_DIR="${HOME}/.local/share/icons/hicolor/scalable/apps"
ICON_FILE="${ICON_DIR}/9router.svg"

EXPOSE_MODE="loopback"

die() { echo "Error: $*" >&2; exit 1; }

# ── Argument parsing ───────────────────────────────────────────────────────
PRINT_BIND=""
UNINSTALL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall)
      UNINSTALL="1"; shift
      ;;
    --expose)
      [[ $# -gt 1 ]] || die "--expose requires loopback|tailnet|lan"
      EXPOSE_MODE="$2"; shift 2
      ;;
    --print-bind)
      PRINT_BIND="1"; shift
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

case "$EXPOSE_MODE" in
  loopback|tailnet|lan) ;;
  *) die "Invalid --expose mode '$EXPOSE_MODE' (expected loopback|tailnet|lan)" ;;
esac

# Resolve the bind host for the chosen exposure mode.
# Returns: "<bind_host>|<check_host>|<human_url_host>"
resolve_bind() {
  case "$EXPOSE_MODE" in
    loopback)
      echo "127.0.0.1|127.0.0.1|127.0.0.1"
      ;;
    lan)
      echo "0.0.0.0|127.0.0.1|127.0.0.1"
      ;;
    tailnet)
      local ip
      ip="$(command -v tailscale >/dev/null 2>&1 && tailscale ip -4 2>/dev/null | head -n1 || true)"
      [[ -n "${ip}" ]] || die "tailnet mode needs Tailscale running: could not resolve 'tailscale ip -4'. Install/enable Tailscale first, or use --expose loopback."
      echo "${ip}|${ip}|${ip}"
      ;;
  esac
}

IFS='|' read -r BIND_HOST CHECK_HOST HUMAN_HOST <<< "$(resolve_bind)"

# Early, side-effect-free mode that lets tests (and users) see the resolved bind.
if [[ -n "${PRINT_BIND}" ]]; then
  echo "${BIND_HOST}"
  exit 0
fi

refresh_menus() {
  systemctl --user daemon-reload 2>/dev/null || true
  command -v update-desktop-database >/dev/null 2>&1 && \
    update-desktop-database "${APPS_DIR}" >/dev/null 2>&1 || true
}

uninstall() {
  systemctl --user disable --now "${UNIT_NAME}" >/dev/null 2>&1 || true
  rm -f "${UNIT_PATH}" "${LAUNCHER}" "${DESKTOP_FILE}" "${ICON_FILE}"
  refresh_menus
  echo "9Router desktop integration removed."
}

[[ "$(uname -s)" == "Linux" ]] || die "This installer targets Linux (systemd --user)."

if [[ -n "${UNINSTALL}" ]]; then
  uninstall
  exit 0
fi

[[ -f "${STANDALONE_DIR}/custom-server.js" && -f "${STANDALONE_DIR}/server.js" ]] || \
  die "Standalone build not found at ${STANDALONE_DIR}. Run 'npm run build' first."
[[ -f "${ENV_FILE}" ]] || \
  die "Missing ${ENV_FILE}. Copy .env.example to .env and configure it."

NODE_BIN="$(node -e 'process.stdout.write(process.execPath)' 2>/dev/null || true)"
[[ -n "${NODE_BIN}" ]] || NODE_BIN="$(command -v node || true)"
[[ -x "${NODE_BIN}" ]] || die "Could not locate the node executable on PATH."

PORT="$(sed -n 's/^PORT=\([0-9]\{1,\}\).*/\1/p' "${ENV_FILE}" | tail -n1)"
PORT="${PORT:-20128}"
APP_URL="http://${CHECK_HOST}:${PORT}"
DASHBOARD_URL="${APP_URL}/dashboard"

mkdir -p "${UNIT_DIR}" "${BIN_DIR}" "${APPS_DIR}" "${ICON_DIR}"

# SECURITY: bind only the resolved host (loopback by default). The launcher and
# health check use the same host, so nothing forces a 0.0.0.0 bind.
cat > "${UNIT_PATH}" <<EOF
[Unit]
Description=9Router AI routing gateway + dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=${STANDALONE_DIR}
EnvironmentFile=${ENV_FILE}
Environment=HOSTNAME=${BIND_HOST}
ExecStart=${NODE_BIN} ${STANDALONE_DIR}/custom-server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF

cat > "${LAUNCHER}" <<EOF
#!/usr/bin/env bash
# 9Router - AI routing gateway + dashboard launcher.
# Ensures the systemd user service is running, then launches the dashboard as a web app.
# Generated by scripts/install-linux-desktop.sh - edits will be overwritten.

set -euo pipefail

APP_URL="${APP_URL}"
DASHBOARD_URL="${DASHBOARD_URL}"
UNIT="${UNIT_NAME}"
CHECK_HOST="${CHECK_HOST}"

action="\${1:-}"

is_healthy() {
  curl -fsS --max-time 2 "\${APP_URL}/" >/dev/null 2>&1
}

ensure_service() {
  if is_healthy; then
    return 0
  fi
  systemctl --user start "\${UNIT}"
  for _ in {1..40}; do
    if is_healthy; then
      return 0
    fi
    sleep 0.25
  done
  echo "Error: 9Router did not respond on \${APP_URL}." >&2
  systemctl --user status "\${UNIT}" --no-pager >&2 || true
  return 1
}

case "\${action}" in
  --restart)
    echo "Restarting \${UNIT}..."
    systemctl --user restart "\${UNIT}"
    ensure_service
    echo "9Router is RUNNING at \${DASHBOARD_URL}"
    exit 0
    ;;
  --stop)
    echo "Stopping \${UNIT}..."
    systemctl --user stop "\${UNIT}"
    exit 0
    ;;
  --status)
    if is_healthy; then
      echo "9Router is RUNNING at \${DASHBOARD_URL}"
      systemctl --user status "\${UNIT}" --no-pager | head -n 8
    else
      echo "9Router is OFFLINE"
      systemctl --user status "\${UNIT}" --no-pager || true
    fi
    exit 0
    ;;
  --logs)
    exec journalctl --user -u "\${UNIT}" -n 100 --no-pager
    ;;
  *)
    ensure_service
    if command -v omarchy-launch-webapp >/dev/null 2>&1; then
      exec omarchy-launch-webapp "\${DASHBOARD_URL}"
    elif command -v xdg-open >/dev/null 2>&1; then
      exec xdg-open "\${DASHBOARD_URL}"
    else
      echo "9Router ready at \${DASHBOARD_URL}"
    fi
    ;;
esac
EOF
chmod +x "${LAUNCHER}"

cat > "${DESKTOP_FILE}" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=9Router
GenericName=AI Routing Gateway
Comment=Open the local 9Router gateway dashboard
Exec=${LAUNCHER}
Icon=9router
Terminal=false
Categories=Development;
Keywords=9Router;AI;Models;Gateway;Router;LLM;
StartupNotify=true
Actions=Status;Restart;Logs;

[Desktop Action Status]
Name=Status
Exec=${LAUNCHER} --status

[Desktop Action Restart]
Name=Restart Server
Exec=${LAUNCHER} --restart

[Desktop Action Logs]
Name=View Logs
Exec=${LAUNCHER} --logs
EOF

cp "${ICON_SRC}" "${ICON_FILE}"

systemctl --user daemon-reload
systemctl --user enable "${UNIT_NAME}"
systemctl --user restart "${UNIT_NAME}"
refresh_menus

echo "9Router installed."
echo "  Service:   ${UNIT_NAME} (systemd --user, enabled)"
echo "  Exposure:  ${EXPOSE_MODE} (bind ${BIND_HOST})"
echo "  Dashboard: ${DASHBOARD_URL}"
echo "  App menu:  9Router"
