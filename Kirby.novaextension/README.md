**Kirby Language Server** helps with snippets, collections, translations, assets, templates and blueprints in [Kirby CMS](https://getkirby.com) 6 projects.

## What it does

In PHP files:

- **Snippets, collections and translations**: `snippet('`, `collection('` and `t('` (also `tt('`, `tc('`, and `kirby.collection("` in blueprint queries) list every snippet, collection or translation key of the project, with where it comes from:
	- snippets from `site/snippets`, registered by plugins or in the config, and Kirby's block snippets; each shows the variables it expects (`@var` lines and defaults like `$size ??= null;`)
	- collections from `site/collections`, registered by plugins or under `'extensions'` in the config; each shows its signature
	- translation keys from `site/languages`, plugins and the config, then Kirby's own (from `kirby/i18n/translations`); each shows its text in the default language, and in all languages in the details
- **Snippet variables**: inside `snippet('m-card', ['…`, the keys of the data array are completed with the variables the snippet expects, their type and default.
- **File paths** in `hashedUrl('`, `asset('`, `svg('`, `css('`, `js('` and `url('assets/`: the files and folders of the docroot (where Kirby's `index.php` is). URLs, `@auto` and files in `media/` (which Kirby creates on demand) aren't checked.
- **Templates** in `->template('…')`, `->notTemplate('…')`, `->changeTemplate('…')` and `filterBy('template', …)`.
- **Field names**: after `$page->`, `$site->`, `$block->` and `$this->` (in a model), the fields of the page's, site's or block's blueprint are offered as `name()`, with their type and label. In a template, controller or model it's the blueprint of that template; in a block snippet that block's; in other snippets the fields of all page blueprints.

In blueprints:

- `type: ` offers Kirby 6's field types, such as `pagelist` and `pagepicker`. `pages`, `files` and `users` are shown as deprecated aliases.
- At a key of a field, the options of its type are offered, with their type, default and description: `counter`, `maxlength` … for a `text` field, `templates`, `layout` … for a `pagelist`. Options the field already has are left out. In the value of a boolean option, `true`, `false` and (if it may be empty) `null` are offered, the default marked: `translate: ` offers `true` (default), `false` and `null`.
- `extends: ` and the shorthand `seo: fields/seo` (in `fields`, `tabs` and `sections`) offer the project's blueprints, those of the fitting folder first.
- Template names in `template:`/`templates:`/`create:` of a `pagelist`, `template:` of a `filelist`, `uploads:` of a `filepicker` or `textarea` and `options: changeTemplate:` offer the page (or file) templates: from blueprints, `site/templates`, plugins, and the pages in the content folder.

For all of them:

- **Open Referenced File** (⌃⌥⌘O, or from the command palette) opens the file the name under the cursor refers to: the snippet, collection, file, blueprint or template, for translation keys the line in the language file.
- **Warnings** mark names that don't exist.
	- `t('key', 'Fallback')` with a fallback text isn't flagged. If a plugin loads its translations at runtime (e.g. from JSON files), missing keys are only a hint, because they might come from there.
	- `intro: textarea` is marked too, because Kirby reads it as `extends` and not as the type.
	- A template exists if there's a blueprint, a template file or a page that uses it. For file templates without a blueprint it's only a hint, because Kirby falls back to `files/default`.

Fallbacks such as `snippet(['m-card-project', 'm-card'])` are understood. Names built at runtime, like `snippet('blocks/' . $block->type())`, are not checked.

Hover and ⌘-click don't work while Nova's built-in PHP language server (Intelephense) is on: Nova then asks only Intelephense. Without it, hover works, but ⌘-click still doesn't jump. That's why opening is a command of its own.

## Requirements

[Node.js](https://nodejs.org) 18 or newer. The extension finds `node` through your login shell, so installations via nvm or Homebrew work as they are. Otherwise, set the path in the extension settings.

The project needs a Kirby `site` folder (`site/` or e.g. `public/site/`) within three levels of the project root.
