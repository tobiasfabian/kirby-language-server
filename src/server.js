import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	CodeActionKind,
	DefinitionRequest,
	HoverRequest,
	CompletionItemKind,
	CompletionItemTag,
	createConnection,
	DiagnosticSeverity,
	MarkupKind,
	ProposedFeatures,
	TextDocuments,
	TextDocumentSyncKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { blueprintFields, blueprintReferences, extend, extendsContext, fieldDefinitions, fieldKeyAt, fieldKeyOffset, fieldTypeAt, optionValues, templatePlace, fieldMethods, fieldProperties, fieldReferences, fieldsetReferences, fieldTypes, fittingMethods, isFieldType, listItemContext, literalValues, propertyContext, referenceAt, templateSlots, typeContext, valueContext } from './blueprints.js';
import { completionContext, fieldContext, fieldMethodContext, findCalls, memberAt, nameAt, propsContext, variableAt, variableContext } from './calls.js';
import { classInfo, classMethods, closureInfo, collectionSignature, controllerVariables, findAsset, findSites, listBlueprints, listCollections, listControllers, listDocroot, listMethods, listModels, listSnippets, listStubs, listTemplates, listTranslations, readBlueprint, snippetProps, snippetVariables } from './project.js';
import { chainAt, classOf, hasFields, queryContext, queryMethods, queryNameAt } from './query.js';
import { isInPhp, phpOnly, undefinedVariables } from './variables.js';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

/** @type {string[]} */
let workspaceFolders = [];

/** @type {string[] | null} */
let sites = null;

// Whether the editor understands LocationLink, which also names the clicked range
let definitionLinks = false;

// The languages to offer Go to Definition and hover for, if the editor asks for only some
// (`initializationOptions.navigation`, e.g. Nova: only YAML, so PHP stays with Intelephense)
let navigation = null;

const cache = new Map();
const validationTimers = new Map();

/**
 * The Kirby `site` folders of all workspace folders, found once
 */
function allSites() {
	sites ??= workspaceFolders.flatMap((folder) => findSites(folder));
	return sites;
}

/**
 * The site a document belongs to: the one whose project contains it
 * @param {string} uri
 */
function siteFor(uri) {
	if (uri.startsWith('file:') === false) {
		return null;
	}

	const file = fileURLToPath(uri);
	const candidates = allSites().filter((site) => file.startsWith(path.dirname(site) + path.sep));

	// The deepest project wins (for sites nested in other folders)
	return candidates.sort((a, b) => b.length - a.length)[0] ?? null;
}

/**
 * Reads something about a site, again at most every two seconds (or `ttl` milliseconds)
 * @template T
 * @param {string} key
 * @param {() => T} read
 * @param {number} [ttl]
 * @returns {T}
 */
function cached(key, read, ttl = 2000) {
	const entry = cache.get(key);

	if (entry !== undefined && Date.now() - entry.time < ttl) {
		return entry.value;
	}

	const value = read();
	cache.set(key, { time: Date.now(), value });

	return value;
}

/**
 * Completion for `type:` in a blueprint
 * @param {TextDocument} document
 * @param {{ line: number, character: number }} position
 */
function typeCompletion(document, position) {
	const context = typeContext(document.getText(), document.offsetAt(position));

	if (context === null) {
		return null;
	}

	const range = { start: document.positionAt(context.start), end: position };

	return fieldTypes().map(({ name, replacement, docs }) => ({
		label: name,
		kind: CompletionItemKind.EnumMember,
		detail: replacement === undefined ? 'field' : `deprecated: use ${replacement}`,
		tags: replacement === undefined ? [] : [CompletionItemTag.Deprecated],
		documentation: { kind: MarkupKind.Markdown, value: `[${replacement ?? name}](${docs})` },
		sortText: (replacement === undefined ? '0' : '1') + name,
		filterText: name,
		textEdit: { range, newText: name },
	}));
}

/**
 * Completion for a path in `css('…')`, `svg('…')` etc.: the files and folders
 * in the folder typed so far, relative to the docroot
 * @param {TextDocument} document
 * @param {{ line: number, character: number }} position
 * @param {string} site
 * @param {{ fn: string, prefix: string, start: number }} context
 */
function assetCompletion(document, position, site, context) {
	const slash = context.prefix.lastIndexOf('/');
	const folder = context.prefix.slice(0, slash + 1).replace(/^\//, '');

	// url() is only about files in assets/
	if (context.fn === 'url' && folder.startsWith('assets/') === false && folder !== '') {
		return [];
	}

	const range = { start: document.positionAt(context.start + slash + 1), end: position };

	return listDocroot(site, folder)
		.filter(({ name }) => context.fn !== 'url' || folder !== '' || name === 'assets')
		.map(({ name, directory }) => ({
			label: directory ? name + '/' : name,
			kind: directory ? CompletionItemKind.Folder : CompletionItemKind.File,
			filterText: name,
			sortText: (directory ? '0' : '1') + name,
			textEdit: { range, newText: directory ? name + '/' : name },
		}));
}

/**
 * The file a path in `css('…')`, `svg('…')` etc. points to, as an entry
 * @param {string} site
 * @param {string} name
 * @returns {import('./project.js').Entry | undefined}
 */
function assetEntry(site, name) {
	const asset = findAsset(site, name);
	return asset === null || asset.directory === true ? undefined : { file: asset.file, line: 0, source: 'site' };
}

/**
 * The blueprints whose fields `$page`, `$site`, `$block` or `$this` has in a file:
 * `pages/<template>` in a template, controller or model (`pages/default` if there's no
 * blueprint of its own), `blocks/<type>` in a block snippet, `site` for `$site`.
 * Where it's not clear, e.g. `$page` in a snippet, all page (or block) blueprints.
 * @param {'page' | 'site' | 'block' | 'this'} variable
 * @param {string} file
 * @param {string} site
 * @returns {string[]}
 */
function blueprintsForVariable(variable, file, site) {
	if (variable === 'site') {
		return ['site'];
	}

	const blueprints = entriesOf(site, 'blueprint');
	const [folder, ...rest] = path.relative(site, file).split(path.sep);
	const name = rest.join('/').replace(/\..*$/, '');
	const all = (prefix) => [...blueprints.keys()].filter((blueprint) => blueprint.startsWith(prefix) && blueprint.slice(prefix.length).includes('/') === false);

	if (variable === 'block') {
		return folder === 'snippets' && name.startsWith('blocks/') ? [name] : all('blocks/');
	}

	if (['templates', 'controllers', 'models'].includes(folder) === true && name.includes('/') === false) {
		return [blueprints.has('pages/' + name) ? 'pages/' + name : 'pages/default'];
	}

	// $this is only clear in a model
	return variable === 'page' ? all('pages/') : [];
}

/**
 * The fields `$page`, `$site`, `$block` or `$this` has in a file, by name, with the blueprints they're from
 * @param {'page' | 'site' | 'block' | 'this'} variable
 * @param {string} file
 * @param {string} site
 * @returns {Map<string, import('./blueprints.js').BlueprintField & { blueprints: string[] }>}
 */
function fieldsFor(variable, file, site) {
	return fieldsOf(blueprintsForVariable(variable, file, site), site);
}

/**
 * The fields of blueprints that store content, by name, with the blueprints they're from.
 * The site always has its title (in `site.txt`), which no blueprint defines.
 * @param {string[]} names e.g. `pages/project`
 * @param {string} site
 * @returns {Map<string, import('./blueprints.js').BlueprintField & { blueprints: string[] }>}
 */
function fieldsOf(names, site) {
	const find = blueprintFinder(site);
	const fields = new Map();

	for (const name of names) {
		const blueprint = find(name);
		const own = blueprint === null ? [] : cached(`fields:${site}:${name}`, () => blueprintFields(blueprint, find));
		const builtIn = name === 'site' && own.some((field) => field.name.toLowerCase() === 'title') === false ? [{ name: 'title', type: 'text', label: 'The title of the site' }] : [];

		for (const field of [...builtIn, ...own]) {
			const known = fields.get(field.name);
			fields.set(field.name, { ...field, blueprints: [...known?.blueprints ?? [], name] });
		}
	}

	return fields;
}

/**
 * The methods `$page`, `$site`, `$block` or `$this` (in a model) has in a file besides Kirby's own:
 * those plugins and the config register, and for a page in a template or controller its model's
 * @param {'page' | 'site' | 'block' | 'this'} variable
 * @param {string} file
 * @param {string} site
 * @returns {{ name: string, params: string, returns?: string, description?: string, origin: string, entry: import('./project.js').Entry }[]}
 */
function methodsFor(variable, file, site) {
	const [folder, ...rest] = path.relative(site, file).split(path.sep);

	// $this is only clear in a model, where PHP itself knows the model's own methods
	if (variable === 'this' && folder !== 'models') {
		return [];
	}

	const kind = { page: 'pageMethods', this: 'pageMethods', site: 'siteMethods', block: 'blockMethods' }[variable];
	const methods = [...entriesOf(site, kind)].map(([name, entry]) => {
		const info = cached(`closure:${entry.file}:${entry.line}`, () => closureInfo(entry));
		return { name, params: info?.params ?? '', returns: info?.returns, description: info?.description, origin: origin(entry, site), entry };
	});

	const template = rest.join('/').replace(/\..*$/, '');
	const model = variable === 'page' && ['templates', 'controllers'].includes(folder) ? cached('models:' + site, () => listModels(site)).get(template) : undefined;

	if (model !== undefined) {
		const file = path.relative(path.dirname(site), model.file);
		methods.push(...cached(`model:${model.file}`, () => classMethods(model.file, model.className)).map((method) => ({ ...method, origin: `model · ${file}`, entry: { file: model.file, line: method.line, source: /** @type {const} */ ('site') } })));
	}

	return methods;
}

/**
 * The classes a file tells PHP's language server its variables have: `@var ProjectPage $page`,
 * typed parameters (`function (ProjectPage $page)`), and `$this` in a class. Short names only.
 * @param {string} text
 * @returns {Map<string, string>}
 */
function typesIn(text) {
	const types = new Map();
	const short = (type) => type.replace(/<[\s\S]*$/, '').replace(/^\?/, '').split('|')[0].split('\\').pop();

	for (const match of text.matchAll(/@var\s+([^\s$]+)\s+\$(\w+)/g)) {
		types.set(match[2], short(match[1]));
	}

	for (const match of text.matchAll(/\b(?:function|fn)\s*\(([^)]*)\)/g)) {
		for (const param of match[1].matchAll(/([\\\w?|]+)\s+&?\$(\w+)/g)) {
			if (types.has(param[2]) === false) {
				types.set(param[2], short(param[1]));
			}
		}
	}

	const declaration = text.match(/\bclass\s+(\w+)/);

	if (declaration !== null) {
		types.set('this', declaration[1]);
	}

	return types;
}

