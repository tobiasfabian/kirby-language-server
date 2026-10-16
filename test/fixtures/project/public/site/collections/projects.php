<?php

use Kirby\Cms\Pages;
use Kirby\Cms\Site;

return function (Site $site): Pages {
	return $site->children()->listed();
};
