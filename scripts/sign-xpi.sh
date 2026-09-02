#!/usr/bin/env bash
# Signs the Firefox build with Mozilla so it can be installed and self-hosted.
#
# Firefox refuses unsigned add-ons, so an unsigned .xpi is not installable on
# release builds. `--channel unlisted` means Mozilla signs the file for
# self-hosting without creating a public AMO listing: automated review only,
# no human review queue.
#
# Credentials are read from ~/.config/cairn/amo.env, which is outside the
# repository on purpose. Anyone holding the secret can publish updates that
# existing users' browsers install automatically.
set -euo pipefail

ENV_FILE="${AMO_ENV_FILE:-$HOME/.config/cairn/amo.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: $ENV_FILE not found." >&2
  echo "Copy ~/.config/cairn/amo.env.example to amo.env and fill in both values." >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

: "${AMO_JWT_ISSUER:?missing AMO_JWT_ISSUER in $ENV_FILE}"
: "${AMO_JWT_SECRET:?missing AMO_JWT_SECRET in $ENV_FILE}"

VERSION=$(node -p "require('./package.json').version")

echo "Building Firefox target..."
npm run build:firefox >/dev/null

echo "Signing version $VERSION with Mozilla (unlisted channel)..."
npx --yes web-ext sign \
  --source-dir .output/firefox-mv3 \
  --artifacts-dir .output/signed \
  --channel unlisted \
  --api-key "$AMO_JWT_ISSUER" \
  --api-secret "$AMO_JWT_SECRET"

mkdir -p dist
mv .output/signed/*.xpi "dist/cairn-$VERSION.xpi"
echo
echo "Signed: dist/cairn-$VERSION.xpi"
echo "This file installs on release Firefox by opening it directly."
