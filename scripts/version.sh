#!/bin/bash
# ==============================================================================
# Ghita Agent — Version Bump Script
# ==============================================================================
# Usage: ./scripts/version.sh <version>
# Example: ./scripts/version.sh 0.0.5
#
# This script updates the version in:
#   - Root package.json
#   - All packages/*/package.json (if they have a non-zero version)
#   - All apps/*/package.json (if they have a non-zero version)
# ==============================================================================

set -euo pipefail

VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 0.0.5"
  exit 1
fi

# Validate semver format
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$'; then
  echo "Error: '$VERSION' is not a valid semver string (e.g., 0.0.5, 0.1.0-beta1)"
  exit 1
fi

echo "🔖 Bumping version to $VERSION ..."

# Update root package.json
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = '$VERSION';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  console.log('  ✓ Root package.json');
"

# Update all workspace package.json files
for pkg_file in packages/*/package.json apps/*/package.json; do
  if [ -f "$pkg_file" ]; then
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('$pkg_file', 'utf8'));
      if (pkg.version && pkg.version !== '0.0.0' && pkg.name && !pkg.name.startsWith('@ghita/')) {
        // Skip non-GHITA packages
      } else if (pkg.version && pkg.version !== '0.0.0') {
        pkg.version = '$VERSION';
        fs.writeFileSync('$pkg_file', JSON.stringify(pkg, null, 2) + '\n');
        console.log('  ✓ $pkg_file');
      }
    "
  fi
done

echo ""
echo "✅ Version bumped to $VERSION"
echo ""
echo "Next steps:"
echo "  1. Update CHANGELOG.md with changes for $VERSION"
echo "  2. Review and commit: git add -A && git commit -m 'chore: bump version to $VERSION'"
echo "  3. Tag: git tag v$VERSION"
echo "  4. Push: git push origin main --tags"