/**
 * What PHP's language server knows `$page`, `$site`, `$block` or `$this` has, if the file tells it
 * the variable's class (see `typesIn`): the methods and `@method` lines of that class if it's a
 * model, and the `@method` lines of the stubs for Kirby's class (`Page`, `Site`, `Block`).
 * `fields` are the `@method` lines that return a field. Null if PHP doesn't know the class; names in lowercase.
 * @param {'page' | 'site' | 'block' | 'this'} variable
 * @param {TextDocument} document
 * @param {string} site
 * @returns {{ names: Set<string>, fields: Set<string> } | null}
 */
function phpKnowledge(variable, document, site) {
	const type = typesIn(document.getText()).get(variable);

	if (type === undefined) {
		return null;
	}

	const base = { page: 'Page', this: 'Page', site: 'Site', block: 'Block' }[variable];
	const names = new Set(cached('stubs:' + site, () => listStubs(site), 10000).get(base) ?? []);
	const fields = new Set();
	const model = [...cached('models:' + site, () => listModels(site)).values()].find(({ className }) => className === type);
	const info = model === undefined ? null : cached(`class:${model.file}`, () => classInfo(model.file, model.className));

	for (const method of info?.methods ?? []) {
		names.add(method.name.toLowerCase());
	}

	for (const method of info?.documented ?? []) {
		names.add(method.name.toLowerCase());

		if (/Field$/.test(method.returns) === true) {
			fields.add(method.name.toLowerCase());
		}
	}

	return { names, fields };
}

/**
 * A completion item for a method
 * @param {{ name: string, params: string, returns?: string, description?: string, origin?: string }} method
 * @param {{ start: import('vscode-languageserver').Position, end: import('vscode-languageserver').Position }} range
 * @param {boolean} call whether `(` already follows
 * @param {string} sortText
 */
function methodItem(method, range, call, sortText) {
	return {
		label: method.name,
		kind: CompletionItemKind.Method,
		detail: `(${method.params})${method.returns === undefined ? '' : ': ' + method.returns}${method.origin === undefined ? '' : ' · ' + method.origin}`,
		documentation: method.description,
		filterText: method.name,
		sortText,
		textEdit: { range, newText: call ? method.name : method.name + '()' },
	};
}

/**
 * Completion after `$page->`, `$site->`, `$block->` or `$this->` (in a model): the fields
 * from the blueprint of the page, site or block, inserted as `name()`, then the methods
 * that plugins, the config or the page's model add
 * @param {TextDocument} document
 * @param {{ line: number, character: number }} position
 * @param {string} site
 */
function fieldCompletion(document, position, site) {
	const context = fieldContext(document.getText(), document.offsetAt(position));

	if (context === null) {
		return null;
	}

	const file = fileURLToPath(document.uri);
	const range = { start: document.positionAt(context.start), end: document.positionAt(context.end) };
	const all = methodsFor(context.variable, file, site);

	// What PHP's language server knows from types and docblocks is left to it
	const known = phpKnowledge(context.variable, document, site);
	const unknown = ({ name }) => known === null || known.names.has(name.toLowerCase()) === false;
	const methods = all.filter(unknown);

	// A method of the same name wins over the field
	const overridden = new Set(all.map(({ name }) => name.toLowerCase()));
	const fields = [...fieldsFor(context.variable, file, site).values()].filter(({ name }) => overridden.has(name.toLowerCase()) === false).filter(unknown).map((field, index) => ({
		label: field.name,
		kind: CompletionItemKind.Field,
		detail: `${field.type} · ${field.blueprints.join(', ')}`,
		documentation: field.label === undefined ? undefined : field.label,
		filterText: field.name,
		sortText: '0' + String(index).padStart(3, '0'),
		textEdit: { range, newText: context.call ? field.name : field.name + '()' },
	}));

	return [...fields, ...methods.map((method) => methodItem(method, range, context.call, '1' + method.name))];
}

/**
 * Completion after a field, `$page->cover()->`: Kirby's field methods (those that fit the
 * field's type first, like `toFile()` for a `filepicker`) and those plugins and the config add.
 * Only for fields of the blueprint; other calls are left to PHP's own language server.
 * @param {TextDocument} document
 * @param {{ line: number, character: number }} position
 * @param {string} site
 */
function fieldMethodCompletion(document, position, site) {
	const context = fieldMethodContext(document.getText(), document.offsetAt(position));
	const field = context === null ? undefined : [...fieldsFor(context.variable, fileURLToPath(document.uri), site).values()].find(({ name }) => name.toLowerCase() === context.field.toLowerCase());

	if (field === undefined) {
		return null;
	}

	const range = { start: document.positionAt(context.start), end: document.positionAt(context.end) };
	const fitting = fittingMethods(field.type);

	// Plugin field methods get the field as their first parameter
	const custom = [...entriesOf(site, 'fieldMethods')].map(([name, entry]) => {
		const info = cached(`closure:${entry.file}:${entry.line}`, () => closureInfo(entry));
		const params = (info?.params ?? '').split(',').slice(1).join(',').trim();
		return methodItem({ name, params, returns: info?.returns, description: info?.description, origin: origin(entry, site) }, range, context.call, '1' + name);
	});

	// If PHP's language server knows the field (an `@method` line), it shows Kirby's field methods and those of stubs
	if (phpKnowledge(context.variable, document, site)?.fields.has(field.name.toLowerCase()) === true) {
		const stubbed = cached('stubs:' + site, () => listStubs(site), 10000).get('Field') ?? new Set();
		return custom.filter(({ label }) => stubbed.has(label.toLowerCase()) === false);
	}

	const core = fieldMethods().map((method) => methodItem(method, range, context.call, fitting.includes(method.name) ? '0' + fitting.indexOf(method.name) : '2' + method.name));

	return [...core, ...custom];
}

/**
 * The type of a field in a blueprint: its `type`, the type of what it extends, or its name
 * @param {import('./blueprints.js').FieldAtLine} field
 * @param {string} site
 */
function typeOfField(field, site) {
	const extended = field.extends === undefined ? null : extend({ extends: field.extends }, blueprintFinder(site));
	return field.type ?? extended?.type ?? field.name;
}

/**
 * Completion for the value of a field's option that can be written literally:
 * `true` and `false` for a boolean, `null` if it may be empty
 * @param {TextDocument} document
 * @param {{ line: number, character: number }} position
 * @param {string} site
 */
function valueCompletion(document, position, site) {
	const context = valueContext(document.getText(), document.offsetAt(position), partialName(document, site));
	const type = context === null ? null : typeOfField(context, site);
	const option = context === null ? undefined : fieldProperties(type)?.find(({ name }) => name === context.key);
	const values = option === undefined ? [] : [...optionValues(type, context.key), ...literalValues(option.type)];

	if (values.length === 0) {
		return null;
	}

	const range = { start: document.positionAt(context.start), end: position };

	return values.map((value, index) => ({
		label: value,
		kind: CompletionItemKind.Value,
		// An option without a default is null (for theme the docs name info)
		detail: value === (option.default ?? (context.key === 'theme' ? 'info' : 'null')) ? 'default' : undefined,
		documentation: option.description,
		filterText: value,
		sortText: '2' + index,
		textEdit: { range, newText: value },
	}));
}

/**
 * Compares the `@method … Field name()` lines of a model in `site/models` with the fields of
 * its blueprint, for models that document their fields this way (at least one such line):
 * the fields without a line, and the lines for fields the blueprint doesn't have.
 * PHP's language server only knows the documented ones.
 * @param {TextDocument} document
 * @param {string} site
 */
function modelDocs(document, site) {
	const file = fileURLToPath(document.uri);
	const [folder, name, ...rest] = path.relative(site, file).split(path.sep);
	const template = name?.endsWith('.php') ? name.slice(0, -4) : null;

	if (folder !== 'models' || rest.length > 0 || template === null || entriesOf(site, 'blueprint').has('pages/' + template) === false) {
		return null;
	}

	const info = classInfo(file, undefined, document.getText());
	const documented = info?.documented.filter(({ returns }) => /Field$/.test(returns)) ?? [];

	if (documented.length === 0) {
		return null;
	}

	const fields = [...fieldsFor('page', file, site).values()];
	const has = (list, name) => list.some((item) => item.name.toLowerCase() === name.toLowerCase());

	// Every page has a title, with or without a field in the blueprint, and Kirby's Page::title()
	const isTitle = ({ name }) => name.toLowerCase() === 'title';

	return {
		info,
		blueprint: 'pages/' + template,
		// A method of the model takes the field's place
		missing: fields.filter((field) => has(info.documented, field.name) === false && has(info.methods, field.name) === false && isTitle(field) === false),
		stale: documented.filter((method) => has(fields, method.name) === false && has(info.methods, method.name) === false && isTitle(method) === false),
		type: documented[0].returns,
	};
}

