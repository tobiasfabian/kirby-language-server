<?php

return [
	'debug' => false,
	'extensions' => [
		'collections' => [
			'team' => fn () => site()->children(),
		],
		'translations' => [
			'de' => [
				'footer.copyright' => '© Beispiel',
			],
		],
	],
];
