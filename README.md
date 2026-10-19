# Kirby Language Server

A [language server](https://microsoft.github.io/language-server-protocol/) for [Kirby CMS](https://getkirby.com) 6 projects, with an extension for [Nova](https://nova.app).

In PHP files:

- **Snippets, collections and translations**: completion of every snippet, collection or translation key in `snippet('…')`, `collection('…')` and `t('…')`/`tt('…')`/`tc('…')` (also `kirby.collection("…")` in blueprint queries):
	- snippets from `site/snippets`, plugins, the config and Kirby's block snippets, with the variables they expect
	- collections from `site/collections`, plugins and `'extensions'` in the config, with their signature
	- translation keys from `site/languages`, plugins and the config, then Kirby's own from `kirby/i18n/translations`, with their text in each language
- **Snippet variables**: in `snippet('m-card', ['…` the keys the snippet expects, with type and default. Not `$page`, `$site`, `$kirby` and `$pages`, which every snippet has anyway, nor `$slot`/`$slots`, which can't be passed.
- **File paths** in `hashedUrl('…')`, `asset('…')`, `svg('…')`, `css('…')`, `js('…')` and `url('assets/…')`: the files and folders in the docroot (the folder of Kirby's `index.php`). URLs, `@auto` and files in `media/` aren't checked.
- **Template names** in `->template('…')`, `->notTemplate('…')`, `->changeTemplate('…')` and `filterBy('template', …)`
- **Field names** after `$page->`, `$site->`, `$block->` and `$this->` (in a model): the fields of the blueprint that store content (from tabs, columns, groups and what they extend; no lists or info fields), inserted as `name()`. `$page` in a template, controller or model is the page of that template (`pages/default` without a blueprint of its own), `$block` in `snippets/blocks/<type>.php` that block, `$site` the site. In other snippets `$page` offers the fields of all page blueprints.
- **Methods** after `$page->`, `$site->` and `$block->`: those plugins and the config register (`pageMethods`, `siteMethods`, `blockMethods`) with their signature and docblock, and in a template or controller the methods of the page's model (`site/models` or a plugin's `pageModels`). PHP's own language server knows neither, which is why projects keep `*-methods.stub.php` files.
- **Field methods** after a field, `$page->cover()->`: Kirby's field methods, those that fit the field's type first (`toFile()` for a `filepicker`, `toBlocks()` for `blocks` …), and those of plugins and the config (`fieldMethods`)
- **Controller variables** in templates: after `$`, what the template's controllers return (the `site` controller, then the template's own; for `project.json.php` the `project.json` controller if there is one), and Kirby's `$page`, `$site`, `$kirby`, `$pages`. Hover and Jump to Definition lead to the controller.

In blueprints (`src/blueprints.js`):

- **`type:`**: Kirby 6 field types, with `pages`, `files` and `users` as deprecated aliases
- **Field options**: at a key of a field, the options of its type (from `type`, what it `extends`, or its name), with type, default and description, without those it already has. They are read from Kirby 6's field classes into `src/field-properties.json`. In the value of a boolean option, `true`, `false` and (if it may be empty) `null`, the default marked.
- **`extends:`** and the shorthand `seo: fields/seo` in `fields`, `tabs` and `sections`: the blueprints from `site/blueprints`, plugins, the config and Kirby, those of the fitting folder first
- **Template names** in `template`, `templates`, `templatesIgnore` and `create` of a `pagelist`, `template` of a `filelist`, `uploads` of a `filepicker` or `textarea`, and `options: changeTemplate`
- **Field references** (Kirby 6): in a list of `fields` in tabs and columns, the fields defined at the top of the blueprint. Jump to Definition leads to the definition.
- **Block types** in `fieldsets` of blocks and layout fields: the `blocks/*` blueprints of the project and Kirby

For all of them:

- **Warnings** for names that don't exist:
	- `t('key', 'Fallback')` isn't flagged, and Kirby's own keys (`t('save')`) are known. If a plugin loads translations at runtime, missing keys are only a hint.
	- A page template exists if there's a blueprint, a template file (also from a plugin) or a page in the content folder that uses it. A file template without a blueprint is only a hint: Kirby falls back to `files/default`.
	- `intro: textarea` is flagged: Kirby reads it as `extends`, not as the type. If a plugin registers blueprints in a way that can't be read, missing blueprints and templates are only a hint.
	- A field reference in `fields: [intro]` must be defined at the top (checked in the blueprints of pages, files, users and the site; a partial gets them from the blueprint that uses it). A block type in `fieldsets` needs a `blocks/*` blueprint.
	- A variable in a template must come from the template itself, its controllers or Kirby. This is only checked when every controller could be read completely (not with `return $data;` or `...$spread`) and the template doesn't use `extract()`, `$$name` or `include`.
- **Jump to Definition** to the file (or the line of a collection defined as a closure, or of a translation key). After `->` to the method (the closure in a plugin or the config, the method in the model, Kirby's own field method in its source) or to the field's key in the blueprint, also when it's defined in a tab or partial the blueprint extends
- **Hover** with the same information as the completion
- **Code lenses** with each snippet's or collection's origin above its line (not shown in Nova)

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
- `npm run read-kirby -- path/to/kirby`: reads the options of each field type and Kirby's field methods from a Kirby 6 checkout into `src/field-properties.json` and `src/field-methods.json`

```
src/
├── blueprints.js positions in blueprints, field types and options, extends, template names
├── field-methods.json Kirby's field methods (generated)
├── field-properties.json options of each field type (generated)
├── calls.js      finds snippet(), collection(), t(), template() calls and file paths
├── php.js        reads what plugins and the config register
├── project.js    reads snippets, collections, translations, blueprints, templates, controllers, methods, models and the docroot
├── server.js     the language server
└── variables.js  variables a template uses but doesn't define
scripts/
└── read-kirby.mjs writes the field options and methods from Kirby's source
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
- warnings for `$page->name()` that is neither a field nor a method
