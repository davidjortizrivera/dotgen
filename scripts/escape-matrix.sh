#!/usr/bin/env bash
# Escape matrix: writes an env file with synthetic values and loads it with Bun,
# with Vite's loadEnv, and with node --env-file, to compare how each one reads it.
set -euo pipefail

dir="$(mktemp -d)"
cd "$dir"
npm init -y >/dev/null
npm i vite@latest >/dev/null 2>&1

cat > .env.development <<'EOF'
REF="hello"
PW_RAW="abc$defgh123"
PW_BS="abc\$defgh123"
PW_SQ='abc$defgh123'
HASH="a#b"
HASH_SP="a #b"
DQ_BS="a\"b"
SQ_IN="a'b"
BS_DBL="a\\b"
BS_ONE="a\b"
BS_DOLLAR_DBL="a\\\$b"
NL_ESC="a\nb"
EXP_BRACE="x${REF}y"
EXP_BRACE_BS="x\${REF}y"
TRAIL_BS="ab\\"
EOF

keys='["PW_RAW","PW_BS","PW_SQ","HASH","HASH_SP","DQ_BS","SQ_IN","BS_DBL","BS_ONE","BS_DOLLAR_DBL","NL_ESC","EXP_BRACE","EXP_BRACE_BS","TRAIL_BS"]'

echo "const keys = $keys; console.log(JSON.stringify(Object.fromEntries(keys.map((k) => [k, Bun.env[k]]))))" > bun.ts
echo "import { loadEnv } from 'vite'; const env = loadEnv('development', process.cwd(), ''); const keys = $keys; console.log(JSON.stringify(Object.fromEntries(keys.map((k) => [k, env[k]]))))" > vite.mjs
echo "const keys = $keys; console.log(JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k]]))))" > node.mjs

echo "vite $(node -p "require('vite/package.json').version") / bun $(bun --version) / node $(node --version)"
echo BUN;  NODE_ENV=development bun run bun.ts
echo VITE; node vite.mjs
echo NODE; node --env-file=.env.development node.mjs

rm -rf "$dir"