/**
 * Hints for the `@method` lines of a model: fields of the blueprint without one (on the class),
 * and lines for fields that don't exist (on the line). Both come with a quick fix.
 * @param {TextDocument} document
 * @param {string} site
 */
function modelDiagnostics(document, site) {
	const docs = modelDocs(document, site);

	if (docs === null) {
		return [];
	}

	const lineRange = (line) => ({ start: { line, character: 0 }, end: { line, character: document.getText({ start: { line, character: 0 }, end: { line: line + 1, character: 0 } }).replace(/\n$/, '').length } });
	const diagnostics = docs.stale.map((method) => ({
		severity: DiagnosticSeverity.Warning,
		range: lineRange(method.line),
		message: `Field “${method.name}” isn’t in blueprint ${docs.blueprint}.`,
		source: 'Kirby',
		code: 'stale-method-doc',
	}));

	if (docs.missing.length > 0) {
		const names = docs.missing.map(({ name }) => name).join(', ');

		diagnostics.push({
			severity: DiagnosticSeverity.Information,
			range: lineRange(docs.info.line),
			message: `Missing @method for field${docs.missing.length === 1 ? '' : 's'} of blueprint ${docs.blueprint}: ${names}`,
			source: 'Kirby',
			code: 'missing-method-docs',
		});
	}

	return diagnostics;
}

/**
 * Quick fixes for the hints of `modelDiagnostics`: add the missing `@method` lines (after the
 * last one, written like it), or remove a line for a field that doesn't exist
 * @param {TextDocument} document
 * @param {string} site
 * @param {{ start: { line: number }, end: { line: number } }} range
 * @param {any[]} diagnostics those the editor sends along
 */
function modelCodeActions(document, site, range, diagnostics) {
	const docs = modelDocs(document, site);

	if (docs === null) {
		return [];
	}

	const uri = document.uri;
	const lines = document.getText().split('\n');
	const touches = (line) => line >= range.start.line && line <= range.end.line;
	const matching = (code, line) => diagnostics.filter((diagnostic) => diagnostic.code === code && diagnostic.range.start.line === line);
	const actions = [];

	if (docs.missing.length > 0 && touches(docs.info.line) === true) {
		// After the last @method line, with its indentation
		const last = docs.info.documented.at(-1).line;
		const prefix = lines[last].match(/^\s*\*\s*/)?.[0] ?? ' * ';
		const text = docs.missing.map(({ name }) => `${prefix}@method ${docs.type} ${name}()\n`).join('');

		actions.push({
			title: docs.missing.length === 1 ? `Add @method line for “${docs.missing[0].name}”` : `Add @method lines for ${docs.missing.length} fields`,
			kind: CodeActionKind.QuickFix,
			isPreferred: true,
			diagnostics: matching('missing-method-docs', docs.info.line),
			edit: { changes: { [uri]: [{ range: { start: { line: last + 1, character: 0 }, end: { line: last + 1, character: 0 } }, newText: text }] } },
		});
	}

	for (const method of docs.stale.filter(({ line }) => touches(line))) {
		actions.push({
			title: `Remove @method line for “${method.name}”`,
			kind: CodeActionKind.QuickFix,
			diagnostics: matching('stale-method-doc', method.line),
			edit: { changes: { [uri]: [{ range: { start: { line: method.line, character: 0 }, end: { line: method.line + 1, character: 0 } }, newText: '' }] } },
		});
	}

	return actions;
}

// What Kirby gives every template
const TEMPLATE_DATA = { kirby: 'Kirby\\Cms\\App', site: 'Kirby\\Cms\\Site', pages: 'Kirby\\Cms\\Pages', page: 'Kirby\\Cms\\Page' };

// Every snippet has the template's data already; `$slot` and `$slots` can't be passed at all (Kirby throws)
const SNIPPET_GLOBALS = new Set([...Object.keys(TEMPLATE_DATA), 'slot', 'slots']);

/**
 * @typedef {{ entry: import('./project.js').Entry, value: string, controller: string }} TemplateVariable
 */

/**
 * The variables the controllers give a template in `site/templates`: those of the `site`
 * controller, then those of the template's own (for `project.json.php` the `project.json`
 * controller, else `project`), as Kirby merges them. Null for other files.
 * `complete` is false if a controller returns something that can't be read completely.
 * @param {string} file
 * @param {string} site
 * @returns {{ variables: Map<string, TemplateVariable>, complete: boolean } | null}
 */
function templateVariables(file, site) {
	const [folder, name, ...rest] = path.relative(site, file).split(path.sep);

	if (folder !== 'templates' || rest.length > 0 || name.endsWith('.php') === false) {
		return null;
	}

	const [template, type] = name.slice(0, -4).split('.');
	const controllers = cached('controllers:' + site, () => listControllers(site));
	const lookup = (base) => (type === undefined ? undefined : controllers.get(`${base}.${type}`)) ?? controllers.get(base);
	const variables = new Map();
	let complete = true;

	for (const [controller, entry] of [['site', lookup('site')], [template, lookup(template)]]) {
		if (entry === undefined) {
			continue;
		}

		const result = cached(`controller:${entry.file}:${entry.line}`, () => controllerVariables(entry));
		complete &&= result.complete;

		for (const variable of result.variables) {
			variables.set(variable.name, { entry: { ...entry, line: variable.line, value: variable.value }, value: variable.value, controller });
		}
	}

	return { variables, complete };
}

/**
 * Completion for variables in a template: what its controllers return, and Kirby's `$page`, `$site` …
 * @param {TextDocument} document
 * @param {{ line: number, character: number }} position
 * @param {string} site
 */
function variableCompletion(document, position, site) {
	const context = variableContext(document.getText(), document.offsetAt(position));
	const data = context === null ? null : templateVariables(fileURLToPath(document.uri), site);

	if (data === null) {
		return null;
	}

	const range = { start: document.positionAt(context.start), end: document.positionAt(context.end) };
	const item = (name, detail, documentation, sortText) => ({
		label: '$' + name,
		kind: CompletionItemKind.Variable,
		detail,
		documentation,
		filterText: '$' + name,
		sortText,
		textEdit: { range, newText: '$' + name },
	});

	return [
		...[...data.variables].map(([name, variable]) => item(name, shorten(variable.value), { kind: MarkupKind.Markdown, value: describe('variable', name, variable.entry, site) }, '0' + name)),
		...Object.entries(TEMPLATE_DATA).filter(([name]) => data.variables.has(name) === false).map(([name, type]) => item(name, type, 'Kirby', '1' + name)),
	];
}

/**
 * The variables a template in `site/templates` uses that come from Kirby or its controllers
 * but have no `@var` line, so PHP's language server reports them as undefined: each with its
 * first use and the type for its line (the page's model, Kirby's classes, else `mixed`)
 * @param {TextDocument} document
 * @param {string} site
 * @returns {{ name: string, type: string, start: number, end: number }[]}
 */
function missingVarDocs(document, site) {
	const file = fileURLToPath(document.uri);
	const data = templateVariables(file, site);
	const used = data === null ? null : undefinedVariables(document.getText());

	if (used === null) {
		return [];
	}

	const declared = new Set([...document.getText().matchAll(/@var\s+[^\s$]+\s+\$(\w+)/g)].map(([, name]) => name));
	const model = cached('models:' + site, () => listModels(site)).get(path.basename(file).split('.')[0]);
	const missing = new Map();

	for (const { name, start, end } of used) {
		if (missing.has(name) === true || declared.has(name) === true) {
			continue;
		}

		if (data.variables.has(name) === true) {
			missing.set(name, { name, type: 'mixed', start, end });
		} else if (TEMPLATE_DATA[name] !== undefined) {
			missing.set(name, { name, type: name === 'page' && model?.className ? model.className : '\\' + TEMPLATE_DATA[name], start, end });
		}
	}

	return [...missing.values()];
}

/**
 * Hints for variables of a template without `@var` line (see `missingVarDocs`), on their first use
 * @param {TextDocument} document
 * @param {string} site
 */
function varDocDiagnostics(document, site) {
	return missingVarDocs(document, site).map(({ name, start, end }) => ({
		severity: DiagnosticSeverity.Information,
		range: { start: document.positionAt(start), end: document.positionAt(end) },
		message: `Missing @var for $${name} (from ${TEMPLATE_DATA[name] === undefined ? 'the controller' : 'Kirby'})`,
		source: 'Kirby',
		code: 'missing-var-doc',
	}));
}

/**
 * The quick fix for `varDocDiagnostics`: adds the missing `@var` lines to the docblock at the
 * top of the template (before its `*\/`), or a new docblock after `<?php` (or in a new PHP block)
 * @param {TextDocument} document
 * @param {string} site
 * @param {{ start: { line: number }, end: { line: number } }} range
 * @param {any[]} diagnostics those the editor sends along
 */
