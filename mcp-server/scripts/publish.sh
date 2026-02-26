#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Publish arcagent-mcp to npm
# ---------------------------------------------------------------------------
#
# Prerequisites:
#   1. npm package trusted publisher configured for this repo/workflow
#   2. GitHub Actions workflow `.github/workflows/publish-mcp.yml` present
#
# Usage (preferred):
#   ./scripts/publish.sh          # run checks + push stable tag
#   ./scripts/publish.sh patch    # bump patch + push stable tag
#   ./scripts/publish.sh minor    # bump minor + push stable tag
#   ./scripts/publish.sh major    # bump major + push stable tag
#
# Local manual publish fallback (requires OTP):
#   cd mcp-server
#   npm publish --access public --otp <code>
# ---------------------------------------------------------------------------

cd "$(dirname "$0")/.."

echo "==> Running tests..."
npm test

echo "==> Building clean package..."
npm run prepack

echo "==> Validating package contents..."
npm run pack:check

# Optional version bump
if [ "${1:-}" != "" ]; then
  echo "==> Bumping version ($1)..."
  npm version "$1" --no-git-tag-version
fi

VERSION=$(node -p "require('./package.json').version")
TAG="mcp-server-v${VERSION}"
echo "==> Creating/pushing tag ${TAG} for trusted publishing..."
git tag "${TAG}"
git push origin "${TAG}"

echo ""
echo "Queued trusted publish for arcagent-mcp@${VERSION} via GitHub Actions tag ${TAG}"
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
