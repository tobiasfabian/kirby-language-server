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
import { blueprintReferences, extendsContext, fieldTypes, isFieldType, referenceAt, typeContext } from './blueprints.js';
import { completionContext, findCalls, nameAt, propsContext } from './calls.js';
import { collectionSignature, findAsset, findSites, listBlueprints, listCollections, listDocroot, listSnippets, listTranslations, snippetProps, snippetVariables } from './project.js';

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
 * Reads something about a site, again at most every two seconds
 * @template T
 * @param {string} key
 * @param {() => T} read
 * @returns {T}
 */
function cached(key, read) {
	const entry = cache.get(key);

	if (entry !== undefined && Date.now() - entry.time < 2000) {
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
	const file = fileURLToPath(document.uri);
	const own = [...blueprints].find(([, entry]) => entry.file === file)?.[0];
	const folder = context.folder ?? (own?.includes('/') ? own.split('/')[0] : null);

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
 * The blueprints of a site, and whether all of them could be read
 * @param {string} site
 */
function blueprintsOf(site) {
	return cached('blueprints:' + site, () => listBlueprints(site));
}

/**
 * The translation keys of a site, with their texts per language
 * @param {string} site
 */
function translationsOf(site) {
	return cached('translation:' + site, () => listTranslations(site));
}

/**
 * The snippets, collections or translations of a site, by name
 * @param {string} site
 * @param {import('./calls.js').Kind} kind
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
 * @param {import('./calls.js').Kind | 'blueprint'} kind
 * @param {string} name
 * @param {import('./project.js').Entry} entry
 * @param {string} site
 */
function describe(kind, name, entry, site) {
	const lines = [`**${name}** · ${origin(entry, site)}`];

	if (kind === 'asset' || kind === 'blueprint') {
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
	const reference = site && isBlueprint(document) ? referenceAt(document.getText(), offset) : null;
	const name = site === null ? null : reference === null ? nameAt(document.getText(), offset) : { kind: 'blueprint', ...reference };
	const entry = name === null ? undefined : name.kind === 'asset' ? assetEntry(site, name.name) : entriesOf(site, name.kind).get(name.name);

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
 * Warns about calls whose snippet, collection, translation or file doesn't exist,
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

	if (isBlueprint(document) === true) {
		diagnostics.push(...blueprintDiagnostics(document, site));
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
			// A space for `type: ` in blueprints
			completionProvider: { triggerCharacters: ['\'', '"', '/', ' '] },
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
		const items = typeCompletion(document, position) ?? extendsCompletion(document, position, site);

		if (items !== null) {
			return items;
		}
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
