## 0.1.0

- Completion for `snippet('…')`, `collection('…')` and `t('…')`/`tt('…')`/`tc('…')`, also `kirby.collection("…")` in blueprint queries, with each entry's origin, variables, signature or text
- Completion for `type:` in blueprints with Kirby 6's field types
- Completion for the options of a field in blueprints, by its type, and of `true`, `false` and `null` as the values of boolean options
- Completion for `extends:` and the shorthand `seo: fields/seo` in blueprints, with warnings for blueprints that don't exist
- Completion for template names in blueprints and in `->template('…')`, `->notTemplate('…')`, `->changeTemplate('…')` and `filterBy('template', …)`
- Completion of a snippet's variables in `snippet('…', ['…`
- Completion of field names after `$page->`, `$site->`, `$block->` and `$this->`, from the blueprint
- Completion of methods from plugins, the config and the page's model after `$page->`, `$site->` and `$block->`, and of field methods after `$page->field()->`, the fitting ones first
- Completion of controller variables in templates, with warnings for variables nothing defines
- Completion of field references (`fields: [intro]`) and block types (`fieldsets`) in blueprints, with warnings for those that don't exist
- Completion of file paths in `hashedUrl('…')`, `asset('…')`, `svg('…')`, `css('…')`, `js('…')` and `url('assets/…')`
- Command Open Referenced File (⌃⌥⌘O)
- Warnings for snippets, collections, translation keys, files, blueprints and templates that don't exist
