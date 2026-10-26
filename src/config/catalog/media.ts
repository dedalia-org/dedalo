/**
 * CONFIG CATALOG — domain: media
 *
 * GENERATED SCAFFOLD (probe_emit_catalog.ts). Hand-edit from here on.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CatalogEntry, CatalogGet } from '../catalog_types.ts';
import { privateDir, projectRoot, readEnv } from '../env.ts';

/**
 * Legacy-dir probe (2026-08-23 review, FINDING 1). Three honest answers:
 *  - 'content':    the dir exists and holds ANY entry — dot-entries INCLUDED.
 *    `.publication` (the media ACCESS-CONTROL marker tree,
 *    core/media/protection.ts) lives at `<mediaRoot>/.publication`, and so does
 *    anything else an operator put there; the old non-dotfile filter read a
 *    marker-only legacy dir as "empty" and silently repointed the root,
 *    orphaning the access-control state.
 *  - 'empty':      the dir does not exist, or exists and is empty.
 *  - 'unreadable': the dir exists but readdir failed (EACCES, an NFS blip) —
 *    NEVER "empty": a transient error must not repoint a live media root.
 */
export type LegacyDirProbe = 'content' | 'empty' | 'unreadable';

function probeLegacyDir(path: string): LegacyDirProbe {
	if (!existsSync(path)) return 'empty';
	try {
		return readdirSync(path).length > 0 ? 'content' : 'empty';
	} catch {
		return 'unreadable';
	}
}

/**
 * Where the boot-resolved facts live: a mirror of core/resolve/server_state.ts
 * `statePath()` WITHOUT its mkdir side effect — the runtime-path census calls
 * through here as a PURE question, and importing server_state from the config
 * catalog would invert the layering. Extra keys in ts_state.json survive
 * server_state's read-spread/write cycle, so the two writers coexist.
 */
function stateFilePath(): string {
	const override = readEnv('DEDALO_TS_STATE_PATH');
	if (override !== undefined && override !== '') return override;
	return join(privateDir, 'ts_state.json');
}

type LegacyDirDecision = 'legacy' | 'modern';

/** The recorded (sticky) legacy-vs-modern decisions, keyed by config key. */
function readStickyDecisions(): Record<string, LegacyDirDecision> {
	try {
		const state = JSON.parse(readFileSync(stateFilePath(), 'utf8')) as {
			legacy_dir_fallback?: Record<string, LegacyDirDecision>;
		};
		const map = state.legacy_dir_fallback;
		return map !== null && typeof map === 'object' ? map : {};
	} catch {
		return {};
	}
}

/** Record one decision durably (merge-write; other ts_state.json keys survive). */
function recordStickyDecision(key: string, decision: LegacyDirDecision): void {
	const path = stateFilePath();
	try {
		let state: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
			if (parsed !== null && typeof parsed === 'object') state = parsed as Record<string, unknown>;
		} catch {
			/* fresh or unreadable state file — start from the decision alone */
		}
		const previous = (state.legacy_dir_fallback ?? {}) as Record<string, LegacyDirDecision>;
		state.legacy_dir_fallback = { ...previous, [key]: decision };
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(state, null, '\t')}\n`);
	} catch (error) {
		console.warn(
			`[config] could not record the ${key} legacy-dir decision ('${decision}') in '${path}' (${(error as Error).message}) — the decision holds for this process but will be re-derived at next boot.`,
		);
	}
}

/**
 * LEGACY-AWARE DEFAULT for a runtime data directory that historically lived
 * INSIDE the code tree (2026-08-23, the runtime-path census: a code update
 * renames the whole tree away, so in-tree defaults silently move an install's
 * data into the backup dir — src/core/install/runtime_paths.ts).
 *
 * The default is now `<private dir>/<privateRel>`, but a location change must
 * NEVER move anyone's files: when the key is unset and the legacy in-tree
 * directory still holds content, the legacy path keeps being used and a
 * one-line warning names the key that ends the fallback. Only an install with
 * no legacy data gets the new default. A key whose legacy dir SHIPS release
 * content passes its own `probe`, which answers 'empty' for what the release
 * ships (ONTOLOGY_DATA_IO_DIR: the vendored `install/import/ontology/7.0/`
 * seeds would otherwise make "legacy is non-empty" permanently true —
 * catalog/maintenance.ts probeOntologyLegacyDir). `preferPrivateWhenExists`
 * lets an operator end the fallback by creating the private-dir home.
 *
 * It lives HERE (not in runtime_paths.ts) because the census module imports
 * the typed readers, which load the catalog — the helper in runtime_paths
 * would be an import cycle.
 *
 * THE DECISION IS STICKY (2026-08-23 review, FINDING 1). Re-deriving it from
 * directory contents at every config build made the media root BISTABLE: a
 * legacy dir emptied of visible files (but still holding `.publication`, the
 * access-control marker tree) silently flipped the root to `<private>/media`;
 * a fresh install that later gained a stray `<root>/media` with files silently
 * repointed the live archive; and the boot-frozen `config.media.rootPath`
 * could disagree with the update-time census. So the first derivation is
 * RECORDED in ts_state.json (`legacy_dir_fallback`, the home of boot-resolved
 * facts) by the ONE consumer call (`options.record`, set by buildMediaConfig),
 * and every later call — config rebuilds, the census at update time — returns
 * the recorded answer. It changes only when an operator sets the key
 * explicitly, which bypasses this function entirely. Note
 * `DEDALO_TEST_MEDIA_ROOT` outranks all of this: both buildMediaConfig and the
 * census resolve it BEFORE ever reaching this default.
 */
export function legacyAwareDefaultDir(
	key: string,
	legacyRel: readonly string[],
	privateRel: readonly string[],
	options: {
		preferPrivateWhenExists?: boolean;
		warn?: boolean;
		record?: boolean;
		probe?: (path: string) => LegacyDirProbe;
	} = {},
): string {
	const legacy = join(projectRoot, ...legacyRel);
	const modern = join(privateDir, ...privateRel);
	if (options.preferPrivateWhenExists === true && existsSync(modern)) return modern;
	const decision = stickyOrDerivedDecision(
		key,
		legacy,
		options.record === true,
		options.probe ?? probeLegacyDir,
	);
	if (decision === 'legacy') {
		if (options.warn === true) {
			console.warn(
				`[config] ${key} is unset and the LEGACY in-tree default '${legacy}' holds data — keeping it so nothing moves, but a code update renames the whole tree away. Set ${key} (e.g. to '${modern}') and move the directory to end this warning.`,
			);
		}
		return legacy;
	}
	return modern;
}

/** The recorded decision when one exists; else derive it (and record it when
 * `record` — the ONE consumer call, buildMediaConfig — asks; see the sticky
 * contract in legacyAwareDefaultDir's doc comment). */
function stickyOrDerivedDecision(
	key: string,
	legacy: string,
	record: boolean,
	probe: (path: string) => LegacyDirProbe,
): LegacyDirDecision {
	const sticky = readStickyDecisions()[key];
	if (sticky === 'legacy' || sticky === 'modern') return sticky;
	const decision = deriveLegacyDecision(key, legacy, probe);
	if (record) recordStickyDecision(key, decision);
	return decision;
}

/** First-time derivation from the legacy dir's contents. */
function deriveLegacyDecision(
	key: string,
	legacy: string,
	probeDir: (path: string) => LegacyDirProbe,
): LegacyDirDecision {
	const probe = probeDir(legacy);
	if (probe === 'unreadable') {
		// Assume-legacy on error: keeping a dir that turns out empty costs
		// nothing; repointing a root that turns out full loses the library.
		console.warn(
			`[config] ${key} is unset and the legacy in-tree directory '${legacy}' exists but CANNOT BE READ — assuming it holds data and keeping it (nothing moves on a guess). Fix its permissions, or set ${key} explicitly.`,
		);
		return 'legacy';
	}
	return probe === 'content' ? 'legacy' : 'modern';
}

export const MEDIA_KEYS = {
	DEDALO_3D_ALTERNATIVE_EXTENSIONS: {
		type: 'string_list',
		scope: 'operator',
		default: [],
		heading: '3D',
		typeLabel: 'array',
		typeSuffix: '*optional*',
		doc: `**This engine builds no alternative versions of 3d files, so this parameter has no effect.** Keep it empty.

The reason is structural, not a missing option: the web version of a 3d file is a plain copy of the uploaded model, and no mesh converter is called anywhere in the engine, so there is nothing here that could write a second format.

A value set here is not silently obeyed and not silently ignored either: the formats are refused at start-up, and the server log names this parameter, its value and this reason. Nothing is scanned for, indexed or offered in the versions panel for a file that cannot be produced.

Dédalo stores the uploaded file and the web version, and nothing else.