function varDocCodeActions(document, site, range, diagnostics) {
	const missing = missingVarDocs(document, site);
	const touched = missing.some(({ start }) => {
		const line = document.positionAt(start).line;
		return line >= range.start.line && line <= range.end.line;
	});

	if (missing.length === 0 || touched === false) {
		return [];
	}

	const text = document.getText();
	const lines = missing.map(({ name, type }) => `@var ${type} $${name}`);
	const docblock = text.match(/\/\*\*(?:(?!\*\/)[\s\S])*@var(?:(?!\*\/)[\s\S])*\*\//);
	let edit;

	if (docblock !== null && docblock[0].includes('\n') === true) {
		// Before the closing line of a docblock with @var lines, written like them
		const close = document.positionAt(docblock.index + docblock[0].lastIndexOf('*/')).line;
		const prefix = docblock[0].match(/\n(\s*\*\s*)@var/)?.[1] ?? ' * ';
		edit = { range: { start: { line: close, character: 0 }, end: { line: close, character: 0 } }, newText: lines.map((line) => prefix + line + '\n').join('') };
	} else if (docblock !== null) {
		// After a one-line docblock, as one-line docblocks
		const end = document.positionAt(docblock.index + docblock[0].length);
		edit = { range: { start: end, end }, newText: lines.map((line) => `\n/** ${line} */`).join('') };
	} else if (text.startsWith('<?php') === true) {
		const end = document.positionAt(5);
		edit = { range: { start: end, end }, newText: '\n\n/**\n' + lines.map((line) => ` * ${line}\n`).join('') + ' */\n' };
	} else {
		const start = { line: 0, character: 0 };
		edit = { range: { start, end: start }, newText: '<?php\n/**\n' + lines.map((line) => ` * ${line}\n`).join('') + ' */\n?>\n' };
	}

	return [{
		title: missing.length === 1 ? `Add @var line for $${missing[0].name}` : `Add @var lines for ${missing.length} variables`,
		kind: CodeActionKind.QuickFix,
		isPreferred: true,
		diagnostics: diagnostics.filter((diagnostic) => diagnostic.code === 'missing-var-doc'),
		edit: { changes: { [document.uri]: [edit] } },
	}];
}

// The start of a query: what each name is, by the blueprint the query is in (see `queryRoots`)
const QUERY_ROOTS = {
	kirby: 'The Kirby instance',
	site: 'The site',
	model: 'The page, file, user or site of the blueprint',
	page: 'The page of the blueprint, or in a template the page of each entry',
	file: 'The file of the blueprint, or in a template the file of each entry',
	user: 'The user of the blueprint, or in a template the user of each entry',
	users: 'All users',
	collection: 'A collection: collection("name")',
	item: 'In a template, each entry of the query',
	block: 'In a template, each block of the query',
	t: 'A translation: t("key")',
};

// Fields whose templates (`info`, `text` …) show each of their entries
const ENTRY_FIELDS = ['pagelist', 'filelist', 'pagepicker', 'filepicker', 'userpicker'];

/**
 * What the names at the start of a query are: mostly the model of the blueprint (`page` with
 * the fields and model of `pages/project`). In a template (`{{ … }}`) below `options:` or of a
 * list or picker field, they're each entry, whose blueprint isn't known, so they have the fields
 * of all blueprints of their kind.
 * @param {TextDocument} document
 * @param {string} site
 * @param {boolean} template
 * @param {number} offset
 * @returns {Record<string, import('./query.js').QueryType>}
 */
function queryRoots(document, site, template, offset) {
	const own = ownName(document, site);
	const place = template ? templatePlace(document.getText(), offset) : null;
	const type = place?.field === null || place === null ? null : typeOfField(place.field, site);
	const entries = place !== null && (place.inOptions || ENTRY_FIELDS.includes(fieldTypes().find(({ name }) => name === type)?.replacement ?? type));
	const all = (folder) => [...entriesOf(site, 'blueprint').keys()].filter((name) => name.startsWith(folder + '/') && name.slice(folder.length + 1).includes('/') === false);
	const of = (folder, cls) => ({ cls, blueprints: entries === false && own?.startsWith(folder + '/') ? [own] : all(folder) });
	const kinds = { pages: 'Page', files: 'File', users: 'User' };
	const model = own === 'site' ? { cls: 'Site', blueprints: ['site'] } : kinds[own?.split('/')[0]] ? { cls: kinds[own.split('/')[0]], blueprints: [own] } : null;

	return {
		kirby: { cls: 'App' },
		site: { cls: 'Site', blueprints: ['site'] },
		...(model === null ? {} : { model }),
		page: of('pages', 'Page'),
		file: of('files', 'File'),
		user: of('users', 'User'),
		users: { cls: 'Users' },
		...(template === true ? { block: { cls: 'Block', blueprints: all('blocks') } } : {}),
	};
}

/**
 * The methods a query class has besides Kirby's own: those of plugins and the config
 * (`pageMethods` …) and, for a page of one blueprint, those of its model
 * @param {import('./query.js').QueryType} type
 * @param {string} site
 * @returns {{ name: string, params: string, returns?: string, description?: string, origin: string }[]}
 */
function queryExtras(type, site) {
	const kind = { Page: 'pageMethods', Site: 'siteMethods', Field: 'fieldMethods', Block: 'blockMethods' }[type.cls];
	const methods = kind === undefined ? [] : [...entriesOf(site, kind)].map(([name, entry]) => {
		const info = cached(`closure:${entry.file}:${entry.line}`, () => closureInfo(entry));

		// Field methods get the field as their first parameter
		const params = kind === 'fieldMethods' ? (info?.params ?? '').split(',').slice(1).join(',').trim() : info?.params ?? '';
		return { name, params, returns: info?.returns, description: info?.description, origin: origin(entry, site), entry };
	});

	const model = type.cls === 'Page' && type.blueprints?.length === 1 ? cached('models:' + site, () => listModels(site)).get(type.blueprints[0].slice('pages/'.length)) : undefined;

	if (model !== undefined) {
		const file = path.relative(path.dirname(site), model.file);
		const info = cached(`class:${model.file}`, () => classInfo(model.file, model.className));
		const entry = (line) => ({ file: model.file, line, source: /** @type {const} */ ('site') });

		methods.push(...(info?.methods ?? []).map((method) => ({ ...method, origin: `model · ${file}`, entry: entry(method.line) })));

		// Methods only documented with @method (parent() returning the parent's model); fields are listed from the blueprint
		for (const method of info?.documented ?? []) {
			if (/Field$/.test(method.returns) === false && methods.some(({ name }) => name.toLowerCase() === method.name.toLowerCase()) === false) {
				methods.push({ ...method, origin: `@method · ${file}`, entry: entry(method.line) });
			}
		}
	}

	return methods;
}

/**
 * The query type a PHP type is: a query class (`Pages`), or the class of a page model
 * (`ProjectsPage`), which is a page with the fields of its blueprint
 * @param {string | undefined} returns
 * @param {string} site
 * @returns {import('./query.js').QueryType | null}
 */
function typeOfReturns(returns, site) {
	if (classOf(returns) !== null) {
		return { cls: classOf(returns) };
	}

	const name = (returns ?? '').split('|').map((part) => part.replace(/^\?/, '').split('\\').pop()).find((part) => part !== '' && part !== 'null');
	const template = [...cached('models:' + site, () => listModels(site))].find(([, model]) => model.className === name)?.[0];

	return template === undefined ? null : { cls: 'Page', blueprints: entriesOf(site, 'blueprint').has('pages/' + template) ? ['pages/' + template] : null };
}

/**
 * The type a query chain leads to: its first name is one of the roots (or a function like `page("id")`)
 * @param {{ names: string[], args: (string | null)[] }} chain
 * @param {Record<string, import('./query.js').QueryType>} roots
 * @param {string} site
 * @returns {import('./query.js').QueryType | null}
 */
function queryType(chain, roots, site) {
	const functions = { page: 'Page', file: 'File', user: 'User' };
	let type = chain.args[0] === null ? roots[chain.names[0]] ?? null : functions[chain.names[0]] ? { cls: functions[chain.names[0]] } : null;

	for (let i = 1; i < chain.names.length && type !== null; i++) {
		type = queryStep(type, chain.names[i], chain.args[i], site);
	}

	return type ?? null;
}

/**
 * What the name under the cursor in a query refers to, for Go to Definition and hover:
 * the blueprint of a root (`page`), a field's key in the blueprint, a method of a plugin, the
 * config or the model, or a method in Kirby's source (in the project's `kirby` folder)
 * @param {TextDocument} document
 * @param {number} offset
 * @param {string} site
 * @returns {{ name: { kind: 'member', name: string, start: number, end: number }, entry: import('./project.js').Entry & { markdown: string } } | null}
 */
function queryTarget(document, offset, site) {
	const at = queryNameAt(document.getText(), offset);

	if (at === null) {
		return null;
	}

	const roots = queryRoots(document, site, at.template, offset);
	const name = { kind: /** @type {const} */ ('member'), name: at.name, start: at.start, end: at.end };
	const same = (candidate) => candidate.toLowerCase() === at.name.toLowerCase();

	// A root: the blueprint it comes from
	if (at.names.length === 0) {
		const blueprint = roots[at.name]?.blueprints?.length === 1 ? entriesOf(site, 'blueprint').get(roots[at.name].blueprints[0]) : undefined;
		return blueprint === undefined ? null : { name, entry: { ...blueprint, markdown: `**${at.name}** · ${origin(blueprint, site)}` } };
	}

	const type = queryType(at, roots, site);

	if (type === null) {
		return null;
	}

	const extra = queryExtras(type, site).find((method) => same(method.name));

	if (extra !== undefined) {
		return { name, entry: { ...extra.entry, markdown: describeMethod(extra) } };
	}

	const method = queryMethods(type.cls).find((candidate) => same(candidate.name));

	if (method !== undefined) {
		const file = path.join(path.dirname(site), 'kirby', method.file);
		let line = -1;

		try {
			line = fs.readFileSync(file, 'utf8').split('\n').findIndex((row) => row.includes(`function ${method.name}(`));
		} catch {
			// no Kirby folder next to the site
		}

		return line === -1 ? null : { name, entry: { file, line, source: 'kirby', markdown: describeMethod({ ...method, origin: 'Kirby core' }) } };
	}

	// A field of the blueprint
	for (const blueprint of hasFields(type.cls) ? type.blueprints ?? [] : []) {
		const location = fieldLocation(blueprint, at.name, site);

		if (location !== null) {
			return { name, entry: { ...location, markdown: `**${at.name}** · ${origin(location, site)}` } };
		}
	}

	return null;
}

/**
 * What a name returns on a query type: a method of Kirby, a plugin or the model, else
 * (on pages, files, users, the site and blocks) a field
 * @param {import('./query.js').QueryType} type
 * @param {string} name
 * @param {string | null} args
 * @param {string} site
 * @returns {import('./query.js').QueryType | null}
 */
function queryStep(type, name, args, site) {
	const extra = queryExtras(type, site).find((method) => method.name.toLowerCase() === name.toLowerCase());

	if (extra !== undefined) {
		return typeOfReturns(extra.returns, site);
	}

	// kirby.collection("name"): what the collection's closure returns
	if (type.cls === 'App' && name === 'collection') {
		const collection = entriesOf(site, 'collection').get(args?.match(/^\s*["']([^"']+)["']/)?.[1]);
		const info = collection === undefined ? null : cached(`closure:${collection.file}:${collection.line}`, () => closureInfo(collection));
		return classOf(info?.returns) === null ? null : { cls: classOf(info.returns) };
	}

	const method = queryMethods(type.cls).find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());

	if (method !== undefined) {
		return method.type === null ? null : { cls: method.type };
	}

	return hasFields(type.cls) === true ? { cls: 'Field' } : null;
}

