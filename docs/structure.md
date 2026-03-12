# Structure

```plaintext
src/
├── commands/          ← one file per command group, all thin handlers
├── models/            ← pure data shapes, no VS Code imports
├── providers/         ← VS Code TreeDataProvider implementations and track/ignore management
├── services/          ← core logic: persistence, hydration, analysis, tree building, file watching
├── ui/                ← tree rendering, status bar, drag and drop, webview preview
├── utils/             ← stateless helpers: clipboard, formatting, file scanning, token estimation
├── constants.ts       ← shared constants: file size limits, exclude patterns, known extensions
└── extension.ts       ← activation entry point, wires ServiceRegistry and registers commands
```

## Build

The extension bundles with esbuild via `esbuild.js`. TypeScript type checking runs separately via `tsc --noEmit` so the build stays fast. Both run as part of `compile` and `package`.

```plaintext
dist/         ← compiled output, not committed
out/          ← compiled test output, not committed
```

Key scripts:

- `npm run compile` — type check, lint, bundle
- `npm run watch` — parallel watch for esbuild and tsc
- `npm run package` — production bundle, runs before publish
- `npm run test` — compiles tests then runs the suite via `@vscode/test-cli`
