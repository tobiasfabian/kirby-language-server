<?php

return function ($site) {
	return [
		'navigation' => $site->children()->listed(),
	];
};
