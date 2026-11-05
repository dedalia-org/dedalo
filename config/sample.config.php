<?php
################################################################
################### DEDALO VERSION 6 ###########################
################################################################
/*
	UNDER GNU PUBLIC LICENSE
	http://www.gnu.org/licenses/licenses.es.html
	Versión 4, 14 de Marzo de 2012 / 21 Abril 2015

	Juan Francisco Onielfa Veneros
	Alejandro Peña Carbonell
	https://dedalo.dev

	Reviewed: 17-05-2022
*/



// duplicity check
	if (defined('DEDALO_ROOT_PATH')) {
		throw new Exception("Error Processing Request: config file is already included!", 1);
	}



// dedalo paths
	// xx_PATH is absolute system path like '/user/httpdocs/dedalo/core'
	// xx_WEB is relative url path (to current dedalo url dir, often 'dedalo') like '/dedalo/core'

	// host
		define('DEDALO_HOST', php_sapi_name()==='cli'
			? 'localhost'
			: $_SERVER['HTTP_HOST'] ?? ''
		);
		define('DEDALO_PROTOCOL', (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS']==='on') ? 'https://' : 'http://');

	// root paths
		define('DEDALO_ROOT_PATH',	dirname(__FILE__, 2));
		define('DEDALO_ROOT_WEB',	php_sapi_name()==='cli'
			? '/dedalo'
			: '/' . explode('/', $_SERVER["REQUEST_URI"])[1]
		);

	// base paths
		define('DEDALO_CONFIG',	'config');
		define('DEDALO_CORE',	'core');
		define('DEDALO_SHARED',	'shared');
		define('DEDALO_TOOLS',	'tools');
		define('DEDALO_LIB',	'lib');

	// config
		define('DEDALO_CONFIG_PATH',	DEDALO_ROOT_PATH .'/'. DEDALO_CONFIG );

	// core
		define('DEDALO_CORE_PATH',		DEDALO_ROOT_PATH .'/'. DEDALO_CORE);
		define('DEDALO_CORE_URL',		DEDALO_ROOT_WEB .'/'. DEDALO_CORE );

	// shared
		define('DEDALO_SHARED_PATH',	DEDALO_ROOT_PATH .'/'. DEDALO_SHARED);
		define('DEDALO_SHARED_URL',		DEDALO_ROOT_WEB  .'/'. DEDALO_SHARED );

	// tools
		define('DEDALO_TOOLS_PATH',		DEDALO_ROOT_PATH .'/'. DEDALO_TOOLS);
		define('DEDALO_TOOLS_URL',		DEDALO_ROOT_WEB .'/'. DEDALO_TOOLS );

	// lib
		define('DEDALO_LIB_PATH',		DEDALO_ROOT_PATH .'/'. DEDALO_LIB);
		define('DEDALO_LIB_URL',		DEDALO_ROOT_WEB .'/'. DEDALO_LIB );

	// widgets
		define('DEDALO_WIDGETS_PATH',	DEDALO_CORE_PATH . '/widgets');
		define('DEDALO_WIDGETS_URL',	DEDALO_CORE_URL . '/widgets');

	// extras
		define('DEDALO_EXTRAS_PATH',	DEDALO_CORE_PATH . '/extras');
		define('DEDALO_EXTRAS_URL',		DEDALO_CORE_URL . '/extras');

	// install
		define('DEDALO_INSTALL_PATH',	DEDALO_ROOT_PATH . '/install');
		define('DEDALO_INSTALL_URL',	DEDALO_ROOT_WEB . '/install');

	// Work API
		define('DEDALO_API_URL',		DEDALO_CORE_URL . '/api/v1/json/');

// Dedalo information
	// string to use in Dédalo cryptography
	define('DEDALO_SALT_STRING', 'dedalo_six');



// time zone (for backups archive names)
	define('DEDALO_TIMEZONE', 'Europe/Madrid');
	date_default_timezone_set(DEDALO_TIMEZONE);



// locale options
	// set locale ('en_ES' Spanish for example) es_ES | en_EN | ...
	// For Mac, use format as 'es_ES'. For Linux as 'es_ES.utf8'
	define('DEDALO_LOCALE', 'es-ES');
	setlocale(LC_ALL, DEDALO_LOCALE);
	// date order, used to input and output dates in different order
	// options:
	// dmy = common way order day/moth/year
	// mdy = USA way order moth/day/year
	// ymd = China, Japan, Korean, Iran way year/month/day
	define('DEDALO_DATE_ORDER', 'dmy');



// internal encoding
	mb_internal_encoding('UTF-8');



// dedalo entity
	// dedalo_entity string. Do not use here spaces or non ASCII chars
	define('DEDALO_ENTITY', 'my_entity_name'); // Like 'dedalo4'
	// dedalo_entity_label . (Showed title of html pages)
	define('DEDALO_ENTITY_LABEL', DEDALO_ENTITY);
	// dedalo_entity_id . (From Dédalo private list. You need to be register before but it's not mandatory fill this)
	define('DEDALO_ENTITY_ID', 0);
	// development_server. Default is false
	define('DEVELOPMENT_SERVER', false);



// required files
	// core_functions. Basic common functions (before session start)
	include(DEDALO_SHARED_PATH . '/core_functions.php');
	// config_core. core definitions and status.
	include(DEDALO_CONFIG_PATH . '/config_core.php');
	// config_db. Dédalo PostgreSQL and MariaDB config file
	include(DEDALO_CONFIG_PATH . '/config_db.php');
	// dd_tipos. List of main Dédalo resolved tipos
	include(DEDALO_CORE_PATH . '/base/dd_tipos.php');
	// version. Info about current version and build
	include(DEDALO_CORE_PATH . '/base/version.inc');



// SESSIONS
	define('DEDALO_SESSIONS_PATH', dirname(DEDALO_ROOT_PATH, 2) . '/sessions');

	if (session_status()!==PHP_SESSION_ACTIVE) {

		// HANDLER
		$SESSION_HANDLER = 'files';	// files | memcached | user | postgresql
		define('DEDALO_SESSION_HANDLER', $SESSION_HANDLER);

		// LIFETIME
		// Set max duration of dedalo user session
		// Use ini directive to set session.gc_maxlifetime (Garbage Collection lifetime)
		// Use session_cache_expire to set duration of session
		// Set duration max of session data in hours (default 8 hours)
		// Set before session start
		$session_duration_hours	= $session_duration_hours ?? 8;
		$timeout_seconds		= intval($session_duration_hours*3600); // in seconds

		// session start
		$cookie_secure		= (DEDALO_PROTOCOL==='https://');
		$cookie_samesite	= (DEVELOPMENT_SERVER===true) ? 'Lax' : 'Strict';
		session_start_manager([
			'save_handler'				=> 'files',
			'timeout_seconds'			=> $timeout_seconds,
			'save_path'					=> DEDALO_SESSIONS_PATH,
			// 'additional_save_path'	=> false, bool optional
			'prevent_session_lock'		=> defined('PREVENT_SESSION_LOCK') ? PREVENT_SESSION_LOCK : false,
			'session_name'				=> 'dedalo_'.DEDALO_ENTITY,
			// cookie params
			'cookie_secure'				=> $cookie_secure, // Only https (true | false)
			'cookie_samesite'			=> $cookie_samesite // (None | Lax | Strict)
		]);
	}//end if (session_status()!==PHP_SESSION_ACTIVE)



// cache
	// dedalo_cache_manager. bool|array.
	// Default manager: files : write cache files with complex resolved data of current logged user (like profiles)
	// sample: value ['manager' => 'files', 'files_path' => '/tmp']
	define('DEDALO_CACHE_MANAGER', [
		'manager'		=> 'files',
		'files_path'	=> DEDALO_SESSIONS_PATH
	]);



// show_debug
	if (!defined('SHOW_DEBUG')) {
		// Application debug config. When the user is DEDALO_SUPERUSER it is active by default, otherwise it is not active.
		define('SHOW_DEBUG', (logged_user_id()==DEDALO_SUPERUSER)
			? true
			: false // default false
		);
	}



// is_developer
	// Logged user is developer value. Depends of user config 'is_developer' value from database (user section)
	define('SHOW_DEVELOPER', (logged_user_is_developer()===true)
		? true
		: false // default false
	);



// loader
	// auto load main classes and manages classes calls
	include DEDALO_CORE_PATH . '/base/class.loader.php';



// backup : Automatic backups control
	// DEDALO_BACKUP_ON_LOGIN : true / false
	define('DEDALO_BACKUP_ON_LOGIN', true);
	// DEDALO_BACKUP_TIME_RANGE Minimum lapse of time (in hours) for run backup script again. Default: (int) 8
	// Note that backups are fired in background when user is logging when the time lapse is bigger than this value
	define('DEDALO_BACKUP_TIME_RANGE', 8);
	// backups paths. Keep the backup directory outside the scope of httpdocs for security reasons.
	define('DEDALO_BACKUP_PATH',			dirname(DEDALO_ROOT_PATH, 2) . '/backups');
	define('DEDALO_BACKUP_PATH_TEMP',		DEDALO_BACKUP_PATH . '/temp');
	define('DEDALO_BACKUP_PATH_DB',			DEDALO_BACKUP_PATH . '/db');
	define('DEDALO_BACKUP_PATH_ONTOLOGY',	DEDALO_BACKUP_PATH . '/ontology');



// log and errors : Store application activity data info and errors to DDBB
	// server error log logger_level. Default: ERROR (will be ignored when SHOW_DEBUG===true)
	// Note that log outputs to be the php.ini error_log config file like '/var/log/fpm-php.log'
	// You can view the server log using terminal command 'tail -f /var/log/php_errors.log' with your own log path
		// level error codes
		// DEBUG	= 100;
		// INFO		= 75;
		// NOTICE	= 50;
		// WARNING	= 25;
		// ERROR	= 10;
		// CRITICAL	= 5;
		define('LOGGER_LEVEL', (SHOW_DEBUG===true || SHOW_DEVELOPER===true)
			? logger::DEBUG // log all messages
			: logger::ERROR // log only errors
		);
	// matrix_activity log db. Manages log write to the table
		// Log application info in db
		logger::register('activity'	, 'activity://auto:auto@auto:5432/log_data?table=matrix_activity');
		// Store object in logger static array var
		logger::$obj['activity'] = logger::get_instance('activity');
	// update log. Administration update data version action, write status info to this file
		// Default dir is inside Dédalo config folder (web read is forbidden) but you can
		// use another more private dir outside httpdocs folder
		define('UPDATE_LOG_FILE', DEDALO_CONFIG_PATH . '/update.log');



// lang
	// dedalo structure (Ontology) lang. Ontology lang default is 'lg-spa'. Do not change this value !
	define('DEDALO_STRUCTURE_LANG', 'lg-spa'); // only 'lg-spa' is accepted now
	// dedalo_application_langs
	define('DEDALO_APPLICATION_LANGS', [
		'lg-eng'	=> 'English',
		'lg-spa'	=> 'Castellano',
		'lg-cat'	=> 'Català',
		'lg-eus'	=> 'Euskara',
		'lg-fra'	=> 'Français',
		'lg-por'	=> 'Português',
		'lg-deu'	=> 'Deutsch',
		'lg-ita'	=> 'Italiano',
		'lg-ell'	=> 'Ελληνικά',
		'lg-nep'	=> 'नेपाली'
	]);
	// dedalo_application_langs_default. The default lang used when is not set
	define('DEDALO_APPLICATION_LANGS_DEFAULT', 'lg-eng');
	// dedalo_application_lang. Current Dédalo application lang (cascade calculate from get, post, session vars, default)
	define('DEDALO_APPLICATION_LANG',			fix_cascade_config_var('dedalo_application_lang',DEDALO_APPLICATION_LANGS_DEFAULT));
	// dedalo_data_lang
	define('DEDALO_DATA_LANG_DEFAULT',			'lg-eng');
	define('DEDALO_DATA_LANG',					fix_cascade_config_var('dedalo_data_lang',DEDALO_DATA_LANG_DEFAULT));
	// dedalo_data_lang_selector. Show/hide menu data lang selector. bool default true
	define('DEDALO_DATA_LANG_SELECTOR',			true);
	// dedalo_data_lang_sync. When set to ' true', it forces to keep DEDALO_APPLICATION_LANG and DEDALO_DATA_LANG synchronized.
	define('DEDALO_DATA_LANG_SYNC',				false);
	// dedalo_data_nolan. string default 'lg-nolan'. Do not change this
	define('DEDALO_DATA_NOLAN',					'lg-nolan');
	// Projects langs
	define('DEDALO_PROJECTS_DEFAULT_LANGS',		[
		'lg-spa',
		'lg-cat',
		'lg-eng',
		'lg-fra'
	]);
	// dedalo_diffusion_langs. Default value is the same as project langs. Change for custom diffusion langs
	define('DEDALO_DIFFUSION_LANGS', DEDALO_PROJECTS_DEFAULT_LANGS);



// dedalo default config values
	// dedalo_prefix_tipos. Array of main active tipos of the ontology to be imported and managed by Dédalo.
	// mandatory: ['dd','rsc','hierarchy','lg','nexus']
	// optional: ['test']
	define('DEDALO_PREFIX_TIPOS', [
		'dd',
		'rsc',
		'ontology',
		'hierarchy',
		'lg',
		'utoponymy',
		'oh',
		'ich',
		'nexus',
		'actv'
	]);
	// main_fallback_section. Default section tipo to go when it's not defined any
	define('MAIN_FALLBACK_SECTION', 'oh1'); // go after login (tipo inventory)
	// numerical matrix values of list of values 'yes/no'. Do not change this values !
	define('NUMERICAL_MATRIX_VALUE_YES', 1);
	define('NUMERICAL_MATRIX_VALUE_NO',  2);
	// dedalo_max_rows_per_page . Default max record per page. int default 10
	define('DEDALO_MAX_ROWS_PER_PAGE', 10);
	// user profile by default. Default profile id. int default 2 (regular user)
	define('DEDALO_PROFILE_DEFAULT', 2);
	// dedalo_default_project. Default section_id of target filter section. int default 1
	define('DEDALO_DEFAULT_PROJECT', 1);
	// dedalo_filter_section_tipo_default. Target filter section (current 'dd153' - Projects section). Do not change this
	define('DEDALO_FILTER_SECTION_TIPO_DEFAULT', DEDALO_SECTION_PROJECTS_TIPO);
	// defaults (optional, disable)
	// optional defaults values of components
		// array of objects, every object is a default that will apply to the component defined.
		// Is possible add multiple defaults for different components as:
		// [{
		//	"tipo": "rsc279",
		//	"type": "component",
		//	"tld": "rsc",
		//	"value": [
		//		{
		//			"section_id": "2",
		//			"section_tipo": "dd64"
		//		}
		//	]
		// }]
		//define('CONFIG_DEFAULT_FILE_PATH', DEDALO_CONFIG_PATH .'/config_defaults.json');



// media config
	// media_base paths
	define('DEDALO_MEDIA_PATH',	DEDALO_ROOT_PATH	. '/media');
	define('DEDALO_MEDIA_URL',	DEDALO_ROOT_WEB		. '/media');

	// thumb common
		// this part is used by all components to create and show thumbs images
		// thumb_extension.  Default: 'jpg'
		define('DEDALO_THUMB_EXTENSION',			'jpg');
		// dedalo_thumb_default. Default: 'thumb')
		define('DEDALO_QUALITY_THUMB',				'thumb');
		// thumbs dedalo_image_thumb sizes. Integer as pixels
		define('DEDALO_IMAGE_THUMB_WIDTH',			222);	// int Default 102 | 222
		define('DEDALO_IMAGE_THUMB_HEIGHT',			148);	// int Default 57 | 148

	// av media
		// dedalo_av_folder. string default '/av'
		define('DEDALO_AV_FOLDER',					'/av');
		// dedalo_av_extension string default 'mp4'
		define('DEDALO_AV_EXTENSION',				'mp4');
		// dedalo_av_extensions_supported. array default ['mp4','wave','wav','aiff','aif','mp3','mov','avi','mpg','mpeg','vob','zip','flv']
		define('DEDALO_AV_EXTENSIONS_SUPPORTED',	['mp4','wave','wav','aiff','aif','mp3','mov','avi','mpg','mpeg','vob','zip','flv']);
		// dedalo_av_mime_type. string default 'video/mp4'
		define('DEDALO_AV_MIME_TYPE',				'video/mp4');
		// dedalo_av_type. string default 'h264/AAC'
		define('DEDALO_AV_TYPE',					'h264/AAC');
		// dedalo_av_quality_original. string default 'original'
		define('DEDALO_AV_QUALITY_ORIGINAL',		'original');
		// quality default normally '404' (standard dedalo 72x404)
		define('DEDALO_AV_QUALITY_DEFAULT',			'404');
		// quality folders array normally '404','audio' (sort desc quality)
		define('DEDALO_AV_AR_QUALITY',				[DEDALO_AV_QUALITY_ORIGINAL,'1080','720','576','404','240','audio']);

		// av_posterframe_extension normally 'jpg'
		define('DEDALO_AV_POSTERFRAME_EXTENSION',	'jpg');
		// ffmpeg path normally /usr/bin/ffmpeg
		define('DEDALO_AV_FFMPEG_PATH',				'/usr/bin/ffmpeg');
		// ffmpeg_settings (quality conversion and aspect ratio definitions)
		define('DEDALO_AV_FFMPEG_SETTINGS',			DEDALO_CORE_PATH . '/media_engine/lib/ffmpeg_settings');
		// av_faststart_path normally /usr/bin/qt-faststart
		define('DEDALO_AV_FASTSTART_PATH',			'/usr/bin/qt-faststart');
		// av_ffprobe_path normally /usr/bin/ffprobe
		define('DEDALO_AV_FFPROBE_PATH',			'/usr/bin/ffprobe');
		// av_streamer. Optional media streamer. Default is null
		define('DEDALO_AV_STREAMER',				null);
		// av_watermark_file
		define('DEDALO_AV_WATERMARK_FILE',			DEDALO_MEDIA_PATH .'/'. DEDALO_AV_FOLDER . '/watermark/watermark.png');
		// dedalo_subtitles_folder (tool_subtitles)
		define('DEDALO_SUBTITLES_FOLDER',			'/subtitles');
		// dedalo_av_subtitles_extension . Default is 'vtt'
		define('DEDALO_AV_SUBTITLES_EXTENSION',		'vtt');
		// dedalo_av_recompress_all. On 1, all video files are re-compressed to 960k/s variable bit rate and keyframe every 75 frames
		define('DEDALO_AV_RECOMPRESS_ALL',			1); // 1 re-compress all av files uploaded, 0 to only copy av files uploaded (default 0)
		// Optional Extensions list of preferable extensions in original or modified qualities.
		// define('DEDALO_AV_BEST_EXTENSIONS',		['mov','wave','wav','aiff','aif']);

	// image media
		// image_folder. Default: '/image'
		define('DEDALO_IMAGE_FOLDER',				'/image');
		// image_extension.  Default: 'jpg'
		define('DEDALO_IMAGE_EXTENSION',			'jpg');
		// image_mime_type. Default: 'image/jpeg'
		define('DEDALO_IMAGE_MIME_TYPE',			'image/jpeg');
		// image_type. Default: 'jpeg'
		define('DEDALO_IMAGE_TYPE',					'jpeg');
		// image_extensions_supported. Array default: ['jpg','jpeg','png','tif','tiff','bmp','psd','raw','webp','heic']
		define('DEDALO_IMAGE_EXTENSIONS_SUPPORTED', ['jpg','jpeg','png','tif','tiff','bmp','psd','raw','webp','heic','avif']);
		// image_alternative_extensions. Optional array with the optional compression format extensions like ['avif','png']
		define('DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS', []);
		// image_quality_original. Default: 'original'
		define('DEDALO_IMAGE_QUALITY_ORIGINAL',		'original');
		// image_quality_retouched of original. Default: 'modified' ('modificada' in old versions)
		define('DEDALO_IMAGE_QUALITY_RETOUCHED',	'modified');
		// quality default. Default: '1.5MB'
		define('DEDALO_IMAGE_QUALITY_DEFAULT',		'1.5MB');
		// image_ar_quality. Array of image quality specifications like [DEDALO_IMAGE_QUALITY_ORIGINAL,DEDALO_IMAGE_QUALITY_DEFAULT,'<1MB',DEDALO_QUALITY_THUMB]
		define('DEDALO_IMAGE_AR_QUALITY',			[DEDALO_IMAGE_QUALITY_ORIGINAL,DEDALO_IMAGE_QUALITY_RETOUCHED,'100MB','25MB','6MB','1.5MB',DEDALO_QUALITY_THUMB]);
		// image_print_dpi (default int 150. Used to calculate print size of images -tool_image_versions-)
		define('DEDALO_IMAGE_PRINT_DPI',			150);
		// image_file_url
		define('DEDALO_IMAGE_FILE_URL',				DEDALO_CORE_URL . '/media_engine/img.php');
		// lib ImageMagick magick_path
		define('MAGICK_PATH',						'/usr/bin/'); // Like '/usr/bin/';
		// ImageMagick config
		define('MAGICK_CONFIG', [
			// Transparent tiff, remove the layer 0 (flat composition layer)
				// see: /core/media_engine/class.ImageMagick.php -> convert()
				// Ubuntu : false | don't remove the composition layer, because it delete the color layers (the image disappear)
				// Rocky, RedHat, MacOS: true | remove the composition layer, because it has the flat image with background color and it doesn't preserve the transparency
			'remove_layer_0' => false, // default false
			// set a fixed value for transparent images
				// Rocky, RedHat | set it as false | active the property, it set that all images are transparent (is_opaque = false), Rocky version of ImageMagick can not detect if the image has transparent pixels
				// Ubuntu, MacOs | set it as null | remove the property, it will check if the image has a transparent pixels correctly.
			'is_opaque' => null // default null, if isset as false, all images will be processed as transparent, if isset as true, all images will be processed as opaque.
		]);
		// color_profiles_path
		define('COLOR_PROFILES_PATH',				DEDALO_CORE_PATH . '/media_engine/lib/color_profiles_icc/');
		// thumbs dedalo_image_thumb sizes. Integer as pixels
		// define('DEDALO_IMAGE_THUMB_WIDTH',			222);	// int Default 102 | 222
		// define('DEDALO_IMAGE_THUMB_HEIGHT',			148);	// int Default 57 | 148
		// image_web_folder normally '/web' Used to save uploaded files from component_html_text
		define('DEDALO_IMAGE_WEB_FOLDER',			'/web');
		// Optional Extensions list of preferable extensions in original or modified qualities.
		// define('DEDALO_IMAGE_BEST_EXTENSIONS',		['tif','tiff','psd']);

	// pdf media
		// pdf_folder. Default '/pdf'
		define('DEDALO_PDF_FOLDER',					'/pdf');
		// pdf_extension normally 'pdf'
		define('DEDALO_PDF_EXTENSION',				'pdf');
		// pdf_extensions_supported. Array default: ['pdf']
		define('DEDALO_PDF_EXTENSIONS_SUPPORTED',	['pdf','doc','pages','odt','ods','rtf','ppt','pages']);
		// dedalo_pdf_alternative_extensions. Array with the optional compression formats extension
		// Allows you to create image versions of the PDF, useful for previews or web versions
		define('DEDALO_PDF_ALTERNATIVE_EXTENSIONS', ['jpg']);
		// pdf_mime_type. Default: 'application/pdf'
		define('DEDALO_PDF_MIME_TYPE',				'application/pdf');
		// pdf_type. Default: 'pdf'
		define('DEDALO_PDF_TYPE',					'pdf');
		// dedalo_pdf_quality_original. string default 'original'
		define('DEDALO_PDF_QUALITY_ORIGINAL',		'original');
		// pdf_quality_default. Default: 'web'
		define('DEDALO_PDF_QUALITY_DEFAULT',		'web');
		// pdf_ar_quality. Array of PDF quality definitions
		define('DEDALO_PDF_AR_QUALITY',				[DEDALO_PDF_QUALITY_ORIGINAL, DEDALO_PDF_QUALITY_DEFAULT]);
		// pdf_renderer (path of daemon pdf generator from html) Normally wkhtmltopdf (https://wkhtmltopdf.org) lib is used
		// define('DEDALO_PDF_RENDERER',				'/usr/bin/wkhtmltopdf');
		// automatic_transcription_engine (path of daemon generator of text files from PDF) Using XPDF from http://www.foolabs.com/xpdf/ or https://pdftotext.com
		define('PDF_AUTOMATIC_TRANSCRIPTION_ENGINE','/usr/bin/pdftotext');
		// OCR engine (path of daemon of OCR) Using ocrmypdf https://ocrmypdf.readthedocs.io/en/latest/index.html
		// define('PDF_OCR_ENGINE',					'/usr/bin/ocrmypdf');

	// 3d media
		// dedalo_3d_foler. string default '/3d'
		define('DEDALO_3D_FOLDER',					'/3d');
		// dedalo_3d_extension. string default 'glb'
		define('DEDALO_3D_EXTENSION',				'glb');
		// dedalo_3d_extensions_supported. array default ['glb', 'gltf', 'obj', 'fbx', 'dae', 'zip']
		define('DEDALO_3D_EXTENSIONS_SUPPORTED',	['glb', 'gltf', 'obj', 'fbx', 'dae', 'zip']);
		// dedalo_3d_mime_type. string default 'model/gltf+json'
		define('DEDALO_3D_MIME_TYPE',				'model/gltf-binary');
		// dedalo_3d_quality_original. string default 'original'
		define('DEDALO_3D_QUALITY_ORIGINAL',		'original');
		// quality default normally 'web'
		define('DEDALO_3D_QUALITY_DEFAULT',			'web');
		// Thumbs folders to store 1 render of the 3d file, used in list
		define('DEDALO_3D_THUMB_DEFAULT',			'thumb');
		// quality folders array (sort desc quality)
		define('DEDALO_3D_AR_QUALITY',				[DEDALO_3D_QUALITY_ORIGINAL, DEDALO_3D_QUALITY_DEFAULT]);
		// dedalo_3d_gltfpack_path normally /usr/local/bin/gltfpack or /opt/gltfpack (converts and compresses .obj/.gltf to .glb/.gltf)
		define('DEDALO_3D_GLTFPACK_PATH',			'/usr/local/bin/gltfpack');
		// dedalo_3d_fbx2gltf_path normally /usr/local/bin/FBX2glTF or /opt/FBX2glTF (converts .fbx to .glb/.gltf)
		define('DEDALO_3D_FBX2GLTF_PATH',			'/usr/local/bin/FBX2glTF');
		// dedalo_3d_collada2gltf_path normally /usr/local/bin/COLLADA2GLTF-bin or /opt/COLLADA2GLTF-bin (converts .dae to .glb/.gltf)
		define('DEDALO_3D_COLLADA2GLTF_PATH',		'/usr/local/bin/COLLADA2GLTF-bin');

	// svg media
		// svg_folder. Default: '/svg'
		define('DEDALO_SVG_FOLDER',					'/svg');
		// svg_extension normally 'svg'
		define('DEDALO_SVG_EXTENSION',				'svg');
		// svg_extensions_supported. Default ['svg']
		define('DEDALO_SVG_EXTENSIONS_SUPPORTED',	['svg']);
		// svg_mime_type. Default 'image/svg+xml'
		define('DEDALO_SVG_MIME_TYPE',				'image/svg+xml');
		// svg_quality_original. Default 'original'
		define('DEDALO_SVG_QUALITY_ORIGINAL',		'original');
		// svg_quality_default. Default 'web'
		define('DEDALO_SVG_QUALITY_DEFAULT',		'web');
		// svg_ar_quality
		define('DEDALO_SVG_AR_QUALITY',				[DEDALO_SVG_QUALITY_ORIGINAL, DEDALO_SVG_QUALITY_DEFAULT]);

	// html_files
		define('DEDALO_HTML_FILES_FOLDER',			'/html_files');
		define('DEDALO_HTML_FILES_EXTENSION',		'html');



// upload config
	// DEDALO_UPLOAD_TMP_DIR
	// it defines the temporary directory to use to store the files uploaded, moved from php/tmp upload directory
	define('DEDALO_UPLOAD_TMP_DIR',	DEDALO_MEDIA_PATH . '/upload/service_upload/tmp');
	define('DEDALO_UPLOAD_TMP_URL',	DEDALO_MEDIA_URL  . '/upload/service_upload/tmp');
	// DEDALO_UPLOAD_SERVICE_CHUNK_FILES
	// split files into chunks before upload at max size defined
	// values supported:
	// bool: false -> the files will not chunked
	// int: 95 -> files will be chunked in xMB fragments. 95MB files
	define('DEDALO_UPLOAD_SERVICE_CHUNK_FILES', 4); // 5 = 5MB
	// DEDALO_UPLOAD_SERVICE_MAX_CONCURRENT
	// Used to limit the maximum request that client can open to the server when the uploaded file is chunked
	// in HTTP1.1 connections the limit is 4 request and is not possible to change it.
	// in HTTP2 connections is not limited and can overload the server, this param set a valid upload request that servers can handle.
	define('DEDALO_UPLOAD_SERVICE_MAX_CONCURRENT', 50); // 50 chunk request simultaneous.


// geo location. string from values: OSM | ARCGIS | GOOGLE | VARIOUS | ARCGIS . Default: 'VARIOUS'
	define('DEDALO_GEO_PROVIDER', 'VARIOUS');



// media entity menu config
	// DEDALO_ENTITY_MEDIA_AREA_TIPO = remove the Real sections from menu ALL sections
	define('DEDALO_ENTITY_MEDIA_AREA_TIPO', '');
	// DEDALO_ENTITY_MENU_SKIP_TIPOS = skip the array of tipos but walk the children, used for groupings that don't want see into the menu "Oral History" "list of values"...
	define('DEDALO_ENTITY_MENU_SKIP_TIPOS', []);



// dedalo_test_install. bool
	// 	On true, check if the root user has set password at login page, if not set Dédalo will init the install process.
	define('DEDALO_TEST_INSTALL', true);



// dedalo_section_id_temp
	// name / prefix of section_id temporal used to store special sections in memory or session. Do not change this
	define('DEDALO_SECTION_ID_TEMP', 'tmp');



// tools vars
	// tool export
	define('DEDALO_TOOL_EXPORT_FOLDER_PATH',			DEDALO_MEDIA_PATH . '/export/files');
	define('DEDALO_TOOL_EXPORT_FOLDER_URL' ,			DEDALO_MEDIA_URL  . '/export/files');
	// tool import
	define('DEDALO_TOOL_IMPORT_DEDALO_CSV_FOLDER_PATH',	DEDALO_MEDIA_PATH . '/import/files');



// lock_components
	// Set lock components function when users are editing fields. boolean
	define('DEDALO_LOCK_COMPONENTS', true);



// protect media files, when active the access to media files are controlled and only register users can access to it.
	define('DEDALO_PROTECT_MEDIA_FILES', false);



// notifications
	// Send notifications to user browser. E.g. Current lock components..
	define('DEDALO_NOTIFICATIONS',	false);



// dedalo_ar_exclude_components
	// optional array of component tipo to exclude
	define('DEDALO_AR_EXCLUDE_COMPONENTS', []);



// dedalo_filter_user_records_by_id
	// Activate user records filter restriction
	define('DEDALO_FILTER_USER_RECORDS_BY_ID', false);



// geonames
	// geonames_account_username. For development only
	// define('GEONAMES_ACCOUNT_USERNAME', 'my_account');



// encryption_mode
	// If not is defined, will be calculated from current Dédalo data version
	define('ENCRYPTION_MODE', 'openssl');



// diffusion
	// string Set publication diffusion domain. Default value is 'default'
	define('DEDALO_DIFFUSION_DOMAIN',			'default');
	// int Set the number of resolution levels we would like to accomplish. Default: 2
	define('DEDALO_DIFFUSION_RESOLVE_LEVELS',	2);
	// bool Defines how the paths of the media files will be treated in diffusion processing. Default: false
	// on true, the paths will be simplified to the file name like 'rsc37_rsc176_34.pdf' from '/dedalo/media/pdf/web/0/rsc37_rsc176_34.pdf'
	define('DEDALO_PUBLICATION_CLEAN_URL',		false);
	// diffusion_custom
	// Optional custom class to manipulate diffusion options. string|bool . Default: false
	define('DIFFUSION_CUSTOM', false);
	// api (publication). This definition is used only in area maintenance to auto-fill main vars
	// Note that in the public server config file, you need to define again this values because
	// the public API files could be place in another location/server as independent files
	define('API_WEB_USER_CODE_MULTIPLE', [
		[
			'db_name'	=> '', // like web_my_entity
			'code'		=> '',  // like asd38kjlkasd6gadsg2fasdoijQks
			'api_ui'	=> null // optional api ui URL. Used only when publication is in another server like 'https://dedalo.dev/dedalo/publication/server_api/v1/docu/ui/'
		]
	]);

	// array exclude_diffusion_elements. Optional
	// It is used for hiding some diffusion elements from the tool_diffusion to prevent users from being confused by databases that are not usable, such as PRE environments.
	// tool_diffusion uses this value as a fallback when the tool configuration does not define a value for this exclusion list.
	// define('EXCLUDE_DIFFUSION_ELEMENTS', []);


// remote_structure_server_code
	define('STRUCTURE_FROM_SERVER',			true);
	// !DEPRECATED
	// define('STRUCTURE_SERVER_CODE',		'x3a0B4Y020Eg9w');
	// !DEPRECATED
	// define('STRUCTURE_SERVER_URL',		'https://master.dedalo.dev/dedalo/core/extras/str_manager/');

	// Ontology server. Defines if the installation server can provide his ontology files to other Dédalo servers.
	define('IS_AN_ONTOLOGY_SERVER',			false);
	// !DEPRECATED
	// defines the valid code for clients to validate to get ontology files.
	// define('ONTOLOGY_SERVER_CODE',		'valid_code');

	// Remote ontology servers.
	// Defines the ontologies providers
	define('ONTOLOGY_SERVERS',	[
		[
			'name'	=> 'Official Dédalo Ontology server',
			'url'	=> 'https://master6.dedalo.dev/dedalo/core/api/v1/json/',
			'code'	=> 'x3a0B4Y020Eg9w'
		]
	]);

	// Directory to backup ontology files
	// !DEPRECATED
	// define('ONTOLOGY_DOWNLOAD_DIR',		DEDALO_BACKUP_PATH_ONTOLOGY . '/download');
	// Directory to manage input/output, export/import ontology data to sync between installations
	define('ONTOLOGY_DATA_IO_DIR',			DEDALO_INSTALL_PATH . '/import/ontology');
	define('ONTOLOGY_DATA_IO_URL',			DEDALO_INSTALL_URL . '/import/ontology');

	// structure_download. When ontology is updated, download files are saved here
	// !DEPRECATED
	// define('STRUCTURE_DOWNLOAD_JSON_FILE',	DEDALO_BACKUP_PATH_ONTOLOGY);

	// SERVER_PROXY Optional IP and port like 'XXX.XXX.XXX.XXX:3128'. Do not remove comment if its not necessary
	// define('SERVER_PROXY', 				'XXX.XXX.XXX.XXX:3128');



// dedalo_code
	// server side (master)

		// Code server. Defines if the installation server can provide new code files to other Dédalo servers.
		// if the server can provide version change to true and uncomment the `DEDALO_CODE_FILES_DIR` and `DEDALO_CODE_FILES_URL`
		define('IS_A_CODE_SERVER',	false);

		// next constants are used in the process to create new versions and provide to clients
		// by default the Dédalo server doesn't provide code to other servers
		// uncomment it they if you want provide code files as mirror of official Dédalo server

		// Directory with the code files to be server as code versions
		// define('DEDALO_CODE_FILES_DIR',			DEDALO_ROOT_PATH . '/code');

		// URL with the code files to be server as code versions
		// define('DEDALO_CODE_FILES_URL',			DEDALO_ROOT_WEB . '/code');

		// Use only for build new version with the git repository
		// server git files (master) like /home/dedalo/master_dedalo.git
		// define('DEDALO_CODE_SERVER_GIT_DIR',	'/my_dedalo_git_directory');

		// Remote code servers.
		// As client:
		// Defines the code provider.
		// As server provider:
		// If your installation will provide dedalo code, the `code` parameter will be used by clients to validate them.
		define('CODE_SERVERS',	[
			[
				'name'	=> 'Official Dédalo code server',
				'url'	=> 'https://master6.dedalo.dev/dedalo/core/api/v1/json/',
				'code'	=> 'x3a0B4Y020Eg9w'
			]
		]);

		// !DEPRECATED
		// target dir where git command send the compressed file like 'https://master.dedalo.dev/dedalo/code/dedalo5_code.zip'
		// define('DEDALO_SOURCE_VERSION_URL',		'https://master.dedalo.dev/dedalo/code/dedalo6_code.zip');

		// target dir where git command send the compressed file like 'https://master.dedalo.dev/dedalo/code/dedalo5_code.zip'
		define('DEDALO_SOURCE_VERSION_LOCAL_DIR',	'/tmp/'.DEDALO_ENTITY);



// login init_cookie_auth
	// Deprecated. Not used here.



// export hierarchy
	// This is ONLY for MASTER ! . Not use for other domains !



// zotero_import
	// Deprecated. Not used here.



// socrata config
	// Custom connection config. Not used here.



// saml config
	// Custom connection config. Not used here.



// mailer
	// Custom connection config. Not used here.



// IP_API. IP geolocation API end point. Optional, used in section Activity to resolve source Country from IP address
// note that '$ip' string will be replaced by the real IP value in resolution and 'country_code' value
// property is used to generate the icon flag
	// ip-api.com **
		// define('IP_API', [
		// 	'url'			=> 'http://ip-api.com/json/$ip', // only http is free
		// 	'href'			=> 'https://ip-api.com/#$ip', // page to jump on click
		// 	'country_code'	=> 'countryCode' // property where look country code for flag
		// ]);
	// ipapi ***
		// define('IP_API', [
		// 	'url'			=> 'https://ipapi.co/$ip/json/', // https capable as free
		// 	'href'			=> 'https://ipapi.co/?q=$ip', // page to jump on click
		// 	'country_code'	=> 'country_code' // property where look country code for flag
		// ]);
	// Free IP API
		// define('IP_API', [
		// 	'url'			=> 'https://freeipapi.com/api/json/$ip', // 60 Requests per minute
		// 	'href'			=> 'https://ip-api.com/#$ip', // page to jump (Jump to another server because freeipapi don't provide this service)
		// 	'country_code'	=> 'countryCode' // property where look country code fro flag
		// ]);
	// api.country.is
		define('IP_API', [
			'url'			=> 'https://api.country.is/$ip', // 10 Requests per second
			'href'			=> 'https://ip-api.com/#$ip', // page to jump (Jump to another server because api.country.is don't provide this service)
			'country_code'	=> 'country' // property where look country code fro flag
		]);



// maintenance
	// maintenance mode active (true) / inactive (false)
	define('DEDALO_MAINTENANCE_MODE', false);



// notice_to_active_users : Warning to print in all pages to logged users
	$notice = "<b>Warning</b>. In a few minutes the system will shut down about 5 minutes for maintenance updates. <br>
	Please, save the unsaved work and log out as soon as possible.
	After a few minutes, you can re-login to Dédalo and work again";
	// to activate it, uncomment the next line
		// define('DEDALO_NOTIFICATION', ['msg' => $notice, 'class_name' => 'warning']);
