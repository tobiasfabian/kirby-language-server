<?php

return function ($page) {
	return [
		'cover' => $page->cover()->toFile(),
	];
};
