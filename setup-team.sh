#!/usr/bin/env bash
#
# NanoClaw Team Setup
# One-command setup for new team members. Installs everything:
# Telegram, Slack, Gmail, Google Drive, Voice (Whisper STT + Piper/Kokoro TTS)
#
# Usage:
#   ./setup-team.sh              # Full interactive setup
#   ./setup-team.sh --deps-only  # Only install system dependencies
#   ./setup-team.sh --build-only # Only rebuild container image
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[ OK ]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()  { echo -e "${RED}[FAIL]${NC} $*"; exit 1; }
step()  { echo -e "\n${BOLD}━━━ $* ━━━${NC}"; }

# ──────────────────────────────────────────────────
# Detect platform
# ──────────────────────────────────────────────────
detect_platform() {
  case "$(uname -s)" in
    Linux*)  PLATFORM="linux" ;;
    Darwin*) PLATFORM="macos" ;;
    *)       fail "Unsupported OS: $(uname -s)" ;;
  esac
  ARCH="$(uname -m)"
  info "Platform: $PLATFORM ($ARCH)"
}

# ──────────────────────────────────────────────────
# Step 1: System dependencies
# ──────────────────────────────────────────────────
install_system_deps() {
  step "Step 1/7: System Dependencies"

  if [[ "$PLATFORM" == "linux" ]]; then
    command -v apt-get >/dev/null || fail "apt-get not found. This script supports Ubuntu/Debian."

    info "Installing packages via apt..."
    sudo apt-get update -qq
    sudo apt-get install -y -qq \
      ffmpeg \
      docker.io \
      sqlite3 \
      curl \
      git \
      python3 \
      cmake \
      build-essential \
      2>/dev/null

    # Docker socket permissions
    if [[ -S /var/run/docker.sock ]]; then
      sudo chmod 666 /var/run/docker.sock 2>/dev/null || true
    fi

    # whisper-cli
    if ! command -v whisper-cli >/dev/null 2>&1; then
      info "Building whisper.cpp from source (voice transcription)..."
      local whisper_dir="/opt/whisper.cpp"
      if [[ ! -d "$whisper_dir" ]]; then
        sudo git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git "$whisper_dir"
      fi
      pushd "$whisper_dir" >/dev/null
      sudo cmake -B build -DCMAKE_BUILD_TYPE=Release
      sudo cmake --build build --config Release -j"$(nproc)"
      sudo cp build/bin/whisper-cli /usr/local/bin/whisper-cli
      popd >/dev/null
      ok "whisper-cli compiled and installed"
    else
      ok "whisper-cli already installed"
    fi

    # Whisper model
    sudo mkdir -p /usr/local/share/whisper-cpp/models
    if [[ ! -f /usr/local/share/whisper-cpp/models/ggml-base.bin ]]; then
      info "Downloading Whisper base model..."
      sudo curl -sL -o /usr/local/share/whisper-cpp/models/ggml-base.bin \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
      ok "Whisper model downloaded"
    fi

  elif [[ "$PLATFORM" == "macos" ]]; then
    command -v brew >/dev/null || fail "Homebrew not found. Install: https://brew.sh"

    info "Installing packages via brew..."
    brew install --quiet ffmpeg sqlite curl git python3 whisper-cpp 2>/dev/null || true

    # Docker check
    if ! command -v docker >/dev/null 2>&1; then
      warn "Docker not found. Install Docker Desktop: https://docker.com/products/docker-desktop"
      echo "  Or use Apple Container: run /convert-to-apple-container after setup"
      read -rp "Press Enter after installing Docker to continue..."
    fi

    # Whisper model
    mkdir -p /usr/local/share/whisper-cpp/models
    if [[ ! -f /usr/local/share/whisper-cpp/models/ggml-base.bin ]]; then
      info "Downloading Whisper base model..."
      curl -sL -o /usr/local/share/whisper-cpp/models/ggml-base.bin \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin"
    fi
  fi

  ok "System dependencies ready"
}

# ──────────────────────────────────────────────────
# Step 2: Node.js check + npm install
# ──────────────────────────────────────────────────
install_node_deps() {
  step "Step 2/7: Node.js Dependencies"

  # Check Node.js version
  if ! command -v node >/dev/null 2>&1; then
    fail "Node.js not found. Install Node.js 20+: https://nodejs.org"
  fi

  local node_major
  node_major="$(node --version | sed 's/^v//' | cut -d. -f1)"
  if (( node_major < 20 )); then
    fail "Node.js $node_major found, but 20+ is required."
  fi
  ok "Node.js $(node --version)"

  info "Installing npm packages..."
  npm install --silent
  ok "npm packages installed"
}