/**
 * Completion in Kirby's query language in blueprints: in `query:`, `parent:` and `fetch:`,
 * and in `{{ … }}`. Follows the chain up to the cursor (`page.children.first.`) and offers
 * the fields (from the blueprint) and methods of what it leads to.
 * @param {TextDocument} document
 * @param {{ line: number, character: number }} position
 * @param {string} site
 */
function queryCompletion(document, position, site) {
	const offset = document.offsetAt(position);
	const context = queryContext(document.getText(), offset);
	const chain = context === null ? null : chainAt(context.expression);

	if (chain === null) {
		return null;
	}

	const roots = queryRoots(document, site, context.template, offset);
	const range = { start: document.positionAt(offset - chain.prefix.length), end: position };
	const item = (label, kind, detail, documentation, sortText) => ({ label, kind, detail, documentation, filterText: label, sortText, textEdit: { range, newText: label } });

	if (chain.names.length === 0) {
		return Object.entries(QUERY_ROOTS)
			.filter(([name]) => roots[name] !== undefined || ['collection', 't', 'item'].includes(name) && (name !== 'item' || context.template))
			.map(([name, description], index) => item(name, CompletionItemKind.Variable, roots[name]?.cls, description, String(index).padStart(2, '0')));
	}

	const type = queryType(chain, roots, site);

	if (type === null) {
		return [];
	}

	const fields = fieldsOf(hasFields(type.cls) ? type.blueprints ?? [] : [], site);

	// In a query, a method without arguments is written without brackets: show just what it returns
	const signature = (method) => method.params === '' ? method.returns ?? '' : `(${method.params})${method.returns === undefined ? '' : ': ' + method.returns}`;
	const extras = queryExtras(type, site);

	// A method of the model, a plugin or the config wins over Kirby's and over a field of the same name
	const overridden = new Set(extras.map(({ name }) => name.toLowerCase()));

	return [
		...[...fields.values()].filter(({ name }) => overridden.has(name.toLowerCase()) === false).map((field) => item(field.name, CompletionItemKind.Field, `${field.type} · ${field.blueprints.join(', ')}`, field.label, '0' + field.name)),
		...extras.map((method) => item(method.name, CompletionItemKind.Method, [signature(method), method.origin].filter(Boolean).join(' · '), method.description, '1' + method.name)),
		...queryMethods(type.cls).filter(({ name }) => overridden.has(name.toLowerCase()) === false).map((method) => item(method.name, CompletionItemKind.Method, signature(method), method.description, '2' + method.name)),
	];
}

/**
 * Completion for the keys of a field: the options of its type (from `type`, what it
 * extends, or its name), without those it already has. Without a known type, `type` and `extends`.
 * @param {TextDocument} document
 * @param {{ line: number, character: number }} position
 * @param {string} site
 */
function propertyCompletion(document, position, site) {
	const context = propertyContext(document.getText(), document.offsetAt(position), partialName(document, site));

	if (context === null) {
		return null;
	}

	const type = typeOfField(context, site);
	const options = [
		{ name: 'type', type: 'string', description: 'The field type' },
		{ name: 'extends', type: 'string', description: 'A blueprint whose props this field takes over' },
		...fieldProperties(type) ?? [],
	];
	const range = { start: document.positionAt(context.start), end: position };

	return options.filter(({ name }) => context.present.includes(name) === false).map((option, index) => ({
		label: option.name,
		kind: CompletionItemKind.Property,
		detail: option.default === undefined ? option.type : `${option.type} = ${shorten(option.default)}`,
		documentation: option.description === undefined ? undefined : { kind: MarkupKind.Markdown, value: option.description },
		filterText: option.name,
		sortText: String(index).padStart(3, '0'),
		textEdit: { range, newText: option.name + ': ' },
	}));
}

/**
 * Completion for a blueprint name after `extends:` or in the shorthand `seo: fields/seo`.
 * Blueprints of the folder that fits (e.g. `fields/` for a field) come first.
 * @param {TextDocument} document
 * @param {{ line: number, character: number }} position
 * @param {string} site
 */
function extendsCompletion(document, position, site) {
	const context = extendsContext(document.getText(), document.offsetAt(position));

	if (context === null) {
		return null;
	}

	const blueprints = entriesOf(site, 'blueprint');
	const range = { start: document.positionAt(context.start), end: position };

	// At the top of a blueprint, its own folder fits: pages/… in pages/project.yml
	const folder = context.folder ?? ownFolder(document, site);

	return [...blueprints].map(([name, entry]) => ({
		label: name,
		kind: CompletionItemKind.File,
		detail: origin(entry, site),
		filterText: name,
		sortText: (name.startsWith(folder + '/') ? '0' : '1') + (entry.source === 'kirby' ? '1' : '0') + name,
		textEdit: { range, newText: name },
	}));
}

/**
 * The name of the blueprint a document is, e.g. `pages/project`
 * @param {TextDocument} document
 * @param {string} site
 * @returns {string | null}
 */
function ownName(document, site) {
	const file = fileURLToPath(document.uri);
	return [...entriesOf(site, 'blueprint')].find(([, entry]) => entry.file === file)?.[0] ?? null;
}

/**
 * The field's name if a document is a field partial (`fields/writer.yml`), whose top-level keys are the field's own
 * @param {TextDocument} document
 * @param {string} site
 */
function partialName(document, site) {
	const name = ownName(document, site);
	return name?.startsWith('fields/') ? name.slice('fields/'.length) : null;
}

/**
 * The folder of the blueprint a document is, e.g. `pages` for `pages/project.yml`
 * @param {TextDocument} document
 * @param {string} site
 * @returns {string | null}
 */
function ownFolder(document, site) {
	const name = ownName(document, site);
	return name?.includes('/') ? name.split('/')[0] : null;
}

/**
 * The fields defined at the top of a blueprint, for references in `fields: [intro]`.
 * Only for the blueprints of pages, files, users and the site: a partial like
 * `tabs/seo.yml` gets them from the blueprint that uses it. Null where unknown.
 * @param {TextDocument} document
 * @param {string} site
 */
function definitionsOf(document, site) {
	const name = ownName(document, site);
	const isModel = name === 'site' || ['pages', 'files', 'users'].includes(name?.split('/')[0]);

	return isModel ? fieldDefinitions(document.getText(), blueprintFinder(site)) : null;
}

/**
 * The block types `fieldsets` can name: the names of the `blocks/*` blueprints
 * @param {string} site
 * @returns {Map<string, import('./project.js').Entry>}
 */
function blockTypesOf(site) {
	return new Map([...entriesOf(site, 'blueprint')].filter(([name]) => /^blocks\/[^/]+$/.test(name)).map(([name, entry]) => [name.slice(7), entry]));
}

/**
 * Completion in a list item of `fields` (the fields defined at the top) or of `fieldsets` (block types)
 * @param {TextDocument} document
 * @param {{ line: number, character: number }} position
 * @param {string} site
 */
function listItemCompletion(document, position, site) {
	const context = listItemContext(document.getText(), document.offsetAt(position));

	if (context === null) {
		return null;
	}

	const range = { start: document.positionAt(context.start), end: position };
	const item = (label, detail, sortText) => ({ label, kind: CompletionItemKind.Reference, detail, filterText: label, sortText, textEdit: { range, newText: label } });

	if (context.list === 'fieldsets') {
		return [...blockTypesOf(site)].map(([name, entry]) => item(name, origin(entry, site), (entry.source === 'kirby' ? '1' : '0') + name));
	}

	const definitions = definitionsOf(document, site);
	return definitions === null ? null : [...definitions.keys()].map((name, index) => item(name, 'defined at the top', String(index).padStart(3, '0')));
}

/**
 * Warnings for references to fields that aren't defined at the top of the blueprint,
 * and for block types in `fieldsets` without a blueprint
 * @param {TextDocument} document
 * @param {string} site
 */
function referenceDiagnostics(document, site) {
	const diagnostics = [];
	const warn = (start, end, message, severity = DiagnosticSeverity.Warning) => diagnostics.push({ severity, range: { start: document.positionAt(start), end: document.positionAt(end) }, message, source: 'Kirby' });
	const definitions = definitionsOf(document, site);

	for (const reference of definitions === null ? [] : fieldReferences(document.getText())) {
		if (definitions.has(reference.name) === false) {
			warn(reference.start, reference.end, `Field “${reference.name}” isn’t defined in the top-level fields.`);
		}
	}

	const { blueprints, complete } = blueprintsOf(site);

	for (const reference of fieldsetReferences(document.getText())) {
		if (reference.inline !== true && blueprints.has(reference.blueprint) === false) {
			const message = `Block type “${reference.name}” has no blueprint.`;
			warn(reference.start, reference.end, complete ? message : message + ' (a plugin may add it)', complete ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information);
		}
	}

	return diagnostics;
}

