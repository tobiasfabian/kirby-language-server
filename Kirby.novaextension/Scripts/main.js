/**
 * Starts the Kirby language server for PHP files.
 * The server runs on Node.js, which is found through the login shell,
 * so a node installed with nvm or Homebrew works without configuration.
 */

const NODE_PATH = 'tobiasfabian.kirby.nodePath';

let client = null;

/**
 * Shows an error the user should see, not only in the Extension Console
 * @param {string} message
 */
function showError(message) {
	console.error('Kirby: ' + message);

	const request = new NotificationRequest('tobiasfabian-kirby-error');
	request.title = 'Kirby language server';
	request.body = message;
	nova.notifications.add(request);
}

/**
 * Finds node: the configured path, otherwise what the login shell finds
 * @returns {Promise<string>}
 */
function findNode() {
	const configured = (nova.config.get(NODE_PATH, 'string') || '').trim();

	if (configured !== '') {
		// Nova doesn't expand ~ in config paths
		return Promise.resolve(nova.path.expanduser(configured));
	}

	return new Promise((resolve, reject) => {
		const shell = nova.environment.SHELL || '/bin/zsh';
		const process = new Process(shell, { args: ['-ilc', 'command -v node'] });
		let output = '';

		// Process events are methods, not properties
		process.onStdout((line) => {
			output += line + '\n';
		});

		process.onDidExit((status) => {
			const path = output.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('/')).pop();

			if (status === 0 && path !== undefined) {
				resolve(path);
			} else {
				reject(new Error('Node.js not found. Install it or set its path in the extension settings.'));
			}
		});

		process.start();
	});
}

/**
 * Starts the language server with the given node
 * @param {string} node
 */
function start(node) {
	client = new LanguageClient(
		'tobiasfabian.kirby',
		'Kirby',
		{
			type: 'stdio',
			path: node,
			args: [nova.path.join(nova.extension.path, 'Server', 'server.cjs'), '--stdio'],
		},
		{
			syntaxes: ['php', 'yaml'],
			// Nova asks only the first language server of a language for Go to Definition and
			// hover. In PHP that must stay Intelephense; Open Referenced File covers PHP.
			initializationOptions: { navigation: ['yaml'] },
		},
	);

	client.onDidStop((error) => {
		if (error) {
			showError('The language server stopped: ' + error.message);
		}
	});

	client.start();
	console.log('Kirby: language server started with ' + node);
}

/**
 * Opens the snippet, collection or translation under the cursor.
 * Nova sends Jump to Definition in PHP files only to the Intelephense
 * extension, and ⌘-click on strings to no server at all, so this command
 * asks the Kirby server directly.
 * @param {TextEditor} editor
 */
async function openAtCursor(editor) {
	if (client === null) {
		showError('The language server is not running.');
		return;
	}

	const lines = editor.document.getTextInRange(new Range(0, editor.selectedRange.start)).split('\n');
	const position = { line: lines.length - 1, character: lines[lines.length - 1].length };

	const result = await client.sendRequest('textDocument/definition', {
		textDocument: { uri: editor.document.uri },
		position,
	});

	// A Location, or a list of LocationLinks
	const target = Array.isArray(result) ? result[0] : result;

	if (!target) {
		nova.workspace.showInformativeMessage('There is no known snippet, collection or translation at the cursor.');
		return;
	}

	const range = target.targetSelectionRange ?? target.range;

	// Collections defined as a closure in a plugin sit on a line of their own
	nova.workspace.openFile(target.targetUri ?? target.uri, { line: range.start.line + 1 });
}

function stop() {
	if (client !== null) {
		client.stop();
		client = null;
	}
}

async function restart() {
	stop();

	try {
		start(await findNode());
	} catch (error) {
		showError(error.message);
	}
}

exports.activate = function () {
	restart();
	nova.config.onDidChange(NODE_PATH, restart);
	nova.commands.register('tobiasfabian.kirby.open', openAtCursor);
};

exports.deactivate = function () {
	stop();
};
