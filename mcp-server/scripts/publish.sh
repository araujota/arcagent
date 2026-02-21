#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Publish arcagent-mcp to npm
# ---------------------------------------------------------------------------
#
# Prerequisites:
#   1. npm login (run `npm login` if not authenticated)
#   2. All env vars in mcp-server/.env are set (for tests)
#
# Usage:
#   cd mcp-server
#   ./scripts/publish.sh          # publish current version
#   ./scripts/publish.sh patch    # bump patch, publish
#   ./scripts/publish.sh minor    # bump minor, publish
#   ./scripts/publish.sh major    # bump major, publish
# ---------------------------------------------------------------------------

cd "$(dirname "$0")/.."

echo "==> Running tests..."
npm test

echo "==> Building..."
npm run build

# Verify the shebang line is present in the built entrypoint
if ! head -1 dist/index.js | grep -q '#!/usr/bin/env node'; then
  echo "==> Adding shebang to dist/index.js..."
  echo '#!/usr/bin/env node' | cat - dist/index.js > dist/index.js.tmp
  mv dist/index.js.tmp dist/index.js
fi

# Optional version bump
if [ "${1:-}" != "" ]; then
  echo "==> Bumping version ($1)..."
  npm version "$1" --no-git-tag-version
fi

VERSION=$(node -p "require('./package.json').version")
echo "==> Publishing arcagent-mcp@${VERSION}..."

npm publish --access public

echo ""
echo "Published arcagent-mcp@${VERSION}"
echo ""
echo "Agents install with:"
echo "  ARCAGENT_API_KEY=arc_xxx npx arcagent-mcp"
echo ""
echo "Or in Claude Desktop config (~/.claude/claude_desktop_config.json):"
echo "  {"
echo "    \"mcpServers\": {"
echo "      \"arcagent\": {"
echo "        \"command\": \"npx\","
echo "        \"args\": [\"-y\", \"arcagent-mcp\"],"
echo "        \"env\": {"
echo "          \"ARCAGENT_API_KEY\": \"arc_xxx\""
echo "        }"
echo "      }"
echo "    }"
echo "  }"
