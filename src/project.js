/**
 * Reads what a Kirby project offers from its files.
 * Kirby itself isn't started, so this works without PHP.
 */

import fs from 'node:fs';
import path from 'node:path';
import { arrayEntries, lineAt, pluginArray, returnedArray, stringsIn } from './php.js';

const SKIP = new Set(['.git', 'node_modules', 'vendor', 'kirby', 'content', 'media', 'assets', 'cache', 'sessions', 'accounts', 'logs']);
const SITE_FOLDERS = ['snippets', 'templates', 'blueprints'];

/**
 * @typedef {object} Entry
 * @property {string} file
 * @property {number} line 0-based line where it's defined
 * @property {'site' | 'plugin' | 'config' | 'kirby'} source
 * @property {string} [plugin] folder name of the plugin
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
 * Lists the PHP files below a folder, named by their path without `.php`
 * @param {string} folder
 * @returns {{ name: string, file: string }[]}
 */
function phpFiles(folder) {
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
			} else if (entry.name.endsWith('.php') === true) {
				const name = path.relative(folder, file).slice(0, -4).split(path.sep).join('/');
				files.push({ name, file });
			}
		}
	}

	walk(folder);

	return files;
}

/**
 * Reads the snippets and collections a plugin (`index.php`) or the config
 * (`config.php`, under `'extensions'`) registers
 * @param {string} file
 * @param {'plugin' | 'config'} type
 * @returns {{ snippets: { name: string, file: string, line: number }[], collections: { name: string, file: string, line: number }[] }}
 */
function registered(file, type) {
	const result = { snippets: [], collections: [] };
	let code;

	try {
		code = fs.readFileSync(file, 'utf8');
	} catch {
		return result;
	}

	const start = type === 'plugin' ? pluginArray(code) : returnedArray(code);

	if (start === -1) {
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

	for (const kind of ['snippets', 'collections']) {
		const list = entries.find((entry) => entry.key === kind);

		if (list === undefined || code[list.valueStart] !== '[') {
			continue;
		}

		for (const item of arrayEntries(code, list.valueStart)) {
			// A path to a file (`__DIR__ . '/x.php'`, `require 'x.php'`), or a closure defined right here
			const target = code.slice(item.valueStart, item.valueEnd).match(/['"]([^'"]+\.php)['"]/);

			result[kind].push(target === null
				? { name: item.key, file, line: lineAt(code, item.keyStart) }
				: { name: item.key, file: path.join(path.dirname(file), target[1].replace(/^\//, '')), line: 0 });
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
 * Returns how a collection is defined: its closure's signature,
 * e.g. `return function (Site $site): Pages`
 * @param {Entry} collection
 * @returns {string | null}
 */
export function collectionSignature(collection) {
	const lines = collection.line > 0 ? head(collection.file).slice(collection.line, collection.line + 1) : head(collection.file);

	for (const line of lines) {
		// From `return` or `function`/`fn` up to the return type, without the body
		const match = line.match(/(?:return\s+)?(?:static\s+)?(?:function|fn)\s*\([^)]*\)(?:\s*:\s*[\w\\|?]+)?/);

		if (match !== null) {
			return match[0];
		}
	}

	return null;
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