/**
 * The template slots of a blueprint
 * @param {TextDocument} document
 * @param {string} site
 */
function slotsOf(document, site) {
	return templateSlots(document.getText(), blueprintFinder(site), ownFolder(document, site) === 'files' ? 'files' : 'pages');
}

/**
 * The blueprints of a site, and whether all of them could be read
 * @param {string} site
 */
function blueprintsOf(site) {
	return cached('blueprints:' + site, () => listBlueprints(site));
}

/**
 * A function that returns the content of a blueprint by name, for following `extends`
 * @param {string} site
 * @returns {(name: string) => Record<string, any> | null}
 */
function blueprintFinder(site) {
	const blueprints = entriesOf(site, 'blueprint');

	return (name) => {
		const entry = blueprints.get(name);
		return entry === undefined ? null : cached(`blueprint-content:${entry.file}:${entry.line}`, () => readBlueprint(entry));
	};
}

/**
 * @typedef {{ blueprint?: import('./project.js').Entry, template?: import('./project.js').Entry }} Template
 */

/**
 * The template names of a site with what defines them: for `pages` the page
 * blueprints and the templates in `site/templates` (or of plugins); for `files` the file blueprints
 * @param {string} site
 * @param {'pages' | 'files'} folder
 * @returns {Map<string, Template>}
 */
function templatesOf(site, folder) {
	return cached(`templates-${folder}:${site}`, () => {
		const templates = new Map();

		for (const [name, blueprint] of entriesOf(site, 'blueprint')) {
			const template = name.slice(folder.length + 1);

			if (name.startsWith(folder + '/') === true && template.includes('/') === false) {
				templates.set(template, { blueprint });
			}
		}

		if (folder === 'pages') {
			for (const [name, template] of listTemplates(site)) {
				templates.set(name, { ...templates.get(name), template });
			}
		}

		return templates;
	});
}

/**
 * What to open and describe for a template: its blueprint, else its template file
 * @param {Template | undefined} template
 */
function templateEntry(template) {
	return template?.blueprint ?? template?.template;
}

// Page templates Kirby uses without a blueprint or template file of their own: the error page
const KNOWN_TEMPLATES = ['error'];

/**
 * Completion items for template names
 * @param {Map<string, Template>} templates
 * @param {string} site
 * @param {{ start: import('vscode-languageserver').Position, end: import('vscode-languageserver').Position }} range
 * @param {string} [order] sorts the names before the others (`0` or `1`)
 */
function templateItems(templates, site, range, order = '0') {
	return [...templates].map(([name, template]) => ({
		label: name,
		kind: CompletionItemKind.File,
		detail: origin(templateEntry(template), site),
		documentation: { kind: MarkupKind.Markdown, value: describe('template', name, templateEntry(template), site) },
		filterText: name,
		// Kirby's own defaults last
		sortText: order + (templateEntry(template).source === 'kirby' ? '1' : '0') + name,
		textEdit: { range, newText: name },
	}));
}

/**
 * The template slot at a position in a blueprint, if there is one
 * @param {TextDocument} document
 * @param {number} offset
 * @param {string} site
 */
function templateSlotAt(document, offset, site) {
	return slotsOf(document, site).find(({ start, end }) => offset >= start && offset <= end) ?? null;
}

/**
 * Completion for a template name in a blueprint: `template:` of a pagelist and so on
 * @param {TextDocument} document
 * @param {{ line: number, character: number }} position
 * @param {string} site
 */
function templateCompletion(document, position, site) {
	const slot = templateSlotAt(document, document.offsetAt(position), site);

	if (slot === null) {
		return null;
	}

	return templateItems(templatesOf(site, slot.folder), site, { start: document.positionAt(slot.start), end: position });
}

/**
 * The translation keys of a site, with their texts per language
 * @param {string} site
 */
function translationsOf(site) {
	return cached('translation:' + site, () => listTranslations(site));
}

/**
 * The snippets, collections, translations, templates, blueprints or methods of a site, by name
 * @param {string} site
 * @param {import('./calls.js').Kind | 'blueprint' | 'pageMethods' | 'siteMethods' | 'fieldMethods' | 'blockMethods'} kind
 * @returns {Map<string, any>}
 */
function entriesOf(site, kind) {
	// Own translations win over Kirby's
	if (kind === 'translation') {
		return cached('translation-all:' + site, () => {
			const { translations, kirby } = translationsOf(site);
			return new Map([...kirby, ...translations]);
		});
	}

	if (kind === 'blueprint') {
		return blueprintsOf(site).blueprints;
	}

	if (kind.endsWith('Methods') === true) {
		return cached(kind + ':' + site, () => listMethods(site, kind));
	}

	// Page and file templates; for pages the template file wins (it's what PHP code is about)
	if (kind === 'template') {
		return cached('template:' + site, () => new Map([
			...[...templatesOf(site, 'files')].map(([name, { blueprint }]) => [name, blueprint]),
			...[...templatesOf(site, 'pages')].map(([name, template]) => [name, template.template ?? templateEntry(template)]),
		]));
	}

	return cached(kind + ':' + site, () => kind === 'snippet' ? listSnippets(site) : listCollections(site));
}

/**
 * The texts of a translation, the default language first
 * @param {import('./project.js').Translation} translation
 * @param {string} site
 * @returns {[string, string][]}
 */
function textsOf(translation, site) {
	const order = translationsOf(site).languages;
	return [...translation.values].sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
}

/**
 * Shortens long code for a one-line detail
 * @param {string} code
 */
function shorten(code) {
	return code.length > 40 ? code.slice(0, 39) + '…' : code;
}

/**
 * Where an entry comes from, for humans
 * @param {import('./project.js').Entry} entry
 * @param {string} site
 */
function origin(entry, site) {
	const file = path.relative(path.dirname(site), entry.file);

	return {
		site: file,
		plugin: `plugin ${entry.plugin} · ${file}`,
		config: `config · ${file}`,
		kirby: 'Kirby core',
	}[entry.source];
}

/**
 * Markdown for a snippet or collection: its origin and what it expects or returns
 * @param {import('./calls.js').Kind | 'blueprint' | 'variable' | 'field' | 'member'} kind
 * @param {string} name
 * @param {import('./project.js').Entry & { value?: string, markdown?: string }} entry
 * @param {string} site
 */
function describe(kind, name, entry, site) {
	// Methods and fields after `->` come with their own description
	if (kind === 'member') {
		return entry.markdown;
	}

	// The entry of a controller variable carries its value
	if (kind === 'variable') {
		return `**$${name}** · ${origin(entry, site)}\n\n\`\`\`php\n'${name}' => ${entry.value}\n\`\`\``;
	}

	if (kind === 'template') {
		const page = templatesOf(site, 'pages').get(name);
		const file = templatesOf(site, 'files').get(name);
		const places = [['blueprint', page?.blueprint], ['template', page?.template], ['file blueprint', file?.blueprint]];

		return [`**${name}**`, '', ...places.filter(([, place]) => place !== undefined).map(([label, place]) => `- ${label}: ${origin(place, site)}`)].join('\n');
	}

	const lines = [`**${name}** · ${origin(entry, site)}`];

	if (kind === 'asset' || kind === 'blueprint' || kind === 'field') {
		return lines.join('\n');
	}

	if (kind === 'translation') {
		lines.push('', ...textsOf(entry, site).map(([language, text]) => `- ${language}: ${text || '(empty)'}`));
		return lines.join('\n');
	}

	const code = kind === 'snippet' ? snippetProps(entry.file) : [collectionSignature(entry)].filter(Boolean);

	if (code.length > 0) {
		lines.push('', '```php', ...code, '```');
	}

	return lines.join('\n');
}

/**
 * Where a field of a blueprint is defined: in the blueprint itself, or in one it extends
 * (a tab, a field partial …), followed through the blueprints they extend in turn
 * @param {string} name the blueprint, e.g. `pages/project`
 * @param {string} field
 * @param {string} site
 * @param {Set<string>} [seen]
 * @returns {import('./project.js').Entry | null}
 */
function fieldLocation(name, field, site, seen = new Set()) {
	const entry = entriesOf(site, 'blueprint').get(name);

	if (entry === undefined || entry.inline === true || seen.has(name) === true) {
		return null;
	}

	seen.add(name);

	let text;

	try {
		text = fs.readFileSync(entry.file, 'utf8');
	} catch {
		return null;
	}

	const offset = fieldKeyOffset(text, field);

	if (offset !== -1) {
		return { file: entry.file, line: text.slice(0, offset).split('\n').length - 1, source: entry.source, plugin: entry.plugin };
	}

	for (const reference of blueprintReferences(text)) {
		const found = fieldLocation(reference.name, field, site, seen);

		if (found !== null) {
			return found;
		}
	}

	return null;
}

/**
 * Markdown for a method: its signature, description and origin
 * @param {{ name: string, params: string, returns?: string, description?: string, origin?: string }} method
 */
function describeMethod(method) {
	const signature = `${method.name}(${method.params})${method.returns === undefined ? '' : ': ' + method.returns}`;
	return ['```php', signature, '```', method.description, method.origin].filter((line) => line !== undefined).join('\n');
}

/**
 * What `$page->name(` (or `$site`, `$block`, `$this`) or `$page->field()->name(` refers to:
 * a method of a plugin, the config or the page's model (methods win, as in PHP),
 * a field of the blueprint, or a field method (a plugin's, or Kirby's own in its source)
 * @param {TextDocument} document
 * @param {NonNullable<ReturnType<typeof memberAt>>} member
 * @param {string} site
 * @returns {(import('./project.js').Entry & { markdown: string }) | undefined}
 */
