import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
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
import { blueprintFields, blueprintReferences, extend, extendsContext, fieldDefinitions, fieldMethods, fieldProperties, fieldReferences, fieldsetReferences, fieldTypes, fittingMethods, isFieldType, listItemContext, literalValues, propertyContext, referenceAt, templateSlots, typeContext, valueContext } from './blueprints.js';
import { completionContext, fieldContext, fieldMethodContext, findCalls, nameAt, propsContext, variableAt, variableContext } from './calls.js';
import { classMethods, closureInfo, collectionSignature, controllerVariables, findAsset, findSites, listBlueprints, listCollections, listContentTemplates, listControllers, listDocroot, listMethods, listModels, listSnippets, listTemplates, listTranslations, readBlueprint, snippetProps, snippetVariables } from './project.js';
import { undefinedVariables } from './variables.js';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

/** @type {string[]} */
let workspaceFolders = [];

/** @type {string[] | null} */
let sites = null;

// Whether the editor understands LocationLink, which also names the clicked range
let definitionLinks = false;

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
	const find = blueprintFinder(site);
	const fields = new Map();

	for (const name of blueprintsForVariable(variable, file, site)) {
		const blueprint = find(name);

		for (const field of blueprint === null ? [] : cached(`fields:${site}:${name}`, () => blueprintFields(blueprint, find))) {
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
 * @returns {{ name: string, params: string, returns?: string, description?: string, origin: string }[]}
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
		return { name, params: info?.params ?? '', returns: info?.returns, description: info?.description, origin: origin(entry, site) };
	});

	const template = rest.join('/').replace(/\..*$/, '');
	const model = variable === 'page' && ['templates', 'controllers'].includes(folder) ? cached('models:' + site, () => listModels(site)).get(template) : undefined;

	if (model !== undefined) {
		const file = path.relative(path.dirname(site), model.file);
		methods.push(...cached(`model:${model.file}`, () => classMethods(model.file, model.className)).map((method) => ({ ...method, origin: `model · ${file}` })));
	}

	return methods;
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
	const methods = methodsFor(context.variable, file, site);

	// A method of the same name wins over the field
	const overridden = new Set(methods.map(({ name }) => name.toLowerCase()));
	const fields = [...fieldsFor(context.variable, file, site).values()].filter(({ name }) => overridden.has(name.toLowerCase()) === false).map((field, index) => ({
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
	const context = valueContext(document.getText(), document.offsetAt(position));
	const option = context === null ? undefined : fieldProperties(typeOfField(context, site))?.find(({ name }) => name === context.key);
	const values = option === undefined ? [] : literalValues(option.type);

	if (values.length === 0) {
		return null;
	}

	const range = { start: document.positionAt(context.start), end: position };

	return values.map((value, index) => ({
		label: value,
		kind: CompletionItemKind.Value,
		// An option without a default is null
		detail: value === (option.default ?? 'null') ? 'default' : undefined,
		documentation: option.description,
		filterText: value,
		sortText: '2' + index,
		textEdit: { range, newText: value },
	}));
}

// What Kirby gives every template
const TEMPLATE_DATA = { kirby: 'Kirby\\Cms\\App', site: 'Kirby\\Cms\\Site', pages: 'Kirby\\Cms\\Pages', page: 'Kirby\\Cms\\Page' };

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
 * Warnings for variables a template uses that neither it nor its controllers define.
 * Only if every controller could be read and the template doesn't define variables in ways that can't be followed.
 * @param {TextDocument} document
 * @param {string} site
 */
function variableDiagnostics(document, site) {
	const data = templateVariables(fileURLToPath(document.uri), site);
	const used = data?.complete === true ? undefinedVariables(document.getText()) : null;

	return (used ?? [])
		.filter(({ name }) => data.variables.has(name) === false && TEMPLATE_DATA[name] === undefined)
		.map(({ name, start, end }) => ({
			severity: DiagnosticSeverity.Warning,
			range: { start: document.positionAt(start), end: document.positionAt(end) },
			message: `Variable “$${name}” is not defined: the template doesn’t set it and its controller doesn’t return it.`,
			source: 'Kirby',
		}));
}

/**
 * Completion for the keys of a field: the options of its type (from `type`, what it
 * extends, or its name), without those it already has. Without a known type, `type` and `extends`.
 * @param {TextDocument} document
 * @param {{ line: number, character: number }} position
 * @param {string} site
 */
function propertyCompletion(document, position, site) {
	const context = propertyContext(document.getText(), document.offsetAt(position));

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
			warn(reference.start, reference.end, `Field “${reference.name}” is not defined in fields at the top of the blueprint. Kirby shows an error instead.`);
		}
	}

	const { blueprints, complete } = blueprintsOf(site);

	for (const reference of fieldsetReferences(document.getText())) {
		if (blueprints.has(reference.blueprint) === false) {
			const message = `Block type “${reference.name}” not found: there is no blueprint ${reference.blueprint}, so the block has no fields.`;
			warn(reference.start, reference.end, complete ? message : message + ' (Some plugins register blueprints in a way that couldn’t be read.)', complete ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information);
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
 * @typedef {{ blueprint?: import('./project.js').Entry, template?: import('./project.js').Entry, content?: import('./project.js').Entry }} Template
 */

/**
 * The template names of a site with what defines them: for `pages` the page
 * blueprints, the templates in `site/templates` (or of plugins) and the templates
 * pages in the content folder use; for `files` the file blueprints
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

			// Reading the content folder takes a while on big sites
			for (const [name, content] of cached('content-templates:' + site, () => listContentTemplates(site), 60000)) {
				templates.set(name, { ...templates.get(name), content });
			}
		}

		return templates;
	});
}

/**
 * What to open and describe for a template: its blueprint, else its template file, else a content file using it
 * @param {Template | undefined} template
 */
function templateEntry(template) {
	return template?.blueprint ?? template?.template ?? template?.content;
}

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
		content: file,
	}[entry.source];
}

/**
 * Markdown for a snippet or collection: its origin and what it expects or returns
 * @param {import('./calls.js').Kind | 'blueprint' | 'variable' | 'field'} kind
 * @param {string} name
 * @param {import('./project.js').Entry & { value?: string }} entry
 * @param {string} site
 */
function describe(kind, name, entry, site) {
	// The entry of a controller variable carries its value
	if (kind === 'variable') {
		return `**$${name}** · ${origin(entry, site)}\n\n\`\`\`php\n'${name}' => ${entry.value}\n\`\`\``;
	}

	if (kind === 'template') {
		const page = templatesOf(site, 'pages').get(name);
		const file = templatesOf(site, 'files').get(name);
		const places = [['blueprint', page?.blueprint], ['template', page?.template], ['used by', page?.content], ['file blueprint', file?.blueprint]];

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
 * The site and the name at a position, with what it refers to
 * @param {{ uri: string }} textDocument
 * @param {{ line: number, character: number }} position
 */
function lookup(textDocument, position) {
	const document = documents.get(textDocument.uri);
	const site = document ? siteFor(document.uri) : null;
	const offset = document?.offsetAt(position);
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
		entry = entriesOf(site, 'blueprint').get(reference.name);
	} else if (field !== null) {
		// A field defined at the top of this blueprint
		const at = definitionsOf(document, site)?.get(field.name) ?? -1;
		name = { kind: 'field', ...field };
		entry = at === -1 ? undefined : { file: fileURLToPath(document.uri), line: document.positionAt(at).line, source: 'site' };
	} else if (slot?.name) {
		name = { kind: 'template', ...slot };
		entry = templateEntry(templatesOf(site, slot.folder).get(slot.name));
	} else if (name !== null) {
		entry = name.kind === 'asset' ? assetEntry(site, name.name) : entriesOf(site, name.kind).get(name.name);
	} else if (site !== null) {
		// A variable in a template that its controller returns
		const variable = variableAt(document.getText(), offset);
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
 * Warns about blueprints that `extends` or the shorthand `seo: fields/seo` refer to and that don't exist
 * @param {TextDocument} document
 * @param {string} site
 */
function blueprintDiagnostics(document, site) {
	const { blueprints, complete } = blueprintsOf(site);

	return blueprintReferences(document.getText()).filter(({ name }) => blueprints.has(name) === false).map((reference) => {
		let message = `Blueprint “${reference.name}” not found. Kirby ignores it.`;

		// `intro: textarea` isn't a type shorthand; Kirby takes the field name as type
		if (reference.shorthand === true && isFieldType(reference.name) === true) {
			message += ` For a field type, use “type: ${reference.name}”.`;
		}

		// A plugin we couldn't read may register it
		if (complete === false) {
			message += ' (Some plugins register blueprints in a way that couldn’t be read.)';
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
		pages: `Template “${name}” not found: no blueprint pages/${name}, no template ${name}.php and no page that uses it.`,
		files: `File template “${name}” has no blueprint files/${name}. Kirby uses files/default.`,
	}[folder] ?? `Template “${name}” not found: no blueprint pages/${name} or files/${name}, no template ${name}.php and no page that uses it.`;
	const { complete } = blueprintsOf(site);

	return {
		severity: complete === true && folder !== 'files' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
		range: { start: document.positionAt(start), end: document.positionAt(end) },
		message: complete === true ? message : message + ' (Some plugins register blueprints in a way that couldn’t be read.)',
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

	for (const call of findCalls(document.getText())) {
		let severity = DiagnosticSeverity.Warning;

		// Every template of a list must exist
		if (call.kind === 'template') {
			const templates = entriesOf(site, 'template');
			diagnostics.push(...call.names.filter(({ name }) => templates.has(name) === false).map((name) => templateDiagnostic(document, site, name, null)));
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

			message = `Translation ${list} not found. ${call.fn}() returns null.`;

			// Some plugins load translations at runtime; then this is only a hint
			if (complete === false) {
				message += ' (Some plugins load translations at runtime and couldn’t be checked.)';
				severity = DiagnosticSeverity.Information;
			}
		} else if (call.kind === 'collection') {
			message = `Collection ${list} not found. collection() returns null.`;
		} else if (call.kind === 'asset') {
			message = `File ${list} not found.`;
		} else {
			message = call.names.length === 1 ? `Snippet ${list} not found. Kirby renders nothing.` : `None of the snippets ${list} exist. Kirby renders nothing.`;
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

	diagnostics.push(...variableDiagnostics(document, site));

	if (isBlueprint(document) === true) {
		diagnostics.push(...blueprintDiagnostics(document, site), ...referenceDiagnostics(document, site));

		for (const slot of slotsOf(document, site)) {
			if (slot.name && templatesOf(site, slot.folder).has(slot.name) === false) {
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

	return {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// A space for `type: ` in blueprints, `>` for `$page->`, `$` for variables
			completionProvider: { triggerCharacters: ['\'', '"', '/', ' ', '>', '$'] },
			definitionProvider: true,
			hoverProvider: true,
			codeLensProvider: { resolveProvider: false },
		},
	};
});

connection.onInitialized(() => {
	connection.console.log(`Kirby sites: ${allSites().join(', ') || 'none found'}`);
});

connection.onCompletion(({ textDocument, position }) => {
	const document = documents.get(textDocument.uri);
	const site = document ? siteFor(document.uri) : null;

	if (site !== null && isBlueprint(document) === true) {
		// `create:` of a pagelist takes templates or false
		const templates = templateCompletion(document, position, site);
		const values = valueCompletion(document, position, site);
		const both = templates === null && values === null ? null : [...templates ?? [], ...values ?? []];
		const items = typeCompletion(document, position) ?? extendsCompletion(document, position, site) ?? both ?? listItemCompletion(document, position, site) ?? propertyCompletion(document, position, site);

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

		return snippet === undefined ? [] : snippetVariables(snippet.file).map((variable, index) => ({
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
connection.onCodeLens(({ textDocument }) => {
	const document = documents.get(textDocument.uri);
	const site = document ? siteFor(document.uri) : null;

	if (site === null) {
		return [];
	}

	return findCalls(document.getText()).filter((call) => call.kind === 'snippet' || call.kind === 'collection').flatMap((call) => {
		const entries = entriesOf(site, call.kind);
		const found = call.names.map(({ name }) => entries.get(name)).find((entry) => entry !== undefined);

		if (found === undefined) {
			return [];
		}

		const start = document.positionAt(call.names[0].start);

		return [{
			range: { start, end: start },
			command: { title: origin(found, site), command: '' },
		}];
	});
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
