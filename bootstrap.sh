#!/usr/bin/env bash
# Trident bootstrap script
# Run this after cloning the repo to set up the full project

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
WHITE='\033[1;37m'
GRAY='\033[0;90m'
RESET='\033[0m'

echo ""
echo -e "${WHITE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${WHITE}  Trident — Bootstrap${RESET}"
echo -e "${WHITE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# ─── Check Node version ───────────────────────────────────────────────────────

NODE_VERSION=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "${YELLOW}  ✗ Node.js 18+ required. Current: $(node -v 2>/dev/null || echo 'not found')${RESET}"
  echo -e "${GRAY}    Install via: https://nodejs.org or nvm${RESET}"
  exit 1
fi
echo -e "${GREEN}  ✓ Node.js $(node -v)${RESET}"

# ─── Create data directories ──────────────────────────────────────────────────

echo -e "${GRAY}  Creating data directories…${RESET}"
mkdir -p data/docs
mkdir -p data/docs/briefings

# ─── Default config files ────────────────────────────────────────────────────

if [ ! -f "trident.config.json" ]; then
  cat > trident.config.json <<'EOF'
{
  "routing": {
    "research": ["perplexity", "claude", "gpt"],
    "code": ["claude", "gpt", "perplexity"],
    "summarize": ["gpt", "claude", "perplexity"],
    "default": ["claude", "gpt", "perplexity"]
  }
}
EOF
  echo -e "${GREEN}  ✓ trident.config.json created (default routing modes)${RESET}"
else
  echo -e "${GREEN}  ✓ trident.config.json already exists${RESET}"
fi

if [ ! -f "schedules.json" ]; then
  echo "[]" > schedules.json
  echo -e "${GREEN}  ✓ schedules.json created (empty — see README for format)${RESET}"
else
  echo -e "${GREEN}  ✓ schedules.json already exists${RESET}"
fi

# ─── .env setup ──────────────────────────────────────────────────────────────

if [ ! -f ".env" ]; then
  cp .env.example .env
  echo -e "${YELLOW}  ⚠ .env created from .env.example — add your API keys before running${RESET}"
else
  echo -e "${GREEN}  ✓ .env already exists${RESET}"
fi

# ─── Install dependencies ─────────────────────────────────────────────────────

echo -e "${GRAY}  Installing dependencies (npm workspaces)…${RESET}"
npm install

echo -e "${GREEN}  ✓ Dependencies installed${RESET}"

# ─── Build TypeScript and UI ─────────────────────────────────────────────────

echo -e "${GRAY}  Building packages (server, scheduler, ui-server, ui, cli)…${RESET}"
npm run build

echo -e "${GREEN}  ✓ Build complete${RESET}"

# ─── Link CLI globally ───────────────────────────────────────────────────────

echo -e "${GRAY}  Linking CLI globally…${RESET}"
cd packages/cli && npm link && cd ../..

echo -e "${GREEN}  ✓ CLI linked — 'trident' command now available${RESET}"

# ─── Get absolute path for MCP config ────────────────────────────────────────

REPO_DIR=$(pwd)
SERVER_PATH="$REPO_DIR/packages/mcp-server/dist/index.js"

# ─── Done ────────────────────────────────────────────────────────────────────

echo ""
echo -e "${WHITE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${WHITE}  Setup complete.${RESET}"
echo -e "${WHITE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "${YELLOW}  Next steps:${RESET}"
echo ""
echo -e "  1. Fill in your API keys in ${WHITE}.env${RESET}"
echo ""
echo -e "  2. Add this to your Claude Desktop config:"
echo -e "     ${GRAY}~/Library/Application Support/Claude/claude_desktop_config.json${RESET}"
echo ""
echo -e '     {
       "mcpServers": {
         "trident": {
           "command": "node",
           "args": ["'"$SERVER_PATH"'"]
         }
       }
     }'
echo ""
echo -e "  3. Restart Claude Desktop"
echo ""
echo -e "  4. Verify setup:"
echo -e "     ${WHITE}trident status${RESET}"
echo ""
echo -e "  5. Try the new features:"
echo -e "     ${WHITE}trident parallel \"What is the MCP protocol?\" --diff --score${RESET}"
echo -e "     ${WHITE}trident chain \"Compare Rust and Go\" --mode research${RESET}"
echo -e "     ${WHITE}trident sessions${RESET}"
echo -e "     ${WHITE}trident ui${RESET}                  ${GRAY}# web dashboard at http://localhost:4242${RESET}"
echo -e "     ${WHITE}trident schedule list${RESET}       ${GRAY}# manage scheduled chains${RESET}"
echo ""
echo -e "  6. (Optional) Google Workspace tools — drop credentials.json at the repo root, then:"
echo -e "     ${WHITE}trident google login${RESET}"
echo ""