# ──────────────────────────────────────────────────
# Step 3: Configure .env
# ──────────────────────────────────────────────────
configure_env() {
  step "Step 3/7: Environment Configuration"

  if [[ -f .env ]]; then
    warn ".env already exists. Skipping. Edit manually if needed."
    mkdir -p data/env && cp .env data/env/env
    return
  fi

  cp .env.example .env

  echo ""
  echo -e "${BOLD}Configure your assistant:${NC}"
  echo ""

  # Assistant name
  read -rp "  Assistant name [Yume]: " name
  name="${name:-Yume}"
  sed -i.bak "s/^ASSISTANT_NAME=.*/ASSISTANT_NAME=$name/" .env

  # Timezone
  local default_tz
  default_tz="$(python3 -c 'import time; import datetime; print(datetime.datetime.now(datetime.timezone.utc).astimezone().tzinfo)' 2>/dev/null || echo 'UTC')"
  read -rp "  Timezone [$default_tz]: " tz
  tz="${tz:-$default_tz}"
  sed -i.bak "s|^# TZ=.*|TZ=$tz|" .env

  # Telegram
  echo ""
  echo -e "  ${BOLD}Telegram Bot:${NC}"
  echo "    1. Talk to @BotFather on Telegram"
  echo "    2. Send /newbot, follow prompts"
  echo "    3. Copy the bot token"
  echo ""
  read -rp "  Telegram Bot Token: " tg_token
  if [[ -n "$tg_token" ]]; then
    sed -i.bak "s/^TELEGRAM_BOT_TOKEN=.*/TELEGRAM_BOT_TOKEN=$tg_token/" .env
  fi

  # Slack
  echo ""
  read -rp "  Set up Slack? (y/n) [n]: " setup_slack
  if [[ "$setup_slack" == "y" ]]; then
    echo ""
    echo -e "  ${BOLD}Slack App:${NC}"
    echo "    1. https://api.slack.com/apps → Create New App → From scratch"
    echo "    2. Socket Mode → enable → generate App Token (xapp-...)"
    echo "    3. Event Subscriptions → Subscribe to bot events:"
    echo "       message.channels, message.groups, message.im"
    echo "    4. OAuth & Permissions → Bot Token Scopes:"
    echo "       chat:write, channels:history, groups:history, im:history,"
    echo "       channels:read, groups:read, users:read"
    echo "    5. Install to Workspace → copy Bot Token (xoxb-...)"
    echo ""
    read -rp "  Slack Bot Token (xoxb-...): " slack_bot
    read -rp "  Slack App Token (xapp-...): " slack_app
    [[ -n "$slack_bot" ]] && sed -i.bak "s/^SLACK_BOT_TOKEN=.*/SLACK_BOT_TOKEN=$slack_bot/" .env
    [[ -n "$slack_app" ]] && sed -i.bak "s/^SLACK_APP_TOKEN=.*/SLACK_APP_TOKEN=$slack_app/" .env
  fi

  # Cleanup sed backups
  rm -f .env.bak

  # Sync to container env
  mkdir -p data/env
  cp .env data/env/env

  ok ".env configured"
}

# ──────────────────────────────────────────────────
# Step 4: Build TypeScript
# ──────────────────────────────────────────────────
build_typescript() {
  step "Step 4/7: Build TypeScript"
  npm run build --silent
  ok "TypeScript compiled"
}

# ──────────────────────────────────────────────────
# Step 5: Build container image
# ──────────────────────────────────────────────────
build_container() {
  step "Step 5/7: Build Container Image"
  info "Building container (includes TTS engines, browser, tools)..."
  info "This downloads ~500MB of models on first build. Please wait..."

  if ! command -v docker >/dev/null 2>&1; then
    fail "Docker not found. Install Docker first."
  fi

  bash container/build.sh
  ok "Container image built: nanoclaw-agent:latest"
}