function memberEntry(document, member, site) {
	const file = fileURLToPath(document.uri);
	const same = (name) => name.toLowerCase() === member.name.toLowerCase();

	if (member.field !== undefined) {
		const field = [...fieldsFor(member.variable, file, site).values()].find(({ name }) => name.toLowerCase() === member.field.toLowerCase());
		const custom = field === undefined ? undefined : [...entriesOf(site, 'fieldMethods')].find(([name]) => same(name));

		if (custom !== undefined) {
			const info = cached(`closure:${custom[1].file}:${custom[1].line}`, () => closureInfo(custom[1]));
			const params = (info?.params ?? '').split(',').slice(1).join(',').trim();
			return { ...custom[1], markdown: describeMethod({ name: custom[0], params, returns: info?.returns, description: info?.description, origin: origin(custom[1], site) }) };
		}

		// Kirby's own field methods, in Kirby's source if it's there
		const core = field === undefined ? undefined : fieldMethods().find(({ name }) => same(name));
		const source = path.join(path.dirname(site), 'kirby', 'src', 'Content', 'FieldMethods.php');
		const line = core === undefined ? -1 : cached('field-methods-source:' + source, () => {
			try {
				return fs.readFileSync(source, 'utf8').split('\n');
			} catch {
				return [];
			}
		}).findIndex((row) => row.includes(`public function ${core.name}(`));

		return line === -1 ? undefined : { file: source, line, source: 'kirby', markdown: describeMethod({ ...core, origin: 'Kirby core' }) };
	}

	const method = methodsFor(member.variable, file, site).find(({ name }) => same(name));

	if (method !== undefined) {
		return { ...method.entry, markdown: describeMethod(method) };
	}

	const field = [...fieldsFor(member.variable, file, site).values()].find(({ name }) => same(name));
	const location = field === undefined ? null : field.blueprints.map((name) => fieldLocation(name, field.name, site)).find((found) => found !== null) ?? null;

	if (location === null) {
		return undefined;
	}

	const markdown = [`**${field.name}** · ${field.type} · ${field.blueprints.join(', ')}`, field.label, origin(location, site)].filter((line) => line !== undefined).join('\n\n');
	return { ...location, markdown };
}

/**
 * Where the model of a page documents a field of its blueprint: its `@method` line, or a
 * method of the same name (which wins over the field). Only in page blueprints themselves.
 * @param {TextDocument} document the blueprint
 * @param {string} field
 * @param {string} site
 * @returns {import('./project.js').Entry | undefined}
 */
function modelDocEntry(document, field, site) {
	const own = ownName(document, site);
	const model = own?.startsWith('pages/') ? cached('models:' + site, () => listModels(site)).get(own.slice('pages/'.length)) : undefined;
	const info = model === undefined ? null : classInfo(model.file, model.className);
	const same = ({ name }) => name.toLowerCase() === field.toLowerCase();
	const line = info?.documented.find(same)?.line ?? info?.methods.find(same)?.line;

	return line === undefined ? undefined : { file: model.file, line, source: 'site' };
}

/**
 * The site and the name at a position, with what it refers to
 * @param {{ uri: string }} textDocument
 * @param {{ line: number, character: number }} position
 */
function lookup(textDocument, position) {
	const document = documents.get(textDocument.uri);
	const offset = document?.offsetAt(position);
	const site = document !== undefined && isCode(document, offset) === true ? siteFor(document.uri) : null;
	const blueprint = site !== null && isBlueprint(document) === true;
	const covers = ({ start, end }) => offset >= start && offset <= end;
	const fieldset = blueprint ? fieldsetReferences(document.getText()).find(covers) ?? null : null;
	const reference = blueprint ? referenceAt(document.getText(), offset) ?? (fieldset === null ? null : { ...fieldset, name: fieldset.blueprint }) : null;
	const field = blueprint && reference === null ? fieldReferences(document.getText()).find(covers) ?? null : null;
	const slot = blueprint && reference === null ? templateSlotAt(document, offset, site) : null;
	let name = site === null ? null : nameAt(document.getText(), offset);
	let entry;

	if (reference !== null) {
		name = { kind: 'blueprint', ...reference };

		// A block type defined right in fieldsets, or without blueprint: the snippet that renders it
		const snippet = fieldset === null ? undefined : entriesOf(site, 'snippet').get(fieldset.blueprint);
		entry = fieldset?.inline === true ? snippet : entriesOf(site, 'blueprint').get(reference.name) ?? snippet;
	} else if (field !== null) {
		// A field defined at the top of this blueprint
		const at = definitionsOf(document, site)?.get(field.name) ?? -1;
		name = { kind: 'field', ...field };
		entry = at === -1 ? undefined : { file: fileURLToPath(document.uri), line: document.positionAt(at).line, source: 'site' };
	} else if (slot?.name) {
		name = { kind: 'template', ...slot };
		entry = templateEntry(templatesOf(site, slot.folder).get(slot.name));
	} else if (blueprint === true && name === null && queryTarget(document, offset, site) !== null) {
		// A name in a query: page.children, page.teaser …
		({ name, entry } = queryTarget(document, offset, site));
	} else if (blueprint === true && name === null) {
		// A field's key: its @method line in the page's model
		const key = fieldKeyAt(document.getText(), offset);
		entry = key === null ? undefined : modelDocEntry(document, key.name, site);
		name = entry === undefined ? null : { kind: 'field', ...key };
	} else if (name !== null) {
		entry = name.kind === 'asset' ? assetEntry(site, name.name) : entriesOf(site, name.kind).get(name.name);
	} else if (site !== null) {
		// A method or field: $page->name(), $page->field()->name()
		const member = memberAt(document.getText(), offset);
		entry = member === null ? undefined : memberEntry(document, member, site);

		if (entry !== undefined) {
			name = { kind: 'member', ...member };
		}

		// A variable in a template that its controller returns
		const variable = entry === undefined ? variableAt(document.getText(), offset) : null;
		const found = variable === null ? undefined : templateVariables(fileURLToPath(document.uri), site)?.variables.get(variable.name);

		if (found !== undefined) {
			name = { kind: 'variable', ...variable };
			entry = found.entry;
		}
	}

	return entry === undefined ? null : { document, site, name, entry };
}

/**
 * Whether a document is a blueprint (a YAML file)
 * @param {TextDocument} document
 */
function isBlueprint(document) {
	return /\.ya?ml$/.test(document.uri);
}

/**
 * Whether a position is somewhere the server has something to say: in a blueprint
 * anywhere, in a PHP file only in its PHP code, not in its HTML
 * @param {TextDocument} document
 * @param {number} offset
 */
function isCode(document, offset) {
	return isBlueprint(document) === true || isInPhp(document.getText(), offset) === true;
}

/**
 * The text to look for calls in: a blueprint as it is, of a PHP file only its PHP code
 * (the HTML around it blanked out, so offsets stay the same)
 * @param {TextDocument} document
 */
function codeOf(document) {
	return isBlueprint(document) === true ? document.getText() : phpOnly(document.getText());
}

/**
 * Warns about blueprints that `extends` or the shorthand `seo: fields/seo` refer to and that don't exist
 * @param {TextDocument} document
 * @param {string} site
 */
function blueprintDiagnostics(document, site) {
	const { blueprints, complete } = blueprintsOf(site);

	return blueprintReferences(document.getText()).filter(({ name }) => blueprints.has(name) === false).map((reference) => {
		let message = `Blueprint “${reference.name}” not found.`;

		// `intro: textarea` isn't a type shorthand; Kirby takes the field name as type
		if (reference.shorthand === true && isFieldType(reference.name) === true) {
			message += ` Did you mean “type: ${reference.name}”?`;
		}

		// A plugin we couldn't read may register it
		if (complete === false) {
			message += ' (a plugin may add it)';
		}

		return {
			severity: complete === true ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
			range: { start: document.positionAt(reference.start), end: document.positionAt(reference.end) },
			message,
			source: 'Kirby',
		};
	});
}

/**
 * A warning for a page template that doesn't exist, only a hint if a plugin registers
 * blueprints in a way that couldn't be read. A file template without a blueprint is
 * only a hint, too: Kirby then uses `files/default`.
 * @param {TextDocument} document
 * @param {string} site
 * @param {{ name: string, start: number, end: number }} name
 * @param {'pages' | 'files' | null} folder null for PHP code, where it's not clear whether it's about pages or files
 */
function templateDiagnostic(document, site, { name, start, end }, folder) {
	const message = {
		files: `File template “${name}” has no blueprint.`,
	}[folder] ?? `Template “${name}” not found.`;
	const { complete } = blueprintsOf(site);

	return {
		severity: complete === true && folder !== 'files' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
		range: { start: document.positionAt(start), end: document.positionAt(end) },
		message: complete === true ? message : message + ' (a plugin may add it)',
		source: 'Kirby',
	};
}

/**
 * Warns about calls whose snippet, collection, translation, template or file doesn't exist,
 * and in blueprints about missing blueprints
 * @param {TextDocument} document
 */
