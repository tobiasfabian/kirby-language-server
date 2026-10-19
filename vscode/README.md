**Kirby Language Server** helps with snippets, collections, translations, assets, templates and blueprints in [Kirby CMS](https://getkirby.com) 6 projects.

## What it does

In PHP files:

- **Snippets, collections and translations**: `snippet('`, `collection('` and `t('` (also `tt('`, `tc('`, and `kirby.collection("` in blueprint queries) list every snippet, collection or translation key of the project, with where it comes from:
	- snippets from `site/snippets`, registered by plugins or in the config, and Kirby's block snippets; each shows the variables it expects (`@var` lines and defaults like `$size ??= null;`)
	- collections from `site/collections`, registered by plugins or under `'extensions'` in the config; each shows its signature
	- translation keys from `site/languages`, plugins and the config, then Kirby's own (from `kirby/i18n/translations`); each shows its text in the default language, and in all languages in the details
- **Snippet variables**: inside `snippet('m-card', ['…`, the keys of the data array are completed with the variables the snippet expects, their type and default. `$page`, `$site`, `$kirby` and `$pages` are left out: every snippet has them anyway.
- **File paths** in `hashedUrl('`, `asset('`, `svg('`, `css('`, `js('` and `url('assets/`: the files and folders of the docroot (where Kirby's `index.php` is). URLs, `@auto` and files in `media/` (which Kirby creates on demand) aren't checked.
- **Templates** in `->template('…')`, `->notTemplate('…')`, `->changeTemplate('…')` and `filterBy('template', …)`.
- **Field names**: after `$page->`, `$site->`, `$block->` and `$this->` (in a model), the fields of the page's, site's or block's blueprint are offered as `name()`, with their type and label. In a template, controller or model it's the blueprint of that template; in a block snippet that block's; in other snippets the fields of all page blueprints.
- **Methods**: after `$page->`, `$site->` and `$block->` also the methods plugins and the config add (`pageMethods`, `siteMethods`, `blockMethods`), and in a template or controller those of the page's model, with signature and description. No more `*-methods.stub.php` needed for that.
- **Field methods**: after a field, `$page->cover()->`, Kirby's field methods, the ones that fit the field's type first (`toFile()` for a file picker, `toBlocks()` for blocks …), and the `fieldMethods` of plugins.
- **Controller variables**: in a template, `$` offers what its controllers return (the `site` controller and the template's own) and Kirby's `$page`, `$site`, `$kirby`, `$pages`. Go to Definition on a variable opens the controller at its line.

In blueprints:

- `type: ` offers Kirby 6's field types, such as `pagelist` and `pagepicker`. `pages`, `files` and `users` are shown as deprecated aliases.
- At a key of a field, the options of its type are offered, with their type, default and description: `counter`, `maxlength` … for a `text` field, `templates`, `layout` … for a `pagelist`. Options the field already has are left out. In the value of a boolean option, `true`, `false` and (if it may be empty) `null` are offered, the default marked: `translate: ` offers `true` (default), `false` and `null`.
- `extends: ` and the shorthand `seo: fields/seo` (in `fields`, `tabs` and `sections`) offer the project's blueprints, those of the fitting folder first.
- In a list of `fields` (Kirby 6: `fields: [intro, text]` in tabs and columns), the fields defined at the top of the blueprint; in `fieldsets`, the block types.
- Template names in `template:`/`templates:`/`create:` of a `pagelist`, `template:` of a `filelist`, `uploads:` of a `filepicker` or `textarea` and `options: changeTemplate:` offer the page (or file) templates: from blueprints, `site/templates`, plugins, and the pages in the content folder.

For all of them:

- Only the PHP code of a file counts, not the HTML, CSS or JavaScript around it.
- PHP's language server (Intelephense) comes first: if a file tells it the class of `$page` (`/** @var ProjectPage $page */`, or a typed parameter in a controller), fields documented with `@method` in the model, the model's own methods, methods in `*.stub.php` files and, after a documented field, Kirby's field methods are left to it. In a model that documents its fields with `@method`, a hint lists the fields of the blueprint that have no line yet, and a warning marks lines for fields that don't exist, each with a quick fix.


- **Go to Definition** (F12 or ⌘-click) opens the file the name under the cursor refers to: the snippet, collection, file, blueprint or template, for translation keys the line in the language file. On `$page->name()` it opens the method (in the plugin, the config or the model) or the field's line in the blueprint; on `$page->cover()->toFile()` the field method, Kirby's own in Kirby's source.
- **Hover** shows where a name comes from and what it holds: a snippet's variables, a collection's signature, a translation in all languages, a method's signature.
- **Code lenses** above snippet and collection calls show where they come from.
- **Warnings** mark names that don't exist.
	- `t('key', 'Fallback')` with a fallback text isn't flagged. If a plugin loads its translations at runtime (e.g. from JSON files), missing keys are only a hint, because they might come from there.
	- `intro: textarea` is marked too, because Kirby reads it as `extends` and not as the type.
	- A template exists if there's a blueprint, a template file or a page that uses it. For file templates without a blueprint it's only a hint, because Kirby falls back to `files/default`.
	- Field references that aren't defined at the top of the blueprint, and block types in `fieldsets` without a blueprint.
	- Variables in a template that neither the template, its controllers nor Kirby define. Only when every controller could be read and the template doesn't use `extract()` or `include`.

Fallbacks such as `snippet(['m-card-project', 'm-card'])` are understood. Names built at runtime, like `snippet('blocks/' . $block->type())`, are not checked.

It works next to PHP extensions like Intelephense: VS Code shows the completions, hovers and definitions of all of them.

## Settings

In PHP files, the extension turns on quick suggestions inside strings (`"editor.quickSuggestions": { "strings": "on" }` for `[php]`), so completions appear while you type `snippet('m-`. You can turn it off again in your settings.

## Requirements

VS Code 1.91 or newer. The language server runs in VS Code's own Node.js; nothing else needs to be installed.

The project needs a Kirby `site` folder (`site/` or e.g. `public/site/`) within three levels of the workspace folder.
