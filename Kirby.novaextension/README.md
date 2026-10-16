**Kirby** helps with snippets, collections and translations in [Kirby CMS](https://getkirby.com) projects.

## What it does

When you type `snippet('`, `collection('` or `t('` (also `tt('`, `tc('`) in a PHP file, or `kirby.collection("` in a blueprint query:

- **Completion** lists every snippet, collection or translation key of the project, with where it comes from:
	- snippets from `site/snippets`, registered by plugins or in the config, and Kirby's block snippets; each shows the variables it expects (`@var` lines and defaults like `$size ??= null;`)
	- collections from `site/collections`, registered by plugins or under `'extensions'` in the config; each shows its signature
	- translation keys from `site/languages`, plugins and the config, then Kirby's own (from `kirby/i18n/translations`); each shows its text in the default language, and in all languages in the details
- **Open Snippet, Collection or Translation** (⌃⌥⌘O, or from the command palette) opens the file the name under the cursor refers to, for translation keys the line in the language file.
- **Warnings** mark calls whose snippet, collection or translation key doesn't exist. `t('key', 'Fallback')` with a fallback text isn't flagged. If a plugin loads its translations at runtime (e.g. from JSON files), missing keys are only a hint, because they might come from there.

In blueprints, `type: ` offers the field types (and in Kirby 4 and 5 the section types under `sections:`). Kirby 6's new fields like `pagelist` and `pagepicker` are offered when the project runs Kirby 6.

Fallbacks such as `snippet(['m-card-project', 'm-card'])` are understood. Names built at runtime, like `snippet('blocks/' . $block->type())`, are not checked.

Hover and ⌘-click don't work while Nova's built-in PHP language server (Intelephense) is on: Nova then asks only Intelephense. Without it, hover works, but ⌘-click still doesn't jump. That's why opening is a command of its own.

## Requirements

[Node.js](https://nodejs.org) 18 or newer. The extension finds `node` through your login shell, so installations via nvm or Homebrew work as they are. Otherwise, set the path in the extension settings.

The project needs a Kirby `site` folder (`site/` or e.g. `public/site/`) within three levels of the project root.