function validate(document) {
	const site = siteFor(document.uri);

	// Kirby's own files are not checked
	if (site === null || fileURLToPath(document.uri).startsWith(path.join(path.dirname(site), 'kirby') + path.sep)) {
		return;
	}

	const diagnostics = [];

	for (const call of findCalls(codeOf(document))) {
		let severity = DiagnosticSeverity.Warning;

		// Every template of a list must exist
		if (call.kind === 'template') {
			const templates = entriesOf(site, 'template');
			diagnostics.push(...call.names.filter(({ name }) => templates.has(name) === false && KNOWN_TEMPLATES.includes(name) === false).map((name) => templateDiagnostic(document, site, name, null)));
			continue;
		}

		const exists = call.kind === 'asset'
			? findAsset(site, call.names[0].name) !== null
			: call.names.some(({ name }) => entriesOf(site, call.kind).has(name));

		if (exists === true) {
			continue;
		}

		const list = call.names.map(({ name }) => `“${name}”`).join(', ');
		let message;

		if (call.kind === 'translation') {
			const { kirby, complete } = translationsOf(site);

			// Kirby's own keys, and t()/tt() with a fallback text, are fine
			if (kirby.has(call.names[0].name) === true || (call.fn !== 'tc' && call.more === true)) {
				continue;
			}

			message = `Translation ${list} not found.`;

			// Some plugins load translations at runtime; then this is only a hint
			if (complete === false) {
				message += ' (a plugin may add it)';
				severity = DiagnosticSeverity.Information;
			}
		} else if (call.kind === 'collection') {
			message = `Collection ${list} not found.`;
		} else if (call.kind === 'asset') {
			message = `File ${list} not found.`;
		} else {
			message = call.names.length === 1 ? `Snippet ${list} not found.` : `None of the snippets ${list} found.`;
		}

		diagnostics.push({
			severity,
			range: {
				start: document.positionAt(call.names[0].start),
				end: document.positionAt(call.names.at(-1).end),
			},
			message,
			source: 'Kirby',
		});
	}

	diagnostics.push(...varDocDiagnostics(document, site), ...modelDiagnostics(document, site));

	if (isBlueprint(document) === true) {
		diagnostics.push(...blueprintDiagnostics(document, site), ...referenceDiagnostics(document, site));

		for (const slot of slotsOf(document, site)) {
			if (slot.name && templatesOf(site, slot.folder).has(slot.name) === false && (slot.folder === 'files' || KNOWN_TEMPLATES.includes(slot.name) === false)) {
				diagnostics.push(templateDiagnostic(document, site, slot, slot.folder));
			}
		}
	}

	connection.sendDiagnostics({ uri: document.uri, diagnostics });
}

/**
 * Validates shortly after typing stops
 * @param {TextDocument} document
 */
function scheduleValidation(document) {
	clearTimeout(validationTimers.get(document.uri));
	validationTimers.set(document.uri, setTimeout(() => validate(document), 300));
}

connection.onInitialize((params) => {
	workspaceFolders = (params.workspaceFolders ?? [])
		.map((folder) => folder.uri)
		.concat(params.rootUri ? [params.rootUri] : [])
		.filter((uri) => uri.startsWith('file:'))
		.map((uri) => fileURLToPath(uri));

	workspaceFolders = [...new Set(workspaceFolders)];
	definitionLinks = params.capabilities?.textDocument?.definition?.linkSupport === true;

	// Limiting to some languages needs registering at runtime
	const dynamic = params.capabilities?.textDocument?.definition?.dynamicRegistration === true && params.capabilities?.textDocument?.hover?.dynamicRegistration === true;
	navigation = dynamic && Array.isArray(params.initializationOptions?.navigation) ? params.initializationOptions.navigation : null;

	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// A space for `type: ` in blueprints, `>` for `$page->`, `$` for variables
			completionProvider: { triggerCharacters: ['\'', '"', '/', ' ', '>', '$'] },
			definitionProvider: navigation === null,
			hoverProvider: navigation === null,
			codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
		},
	};
});

connection.onInitialized(() => {
	connection.console.log(`Kirby sites: ${allSites().join(', ') || 'none found'}`);

	// Requests for other languages still get an answer, e.g. from Nova's Open Referenced File
	if (navigation !== null) {
		const documentSelector = navigation.map((language) => ({ language }));
		connection.client.register(DefinitionRequest.type, { documentSelector });
		connection.client.register(HoverRequest.type, { documentSelector });
	}
});

connection.onCompletion(({ textDocument, position }) => {
	const document = documents.get(textDocument.uri);

	// Nothing to offer in the HTML of a template
	const site = document !== undefined && isCode(document, document.offsetAt(position)) === true ? siteFor(document.uri) : null;

	if (site !== null && isBlueprint(document) === true) {
		// `create:` of a pagelist takes templates or false
		const templates = templateCompletion(document, position, site);
		const values = valueCompletion(document, position, site);
		const both = templates === null && values === null ? null : [...templates ?? [], ...values ?? []];
		const items = typeCompletion(document, position) ?? queryCompletion(document, position, site) ?? extendsCompletion(document, position, site) ?? both ?? listItemCompletion(document, position, site) ?? propertyCompletion(document, position, site);

		if (items !== null) {
			return items;
		}
	}

	const fields = site ? fieldMethodCompletion(document, position, site) ?? fieldCompletion(document, position, site) ?? variableCompletion(document, position, site) : null;

	if (fields !== null) {
		return fields;
	}

	// Keys of the data array: snippet('m-card', ['▮
	const props = site ? propsContext(document.getText(), document.offsetAt(position)) : null;

	if (props !== null) {
		const snippets = entriesOf(site, 'snippet');
		const snippet = props.names.map((name) => snippets.get(name)).find((entry) => entry !== undefined);
		const range = { start: document.positionAt(props.start), end: position };

		return snippet === undefined ? [] : snippetVariables(snippet.file).filter(({ name }) => SNIPPET_GLOBALS.has(name) === false).map((variable, index) => ({
			label: variable.name,
			kind: CompletionItemKind.Property,
			detail: [variable.type, variable.default === undefined ? undefined : `= ${shorten(variable.default)}`].filter(Boolean).join(' '),
			documentation: variable.default === undefined ? undefined : { kind: MarkupKind.Markdown, value: '```php\n$' + variable.name + ' ??= ' + variable.default + ';\n```' },
			sortText: String(index).padStart(3, '0'),
			filterText: variable.name,
			textEdit: { range, newText: variable.name },
		}));
	}

	const context = site ? completionContext(document.getText(), document.offsetAt(position)) : null;

	if (context === null) {
		return [];
	}

	if (context.kind === 'asset') {
		return assetCompletion(document, position, site, context);
	}

	// Templates of pages, or of files for $page->files()->template('…')
	if (context.kind === 'template') {
		const range = { start: document.positionAt(context.start), end: position };
		const line = document.getText({ start: { line: position.line, character: 0 }, end: position });
		const files = /\b(?:files|images|documents|videos|audio|code)\(\)|\$\w*(?:file|image)/i.test(line);
		const pages = templateItems(templatesOf(site, 'pages'), site, range, files ? '1' : '0');
		const fileItems = templateItems(templatesOf(site, 'files'), site, range, files ? '0' : '1').filter(({ label }) => templatesOf(site, 'pages').has(label) === false);

		return [...pages, ...fileItems];
	}

	const range = { start: document.positionAt(context.start), end: position };

	return [...entriesOf(site, context.kind)].map(([name, entry]) => ({
		label: name,
		kind: { snippet: CompletionItemKind.File, collection: CompletionItemKind.Module, translation: CompletionItemKind.Text }[context.kind],
		detail: context.kind === 'translation' ? textsOf(entry, site)[0]?.[1] : origin(entry, site),
		documentation: { kind: MarkupKind.Markdown, value: describe(context.kind, name, entry, site) },
		filterText: name,
		// Kirby's own keys after the project's
		sortText: (entry.source === 'kirby' ? '1' : '0') + name,
		textEdit: { range, newText: name },
	}));
});

connection.onDefinition(({ textDocument, position }) => {
	const found = lookup(textDocument, position);

	if (found === null) {
		return null;
	}

	const uri = pathToFileURL(found.entry.file).href;
	const start = { line: found.entry.line, character: 0 };
	const target = { start, end: start };

	if (definitionLinks === false) {
		return { uri, range: target };
	}

	return [{
		originSelectionRange: {
			start: found.document.positionAt(found.name.start),
			end: found.document.positionAt(found.name.end),
		},
		targetUri: uri,
		targetRange: target,
		targetSelectionRange: target,
	}];
});

connection.onHover(({ textDocument, position }) => {
	// A field type in a blueprint: a link to its docs
	const document = documents.get(textDocument.uri);
	const type = document !== undefined && isBlueprint(document) === true ? fieldTypeAt(document.getText(), document.offsetAt(position)) : null;

	if (type !== null) {
		const deprecated = type.replacement === undefined ? '' : ` · deprecated, use \`${type.replacement}\``;

		return {
			contents: { kind: MarkupKind.Markdown, value: `**${type.name}** field${deprecated} · [Kirby docs](${type.docs})` },
			range: { start: document.positionAt(type.start), end: document.positionAt(type.end) },
		};
	}

	const found = lookup(textDocument, position);

	if (found === null) {
		return null;
	}

	return {
		contents: { kind: MarkupKind.Markdown, value: describe(found.name.kind, found.name.name, found.entry, found.site) },
		range: { start: found.document.positionAt(found.name.start), end: found.document.positionAt(found.name.end) },
	};
});

// The origin of each call above its line (editors that don't ask for hovers still show these)
connection.onCodeAction(({ textDocument, range, context }) => {
	const document = documents.get(textDocument.uri);
	const site = document ? siteFor(document.uri) : null;

	return site === null ? [] : [...modelCodeActions(document, site, range, context.diagnostics), ...varDocCodeActions(document, site, range, context.diagnostics)];
});

documents.onDidOpen(({ document }) => validate(document));
documents.onDidChangeContent(({ document }) => scheduleValidation(document));

// A saved file may be a new snippet, collection, blueprint or asset, so check all open documents again
documents.onDidSave(() => {
	cache.clear();
	documents.all().forEach(validate);
});

documents.onDidClose(({ document }) => {
	clearTimeout(validationTimers.get(document.uri));
	connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
});

documents.listen(connection);
connection.listen();
