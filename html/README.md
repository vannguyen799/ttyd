## Prerequisites

> **NOTE:** Node.js 20+ is required. The pnpm version is pinned in `package.json`.

Enable Corepack and install dependencies with `corepack enable && pnpm install`.

## Development

1. Start ttyd: `ttyd bash`
2. Start the dev server: `pnpm start`

## Publish

Run `pnpm build`; this compiles the inlined HTML to `../src/html.h`.
