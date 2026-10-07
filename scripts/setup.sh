#!/usr/bin/env bash
set -euo pipefail
cp -n .env.example .env || true
if grep -q 'replace-with-a-long-random-value' .env; then
  secret=$(openssl rand -hex 32)
  sed -i "s/replace-with-a-long-random-value/$secret/" .env
fi
npm install
npm run build
printf '\nBackend prepared. Start with: npm run dev\n'