\`\`\`bash
DEDALO_3D_ALTERNATIVE_EXTENSIONS=[]
\`\`\``,
	},
	DEDALO_3D_AR_QUALITY: {
		type: 'string_list',
		scope: 'operator',
		default: ['original', 'web'],
		heading: '3D',
		typeLabel: 'array',
		doc: `This parameter defines the different qualities that can be used for store 3d files.

This parameter will use to store files to specific quality.

\`\`\`bash
DEDALO_3D_AR_QUALITY=["original","web"]
\`\`\``,
	},
	DEDALO_3D_EXTENSION: {
		type: 'string',
		scope: 'operator',
		default: 'glb',
		heading: '3D',
		typeLabel: 'string',
		doc: `This parameter defines the standard file type of 3d files.

By default Dédalo use glb standard definition for the 3d files. All other formats will be exported to this standard.

\`\`\`bash
DEDALO_3D_EXTENSION="glb"
\`\`\``,
	},
	DEDALO_3D_EXTENSIONS_SUPPORTED: {
		type: 'string_list',
		scope: 'operator',
		default: ['glb', 'gltf', 'obj', 'fbx', 'dae', 'zip'],
		heading: '3D',
		typeLabel: 'array',
		doc: `This parameter defines the standards file type admitted for the 3d files.

Dédalo will use this parameter to identify the file format of the original files uploaded by the users before transform it to the standard defined in the DEDALO_3D_EXTENSION parameter.

\`\`\`bash
DEDALO_3D_EXTENSIONS_SUPPORTED=["glb"]
\`\`\`

> Note: in current version only glb files are available, in future versions other format files will be supported: as 'gltf', 'obj', 'fbx', 'dae', 'zip'`,
	},
	DEDALO_3D_FOLDER: {
		type: 'string',
		scope: 'operator',
		default: '/3d',
		heading: '3D',
		typeLabel: 'string',
		doc: `This parameter define the main directory for the 3d files.

\`\`\`bash
DEDALO_3D_FOLDER="/3d"
\`\`\``,
	},
	DEDALO_3D_QUALITY_DEFAULT: {
		type: 'string',
		scope: 'operator',
		default: 'web',
		heading: '3D',
		typeLabel: 'string',
		doc: `This parameter defines the default quality used for the 3d files.

This parameter will use to transform all 3d files to specific format, unifying the quality used by all sections. By default Dédalo use glb format for web quality.

\`\`\`bash
DEDALO_3D_QUALITY_DEFAULT="web"
\`\`\``,
	},
	DEDALO_3D_QUALITY_ORIGINAL: {
		type: 'string',
		scope: 'operator',
		default: 'original',
		heading: '3D',
		typeLabel: 'string',
		doc: `This parameter defines the quality original for the 3d files.

This parameter will use to identify the uploaded files to with specific quality. Dédalo admit lots of different formats from different sources and qualities, and it define this files as "original" quality. Dédalo will transform all supported formats to web standard format, unify all different qualities and codecs, and will store the original file without touch. In some cases, if the institution has a protocol for manage image files, is possible to use one specific quality for the files that users can upload. By default Dédalo do not limit the original format to be uploaded using a "original" quality denomination.

\`\`\`bash
DEDALO_3D_QUALITY_ORIGINAL="original"
\`\`\``,
	},
	DEDALO_AV_ALTERNATIVE_EXTENSIONS: {
		type: 'string_list',
		scope: 'operator',
		default: [],
		heading: 'Audiovisual',
		typeLabel: 'array',
		typeSuffix: '*optional*',
		doc: `**This engine builds no alternative versions of audiovisual files, so this parameter has no effect.** Keep it empty.

The reason is structural, not a missing option: every compression profile Dédalo ships forces the same container and the same video codec (mp4 / h264), and a profile is chosen by a name that carries only the resolution, the television standard and the aspect ratio. There is no container axis to build a second format on, and there is no second encoder to point at one.

A value set here is not silently obeyed and not silently ignored either: the formats are refused at start-up, and the server log names this parameter, its value and this reason. Nothing is scanned for, indexed or offered in the versions panel for a file that cannot be produced.

Dédalo keeps the uploaded file untouched and compresses only to the standard encapsulation defined in DEDALO_AV_EXTENSION.

\`\`\`bash
DEDALO_AV_ALTERNATIVE_EXTENSIONS=[]
\`\`\``,
	},
	DEDALO_AV_AR_QUALITY: {
		type: 'string_list',
		scope: 'operator',
		default: ['original', '1080', '720', '576', '404', '240', 'audio'],
		heading: 'Audiovisual',
		typeLabel: 'array',
		doc: `This parameter defines the different qualities that can be used for compress the audiovisual files.

This parameter will use to compress audiovisual files to specific quality. The compression will use the original file and will compress to those qualities when the user demand a specific quality.

\`\`\`bash
DEDALO_AV_AR_QUALITY=["original","1080","720","576","404","240","audio"]
\`\`\``,
	},
	DEDALO_AV_EXTENSION: {
		type: 'string',
		scope: 'operator',
		default: 'mp4',
		heading: 'Audiovisual',
		typeLabel: 'string',
		doc: `This parameter defines the standard file type of encapsulation for the audiovisual files.

By default Dédalo use mp4 encapsulation definition for the audiovisual files with codec h264 or h265. All other formats will be compressed to this parameters.

\`\`\`bash
DEDALO_AV_EXTENSION="mp4"
\`\`\``,
	},
	DEDALO_AV_EXTENSIONS_SUPPORTED: {
		type: 'string_list',
		scope: 'operator',
		default: [
			'mp4',
			'wave',
			'wav',
			'aiff',
			'aif',
			'mp3',
			'mov',
			'avi',
			'mpg',
			'mpeg',
			'vob',
			'zip',
			'flv',
		],
		heading: 'Audiovisual',
		typeLabel: 'array',
		doc: `This parameter defines the standards file type admitted for the audiovisual files.

Dédalo will use this parameter to identify the file format of the original files uploaded by the users before compress it to the standard defined in the DEDALO_AV_EXTENSION parameter.

\`\`\`bash
DEDALO_AV_EXTENSIONS_SUPPORTED=["mp4","wave","wav","aiff","aif","mp3","mov","avi","mpg","mpeg","vob","zip","flv"]
\`\`\``,
	},
	DEDALO_AV_FASTSTART_PATH: {
		type: 'string',
		scope: 'operator',
		default: (get: CatalogGet) => `${get('DEDALO_BINARY_BASE')}/qt-faststart`,
		defaultDoc: '`<DEDALO_BINARY_BASE>/qt-faststart`',
		heading: 'Audiovisual',
		typeLabel: 'string',
		doc: `This parameter defines the path to the qt-faststart library in the server.

qt-faststart is used to move the av header from last bytes of the av file to the start of the av file, this change improve the load of the av because the header is at the beginning of the file and it can read first when loads begin.

\`\`\`bash
DEDALO_AV_FASTSTART_PATH="/usr/bin/qt-faststart"
\`\`\``,
	},
	DEDALO_AV_FFMPEG_PATH: {
		type: 'string',
		scope: 'operator',
		default: (get: CatalogGet) => `${get('DEDALO_BINARY_BASE')}/ffmpeg`,
		defaultDoc: '`<DEDALO_BINARY_BASE>/ffmpeg`',
		heading: 'Audiovisual',
		typeLabel: 'string',
		doc: `This parameter defines the path to the ffmpeg library in the server. ffmpeg will use to compress the audiovisual files.

\`\`\`bash
DEDALO_AV_FFMPEG_PATH="/usr/bin/ffmpeg"
\`\`\``,
	},
	DEDALO_AV_FFPROBE_PATH: {
		type: 'string',
		scope: 'operator',
		default: (get: CatalogGet) => `${get('DEDALO_BINARY_BASE')}/ffprobe`,
		defaultDoc: '`<DEDALO_BINARY_BASE>/ffprobe`',
		heading: 'Audiovisual',
		typeLabel: 'string',
		doc: `This parameter defines the path to the ffprobe library in the server. ffprobe is used to analyze the audiovisual files and get his metadata.

\`\`\`bash
DEDALO_AV_FFPROBE_PATH="/usr/bin/ffprobe"
\`\`\``,
	},
	DEDALO_AV_FOLDER: {
		type: 'string',
		scope: 'operator',
		default: '/av',
		heading: 'Audiovisual',
		typeLabel: 'string',
		doc: `This parameter defines the main directory for the audiovisual files.

\`\`\`bash
DEDALO_AV_FOLDER="/av"
\`\`\``,
	},
	DEDALO_AV_POSTERFRAME_EXTENSION: {
		type: 'string',
		scope: 'operator',
		default: 'jpg',
		heading: 'Audiovisual',
		typeLabel: 'string',
		doc: `This parameter defines the type of the image file used to create the posterframe of the audiovisual files.

The posterframe is the image that will show before load the audiovisual files and identify it. This parameter define the type of this image. By default Dédalo use jpg standard to create the posterframe.

\`\`\`bash
DEDALO_AV_POSTERFRAME_EXTENSION="jpg"
\`\`\``,
	},
	DEDALO_AV_QUALITY_DEFAULT: {
		// A quality NAME that merely looks numeric (404 = 720x404), read with
		// readString. Typed 'number' it contradicted its own reader and example.
		emptyIsUnset: true,
		type: 'string',
		scope: 'operator',
		default: '404',
		heading: 'Audiovisual',
		typeLabel: 'string',
		doc: `This parameter defines the default quality used for the audiovisual files.

This parameter will use to compress all audiovisual files to specific quality, unifying the quality used by all sections. By default Dédalo use 720x404 h264 quality.

\`\`\`bash
DEDALO_AV_QUALITY_DEFAULT="404"
\`\`\``,
	},
	DEDALO_AV_QUALITY_ORIGINAL: {
		type: 'string',
		scope: 'operator',
		default: 'original',
		heading: 'Audiovisual',
		typeLabel: 'string',
		doc: `This parameter defines the quality original for the audiovisual files.

This parameter will use to identify the uploaded files to with specific quality. Dédalo admit lots of different formats from different sources and qualities, and it define this files as "original" quality. Dédalo will compress all formats to web standard format, unify all different qualities and codecs, and will store the original file without touch. In some cases, if the institution has a protocol for manage av files, is possible to use one specific quality for the files that users can upload. By default Dédalo do not limit the original format to be uploaded using a "original" quality denomination.

\`\`\`bash
DEDALO_AV_QUALITY_ORIGINAL="original"
\`\`\``,
	},
	DEDALO_AV_SUBTITLES_EXTENSION: {
		type: 'string',
		scope: 'operator',
		default: 'vtt',
		heading: 'Audiovisual',
		typeLabel: 'string',
		doc: `This parameter defines the standard used to create the subtitles.

By default Dédalo use VTT format to create the subtitles.

\`\`\`bash
DEDALO_AV_SUBTITLES_EXTENSION="vtt"
\`\`\``,
	},
	DEDALO_BINARY_BASE: {
		type: 'string',
		scope: 'operator',
		default: () => (process.platform === 'darwin' ? '/opt/homebrew/bin' : '/usr/bin'),
		defaultDoc: '`/opt/homebrew/bin` on macOS, `/usr/bin` elsewhere',
		heading: 'External binaries',
		typeLabel: 'string',
		doc: `This parameter defines the directory where the external media binaries are installed.

All media processing is done by external programs — ImageMagick, ffmpeg, ffprobe, qt-faststart, pdfinfo, pdftotext, pdftohtml, ocrmypdf — and Dédalo does not search the \`PATH\` for them: every binary key derives its default from this directory (\`DEDALO_AV_FFMPEG_PATH\` = \`<DEDALO_BINARY_BASE>/ffmpeg\`, and so on). Set this one key and the whole family follows; set an individual key only when that single binary lives somewhere else.

By default Dédalo uses \`/usr/bin\` (the location the system packages install to) and \`/opt/homebrew/bin\` on macOS. A source build or a local install (\`/usr/local/bin\`) is the usual reason to change it.

\`\`\`bash
DEDALO_BINARY_BASE="/usr/local/bin"
\`\`\``,
	},
	DEDALO_FILE_BIN_PATH: {
		type: 'string',
		scope: 'operator',
		default: (get: CatalogGet) => `${get('DEDALO_BINARY_BASE')}/file`,
		defaultDoc: '`<DEDALO_BINARY_BASE>/file`',
		heading: 'External binaries',
		typeLabel: 'string',
		doc: `This parameter defines the path to the \`file\` utility in the server, the program that reports the type of a file from its content.

The path is derived from DEDALO_BINARY_BASE and is resolved together with the rest of the external binaries when the server boots, so on a standard install there is nothing to set. Point it at an explicit location only when the utility is not installed alongside the other binaries.

Note that Dédalo does not depend on it to accept an upload: the upload endpoint validates every file by reading its signature bytes with its own detector and refuses anything whose content does not match the declared extension, so an install without this utility still uploads and processes media normally.

\`\`\`bash
DEDALO_FILE_BIN_PATH="/usr/bin/file"
\`\`\``,
	},
	DEDALO_GEO_DEFAULT_LAT: {
		type: 'number',
		scope: 'operator',
		default: 20,
		heading: 'Georeferencing variables',
		typeLabel: 'float',
		doc: `Latitude the geolocation map OPENS on when the record has no coordinate stored.

This is a camera position, never data: it is only where the map is looking before the user
places anything, and it is never saved into the record. A record without coordinates stays
without coordinates, and nothing is published for it.

The default (latitude 20, longitude 0, zoom 2) is a world view, chosen precisely because it
cannot be mistaken for a real location. An institution whose records cluster in one region
should set the three DEDALO_GEO_DEFAULT_* keys to that region so cataloguers do not have to
pan the map on every new record.

\`\`\`bash
DEDALO_GEO_DEFAULT_LAT="20"
\`\`\``,
	},
	DEDALO_GEO_DEFAULT_LON: {
		type: 'number',
		scope: 'operator',
		default: 0,
		heading: 'Georeferencing variables',
		typeLabel: 'float',
		doc: `Longitude the geolocation map OPENS on when the record has no coordinate stored.

The companion of DEDALO_GEO_DEFAULT_LAT: together with DEDALO_GEO_DEFAULT_ZOOM they define the
opening camera of the map widget. It is a view, not a value — opening a record and saving it
stores no coordinate.

Change it, with the other two keys, when the collection is regional and the world view wastes
the cataloguer's time.

\`\`\`bash
DEDALO_GEO_DEFAULT_LON="0"
\`\`\``,
	},
	DEDALO_GEO_DEFAULT_ZOOM: {
		type: 'number',
		scope: 'operator',
		default: 2,
		heading: 'Georeferencing variables',
		typeLabel: 'int',
		doc: `Zoom level the geolocation map OPENS on when the record has no coordinate stored.

Leaflet zoom scale: 2 is the whole world, ~6 a country, ~12 a city, ~18 a street. The default 2
matches the world-view default of DEDALO_GEO_DEFAULT_LAT / DEDALO_GEO_DEFAULT_LON.

Raise it together with the two coordinate keys when every record of the install belongs to the
same region, so the map opens already framed on it.

\`\`\`bash
DEDALO_GEO_DEFAULT_ZOOM="2"
\`\`\``,
	},
	DEDALO_GEO_PROVIDER: {
		type: 'string',
		scope: 'operator',
		default: 'VARIOUS',
		heading: 'Georeferencing variables',
		typeLabel: 'string',
		doc: `This parameter defines the tile maps provider to be used.

The param can be change the provider to specific configurations, for ex, if you want to use the ancient roman map and the actual OSM map you can use the "NUMISDATA" provider that include both maps. values supported: OSM | ARCGIS | GOOGLE | VARIOUS | ARCGIS | NUMISDATA

\`\`\`bash
DEDALO_GEO_PROVIDER="VARIOUS"
\`\`\``,
	},
	DEDALO_HTML_FILES_FOLDER: {
		type: 'string',
		scope: 'operator',
		default: '/html_files',
		heading: 'Generated and exported files',
		typeLabel: 'string',
		doc: `This parameter names the directory, inside the media directory, that holds self-contained HTML copies generated from records — the single files an institution hands to a visitor or publishes beside a catalogue.

The directory is created and verified when the server starts, along with the rest of the media directories, so it always carries the same owner and permissions as the rest of the tree instead of being minted by whichever process happens to write there first. Images uploaded from the rich-text editor's toolbar are stored here and embedded in the text by URL.

Change the value only to match a directory an install already carries. It names the folder Dédalo provisions — it does not move files that are already sitting in the old one, and it is a single folder name (a leading slash is optional and removed), never a path: the media directory is the only place this can live.

\`\`\`bash
DEDALO_HTML_FILES_FOLDER="/html_files"
\`\`\``,
	},
	DEDALO_IDENTIFY_PATH: {
		type: 'string',
		scope: 'operator',
		default: (get: CatalogGet) => `${get('DEDALO_BINARY_BASE')}/identify`,
		defaultDoc: '`<DEDALO_BINARY_BASE>/identify`',
		heading: 'Image',
		typeLabel: 'string',
		doc: `This parameter defines the path to the ImageMagick \`identify\` program in the server. Dédalo uses it to read the attributes of an image file — dimensions, format, colorspace, orientation, transparency — before deciding how to compress it.

The path is derived from DEDALO_BINARY_BASE, so a normal ImageMagick install needs no configuration. Dédalo prefers the modern single-entry-point form (\`magick identify\`, see DEDALO_MAGICK_PATH) and falls back to this standalone binary, which is what the older ImageMagick packages ship. Set this key only to point at a binary in a non-standard location.

\`\`\`bash
DEDALO_IDENTIFY_PATH="/usr/bin/identify"
\`\`\``,
	},
	DEDALO_RSVG_CONVERT_PATH: {
		type: 'string',
		scope: 'operator',
		default: (get: CatalogGet) => `${get('DEDALO_BINARY_BASE')}/rsvg-convert`,
		defaultDoc: '`<DEDALO_BINARY_BASE>/rsvg-convert`',
		heading: 'SVG',
		typeLabel: 'string',
		doc: `This parameter defines the path to the \`rsvg-convert\` program in the server, shipped with [librsvg](https://gitlab.gnome.org/GNOME/librsvg). Dédalo uses it — and only it — to turn a vector SVG into a raster image, which is how the thumbnail of an SVG record is produced.

ImageMagick is deliberately NOT used for this. Dédalo runs ImageMagick under a hardened policy that disables its scripting coders (\`MVG\`/\`MSL\`), a long-standing remote-code-execution vector; on a build without a librsvg delegate ImageMagick renders SVG through its own renderer, which emits MVG, so every SVG rasterization is refused by that policy. Rendering the vector in a dedicated program instead keeps the ImageMagick hardening intact.

Install librsvg (\`brew install librsvg\`, \`apt install librsvg2-bin\`) and the path is derived from DEDALO_BINARY_BASE, so no configuration is needed. Set this key only to point at a binary in a non-standard location. Without it, SVG records keep working — upload, storage, display and download are unaffected — but their thumbnail cannot be built, and the media-versions panel says so.

\`\`\`bash
DEDALO_RSVG_CONVERT_PATH="/usr/bin/rsvg-convert"
\`\`\``,
	},
	DEDALO_SVG_THUMB_DPI: {
		type: 'number',
		scope: 'operator',
		default: 150,
		heading: 'SVG',
		typeLabel: 'int',
		doc: `This parameter defines the resolution, in dots per inch, at which an SVG is rendered before it is reduced to a thumbnail. A vector file has no pixels of its own, so a resolution has to be chosen for it; 150 dpi is enough for a crisp thumbnail without rendering a needlessly large intermediate image.

\`\`\`bash
DEDALO_SVG_THUMB_DPI=150
\`\`\``,
	},
	// --- ImageMagick resource ceilings (audit MEDIA-01) --------------------------
	// The shipped policy.xml (src/core/media/engine/imagemagick-policy/) is the HARD
	// ceiling; these keys are the OPERATING limit spliced into every ImageMagick argv
	// by magickResourceLimitArgs() (core/media/engine/binaries.ts). ImageMagick can
	// only lower a resource below its policy value, never raise it above — so a value
	// here above the policy's is silently the policy's. Gate: magick_policy_tripwire.
	DEDALO_MAGICK_LIMIT_MEMORY: {
		type: 'string',
		scope: 'operator',
		default: '2GiB',
		heading: 'ImageMagick resource limits',
		typeLabel: 'string',
		doc: `This parameter defines how much memory one ImageMagick process may use for its pixel cache before it starts spilling to disk.

It is not a refusal: an image that needs more than this still converts, using the memory-mapped and then the disk-backed cache (DEDALO_MAGICK_LIMIT_MAP and DEDALO_MAGICK_LIMIT_DISK). What it bounds is how much of the server's RAM a single upload can take while the person who sent it waits, which is what makes a deliberately outsized file a denial of service rather than a slow conversion.

Accepts an ImageMagick size: a plain number of bytes, or a number with a unit (\`2GiB\`, \`512MiB\`).

\`\`\`bash
DEDALO_MAGICK_LIMIT_MEMORY="2GiB"
\`\`\``,
	},
	DEDALO_MAGICK_LIMIT_MAP: {
		type: 'string',
		scope: 'operator',
		default: '4GiB',
		heading: 'ImageMagick resource limits',
		typeLabel: 'string',
		doc: `This parameter defines how much memory-mapped address space one ImageMagick process may use for its pixel cache before it falls back to the disk-backed cache.

It is the second step of the same ladder as DEDALO_MAGICK_LIMIT_MEMORY and behaves the same way: crossing it slows a conversion down, it never refuses one. Keep it above the memory limit; a value below it makes the middle step useless.

\`\`\`bash
DEDALO_MAGICK_LIMIT_MAP="4GiB"
\`\`\``,
	},
	DEDALO_MAGICK_LIMIT_AREA: {
		type: 'string',
		scope: 'operator',
		default: '2GiB',
		heading: 'ImageMagick resource limits',
		typeLabel: 'string',
		doc: `This parameter defines the pixel area above which ImageMagick caches an image on disk instead of in memory.

It is the threshold that decides, for one image, whether the ladder above is entered at all. Like the two limits above it degrades rather than refuses.

\`\`\`bash
DEDALO_MAGICK_LIMIT_AREA="2GiB"
\`\`\``,
	},
	DEDALO_MAGICK_LIMIT_DISK: {
		type: 'string',
		scope: 'operator',
		default: '16GiB',
		heading: 'ImageMagick resource limits',
		typeLabel: 'string',
		doc: `This parameter defines how much disk one ImageMagick process may use for its pixel cache.

This is the bottom of the ladder, and the first of these limits that REFUSES: an image whose cache does not fit in this much disk fails to convert, with \`cache resources exhausted\`. Dédalo treats that as a failed derivative — nothing half-written is ever published — so the cost of a value that is too low is a refused conversion, and the cost of one that is too high is a scratch directory that can fill the volume the media library lives on.

\`\`\`bash
DEDALO_MAGICK_LIMIT_DISK="16GiB"
\`\`\``,
	},
	DEDALO_MAGICK_LIMIT_WIDTH: {
		type: 'number',
		scope: 'operator',
		default: 100000,
		heading: 'ImageMagick resource limits',
		typeLabel: 'int',
		doc: `This parameter defines the largest image WIDTH, in pixels, that ImageMagick will read.

Unlike the cache limits above, this is a REFUSAL, and it is the one that stops a decode bomb before a single pixel is allocated: the dimensions are read from the file header, so an image declaring more than this is rejected at header-parse time whatever its size on disk.

The default is deliberately far above any real scan. Raise it only when an institution genuinely holds masters wider than this — large-format map and panorama scans are the real case — and remember the shipped ImageMagick policy carries its own ceiling of 200000, which no value here can exceed.

\`\`\`bash
DEDALO_MAGICK_LIMIT_WIDTH=100000
\`\`\``,
	},
	DEDALO_MAGICK_LIMIT_HEIGHT: {
		type: 'number',
		scope: 'operator',
		default: 100000,
		heading: 'ImageMagick resource limits',
		typeLabel: 'int',
		doc: `This parameter defines the largest image HEIGHT, in pixels, that ImageMagick will read. It is the counterpart of DEDALO_MAGICK_LIMIT_WIDTH and everything said there applies to it unchanged, including the 200000 ceiling in the shipped policy.

\`\`\`bash
DEDALO_MAGICK_LIMIT_HEIGHT=100000
\`\`\``,
	},
	DEDALO_MAGICK_LIMIT_LIST_LENGTH: {
		type: 'number',
		scope: 'operator',
		default: 4096,
		heading: 'ImageMagick resource limits',
		typeLabel: 'int',
		doc: `This parameter defines how many IMAGES one file may contain before ImageMagick refuses to read it.

An image file is not necessarily one image: a PDF has pages, a TIFF can have pages or layers, a GIF has frames. Reading such a file costs memory for every image in it, and that cost is paid even when Dédalo only wants the header — which it does on every upload, to build the preview. A small file can declare an enormous number of tiny images: a 4.6 MB animation of two hundred thousand one-pixel frames, well inside the upload limit, made a single header read take 26 seconds and nearly 9 GB of memory. None of the limits above stops that, because the cost is not in the pixels.

The default admits any real heritage object measured on this engine — a long multi-page scan, a long animation — and refuses the crafted case at about 180 MB. Raise it if an institution genuinely holds masters with more images than this in one file; a file above the limit is refused with \`list length exceeds limit\` and no derivative is written.

\`\`\`bash
DEDALO_MAGICK_LIMIT_LIST_LENGTH=4096
\`\`\``,
	},
	DEDALO_MAGICK_LIMIT_TIME: {
		type: 'number',
		scope: 'operator',
		default: 900,
		heading: 'ImageMagick resource limits',
		typeLabel: 'int',
		doc: `This parameter defines how long, in seconds, one ImageMagick process may run before it is refused.

It is a second, independent bound on the same exposure the dimension limits cover: an image small enough to pass them can still be shaped so that decoding it takes hours. Fifteen minutes is far longer than any legitimate derivative build measured on this engine, and short enough that a wedged conversion does not hold a request open for a day.

\`\`\`bash
DEDALO_MAGICK_LIMIT_TIME=900
\`\`\``,
	},
	DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS: {
		type: 'string_list',
		scope: 'operator',
		default: [],
		heading: 'Image',
		typeLabel: 'array',
		typeSuffix: '*optional*',
		doc: `This parameter defines the extra file formats Dédalo builds beside the standard image format defined in DEDALO_IMAGE_EXTENSION.

Each format listed here produces a companion file of the version Dédalo already stores in a quality: the same picture, the same quality, another container. It is not a copy of every quality in every format, and it never replaces the standard version:

- a quality that holds its standard file gets one companion per format listed here, built from the master image (the retouched one when the record has it, otherwise the original), so that transparency, colour and detail come from the best source the record holds — never from the already delivered standard file, which has lost them;
- a quality that holds no standard file gets no companion, and a companion found there is moved to the \`deleted\` folder: a file whose version is gone would keep showing a picture the record no longer has;
- the original and the retouched qualities never get companions. They hold the files a person uploaded, and a generated file among them would be taken for one of them;
- the thumbnail quality never gets companions. Thumbnails are stored in the thumbnail format alone, so any other file there would never be seen.

**avif is the format to add here.** Of the formats this engine can write it is the one that keeps transparency, which is what makes an automatic background removal visible: the cut-out survives into the avif companion, while the standard jpg version is always composited onto white. Measured on this reference machine it costs 0.16 to 0.37 seconds per quality, and at the larger qualities it is smaller than the jpg it accompanies (180 KB against 256 KB at the 6MB quality).

Every companion is built while the person who uploaded the image is waiting, so the whole list is added to the time an upload takes. Measured on this reference machine, one 19.9 MB master through the complete upload processing: 0.27 seconds with the list empty, 0.59 seconds with avif, 1.87 seconds with avif and png.

png also keeps transparency and is lossless, so it is a defensible archival choice, but state its cost before adding it: measured on a 3.8 megapixel master it takes 1.25 to 4.33 seconds and 7.6 to 10 MB per quality — 25 to 70 times the disk the jpg uses. There is no size or time cap: Dédalo builds exactly what you list.

If a format is listed that the image processing program on this server cannot write, no file is produced for it, any companion already on disk is moved to the \`deleted\` folder rather than left showing an outdated picture, and the refusal is reported in the upload response and named in the server log when Dédalo starts.

A companion is only ever built beside a version that Dédalo itself produced from the master. If someone has rotated or cropped a quality, that file no longer shows what the master shows, and a companion built from the master would show a different picture in the same quality: Dédalo declines to build it and says so, naming both sizes. Rebuilding the quality itself produces both files together again — which discards the rotation, exactly as any change of the master already does.

By default the list is empty: no companion file is created and Dédalo stores only the uploaded file and the standard format.

\`\`\`bash
DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS=["avif"]
\`\`\`

Example:

Original file: **my_image.tif**

Default format defined in DEDALO_IMAGE_EXTENSION: **jpg**

Alternative formats defined in DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS: **\\['avif'\\]**

Result:

In original quality directory (a master quality — no companion is built here):
> ../media/image/original/rsc29_rsc170_1.tif
>
> ../media/image/original/rsc29_rsc170_1.jpg

In 1.5MB quality directory:
> ../media/image/1.5MB/rsc29_rsc170_1.jpg
>
> ../media/image/1.5MB/rsc29_rsc170_1.avif

In thumb quality directory (thumbnails take no companion):
> ../media/image/thumb/rsc29_rsc170_1.jpg`,
	},
	DEDALO_IMAGE_AR_QUALITY: {
		type: 'string_list',
		scope: 'operator',
		default: ['original', 'modified', '100MB', '25MB', '6MB', '1.5MB', 'thumb'],
		heading: 'Image',
		typeLabel: 'serialized array',
		doc: `This parameter defines the different qualities that can be used for compress the image files.

This parameter will use to compress image files to specific quality. The compression will use the original file and will compress to those qualities when the user demand a specific quality.

\`\`\`bash
DEDALO_IMAGE_AR_QUALITY=["original","modified","100MB","25MB","6MB","1.5MB","thumb"]
\`\`\``,
	},
	DEDALO_IMAGE_EXTENSION: {
		type: 'string',
		scope: 'operator',
		default: 'jpg',
		heading: 'Image',
		typeLabel: 'string',
		doc: `This parameter defines the standard file type of image files.

By default Dédalo use jpg standard definition for the image files. All other formats will be compressed to this standard.

\`\`\`bash
DEDALO_IMAGE_EXTENSION="jpg"
\`\`\``,
	},
	DEDALO_IMAGE_EXTENSIONS_SUPPORTED: {
		type: 'string_list',
		scope: 'operator',
		default: ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'bmp', 'psd', 'raw', 'webp', 'heic', 'avif'],
		heading: 'Image',
		typeLabel: 'array',
		doc: `This parameter defines the standards file type admitted for the image files.

Dédalo will use this parameter to identify the file format of the original files uploaded by the users before compress it to the standard defined in the DEDALO_IMAGE_EXTENSION parameter.

\`\`\`bash
DEDALO_IMAGE_EXTENSIONS_SUPPORTED=["jpg","jpeg","png","tif","tiff","bmp","psd","raw","webp","heic"]
\`\`\``,
	},
	DEDALO_IMAGE_FOLDER: {
		type: 'string',
		scope: 'operator',
		default: '/image',
		heading: 'Image',
		typeLabel: 'string',
		doc: `This parameter defines the main directory for the image files.

\`\`\`bash
DEDALO_IMAGE_FOLDER="/image"
\`\`\``,
	},
	DEDALO_IMAGE_PRINT_DPI: {
		type: 'number',
		scope: 'operator',
		default: 150,
		heading: 'Image',
		typeLabel: 'int',
		doc: `This parameter defines the resolution in pixels per inch that will be used in the image compression to be apply when the images will be printed.

\`\`\`bash
DEDALO_IMAGE_PRINT_DPI=150
\`\`\``,
	},
	DEDALO_IMAGE_QUALITY_DEFAULT: {
		type: 'string',
		scope: 'operator',
		default: '1.5MB',
		heading: 'Image',
		typeLabel: 'string',
		doc: `This parameter defines the default quality used for the image files.

This parameter will use to compress all image files to specific quality, unifying the quality used by all sections. By default Dédalo use 1.5MB file size (524.217px or 887x591px) quality.

\`\`\`bash
DEDALO_IMAGE_QUALITY_DEFAULT="1.5MB"
\`\`\``,
	},
	DEDALO_IMAGE_QUALITY_ORIGINAL: {
		type: 'string',
		scope: 'operator',
		default: 'original',
		heading: 'Image',
		typeLabel: 'string',
		doc: `This parameter defines the quality original for the image files.

This parameter will use to identify the uploaded files to with specific quality. Dédalo admit lots of different formats from different sources and qualities, and it define this files as "original" quality. Dédalo will compress all formats to web standard format, unify all different qualities and codecs, and will store the original file without touch. In some cases, if the institution has a protocol for manage image files, is possible to use one specific quality for the files that users can upload. By default Dédalo do not limit the original format to be uploaded using a "original" quality denomination.

\`\`\`bash
DEDALO_IMAGE_QUALITY_ORIGINAL="original"
\`\`\``,
	},
	DEDALO_IMAGE_QUALITY_RETOUCHED: {
		type: 'string',
		scope: 'operator',
		default: 'modified',
		heading: 'Image',
		typeLabel: 'string',
		doc: `This parameter defines the quality for the image files that has been retouched.

Retouched images are the processed images to improve the image, this quality will be a copy of the original that has any kind of process (color balance, background removed, contrasted, etc)

\`\`\`bash
DEDALO_IMAGE_QUALITY_RETOUCHED="modified"
\`\`\``,
	},
	// DEDALO_IMAGE_THUMB_DEFAULT was DELETED here (2026-07-13). It was documented for
	// operators but read by NOTHING — not in src/, not in tools/, not in the v6 fixture,
	// not even in the retired engine's own config. It configured nothing, anywhere, ever.
	// The real setting is DEDALO_QUALITY_THUMB. The census tripwire now makes a
	// documented-but-unread key impossible to reintroduce.
	DEDALO_IMAGE_THUMB_HEIGHT: {
		type: 'number',
		scope: 'operator',
		default: 148,
		heading: 'Thumb',
		typeLabel: 'int',
		doc: `This parameter defines height size in pixels to the thumb images, it will be used to compress the images with the thumb quality (the smaller version to be used in lists).

\`\`\`bash
DEDALO_IMAGE_THUMB_HEIGHT=148
\`\`\``,
	},
	DEDALO_IMAGE_THUMB_WIDTH: {
		type: 'number',
		scope: 'operator',
		default: 222,
		heading: 'Thumb',
		typeLabel: 'int',
		doc: `This parameter defines width size in pixels to the thumb images, it will be used to compress the images with the thumb quality (the smaller version to be used in lists).

\`\`\`bash
DEDALO_IMAGE_THUMB_WIDTH=222
\`\`\``,
	},
	DEDALO_IMAGE_WEB_FOLDER: {
		type: 'string',
		scope: 'operator',
		default: '/web',
		heading: 'Image',
		typeLabel: 'string',
		doc: `This parameter names the directory, inside the image directory, that holds browser-sized copies of pictures brought in from a rich-text field rather than from the image component itself.

It sits beside the quality directories (\`original\`, \`1.5MB\`, \`thumb\`, …) and is created and verified when the server starts, so it carries the same owner and permissions as the rest of the media tree. Images uploaded from the rich-text editor's toolbar are stored here and embedded in the text by URL.

The value is a single folder name (a leading slash is optional and removed), never a path.

\`\`\`bash
DEDALO_IMAGE_WEB_FOLDER="/web"
\`\`\``,
	},
	DEDALO_MAGICK_PATH: {
		type: 'string',
		scope: 'operator',
		default: (get: CatalogGet) => `${get('DEDALO_BINARY_BASE')}/magick`,
		defaultDoc: '`<DEDALO_BINARY_BASE>/magick`',
		heading: 'Image',
		typeLabel: 'string',
		doc: `This parameter defines the path to image magick library in the server (when image magick library is installed)

\`\`\`bash
DEDALO_MAGICK_PATH="/usr/bin/"
\`\`\``,
	},
	DEDALO_MEDIA_DIR: {
		type: 'string',
		scope: 'operator',
		default: 'media',
		heading: 'Defining the media URL directory',
		typeLabel: 'string',
		doc: `This parameter defines the NAME of the media directory as it appears in the URL. Every media URL Dédalo builds is \`/dedalo/<DEDALO_MEDIA_DIR>/\` plus the file path.

Do not confuse it with MEDIA_PATH, which is the directory on disk: this one is the public folder name, and the web server maps the two together (the media rules and the reverse-proxy configuration are generated from both, and they must agree — \`<web root> + /dedalo/<DEDALO_MEDIA_DIR>/…\` must resolve to \`MEDIA_PATH/…\`).

The default is \`media\` and a new installation should keep it. The reason to change it is an existing installation whose media were published under another folder name (\`media_mib\`, say): setting the old name keeps every URL already diffused to the public working.

\`\`\`bash
DEDALO_MEDIA_DIR="media"
\`\`\``,
	},
	DEDALO_MEDIA_EXPORT_BASE: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Defining the media base for exports',
		typeLabel: 'string',
		typeSuffix: '*optional — unset leaves export media cells unresolved*',
		doc: `This parameter defines the base every media URL that LEAVES the application is built on — an exported list, a relation list cell, anything a third party opens outside Dédalo.

Inside the application media URLs may be relative (\`/dedalo/media/image/1.5MB/…\`), because the browser already knows the host — that is DEDALO_MEDIA_WEB_BASE's job. A cell that travels cannot: it must carry an address that resolves anywhere, so those cells are built as this base plus the file path of the model's default quality.

Set it to the ABSOLUTE public address of the media directory — the same value DEDALO_MEDIA_WEB_BASE takes, including \`/dedalo/<DEDALO_MEDIA_DIR>\`, because both are prefixed to the SAME media-root relative path. A trailing slash is stripped.

The parameter is unset by default. When it is unset, media cells cannot be resolved and are reported as unresolved rather than guessed: the export leaves the cell empty and names the models it could not build.

\`\`\`bash
DEDALO_MEDIA_EXPORT_BASE="https://my_institution.org/dedalo/media"
\`\`\``,
	},
	DEDALO_MEDIA_CONVERT_CONCURRENCY: {
		type: 'number',
		scope: 'operator',
		default: 2,
		heading: 'Defining how many image conversions run at the same time',
		typeLabel: 'int',
		doc: `This parameter defines how many image, PDF or SVG conversions Dédalo will run at the same time.

Unlike media jobs, these conversions happen while somebody waits: the preview of a file being uploaded, a regenerated thumbnail, a rotation. Each one is already limited in how much memory and disk it may use (see the \`DEDALO_MAGICK_LIMIT_*\` parameters), but that limit applies to ONE conversion, and a large photograph can legitimately use all of it. Without this parameter, ten simultaneous uploads meant ten simultaneous conversions, each allowed to spend the whole budget, and the server ran out of disk while every upload waited.

With it, a conversion that arrives when the lanes are busy waits for a free one and then runs normally. Nothing is lost and nobody is refused, unless the wait exceeds \`DEDALO_MEDIA_CONVERT_QUEUE_SECONDS\`.

By default Dédalo runs 2 conversions at a time. Raise it on a server with cores and disk to spare and many people uploading at once; lower it to 1 on a small machine that also serves the public website. Values below 1 are raised to 1.

\`\`\`bash
DEDALO_MEDIA_CONVERT_CONCURRENCY=2
\`\`\``,
	},
	DEDALO_MEDIA_CONVERT_QUEUE_SECONDS: {
		type: 'number',
		scope: 'operator',
		default: 120,
		heading: 'Defining how long a conversion waits for a free lane',
		typeLabel: 'int (seconds)',
		doc: `This parameter defines how long a conversion may wait for a free conversion lane (\`DEDALO_MEDIA_CONVERT_CONCURRENCY\`) before it is refused.

Waiting is not free: the person's browser is holding a connection open while it waits. When the server is so busy that the wait becomes long, answering "too many requests, try again" is more useful than an operation that eventually times out with no explanation. The client can retry, and the record is untouched — the original file is never modified by a conversion.

By default Dédalo waits up to 120 seconds. Raise it on an installation that ingests large masters in bulk and prefers slow success to a refusal; lower it on an interactive installation where a quick answer matters more.

\`\`\`bash
DEDALO_MEDIA_CONVERT_QUEUE_SECONDS=120
\`\`\``,
	},
	DEDALO_MEDIA_AV_CONCURRENCY: {
		type: 'number',
		scope: 'operator',
		default: (get: CatalogGet) => Number(get('DEDALO_MEDIA_JOB_CONCURRENCY')) + 1,
		defaultDoc: '`DEDALO_MEDIA_JOB_CONCURRENCY` + 1',
		heading: 'Defining how many audio and video conversions run at the same time',
		typeLabel: 'int',
		doc: `This parameter defines how many audio or video conversions (\`ffmpeg\` processes) Dédalo will run at the same time.

Video work is the heaviest thing this server does, and not all of it happens in a media job: two actions of the audiovisual component run WHILE THE PERSON WAITS — creating a posterframe, and cutting the fragment an index entry points at. Those belong to no job lane, so before this parameter existed the only limit on how many transcodes a server ran at once was how many people pressed the button.

With it, every ffmpeg the engine starts — the jobs and the two interactive actions alike — takes one of these lanes; one that arrives when they are all busy waits, and is refused with "too many requests" if the wait exceeds \`DEDALO_MEDIA_AV_QUEUE_SECONDS\`.

By default Dédalo allows one more than the media-job lanes (\`DEDALO_MEDIA_JOB_CONCURRENCY\`), so a full job queue still leaves room for one interactive fragment. Raise both together on a machine with cores to spare; lower this to 1 on a small server. Values below 1 are raised to 1.

\`\`\`bash
DEDALO_MEDIA_AV_CONCURRENCY=4
\`\`\``,
	},
	DEDALO_MEDIA_AV_QUEUE_SECONDS: {
		type: 'number',
		scope: 'operator',
		default: 120,
		heading: 'Defining how long an audio or video conversion waits for a free lane',
		typeLabel: 'int (seconds)',
		doc: `This parameter defines how long an audio or video conversion may wait for a free lane (\`DEDALO_MEDIA_AV_CONCURRENCY\`) before it is refused.

It exists for the two audiovisual actions that run while somebody waits (the posterframe and the fragment download): when every lane is busy transcoding, answering "too many requests, try again" is more useful than a browser holding a connection open for an hour. Nothing is lost — the original file is never modified, and the person can repeat the action.

A queued media JOB is refused the same way, and its failure is reported in the job's own status, so raise this value on an installation that ingests long interviews in bulk and prefers a slow success to a refusal.

\`\`\`bash
DEDALO_MEDIA_AV_QUEUE_SECONDS=120
\`\`\``,
	},
	DEDALO_MEDIA_JOB_CONCURRENCY: {
		type: 'number',
		scope: 'operator',
		default: 3,
		heading: 'Defining media job concurrency',
		typeLabel: 'int',
		doc: `This parameter defines how many media jobs Dédalo will run at the same time.

Media processing (video transcoding, image derivatives, OCR) is heavy and runs inside the server process, so it is capped: a job that arrives while the lanes are busy is queued and starts as soon as one is free. The upload and the interface never block — only the processing waits.

By default Dédalo uses 3 lanes, a safe figure for a modest server. Raise it on a machine with cores to spare and a heavy ingest workload (bulk imports, long interviews); lower it to 1 when the server also serves the public site and must stay responsive while it transcodes. Values below 1 are raised to 1.

\`\`\`bash
DEDALO_MEDIA_JOB_CONCURRENCY=3
\`\`\``,
	},
	DEDALO_MEDIA_PROCESSES_DIR: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Defining the media job process files directory',
		typeLabel: 'string',
		doc: `This parameter defines the directory holding the process files of the media jobs.

Every media job writes a small JSON file with its state (progress, errors, result) that the client polls while it waits, and that lets a job be resumed after a restart. Terminal files are pruned automatically.

By default Dédalo writes them to \`processes/\` inside the private directory, which the server creates on demand. Change it when the private directory is on a read-only or network volume, or when several installations share one host and their job files must stay apart. The server needs read/write access to the directory as its owner.

\`\`\`bash
DEDALO_MEDIA_PROCESSES_DIR="/var/lib/dedalo/processes"
\`\`\``,
	},
	DEDALO_TEST_MEDIA_ROOT: {
		type: 'string',
		scope: 'test_seam',
		default: undefined,
		heading: 'Test media root',
		typeLabel: 'string',
		doc: `Test seam, not a setting. When it is set it REPLACES the media root for the whole process (it outranks MEDIA_PATH) and, at the same time, ARMS the test-media guard: every door that resolves a media root then refuses a root that does not carry a \`.dedalo_test_media\` marker file, and writes nothing.

One key does both on purpose. A separate "arm the guard" flag could be set without repointing the root — and a separate "repoint the root" key could be set without arming the guard; either half alone is the hole this closes, which is that a test run writes its derivatives, staged uploads and publication markers into the installation's media tree. Unset — every real installation — the guard is inert and the root resolves exactly as before.

The suite sets it from \`test/preload/test_media.ts\`, \`scripts/test_db_setup.ts\` and \`scripts/client_test_server.ts\`, at a directory derived from the suite database name.

\`\`\`bash
DEDALO_TEST_MEDIA_ROOT="/srv/dedalo/../private/test_media/dedalo7_test"
\`\`\``,
	},
	DEDALO_MEDIA_WEB_BASE: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Defining the media web base for the client',
		typeLabel: 'string',
		typeSuffix: '*optional — unset serves media same-origin*',
		doc: `This parameter defines the base every media URL served to the CLIENT is built on — the address the browser fetches images, video, PDFs and their derivatives from.

Unset (the default, and the right value whenever the web server that serves media also fronts the application), media URLs are RELATIVE: \`/dedalo/<DEDALO_MEDIA_DIR>/\` plus the file path, resolved by the browser against the page's own origin. Set it to an ABSOLUTE URL, without a trailing slash, when media is served from a DIFFERENT origin than the application — the typical case is development, with the application on the engine's TCP port and the media on the local web server that enforces the generated access rules:

\`\`\`bash
DEDALO_MEDIA_WEB_BASE="http://localhost:8080/dedalo/media"
\`\`\`

In a production topology (one virtual host fronting both the application and \`/dedalo/media\`) leave it unset.

Do not confuse it with DEDALO_MEDIA_EXPORT_BASE, which builds the media cells of EXPORTS — content that leaves the application and cannot use a relative URL. Both take the same kind of value (an origin plus \`/dedalo/<DEDALO_MEDIA_DIR>\`), and on a single-origin installation they are the same string; they differ in their audience and in what UNSET means. That key stays deliberately unset-means-unresolved; this one always has an effective value (the relative default).`,
	},
	DEDALO_PDF_ALTERNATIVE_EXTENSIONS: {
		type: 'string_list',
		scope: 'operator',
		default: ['jpg'],
		heading: 'PDF',
		typeLabel: 'array',
		typeSuffix: '*optional*',
		doc: `This parameter defines the image formats Dédalo renders the cover of an uploaded PDF into.

The cover is the first page of the document, rasterized into the web quality so that a viewer that cannot display a PDF still has a picture of it. One cover is written per format listed here, always composited onto white: a page has no paper of its own, so a cover built on a transparent background is a sheet of floating glyphs.

**The jpg cover is built whether or not this list names it.** It is what the record, the lists and the search results show, so it is not optional: removing jpg from this list does not stop it being built, and it does not un-index the covers already on disk. Adding another format here adds a cover beside the jpg one; it never replaces it.

Formats other than jpg are only worth adding for a specific consumer — avif for a web front end that prefers it, for instance. Each one is rendered at the same high density as the jpg cover, so it multiplies the part of the upload wait described in the warning below.

If a format is listed that the image processing program on this server cannot write, no cover is produced for it, the jpg cover is still built, and the refusal is reported in the upload response and named in the server log when Dédalo starts.

\`\`\`bash
DEDALO_PDF_ALTERNATIVE_EXTENSIONS=["jpg"]
\`\`\`

Example:

Original file: **my_pdf.pdf**

Formats defined in DEDALO_PDF_ALTERNATIVE_EXTENSIONS: **\\['avif','jpg'\\]**

Result:

In original quality directory (the uploaded file, untouched — no cover is built here):
> ../media/pdf/original/rsc37_rsc176_1.pdf

In web quality directory:
> ../media/pdf/web/rsc37_rsc176_1.pdf
>
> ../media/pdf/web/rsc37_rsc176_1.jpg
>
> ../media/pdf/web/rsc37_rsc176_1.avif

!!! warning "About increment time when uploaded PDF files render alternative versions"
    Alternative versions of PDF increase the rendering process time of uploaded PDF files by ~5 times.
    The render PDF use a high density dpi and reduce the final image to get a good anti-aliased image.
    This process increases the waiting time until the PDF is displayed and usable.`,
	},
	DEDALO_PDF_AR_QUALITY: {
		type: 'string_list',
		scope: 'operator',
		default: ['original', 'web'],
		heading: 'PDF',
		typeLabel: 'array',
		doc: `This parameter defines the different qualities that can be used for compress the PDF files.

This parameter will use to compress PDF files to specific quality. The compression will use the original file and will compress to those qualities when the user demand a specific quality.

\`\`\`bash
DEDALO_PDF_AR_QUALITY=["original","web"]
\`\`\``,
	},
	DEDALO_PDF_EXTENSION: {
		type: 'string',
		scope: 'operator',
		default: 'pdf',
		heading: 'PDF',
		typeLabel: 'string',
		doc: `This parameter defines the standard file type of pdf files.

\`\`\`bash
DEDALO_PDF_EXTENSION="pdf"
\`\`\``,
	},
	DEDALO_PDF_EXTENSIONS_SUPPORTED: {
		type: 'string_list',
		scope: 'operator',
		default: ['pdf', 'doc', 'pages', 'odt', 'ods', 'rtf', 'ppt'],
		heading: 'PDF',
		typeLabel: 'array',
		doc: `This parameter define the standards file type admitted for the pdf files. Dédalo will use this parameter to identify the file format of the original files uploaded by the users. Defaults to \`["pdf","doc","pages","odt","ods","rtf","ppt"]\`.

\`\`\`bash
DEDALO_PDF_EXTENSIONS_SUPPORTED=["pdf","doc","pages","odt","ods","rtf","ppt"]
\`\`\``,
	},
	DEDALO_PDF_FOLDER: {
		type: 'string',
		scope: 'operator',
		default: '/pdf',
		heading: 'PDF',
		typeLabel: 'int',
		doc: `This parameter defines the main directory for the pdf files.

\`\`\`bash
DEDALO_PDF_FOLDER="/pdf"
\`\`\``,
	},
	DEDALO_PDF_QUALITY_DEFAULT: {
		type: 'string',
		scope: 'operator',
		default: 'web',
		heading: 'PDF',
		typeLabel: 'string',
		doc: `This parameter defines the default quality used for the PDF files.

This parameter will use to compress all pdf files to specific format, unifying the quality used by all sections. By default Dédalo will compress images to jpg for web quality.

\`\`\`bash
DEDALO_PDF_QUALITY_DEFAULT="web"
\`\`\``,
	},
	DEDALO_PDF_QUALITY_ORIGINAL: {
		type: 'string',
		scope: 'operator',
		default: 'original',
		heading: 'PDF',
		typeLabel: 'string',
		doc: `This parameter defines the quality original for the pdf files.

This parameter will use to identify the uploaded files to with specific quality. Dédalo admit hight quality for PDF files (print formats or preservation formats), and it define this files as "original" quality. Dédalo will compress to web standard format, unify all different qualities and will store the original file without touch. In some cases, if the institution has a protocol for manage PDF files, is possible to use a specific quality for the files that users can upload. By default Dédalo do not limit the original format to be uploaded using a "original" quality denomination.

\`\`\`bash
DEDALO_PDF_QUALITY_ORIGINAL="original"
\`\`\``,
	},
	// DEDALO_PDF_THUMB_DEFAULT was DELETED here (2026-07-13) — same story as
	// DEDALO_IMAGE_THUMB_DEFAULT above: documented, never read, configured nothing.
	DEDALO_PDFINFO_PATH: {
		type: 'string',
		scope: 'operator',
		default: (get: CatalogGet) => `${get('DEDALO_BINARY_BASE')}/pdfinfo`,
		defaultDoc: '`<DEDALO_BINARY_BASE>/pdfinfo`',
		heading: 'PDF',
		typeLabel: 'string',
		doc: `This parameter defines the path to the \`pdfinfo\` program in the server, usually shipped with [Poppler](https://poppler.freedesktop.org/). Dédalo uses it to read the metadata of the uploaded PDF files — the number of pages and the creation date that feeds the automatic date components.

The path is derived from DEDALO_BINARY_BASE, so a normal Poppler install needs no configuration; set the key only to point at a binary in a non-standard location. When the binary is missing, the PDF is stored and converted normally but its date and page metadata are not extracted.

\`\`\`bash
DEDALO_PDFINFO_PATH="/usr/bin/pdfinfo"
\`\`\``,
	},
	DEDALO_PDFTOHTML_PATH: {
		type: 'string',
		scope: 'operator',
		default: (get: CatalogGet) => `${get('DEDALO_BINARY_BASE')}/pdftohtml`,
		defaultDoc: '`<DEDALO_BINARY_BASE>/pdftohtml`',
		heading: 'PDF',
		typeLabel: 'string',
		doc: `This parameter defines the path to the \`pdftohtml\` program in the server, usually shipped with [Poppler](https://poppler.freedesktop.org/). The PDF extractor tool uses it to pull the content of a PDF out as formatted HTML, keeping the layout of the page; the plain-text alternative is PDF_AUTOMATIC_TRANSCRIPTION_ENGINE, and the user chooses between them in the tool.

The path is derived from DEDALO_BINARY_BASE, so a normal Poppler install needs no configuration. Set this key only to point at a binary in a non-standard location.

\`\`\`bash
DEDALO_PDFTOHTML_PATH="/usr/bin/pdftohtml"
\`\`\``,
	},
	DEDALO_GS_PATH: {
		type: 'string',
		scope: 'operator',
		default: (get: CatalogGet) => `${get('DEDALO_BINARY_BASE')}/gs`,
		defaultDoc: '`<DEDALO_BINARY_BASE>/gs`',
		heading: 'PDF',
		typeLabel: 'string',
		doc: `This parameter defines the path to the \`gs\` program in the server, the [Ghostscript](https://www.ghostscript.com/) interpreter. Dédalo uses it — and only it — to turn the first page of an uploaded PDF into an image, which is how the cover and the thumbnail of a PDF record are produced.

ImageMagick is deliberately NOT asked to do this. ImageMagick cannot read a PDF by itself either: it hands the file to Ghostscript as a *delegate*, i.e. a second program that Dédalo did not start, cannot bound and cannot stop — a PDF declaring an enormous page then keeps a Ghostscript process running, and filling the disk, after the conversion that started it has already been killed. Dédalo therefore runs Ghostscript itself, refuses a page larger than DEDALO_MAGICK_LIMIT_WIDTH x DEDALO_MAGICK_LIMIT_HEIGHT before rendering anything, and the hardened ImageMagick policy denies the Ghostscript delegate outright.

Install Ghostscript (\`brew install ghostscript\`, \`apt install ghostscript\`; version 9.50 or newer, where the safe interpreter mode is the default) and the path is derived from DEDALO_BINARY_BASE, so no configuration is needed. Set this key only to point at a binary in a non-standard location. Without it, PDF records keep working — upload, storage, text extraction, display and download are unaffected — but their cover image and thumbnail cannot be built, and the media-versions panel says so.

\`\`\`bash
DEDALO_GS_PATH="/usr/bin/gs"
\`\`\``,
	},
	DEDALO_QUALITY_THUMB: {
		type: 'string',
		scope: 'operator',
		default: 'thumb',
		heading: 'Thumb',
		typeLabel: 'string',
		doc: `This parameter defines the thumb quality definition that can be used for compress the media files.

This parameter will use to compress and store image files used in lists. The compression will use the default file.

| Media | Remark |
| --- | --- |
| PDF | Will render the first page of the website in quality, if the default image does not exist it will try to use the original quality.|
| AV | Will render the posterframe.|
| Image | Will render the default quality, if the default image does not exist it will try to use the original quality.|
| SVG | Will render the default quality, if the default image does not exist it will try to use the original quality.|
| 3d | Will render the posterframe.|

\`\`\`bash
DEDALO_QUALITY_THUMB="thumb"
\`\`\``,
	},
	DEDALO_SUBTITLES_FOLDER: {
		type: 'string',
		scope: 'operator',
		default: '/subtitles',
		heading: 'Audiovisual',
		typeLabel: 'string',
		doc: `This parameter defines the path to the subtitles directory.

Dédalo will store the VTT files generated by the subtitle engine in this directory.

\`\`\`bash
DEDALO_SUBTITLES_FOLDER="/subtitles"
\`\`\``,
	},
	DEDALO_SVG_ALTERNATIVE_EXTENSIONS: {
		type: 'string_list',
		scope: 'operator',
		default: [],
		heading: 'SVG',
		typeLabel: 'array',
		typeSuffix: '*optional*',
		doc: `**This engine builds no alternative versions of svg files, so this parameter has no effect.** Keep it empty.

The reason is structural, not a missing option: the web version of an svg is a byte copy of the uploaded drawing, so there is no conversion step here that could be pointed at another format. A raster copy of a vector drawing would need an encoder this part of the engine does not have.

A value set here is not silently obeyed and not silently ignored either: the formats are refused at start-up, and the server log names this parameter, its value and this reason. Nothing is scanned for, indexed or offered in the versions panel for a file that cannot be produced.

Dédalo stores the uploaded file and the web version, and nothing else.

\`\`\`bash
DEDALO_SVG_ALTERNATIVE_EXTENSIONS=[]
\`\`\``,
	},
	DEDALO_SVG_AR_QUALITY: {
		type: 'string_list',
		scope: 'operator',
		default: ['original', 'web'],
		heading: 'SVG',
		typeLabel: 'array',
		doc: `This parameter defines the different qualities that can be used transformed svg files.

This parameter will use to store different svg version files to specific quality.

\`\`\`bash
DEDALO_SVG_AR_QUALITY=["original","web"]
\`\`\``,
	},
	DEDALO_SVG_EXTENSION: {
		type: 'string',
		scope: 'operator',
		default: 'svg',
		heading: 'SVG',
		typeLabel: 'string',
		doc: `This parameter defines the standard file type of svg files.

\`\`\`bash
DEDALO_SVG_EXTENSION="svg"
\`\`\``,
	},
	DEDALO_SVG_EXTENSIONS_SUPPORTED: {
		type: 'string_list',
		scope: 'operator',
		default: ['svg'],
		heading: 'SVG',
		typeLabel: 'array',
		doc: `This parameter defines the standards file type admitted for the svg files.

Dédalo will use this parameter to identify the file format of the original files uploaded by the users.

\`\`\`bash
DEDALO_SVG_EXTENSIONS_SUPPORTED=["svg"]
\`\`\``,
	},
	DEDALO_SVG_FOLDER: {
		type: 'string',
		scope: 'operator',
		default: '/svg',
		heading: 'SVG',
		typeLabel: 'string',
		doc: `This parameter defines the main directory for the svg files.

\`\`\`bash
DEDALO_SVG_FOLDER="/svg"
\`\`\``,
	},
	DEDALO_SVG_QUALITY_DEFAULT: {
		type: 'string',
		scope: 'operator',
		default: 'web',
		heading: 'SVG',
		typeLabel: 'string',
		doc: `This parameter defines the default quality used for the SVG files.

This parameter will use to store all svg files, unifying the quality used by all sections. By default Dédalo will use a flat svg for web quality.

\`\`\`bash
DEDALO_SVG_QUALITY_DEFAULT="web"
\`\`\``,
	},
	DEDALO_SVG_QUALITY_ORIGINAL: {
		type: 'string',
		scope: 'operator',
		default: 'original',
		heading: 'SVG',
		typeLabel: 'string',
		doc: `This parameter defines the quality original for the svg files.

This parameter will use to identify the uploaded files to with specific quality. Dédalo admit different editing vector formats, and it define this files as "original" quality, Dédalo will store the original file without touch. In some cases, if the institution has a protocol for manage SVG files, is possible to use a specific quality for the files that users can upload. By default Dédalo do not limit the original format to be uploaded using a "original" quality denomination.

\`\`\`bash
DEDALO_SVG_QUALITY_ORIGINAL="original"
\`\`\``,
	},
	DEDALO_THUMB_EXTENSION: {
		type: 'string',
		scope: 'operator',
		default: 'jpg',
		heading: 'Thumb',
		typeLabel: 'string',
		doc: `This parameter defines the standard file type of thumb files.

\`\`\`bash
DEDALO_THUMB_EXTENSION="jpg"
\`\`\``,
	},
	DEDALO_TOOL_EXPORT_FOLDER_PATH: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		defaultDoc: '`<media directory>/export/files` — inside the media tree',
		heading: 'Generated and exported files',
		typeLabel: 'string',
		typeSuffix: '*optional — unset means the default location inside the media directory*',
		doc: `This parameter defines where the export tool writes the bundles it produces.

Left unset — the normal case — the bundles go to \`export/files\` inside the media directory, and that directory is created and verified with the rest of the media tree when the server starts.

Set it to an ABSOLUTE path to put exports somewhere else entirely, which is the reason the setting exists: an export bundle can be large, is regenerated rather than curated, and an institution often wants it on a scratch volume, a shared mount, or a disk that is backed up on a different schedule from the archive itself. A relative value is refused rather than guessed at.

When the path lands OUTSIDE the media directory, Dédalo will create the directory itself but not the volume above it: its parent must already exist, so that a mount that has not come up is reported as a problem you can see instead of quietly recreated as an empty local directory — which is how an export lands on the system disk and fills it.

\`\`\`bash
DEDALO_TOOL_EXPORT_FOLDER_PATH="/srv/exports/dedalo"
\`\`\``,
	},
	DEDALO_UPLOAD_MAX_SIZE_BYTES: {
		type: 'number',
		scope: 'operator',
		default: 2 * 1024 * 1024 * 1024,
		heading: 'Defining the maximum upload size',
		typeLabel: 'int',
		doc: `This parameter defines the largest file, in BYTES, that Dédalo will accept in an upload.

The limit is enforced at three points, and it is a ceiling on the FILE, not on one request. The server publishes it to the client (the upload service reads it when it starts), so the interface can refuse an oversize file before a single byte travels and tell the user why; the server checks the size of every part it receives, so a single oversize request is refused whatever the client believes; and, because a chunked upload is many requests, the server also keeps a running total per transfer and sums the parts before it assembles them, so a file that only exceeds the limit once its chunks are added together is refused too.

A transfer refused for size is QUARANTINED, never deleted: the parts already received stay on disk under a rejection marker, and are released by cancelling the upload or by the ordinary 24 h sweep of staged files.

By default the limit is 2 GB (\`2147483648\`). Raise it for collections of long, high-resolution video — and remember that the web server in front of Dédalo has a limit of its own (\`client_max_body_size\` in nginx, \`LimitRequestBody\` in Apache) which must be at least as large, or the upload dies before it reaches the engine. Splitting the file into chunks (DEDALO_UPLOAD_SERVICE_CHUNK_FILES) is what keeps a single request small; it does not raise this ceiling.

\`\`\`bash
DEDALO_UPLOAD_MAX_SIZE_BYTES=2147483648
\`\`\``,
	},
	DEDALO_UPLOAD_SERVICE_CHUNK_FILES: {
		type: 'number',
		scope: 'operator',
		default: 4,
		heading: 'Defining upload split files in chunks',
		typeLabel: 'int || false',
		doc: `Defines the size at which files are split into chunks for upload.

This parameter allows you to break large files into smaller, more manageable pieces for reliable resumable uploads.

This parameter will use to split files at specific size into small chunks or blobs. The value is expressed in MB, but do not use the MB string, the value is a integer, for ex: 5 will be interpreted as 5MB.

When an integer is provided, any file larger than this value will be automatically segmented into chunks. The value is interpreted as Megabytes (MB). For example, chunkSize: 95 will create chunks of approximately 95MB each.

When set to \`false\`, the chunking feature is disabled, and all files are uploaded in a single request.

\`\`\`bash
# integer = split threshold in MB (e.g. 5 = 5MB); false = disable chunking
DEDALO_UPLOAD_SERVICE_CHUNK_FILES=false
\`\`\``,
	},
	DEDALO_UPLOAD_SERVICE_MAX_CONCURRENT: {
		type: 'number',
		scope: 'operator',
		default: 50,
		heading: 'Defining the maximum number of simultaneous connections for uploading chunked files',
		typeLabel: 'int || false',
		doc: `Defines the maximum number of simultaneous HTTP requests that can be open to the server when uploading a file in chunks.

When set to \`false\`, the internal limit is removed. The browser will then determine the maximum number of concurrent requests, which is typically based on the HTTP protocol version (see below).
When set to a positive integer (e.g., 50), the client will enforce that limit, ensuring no more than the specified number of chunks are uploaded simultaneously.

Protocol Dependencies:
This parameter is highly dependent on the HTTP protocol version in use:

For HTTP/1.1: The standard limits the number of simultaneous requests per domain to a very low number (typically 4-6). In this environment, setting a value higher than ~6 is ineffective and will be ignored by the browser. For optimal performance with HTTP/1.1, it is recommended to set this value to 4.
For HTTP/2: The protocol supports multiplexing, allowing many requests to be sent concurrently over a single connection. While this allows for a higher limit, setting the value too high can overwhelm the server with simultaneous processing load. This parameter should be used to throttle the requests to a level your server can handle reliably.

Purpose:
This setting allows you to optimize upload performance and ensure server stability by defining a number of concurrent chunk upload requests that your server can process efficiently.

\`\`\`bash
DEDALO_UPLOAD_SERVICE_MAX_CONCURRENT=50
\`\`\``,
	},
	DEDALO_UPLOAD_TMP_SUBDIR: {
		type: 'string',
		scope: 'operator',
		default: 'upload/service_upload/tmp',
		heading: 'Defining the upload staging directory',
		typeLabel: 'string',
		doc: `This parameter defines the staging directory where an upload is assembled, RELATIVE to the media root (MEDIA_PATH).

A file arriving in chunks is written there piece by piece, under a subdirectory of the user who is uploading it, and only when the last chunk has landed and the content has been verified is the finished file moved into its media folder. Nothing outside the staging tree is ever written by an upload in flight, and the path is confined to the media root: a value that escapes it is refused.

The default is \`upload/service_upload/tmp\`, and there is normally no reason to change it. A change is only useful to move the staging tree to a different subdirectory of the media volume — it must stay inside it, because the final move has to be a rename on the same filesystem, not a copy.

\`\`\`bash
DEDALO_UPLOAD_TMP_SUBDIR="upload/service_upload/tmp"
\`\`\``,
	},
	MEDIA_DEV_ROUTE_ENABLED: {
		// Tri-state: UNSET is not the same as 'false' (the reader branches on all
		// three), so type:'string' is right and the 'bool' LABEL was the lie.
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Serving media from the engine (development only)',
		typeLabel: 'true || false',
		typeSuffix: '*optional — unset is NOT the same as `false`*',
		doc: `**You normally leave this unset.** Media files are served by the WEB SERVER, which enforces the access rules Dédalo generates for it. But Dédalo can also serve them itself, straight from the media root — with no per-record access control at all. That fallback exists for the one setup that has no web server in the request path: a developer running the engine on its local TCP port.

Unset, the fallback is bound to conditions a production install cannot meet, so it needs no flag: it answers ONLY on the development TCP listener (production serves through a unix socket) and ONLY while media protection is unconfigured (once it is, the generated rules are authoritative and the engine must never undercut them).

Set the key only to override that decision. \`true\` FORCES the fallback on for every listener, the production socket included, serving every file under the media root to any logged-in session with no per-record or per-project check — never do this on a shared or public host; the server logs a loud warning when you do. \`false\` forces it off even in development.

\`\`\`bash
MEDIA_DEV_ROUTE_ENABLED=false
\`\`\``,
	},
	MEDIA_PATH: {
		type: 'string',
		scope: 'operator',
		default: () => legacyAwareDefaultDir('MEDIA_PATH', ['media'], ['media']),
		defaultDoc:
			'`<private dir>/media` — auto-derived; a legacy `<install dir>/media` holding files keeps being used (with a start-up warning) so nothing moves',
		heading: 'Defining media base path',
		typeLabel: 'string',
		doc: `This parameter defines the root media directory in the directory tree.

Unset, it defaults to \`media\` inside the private directory — OUTSIDE the code tree, because a code update replaces the whole install directory and must never carry the media library away with the old code. Installs that already keep their media at the legacy in-tree \`<install dir>/media\` location are not moved: while that directory holds files and this key is unset, it keeps being used and the server logs a one-line warning naming this key as the fix. Set the key (and move the directory) to end the warning.

The directory can be set to any path. The server needs read/write access to this directory as its owner. Unset in dev leaves media handling disabled.

\`\`\`bash
MEDIA_PATH="/srv/dedalo/media"
\`\`\``,
	},
	MEDIA_TREE_BOOT_BUDGET_MS: {
		type: 'number',
		scope: 'operator',
		default: 5000,
		clamp: { min: 100 },
		heading: 'Provisioning the media directories at start-up',
		typeLabel: 'int (milliseconds)',
		doc: `Every time the server starts it walks the media directories, creates any that are missing and reports any that are wrong. This parameter is the wall-clock budget for that walk.

On local storage the walk costs a couple of milliseconds and the budget is never reached. On network storage it is not free: the walk is around fifty directory look-ups plus three write probes, and at 200 ms of latency each that is a start-up that appears to hang. When the budget runs out, Dédalo stops the walk, reports the directory it stopped at and how many were left unchecked, and goes on to serve the archive — a slow media volume must never mean an archive that will not open. The directories it did not reach are simply checked again on the next start.

Raise it on an install whose media volume lives on the network and whose start-up log says the budget was exhausted; 30000 (thirty seconds) is a reasonable ceiling for a mount that is slow but healthy. The value is never allowed below 100 ms, because a budget too small to complete a single look-up would turn every start-up into the same error.

One limit is worth knowing, because no setting can remove it: if the media volume is not slow but UNREACHABLE — a hard network mount whose server is down — the very first look-up blocks inside the operating system, where nothing in Dédalo can interrupt it, and no budget of any size will expire. That situation is fixed in the mount (a soft mount, a timeout, an automounter), not here.

\`\`\`bash
MEDIA_TREE_BOOT_BUDGET_MS=5000
\`\`\``,
	},
	PDF_AUTOMATIC_TRANSCRIPTION_ENGINE: {
		type: 'string',
		scope: 'operator',
		default: (get: CatalogGet) => `${get('DEDALO_BINARY_BASE')}/pdftotext`,
		defaultDoc: '`<DEDALO_BINARY_BASE>/pdftotext`',
		heading: 'PDF',
		typeLabel: 'string',
		doc: `This parameter defines the path to the library, usually [xpdf](http://www.xpdfreader.com/download.html) (pdftotext), to be used for process the pdf to extract the information, this library will be used get the text fo the pdf files and store in the component_text_area. The text will be use to search inside the pdf information.

\`\`\`bash
PDF_AUTOMATIC_TRANSCRIPTION_ENGINE="/usr/bin/pdftotext"
\`\`\``,
	},
	PDF_OCR_ENGINE: {
		type: 'string',
		scope: 'operator',
		default: (get: CatalogGet) => `${get('DEDALO_BINARY_BASE')}/ocrmypdf`,
		defaultDoc: '`<DEDALO_BINARY_BASE>/ocrmypdf`',
		heading: 'PDF',
		typeLabel: 'string',
		doc: `This parameter defines the path to the library, usually [ocrmypdf](https://ocrmypdf.readthedocs.io/en/latest/index.html) that will be used for OCR processing of the pdf uploaded files. Optical Character Recognition or OCR is a technology that converts images of typed or handwritten text, such as in a scanned document, into computer text that can be selected, searched and copied.

\`\`\`bash
PDF_OCR_ENGINE="/usr/bin/ocrmypdf"
\`\`\``,
	},
} as const satisfies Record<string, CatalogEntry>;
