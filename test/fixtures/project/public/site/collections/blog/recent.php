<?php

return fn (Kirby\Cms\Site $site) => $site->children()->limit(3);
