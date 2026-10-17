# Kirby Language Server

A [language server](https://microsoft.github.io/language-server-protocol/) for [Kirby CMS](https://getkirby.com) 6 projects, with an extension for [Nova](https://nova.app).

For `snippet('…')`, `collection('…')` and `t('…')`/`tt('…')`/`tc('…')` in PHP files, and `kirby.collection("…")` in blueprint queries, it offers:

- **Completion** of every snippet, collection or translation key in the project:
	- snippets from `site/snippets`, plugins, the config and Kirby's block snippets, with the variables they expect
	- collections from `site/collections`, plugins and `'extensions'` in the config, with their signature
	- translation keys from `site/languages`, plugins and the config, then Kirby's own from `kirby/i18n/translations`, with their text in each language
- **Completion of `type:`** in blueprints: Kirby 6 field types, with `pages`, `files` and `users` as deprecated aliases (`src/blueprints.js`)
- **Template names** in blueprints (`template`, `templates`, `templatesIgnore` and `create` of a `pagelist`, `template` of a `filelist`, `uploads` of a `filepicker` or `textarea`, `options: changeTemplate`) and in PHP (`->template('…')`, `->notTemplate('…')`, `->changeTemplate('…')`, `filterBy('template', …)`): completion, a warning if there's no blueprint, no template file and no page in the content folder that uses it (only a hint for file templates, where Kirby falls back to `files/default`), Jump to Definition and hover.
- **Field options** in blueprints: at a key of a field, the options of its type (from `type`, what it `extends`, or its name), with type, default and description, without those it already has. They are read from Kirby 6's field classes into `src/field-properties.json`.
- **`extends:`** in blueprints, and the shorthand `seo: fields/seo` in `fields`, `tabs` and `sections`: completion of the blueprints from `site/blueprints`, plugins, the config and Kirby (those of the fitting folder first), a warning if the blueprint doesn't exist (only a hint if a plugin registers blueprints in a way that can't be read), Jump to Definition and hover. `intro: textarea` is flagged too: Kirby reads it as `extends`, not as the type.
- **Snippet variables**: in `snippet('m-card', ['…` the keys the snippet expects, with type and default
- **File paths** in `hashedUrl('…')`, `asset('…')`, `svg('…')`, `css('…')`, `js('…')` and `url('assets/…')`: completion of the files and folders in the docroot (the folder of Kirby's `index.php`), a warning if the file doesn't exist. URLs, `@auto` and files in `media/` aren't checked.
- **Jump to Definition** to the file (or the line of a collection defined as a closure, or of a translation key)
- **Hover** with the same information as the completion
- **Code lenses** with each snippet's or collection's origin above its line (not shown in Nova)
- **Warnings** for snippets, collections, translation keys, files, blueprints and templates that don't exist. `t('key', 'Fallback')` isn't flagged, and Kirby's own keys (`t('save')`) are known. If a plugin loads translations at runtime, missing keys are only a hint.

In Nova, Jump to Definition is the command **Open Referenced File** (⌃⌥⌘O). While Nova's built-in PHP language server (Intelephense) is on, Nova asks only that server for hover and ⌘-click. Without it, hover works but ⌘-click still doesn't jump; code lenses never appear. The completion list shows the same information as the hover.

The server reads the project's files (blueprints with the [yaml](https://eemeli.org/yaml/) package); it doesn't start Kirby. It finds the `site` folder within three levels of the project root (`site/`, `public/site/` …).

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
- `npm run field-properties -- path/to/kirby`: reads the options of each field type from a Kirby 6 checkout into `src/field-properties.json`

```
src/
├── blueprints.js positions in blueprints, field types and options, extends, template names
├── field-properties.json options of each field type (generated)
├── calls.js      finds snippet(), collection(), t(), template() calls and file paths
├── php.js        reads what plugins and the config register
├── project.js    reads snippets, collections, translations, blueprints, templates and the docroot
└── server.js     the language server
scripts/
└── field-properties.mjs writes src/field-properties.json from Kirby's source
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
- field types registered by plugins
- site methods from `*-methods.stub.php`