# ──────────────────────────────────────────────────
# Step 6: Configure system service
# ──────────────────────────────────────────────────
configure_service() {
  step "Step 6/7: System Service"

  if [[ "$PLATFORM" == "linux" ]]; then
    local service_dir="$HOME/.config/systemd/user"
    mkdir -p "$service_dir"
    cat > "$service_dir/nanoclaw.service" <<SYSTEMD
[Unit]
Description=NanoClaw Personal Assistant
After=network.target docker.service

[Service]
Type=simple
WorkingDirectory=$SCRIPT_DIR
ExecStart=$(command -v npx) tsx src/index.ts
Restart=on-failure
RestartSec=5
Environment=PATH=$PATH

[Install]
WantedBy=default.target
SYSTEMD
    systemctl --user daemon-reload
    systemctl --user enable nanoclaw 2>/dev/null || true
    ok "systemd service: nanoclaw"
    echo "    Start:   systemctl --user start nanoclaw"
    echo "    Stop:    systemctl --user stop nanoclaw"
    echo "    Logs:    journalctl --user -u nanoclaw -f"

  elif [[ "$PLATFORM" == "macos" ]]; then
    local plist="$HOME/Library/LaunchAgents/com.nanoclaw.plist"
    mkdir -p "$SCRIPT_DIR/logs"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.nanoclaw</string>
  <key>WorkingDirectory</key>
  <string>$SCRIPT_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v npx)</string>
    <string>tsx</string>
    <string>src/index.ts</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$SCRIPT_DIR/logs/nanoclaw.log</string>
  <key>StandardErrorPath</key>
  <string>$SCRIPT_DIR/logs/nanoclaw-error.log</string>
</dict>
</plist>
PLIST
    ok "launchd service: com.nanoclaw"
    echo "    Start:   launchctl load $plist"
    echo "    Stop:    launchctl unload $plist"
    echo "    Restart: launchctl kickstart -k gui/\$(id -u)/com.nanoclaw"
  fi
}

# ──────────────────────────────────────────────────
# Step 7: First run guidance
# ──────────────────────────────────────────────────
show_next_steps() {
  step "Step 7/7: Next Steps"

  local assistant_name
  assistant_name="$(grep '^ASSISTANT_NAME=' .env 2>/dev/null | cut -d= -f2)"
  assistant_name="${assistant_name:-Yume}"

  echo ""
  echo -e "${GREEN}${BOLD}Setup complete!${NC}"
  echo ""
  echo -e "${BOLD}To start:${NC}"
  echo "  npm run dev"
  echo ""
  echo -e "${BOLD}To register your main channel:${NC}"
  echo "  1. Start NanoClaw with: npm run dev"
  echo "  2. Send any message to your Telegram bot"
  echo "  3. Check logs for the chat ID: grep 'Telegram message stored' /tmp/nanoclaw.log"
  echo "  4. Register:"
  echo "     npx tsx setup/index.ts --step register -- \\"
  echo "       --jid \"tg:<CHAT_ID>\" --name \"Main\" --folder \"main\" \\"
  echo "       --trigger \"@$assistant_name\" --channel telegram \\"
  echo "       --no-trigger-required --is-main"
  echo ""
  echo -e "${BOLD}Features included:${NC}"
  echo "  - Telegram (inbound + outbound)"
  echo "  - Slack (inbound + outbound + cross-channel DMs)"
  echo "  - Voice transcription (Whisper STT on host)"
  echo "  - Voice messages (Piper pt-BR + Kokoro en/ja TTS in container)"
  echo "  - Gmail (read + send with confirmation guardrail)"
  echo "  - Google Drive (read + write)"
  echo "  - Web browsing (agent-browser in container)"
  echo ""
  echo -e "${BOLD}Optional extras:${NC}"
  echo "  - Google Drive: place OAuth keys in ~/.gdrive-mcp/gcp-oauth.keys.json"
  echo "  - Ollama: set OLLAMA_HOST in .env for local LLM access"
  echo ""
}

# ──────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────
main() {
  echo ""
  echo -e "${BOLD}${BLUE}╔═══════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${BLUE}║           NanoClaw Team Setup                 ║${NC}"
  echo -e "${BOLD}${BLUE}╚═══════════════════════════════════════════════╝${NC}"
  echo ""

  detect_platform

  case "${1:-}" in
    --deps-only)
      install_system_deps
      ;;
    --build-only)
      build_container
      ;;
    *)
      install_system_deps
      install_node_deps
      configure_env
      build_typescript
      build_container
      configure_service
      show_next_steps
      ;;
  esac
}

main "$@"
