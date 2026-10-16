# AGENTS.md

A language server for Kirby CMS projects (`src/`) and the Nova extension that starts it (`Kirby.novaextension/`).

## Commands

- `npm run build`: bundles `src/server.js` into `Kirby.novaextension/Server/server.cjs`
- `npm test`: unit tests and an LSP test against the built server; build first
- `npm run lint`: ESLint
- `nova extension validate Kirby.novaextension`: checks the bundle for publishing
- `nova extension activate Kirby.novaextension`: opens it in Nova for development

## Conventions

- Plain modern JavaScript with JSDoc, no TypeScript. Tabs, as `.editorconfig` and ESLint say.
- The server only reads files. It never starts Kirby or runs PHP, so it stays fast and safe in any project.
- No false warnings: a warning is only shown for literal names. Names built at runtime are skipped. Registered snippets and collections are read with the small parser in `src/php.js`, which knows the nesting: `'collections'` inside `'api' => [...]` are API collections, not Kirby collections.
- Translation keys are only reported as missing with a Warning when every source could be read; if a plugin builds its translations at runtime (JSON, YAML), it's an Information instead. Kirby's own keys come from `kirby/i18n/translations/*.json` (the file per site language; es → es_ES.json if there is no es.json) and are offered after the project's keys.
- Before changing what counts as a call, run the server against a few real projects and check that the warnings it shows are real.

## Nova gotchas

- `Process` events are methods: `process.onStdout(cb)`, not `process.onStdout = cb`.
- Nova doesn't expand `~` in config paths; use `nova.path.expanduser()`.
- The bundle is `server.cjs`, not `.js`: the repo's `package.json` sets `"type": "module"`, which would make Node load a CommonJS bundle as an ES module.
- Errors the user should see go through a notification (`showError()` in `main.js`), not only the console.
- While Nova's built-in PHP server (Intelephense) runs, Nova sends `textDocument/hover` and `textDocument/definition` in PHP files only to it, never to this one; completions from all servers are merged. With Intelephense off, hover requests arrive and are shown, but ⌘-click sends no definition request (tried with Location and LocationLink responses). Verified with Nova 14.1 by logging requests in the server. That’s why Open Snippet, Collection or Translation is a command that calls `client.sendRequest('textDocument/definition', …)`.
- Nova announces `codeLens` support in `initialize`, but shows no code lenses from this server.
- A shortcut is only bound if it's free (`ctrl-cmd-o` was taken). The extension uses `cmd-opt-ctrl-o`.
