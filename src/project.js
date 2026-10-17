/**
 * Reads what a Kirby project offers from its files.
 * Kirby itself isn't started, so this works without PHP.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { arrayEntries, closingBracket, lineAt, pluginArray, returnedArray, stringsIn, withoutComments } from './php.js';

const SKIP = new Set(['.git', 'node_modules', 'vendor', 'kirby', 'content', 'media', 'assets', 'cache', 'sessions', 'accounts', 'logs']);
const SITE_FOLDERS = ['snippets', 'templates', 'blueprints'];

// What plugins and the config register that the server reads
const REGISTERED = /** @type {const} */ (['snippets', 'collections', 'templates', 'blueprints', 'controllers', 'pageMethods', 'siteMethods', 'fieldMethods', 'blockMethods', 'pageModels']);

/** @typedef {typeof REGISTERED[number]} Registered */

// Kirby 6's own block blueprints (in kirby/config/blocks)
const KIRBY_BLOCKS = ['code', 'gallery', 'heading', 'image', 'line', 'list', 'markdown', 'quote', 'table', 'text', 'video'];

/**
 * @typedef {object} Entry
 * @property {string} file
 * @property {number} line 0-based line where it's defined
 * @property {'site' | 'plugin' | 'config' | 'kirby' | 'content'} source
 * @property {string} [plugin] folder name of the plugin
 * @property {boolean} [inline] defined in PHP code (a blueprint as an array or closure), not in a file of its own
 */

/**
 * Finds Kirby `site` folders below a folder (e.g. `site` or `public/site`)
 * @param {string} root
 * @param {number} depth
 * @returns {string[]}
 */
export function findSites(root, depth = 3) {
	const isSite = (folder) => SITE_FOLDERS.some((name) => fs.existsSync(path.join(folder, name)));
	const sites = [];

	/** @param {string} folder @param {number} level */
	function walk(folder, level) {
		let entries;

		try {
			entries = fs.readdirSync(folder, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry.isDirectory() === false || SKIP.has(entry.name) === true) {
				continue;
			}

			const child = path.join(folder, entry.name);

			if (entry.name === 'site' && isSite(child)) {
				sites.push(child);
			} else if (level < depth) {
				walk(child, level + 1);
			}
		}
	}

	if (path.basename(root) === 'site' && isSite(root)) {
		return [root];
	}

	walk(root, 1);

	return sites;
}

/**
 * Lists the PHP files (or others) below a folder, named by their path without the extension
 * @param {string} folder
 * @param {string} extension
 * @returns {{ name: string, file: string }[]}
 */
function phpFiles(folder, extension = '.php') {
	const files = [];

	/** @param {string} current */
	function walk(current) {
		let entries;

		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			const file = path.join(current, entry.name);

			if (entry.isDirectory() === true) {
				walk(file);
			} else if (entry.name.endsWith(extension) === true) {
				const name = path.relative(folder, file).slice(0, -extension.length).split(path.sep).join('/');
				files.push({ name, file });
			}
		}
	}

	walk(folder);

	return files;
}

/**
 * Reads the snippets, collections, templates, blueprints, controllers, methods and page models
 * a plugin (`index.php`) or the config (`config.php`, under `'extensions'`) registers.
 * A list may also come from a file (`'blueprints' => require __DIR__ . '/blueprints.php'`).
 * `value` is the code of each entry; `complete` is false if the blueprints couldn't be read.
 * @param {string} file
 * @param {'plugin' | 'config'} type
 * @returns {Record<Registered, { name: string, file: string, line: number, inline?: boolean, value: string }[]> & { complete: boolean }}
 */
