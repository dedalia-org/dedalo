<?php
/**
* DEDALO_VERSION
* Current Dédalo version
*/
$DEDALO_VERSION = '6.9.7';
if(defined('DEVELOPMENT_SERVER') && DEVELOPMENT_SERVER===true) {
	$DEDALO_VERSION .= '.dev';
}
define('DEDALO_VERSION'	, $DEDALO_VERSION);
define('DEDALO_BUILD'	, '2026-11-11T13:04:59+01:00');
define('DEDALO_MAJOR_VERSION', '6');
