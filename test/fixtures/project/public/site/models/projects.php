<?php

use Kirby\Cms\Page;
use Kirby\Cms\Pages;

class ProjectsPage extends Page
{
	public function featured(): Pages
	{
		return $this->children()->listed();
	}
}
