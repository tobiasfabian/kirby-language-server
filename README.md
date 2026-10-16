# Kirby Language Server

A [language server](https://microsoft.github.io/language-server-protocol/) for [Kirby CMS](https://getkirby.com) projects, with an extension for [Nova](https://nova.app).

For `snippet('…')`, `collection('…')` and `t('…')`/`tt('…')`/`tc('…')` in PHP files, and `kirby.collection("…")` in blueprint queries, it offers:

- **Completion** of every snippet, collection or translation key in the project:
	- snippets from `site/snippets`, plugins, the config and Kirby's block snippets, with the variables they expect
	- collections from `site/collections`, plugins and `'extensions'` in the config, with their signature
	- translation keys from `site/languages`, plugins and the config, then Kirby's own from `kirby/i18n/translations`, with their text in each language
- **Jump to Definition** to the file (or the line of a collection defined as a closure, or of a translation key)
- **Hover** with the same information as the completion
- **Code lenses** with each snippet's or collection's origin above its line (not shown in Nova)
- **Warnings** for snippets, collections and translation keys that don't exist. `t('key', 'Fallback')` isn't flagged, and Kirby's own keys (`t('save')`) are known. If a plugin loads translations at runtime, missing keys are only a hint.

In Nova, Jump to Definition is the command **Open Snippet, Collection or Translation** (⌃⌥⌘O). While Nova's built-in PHP language server (Intelephense) is on, Nova asks only that server for hover and ⌘-click. Without it, hover works but ⌘-click still doesn't jump; code lenses never appear. The completion list shows the same information as the hover.

The server reads the project's files; it doesn't start Kirby. It finds the `site` folder within three levels of the project root (`site/`, `public/site/` …).

## Use it in Nova

```bash
npm install
npm run build
nova extension activate Kirby.novaextension
```

`activate` opens the extension in Nova for development. Messages from the extension and the server are in **Extensions → Show Extension Console**.

The extension needs Node.js 18 or newer. It looks for `node` through the login shell (nvm and Homebrew work); a different path can be set in the extension settings.

## Develop

- `npm run dev`: rebuilds the server on every change
- `npm test`: unit tests for `src/` and a test that talks to the built server over stdio (`npm run build` first)
- `npm run lint`: ESLint

```
src/
├── calls.js      finds snippet() and collection() calls
├── php.js        reads what plugins and the config register
├── project.js    reads snippets, collections and translations from the project
└── server.js     the language server
Kirby.novaextension/
├── extension.json
├── Scripts/main.js   finds node and starts the server
└── Server/server.cjs the bundled server (built, not in git)
test/
```

The language server is plain LSP over stdio, so it can be used in other editors (Zed, VS Code, Neovim) with a small client.

## Ideas

The same pattern (read the project, complete, jump, warn) fits more of Kirby:

- thumb presets in `->thumb('…')` and `->srcset('…')`
- translation keys missing in some of the languages
- `option('…')`
- template names and `extends: fields/…` in blueprints
- site methods from `*-methods.stub.php`