function registered(file, type) {
	const result = { ...Object.fromEntries(REGISTERED.map((kind) => [kind, []])), complete: true };
	const code = read(file);

	if (code === null) {
		return result;
	}

	const start = type === 'plugin' ? pluginArray(code) : returnedArray(code);

	if (start === -1) {
		result.complete = /['"]blueprints['"]\s*=>/.test(code) === false;
		return result;
	}

	let entries = arrayEntries(code, start);

	if (type === 'config') {
		const extensions = entries.find((entry) => entry.key === 'extensions');

		if (extensions === undefined || code[extensions.valueStart] !== '[') {
			return result;
		}

		entries = arrayEntries(code, extensions.valueStart);
	}

	for (const kind of REGISTERED) {
		const entry = entries.find(({ key }) => key === kind);

		// Mentioned, but not where it was expected (e.g. in `array(…)` syntax)
		if (entry === undefined) {
			result.complete &&= kind !== 'blueprints' || /['"]blueprints['"]\s*=>/.test(code) === false;
			continue;
		}

		const list = code[entry.valueStart] === '['
			? { code, index: entry.valueStart, file }
			: includedArray(code, entry.valueStart, entry.valueEnd, file);

		if (list === null) {
			result.complete &&= kind !== 'blueprints';
			continue;
		}

		for (const item of arrayEntries(list.code, list.index)) {
			// A path to a file (`__DIR__ . '/x.php'`, `require 'x.php'`), or something defined right here
			const value = list.code.slice(item.valueStart, item.valueEnd);
			const target = value.startsWith('[') ? null : value.match(kind === 'blueprints' ? /['"]([^'"]+\.(?:ya?ml|php|json))['"]/ : /['"]([^'"]+\.php)['"]/);

			result[kind].push(target === null
				? { name: item.key, file: list.file, line: lineAt(list.code, item.keyStart), inline: true, value }
				: { name: item.key, file: path.join(path.dirname(list.file), target[1].replace(/^\//, '')), line: 0, value });
		}
	}

	return result;
}

/**
 * The plugin folders of a site
 * @param {string} site
 */
function plugins(site) {
	try {
		return fs.readdirSync(path.join(site, 'plugins'), { withFileTypes: true })
			.filter((entry) => entry.isDirectory() === true)
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

/**
 * Lists the snippets of a site in Kirby's lookup order:
 * the site's own snippets win over registered ones, which win over Kirby's.
 * @param {string} site
 * @returns {Map<string, Entry>}
 */
export function listSnippets(site) {
	const snippets = new Map();
	const kirbyBlocks = path.join(path.dirname(site), 'kirby', 'config', 'blocks');

	// Kirby's own block snippets, e.g. blocks/text
	try {
		for (const entry of fs.readdirSync(kirbyBlocks, { withFileTypes: true })) {
			const file = path.join(kirbyBlocks, entry.name, entry.name + '.php');

			if (entry.isDirectory() === true && fs.existsSync(file) === true) {
				snippets.set('blocks/' + entry.name, { file, line: 0, source: 'kirby' });
			}
		}
	} catch {
		// no Kirby folder next to the site
	}

	for (const plugin of plugins(site)) {
		for (const { name, file, line } of registered(path.join(site, 'plugins', plugin, 'index.php'), 'plugin').snippets) {
			snippets.set(name, { file, line, source: 'plugin', plugin });
		}
	}

	for (const { name, file, line } of registered(path.join(site, 'config', 'config.php'), 'config').snippets) {
		snippets.set(name, { file, line, source: 'config' });
	}

	for (const { name, file } of phpFiles(path.join(site, 'snippets'))) {
		snippets.set(name, { file, line: 0, source: 'site' });
	}

	return snippets;
}

/**
 * Lists the collections of a site: from `site/collections` (nested folders
 * included), registered by plugins or under `'extensions'` in the config
 * @param {string} site
 * @returns {Map<string, Entry>}
 */
export function listCollections(site) {
	const collections = new Map();

	for (const plugin of plugins(site)) {
		for (const { name, file, line } of registered(path.join(site, 'plugins', plugin, 'index.php'), 'plugin').collections) {
			collections.set(name, { file, line, source: 'plugin', plugin });
		}
	}

	for (const { name, file, line } of registered(path.join(site, 'config', 'config.php'), 'config').collections) {
		collections.set(name, { file, line, source: 'config' });
	}

	for (const { name, file } of phpFiles(path.join(site, 'collections'))) {
		collections.set(name, { file, line: 0, source: 'site' });
	}

	return collections;
}

/**
 * Reads the first lines of a file, up to the first `?>`
 * @param {string} file
 */
function head(file) {
	try {
		return fs.readFileSync(file, 'utf8').split('?>')[0].split('\n').slice(0, 60);
	} catch {
		return [];
	}
}

/**
 * Returns the variables a snippet expects, as written at its top:
 * `@var` docblocks and defaults like `$size ??= null;`
 * @param {string} file
 * @returns {string[]}
 */
export function snippetProps(file) {
	const props = [];

	for (const line of head(file)) {
		const trimmed = line.trim();

		if (/^\/\*\*\s*@var\b.*\*\/$/.test(trimmed) === true || /^\$\w+\s*\?\?=/.test(trimmed) === true || /^\$(\w+)\s*=\s*\$\1\s*\?\?/.test(trimmed) === true) {
			props.push(trimmed);
		} else if (/^\*\s*@var\b/.test(trimmed) === true) {
			props.push(trimmed.replace(/^\*\s*/, ''));
		}
	}

	return props;
}

/**
 * Reads a closure that a plugin or the config registers (a collection, a method …):
 * its signature from `function`/`fn` up to the return type, e.g. `function (Site $site): Pages`,
 * its parameters and return type, and the text of the docblock above it.
 * For an entry in a file of its own (line 0), the closure the file returns.
 * @param {Entry} entry
 * @returns {{ signature: string, params: string, returns?: string, description?: string } | null}
 */
export function closureInfo(entry) {
	const code = read(entry.file);

	if (code === null) {
		return null;
	}

	const lines = code.split('\n');
	const start = entry.line > 0 ? entry.line : Math.max(0, lines.findIndex((line) => /\breturn\b/.test(line)));
	const offset = lines.slice(0, start).join('\n').length + (start > 0 ? 1 : 0);
	const keyword = lines.slice(start, start + 4).join('\n').match(/(?:static\s+)?(?:function|fn)\s*\(/);

	if (keyword === null) {
		return null;
	}

	// The parameters may span lines and have comments
	const open = offset + keyword.index + keyword[0].length - 1;
	const close = closingBracket(code, open);
	const params = withoutComments(code.slice(open + 1, close)).replace(/\s+/g, ' ').replace(/,\s*$/, '').trim();
	const returns = code.slice(close + 1).match(/^\s*(?:use\s*\([^)]*\)\s*)?:\s*([\w\\|?]+)/)?.[1];

	return {
		signature: `${keyword[0].slice(0, -1).trim()} (${params})${returns === undefined ? '' : ': ' + returns}`,
		params,
		returns,
		description: docblockAbove(lines, start),
	};
}

/**
 * The text of the docblock right above a line, without stars and tags
 * @param {string[]} lines
 * @param {number} index
 */
function docblockAbove(lines, index) {
	let end = index - 1;

	while (end >= 0 && lines[end].trim() === '') {
		end--;
	}

	if (end < 0 || lines[end].trim().endsWith('*/') === false) {
		return undefined;
	}

	let start = end;

	while (start > 0 && lines[start].trim().startsWith('/**') === false) {
		start--;
	}

	const text = lines.slice(start, end + 1)
		.map((line) => line.trim().replace(/^\/\*\*|\*\/$/g, '').replace(/^\*\s?/, '').trim())
		.filter((line) => line !== '' && line.startsWith('@') === false)
		.join(' ');

	return text === '' ? undefined : text;
}

/**
 * Returns how a collection is defined: its closure's signature,
 * e.g. `return function (Site $site): Pages`
 * @param {Entry} collection
 * @returns {string | null}
 */
export function collectionSignature(collection) {
	const info = closureInfo(collection);
	return info === null ? null : (collection.line > 0 ? '' : 'return ') + info.signature;
}

/**
 * @typedef {object} Translation
 * @property {Map<string, string>} values language code → text (plural forms joined with “ / ”)
 * @property {string} file where the key is defined, preferably in the default language
 * @property {number} line
 * @property {'site' | 'plugin' | 'config' | 'kirby'} source
 * @property {string} [plugin]
 */

/**
 * @param {string} file
 */
function read(file) {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return null;
	}
}

/**
 * Reads the `key => text` pairs of the array at `index`
 * @param {Map<string, Translation>} translations
 * @param {string} code
 * @param {number} index
 * @param {string} file
 * @param {string} language
 * @param {{ source: Translation['source'], plugin?: string, primary?: boolean }} origin
 */
function addTranslations(translations, code, index, file, language, origin) {
	for (const entry of arrayEntries(code, index)) {
		const existing = translations.get(entry.key);
		const translation = existing ?? { values: new Map() };

		// The site's own languages win over plugins and the config, the default language over others
		if (existing === undefined || origin.primary === true || (origin.source === 'site' && existing.source !== 'site')) {
			Object.assign(translation, { file, line: lineAt(code, entry.keyStart), source: origin.source, plugin: origin.plugin });
		}

		// Plural forms for tc() are a list; the empty form for 0 is shown as –
		const strings = stringsIn(code, entry.valueStart, entry.valueEnd);
		translation.values.set(language, strings.length > 1 ? strings.map((text) => text === '' ? '–' : text).join(' / ') : strings[0] ?? '');
		translations.set(entry.key, translation);
	}
}

/**
 * Follows `require`/`include` of a PHP file (with or without `__DIR__ .`)
 * to the array it returns
 * @param {string} code
 * @param {number} start
 * @param {number} end
 * @param {string} file the file the code is in, for relative paths
 * @returns {{ code: string, index: number, file: string } | null}
 */
function includedArray(code, start, end, file) {
	const target = code.slice(start, end).match(/^(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+\.php)['"]/);

	if (target === null) {
		return null;
	}

	const included = path.join(path.dirname(file), target[1].replace(/^\//, ''));
	const includedCode = read(included);
	const index = includedCode === null ? -1 : returnedArray(includedCode);

	return index === -1 ? null : { code: includedCode, index, file: included };
}

/**
 * Reads a `'translations' => [...]` entry of a plugin or the config: per
 * language an array, or a PHP file returning one. The whole list may come
 * from a file, too (`'translations' => require __DIR__ . '/translations.php'`).
 * @param {Map<string, Translation>} translations
 * @param {string} code
 * @param {{ valueStart: number, valueEnd: number }} entry
 * @param {string} file
 * @param {{ source: Translation['source'], plugin?: string }} origin
 * @returns {boolean} whether every language could be read
 */
function addRegisteredTranslations(translations, code, entry, file, origin) {
	const list = code[entry.valueStart] === '['
		? { code, index: entry.valueStart, file }
		: includedArray(code, entry.valueStart, entry.valueEnd, file);

	if (list === null) {
		return false;
	}

	let complete = true;

	for (const language of arrayEntries(list.code, list.index)) {
		const array = list.code[language.valueStart] === '['
			? { code: list.code, index: language.valueStart, file: list.file }
			: includedArray(list.code, language.valueStart, language.valueEnd, list.file);

		if (array === null) {
			complete = false;
			continue;
		}

		addTranslations(translations, array.code, array.index, array.file, language.key, origin);
	}

	return complete;
}

/**
 * The JSON files of Kirby's translations, e.g. es_ES.json
 * @param {string} folder
 */
function kirbyFiles(folder) {
	try {
		return fs.readdirSync(folder).filter((name) => name.endsWith('.json')).sort();
	} catch {
		return [];
	}
}

/**
 * Lists the translation keys of a site: from the language files in
 * `site/languages`, from plugins and from `'extensions'` in the config.
 * `kirby` holds Kirby's own keys (e.g. `save`) with their texts in the site's languages.
 * `complete` is false if a source couldn't be read, e.g. translations loaded from YAML.
 * @param {string} site
 * @returns {{ translations: Map<string, Translation>, kirby: Map<string, Translation>, languages: string[], complete: boolean }}
 */
export function listTranslations(site) {
	const translations = new Map();
	let complete = true;

	// Language files first, to know the default language
	const languageFiles = phpFiles(path.join(site, 'languages'))
		.map(({ name, file }) => ({ code: read(file), file, name }))
		.filter(({ code }) => code !== null && returnedArray(code) !== -1)
		.map((language) => {
			const entries = arrayEntries(language.code, returnedArray(language.code));
			const value = (key) => entries.find((entry) => entry.key === key);
			const codeEntry = value('code');
			const defaultEntry = value('default');

			return {
				...language,
				entries,
				language: codeEntry ? stringsIn(language.code, codeEntry.valueStart, codeEntry.valueEnd)[0] ?? language.name : language.name,
				isDefault: defaultEntry !== undefined && language.code.slice(defaultEntry.valueStart, defaultEntry.valueEnd).trim() === 'true',
			};
		});

	for (const plugin of plugins(site)) {
		const file = path.join(site, 'plugins', plugin, 'index.php');
		const code = read(file);
		const start = code === null ? -1 : pluginArray(code);
		const entry = start === -1 ? undefined : arrayEntries(code, start).find(({ key }) => key === 'translations');

		if (entry !== undefined && addRegisteredTranslations(translations, code, entry, file, { source: 'plugin', plugin }) === false) {
			complete = false;
		}
	}

	const configFile = path.join(site, 'config', 'config.php');
	const config = read(configFile);
	const configStart = config === null ? -1 : returnedArray(config);
	const extensions = configStart === -1 ? undefined : arrayEntries(config, configStart).find(({ key }) => key === 'extensions');
	const configEntry = extensions !== undefined && config[extensions.valueStart] === '[' ? arrayEntries(config, extensions.valueStart).find(({ key }) => key === 'translations') : undefined;

	if (configEntry !== undefined && addRegisteredTranslations(translations, config, configEntry, configFile, { source: 'config' }) === false) {
		complete = false;
	}

	for (const language of languageFiles) {
		const entry = language.entries.find(({ key }) => key === 'translations');

		if (entry === undefined) {
			continue;
		}

		if (language.code[entry.valueStart] !== '[') {
			complete = false;
			continue;
		}

		addTranslations(translations, language.code, entry.valueStart, language.file, language.language, { source: 'site', primary: language.isDefault });
	}

	const languages = languageFiles.sort((a, b) => Number(b.isDefault) - Number(a.isDefault)).map(({ language }) => language);

	// Kirby's own keys, e.g. t('save'), with their texts in the site's languages.
	// A single-language site has no language files; its translations name the language.
	const used = languages.length > 0 ? languages : [...new Set([...translations.values()].flatMap(({ values }) => [...values.keys()]))];
	const folder = path.join(path.dirname(site), 'kirby', 'i18n', 'translations');
	const kirby = new Map();

	for (const language of [...new Set([...used, 'en'])]) {
		// Kirby names its files e.g. de.json or pt_BR.json; a site language like en-us uses en.json
		const base = language.split(/[-_]/)[0];
		const file = [language, language.replace('-', '_'), base]
			.map((name) => path.join(folder, name + '.json'))
			.find((candidate) => fs.existsSync(candidate))
			?? [`${base}_${base.toUpperCase()}.json`, ...kirbyFiles(folder).filter((name) => name.startsWith(base + '_'))]
				.map((name) => path.join(folder, name))
				.find((candidate) => fs.existsSync(candidate));
		const json = file === undefined ? null : read(file);

		if (json === null) {
			continue;
		}

		let texts;

		try {
			texts = JSON.parse(json);
		} catch {
			continue;
		}

		const lines = new Map(json.split('\n').map((line, index) => [line.match(/^\s*"((?:\\.|[^"\\])*)"\s*:/)?.[1], index]));

		for (const [key, text] of Object.entries(texts)) {
			const translation = kirby.get(key) ?? { values: new Map(), file, line: lines.get(key) ?? 0, source: 'kirby' };
			translation.values.set(language, Array.isArray(text) ? text.join(' / ') : String(text));
			kirby.set(key, translation);
		}
	}

	return { translations, kirby, languages, complete };
}

/**
 * The variables a snippet expects, with type (from `@var`) and default (from `??=`)
 * @param {string} file
 * @returns {{ name: string, type?: string, default?: string }[]}
 */
export function snippetVariables(file) {
	const variables = new Map();
	const variable = (name) => variables.get(name) ?? variables.set(name, { name }).get(name);

	for (const line of snippetProps(file)) {
		const typed = line.match(/@var\s+(\S+)\s+\$(\w+)/);
		const defaulted = line.match(/^\$(\w+)\s*\?\?=\s*(.+?);?$/) ?? line.match(/^\$(\w+)\s*=\s*\$\1\s*\?\?\s*(.+?);?$/);

		if (typed !== null) {
			variable(typed[2]).type = typed[1];
		} else if (defaulted !== null) {
			variable(defaulted[1]).default = defaulted[2];
		}
	}

	return [...variables.values()];
}

// Folders in the docroot that hold no files for the browser, or files Kirby creates on demand
const NOT_ASSETS = new Set(['content', 'kirby', 'media', 'node_modules', 'site', 'vendor']);

/**
 * The docroot: the folder of the `index.php` that starts Kirby. Usually the folder around `site`;
 * with custom roots (`'site' => __DIR__ . '/../site'`) a folder like `public` next to `site`.
 * @param {string} site
 */
export function findDocroot(site) {
	const project = path.dirname(site);

	if (fs.existsSync(path.join(project, 'index.php')) === true) {
		return project;
	}

	for (const entry of fs.readdirSync(project, { withFileTypes: true })) {
		if (entry.isDirectory() === true && SKIP.has(entry.name) === false && /\bkirby\b/i.test(read(path.join(project, entry.name, 'index.php')) ?? '') === true) {
			return path.join(project, entry.name);
		}
	}

	return project;
}

/**
 * The files and folders in a folder of the docroot, for completing paths.
 * Hidden files, PHP files and folders like `content` and `media` are left out.
 * @param {string} site
 * @param {string} folder relative to the docroot, e.g. `assets/css/`
 * @returns {{ name: string, directory: boolean }[]}
 */
export function listDocroot(site, folder) {
	if (NOT_ASSETS.has(folder.split('/')[0]) === true) {
		return [];
	}

	try {
		return fs.readdirSync(path.join(findDocroot(site), folder), { withFileTypes: true })
			.filter((entry) => entry.name.startsWith('.') === false && entry.name.endsWith('.php') === false)
			.filter((entry) => folder !== '' || NOT_ASSETS.has(entry.name) === false)
			.map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
	} catch {
		return [];
	}
}

/**
 * The file or folder a path in `css()`, `svg()` etc. points to, if it exists
 * @param {string} site
 * @param {string} name relative to the docroot, maybe with a leading `/`
 * @returns {{ file: string, directory: boolean } | null}
 */
export function findAsset(site, name) {
	const file = path.join(findDocroot(site), name.replace(/^\//, ''));

	try {
		return { file, directory: fs.statSync(file).isDirectory() };
	} catch {
		return null;
	}
}

/**
 * Lists the blueprints of a site in Kirby's lookup order: `site/blueprints` wins
 * over the config and plugins, which win over Kirby's own (the block blueprints
 * and the defaults `pages/default`, `files/default` and `site`).
 * `complete` is false if a plugin's blueprints couldn't be read.
 * @param {string} site
 * @returns {{ blueprints: Map<string, Entry>, complete: boolean }}
 */
export function listBlueprints(site) {
	const blueprints = new Map();
	const kirby = path.join(path.dirname(site), 'kirby');
	const core = path.join(kirby, 'src', 'Cms', 'Core.php');
	const coreCode = read(core) ?? '';
	let complete = true;

	for (const block of KIRBY_BLOCKS) {
		blueprints.set('blocks/' + block, { file: path.join(kirby, 'config', 'blocks', block, block + '.yml'), line: 0, source: 'kirby' });
	}

	for (const name of ['files/default', 'pages/default', 'site']) {
		const index = coreCode.indexOf(`'${name}' =>`);
		blueprints.set(name, { file: core, line: index === -1 ? 0 : lineAt(coreCode, index), source: 'kirby', inline: true });
	}

	for (const plugin of plugins(site)) {
		const found = registered(path.join(site, 'plugins', plugin, 'index.php'), 'plugin');
		complete &&= found.complete;

		for (const { name, ...entry } of found.blueprints) {
			blueprints.set(name, { ...entry, source: 'plugin', plugin });
		}
	}

	const config = registered(path.join(site, 'config', 'config.php'), 'config');
	complete &&= config.complete;

	for (const { name, ...entry } of config.blueprints) {
		blueprints.set(name, { ...entry, source: 'config' });
	}

	for (const { name, file } of phpFiles(path.join(site, 'blueprints'), '.yml')) {
		blueprints.set(name, { file, line: 0, source: 'site' });
	}

	return { blueprints, complete };
}

/**
 * The content of a blueprint file. Null for blueprints defined in PHP and for broken YAML.
 * @param {Entry} entry
 * @returns {Record<string, any> | null}
 */
export function readBlueprint(entry) {
	const code = entry.inline === true || /\.ya?ml$/.test(entry.file) === false ? null : read(entry.file);

	if (code === null) {
		return null;
	}

	try {
		// Like Kirby, a repeated key overrides the one before
		const data = parse(code, { uniqueKeys: false, logLevel: 'silent' });
		return data !== null && typeof data === 'object' && Array.isArray(data) === false ? data : null;
	} catch {
		return null;
	}
}

/**
 * Lists the templates of a site: `site/templates/*.php` and those registered by
 * plugins or under `'extensions'` in the config. Content representations
 * (`project.json.php`) and email templates (`emails/…`) are left out.
 * @param {string} site
 * @returns {Map<string, Entry>}
 */
export function listTemplates(site) {
	const templates = new Map();

	for (const plugin of plugins(site)) {
		for (const { name, file, line } of registered(path.join(site, 'plugins', plugin, 'index.php'), 'plugin').templates) {
			templates.set(name, { file, line, source: 'plugin', plugin });
		}
	}

	for (const { name, file, line } of registered(path.join(site, 'config', 'config.php'), 'config').templates) {
		templates.set(name, { file, line, source: 'config' });
	}

	for (const { name, file } of phpFiles(path.join(site, 'templates'))) {
		templates.set(name, { file, line: 0, source: 'site' });
	}

	return new Map([...templates].filter(([name]) => /[./]/.test(name) === false));
}

/**
 * The templates that pages in the content folder use, from the names of their
 * content files (`project.txt`, `project.de.txt`). A page may use a template
 * that has neither a blueprint nor a template file, like `error`.
 * File meta data (`photo.jpg.txt`) and `site.txt` are left out.
 * @param {string} site
 * @returns {Map<string, Entry>}
 */
export function listContentTemplates(site) {
	const templates = new Map();
	const root = [path.join(path.dirname(site), 'content'), path.join(findDocroot(site), 'content')].find((folder) => fs.existsSync(folder));

	/** @param {string} folder */
	function walk(folder) {
		let entries;

		try {
			entries = fs.readdirSync(folder, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry.name.startsWith('.') === true) {
				continue;
			}

			if (entry.isDirectory() === true) {
				walk(path.join(folder, entry.name));
				continue;
			}

			// The language code, if any, then the template
			const name = entry.name.endsWith('.txt') ? entry.name.slice(0, -4).replace(/\.[a-z]{2}(?:[-_][a-z]{2,4})?$/i, '') : '';

			if (name !== '' && name.includes('.') === false && (folder !== root || name !== 'site') && templates.has(name) === false) {
				templates.set(name, { file: path.join(folder, entry.name), line: 0, source: 'content' });
			}
		}
	}

	if (root !== undefined) {
		walk(root);
	}

	return templates;
}

/**
 * The page, site, field or block methods that plugins and the config register
 * @param {string} site
 * @param {'pageMethods' | 'siteMethods' | 'fieldMethods' | 'blockMethods'} kind
 * @returns {Map<string, Entry>}
 */
export function listMethods(site, kind) {
	const methods = new Map();

	for (const plugin of plugins(site)) {
		for (const { name, file, line, inline } of registered(path.join(site, 'plugins', plugin, 'index.php'), 'plugin')[kind]) {
			methods.set(name, { file, line, inline, source: 'plugin', plugin });
		}
	}

	for (const { name, file, line, inline } of registered(path.join(site, 'config', 'config.php'), 'config')[kind]) {
		methods.set(name, { file, line, inline, source: 'config' });
	}

	return methods;
}

/**
 * @typedef {object} Method
 * @property {string} name
 * @property {string} params
 * @property {string} [returns]
 * @property {string} [description]
 * @property {number} line
 */

/**
 * The public methods a class defines itself (not the inherited ones, and no magic methods)
 * @param {string} file
 * @param {string} [className] the class to read, if the file has more than one
 * @returns {Method[]}
 */
export function classMethods(file, className) {
	const code = read(file);

	if (code === null) {
		return [];
	}

	const classStart = className === undefined ? code.search(/\bclass\s+\w+/) : code.search(new RegExp(`\\bclass\\s+${className}\\b`));

	if (classStart === -1) {
		return [];
	}

	const open = code.indexOf('{', classStart);
	const body = code.slice(0, closingBracket(code, open));
	const lines = code.split('\n');
	const methods = [];

	for (const match of body.slice(open).matchAll(/\n[ \t]*(?:final\s+)?public\s+function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*([\w\\|?]+))?/g)) {
		const line = lineAt(code, open + match.index + 1);

		if (match[1].startsWith('__') === false) {
			methods.push({ name: match[1], params: match[2].replace(/\s+/g, ' ').trim(), returns: match[3], description: docblockAbove(lines, line), line });
		}
	}

	return methods;
}

/**
 * The page models of a site by template: `site/models/<template>.php`, and those
 * plugins register (`'pageModels' => ['order' => OrderPage::class]`, the class looked up in the plugin's PHP files)
 * @param {string} site
 * @returns {Map<string, { file: string, className?: string }>}
 */
export function listModels(site) {
	const models = new Map();

	for (const plugin of plugins(site)) {
		const folder = path.join(site, 'plugins', plugin);

		for (const { name, value } of registered(path.join(folder, 'index.php'), 'plugin').pageModels) {
			const className = value.match(/([\w]+)::class/)?.[1];
			const file = className === undefined ? undefined : phpFiles(folder).map(({ file: candidate }) => candidate).find((candidate) => new RegExp(`\\bclass\\s+${className}\\b`).test(read(candidate) ?? ''));

			if (file !== undefined) {
				models.set(name, { file, className });
			}
		}
	}

	for (const { name, file } of phpFiles(path.join(site, 'models'))) {
		models.set(name, { file });
	}

	return models;
}
