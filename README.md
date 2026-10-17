# Kirby Language Server

A [language server](https://microsoft.github.io/language-server-protocol/) for [Kirby CMS](https://getkirby.com) 6 projects, with an extension for [Nova](https://nova.app).

For `snippet('…')`, `collection('…')` and `t('…')`/`tt('…')`/`tc('…')` in PHP files, and `kirby.collection("…")` in blueprint queries, it offers:

- **Completion** of every snippet, collection or translation key in the project:
	- snippets from `site/snippets`, plugins, the config and Kirby's block snippets, with the variables they expect
	- collections from `site/collections`, plugins and `'extensions'` in the config, with their signature
	- translation keys from `site/languages`, plugins and the config, then Kirby's own from `kirby/i18n/translations`, with their text in each language
- **Completion of `type:`** in blueprints: Kirby 6 field types, with `pages`, `files` and `users` as deprecated aliases (`src/blueprints.js`)
- **Snippet variables**: in `snippet('m-card', ['…` the keys the snippet expects, with type and default
- **File paths** in `hashedUrl('…')`, `asset('…')`, `svg('…')`, `css('…')`, `js('…')` and `url('assets/…')`: completion of the files and folders in the docroot (the folder of Kirby's `index.php`), a warning if the file doesn't exist. URLs, `@auto` and files in `media/` aren't checked.
- **Jump to Definition** to the file (or the line of a collection defined as a closure, or of a translation key)
- **Hover** with the same information as the completion
- **Code lenses** with each snippet's or collection's origin above its line (not shown in Nova)
- **Warnings** for snippets, collections, translation keys and files that don't exist. `t('key', 'Fallback')` isn't flagged, and Kirby's own keys (`t('save')`) are known. If a plugin loads translations at runtime, missing keys are only a hint.

In Nova, Jump to Definition is the command **Open Referenced File** (⌃⌥⌘O). While Nova's built-in PHP language server (Intelephense) is on, Nova asks only that server for hover and ⌘-click. Without it, hover works but ⌘-click still doesn't jump; code lenses never appear. The completion list shows the same information as the hover.

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
├── blueprints.js positions in blueprints, field types for type:
├── calls.js      finds snippet(), collection(), t() calls and file paths
├── php.js        reads what plugins and the config register
├── project.js    reads snippets, collections, translations and the docroot from the project
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
- field types registered by plugins
- site methods from `*-methods.stub.php`
