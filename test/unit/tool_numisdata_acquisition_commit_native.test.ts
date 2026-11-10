/**
 * tool_numisdata_acquisition commit_lots — the WRITE door, driven for real
 * (review-diff 2026-10-21, tests S2: the door shipped with no write-path gate;
 * every earlier test of the tool avoided the write).
 *
 * The tool's targets are an installation's numisdata/rsc sections, which the
 * suite database never holds (the generic-TLD law). So the gate rebinds the
 * tool's ONE targets object (`withAcquisitionSeamForTests`) to a scratch `zzna`
 * situation of the SAME models — object / auction / entity / type / catalogue /
 * image sections, number, input_text, text_area, iri, autocomplete, select,
 * portal and image components — materialized through the engine's own write
 * path, and serves the lot image from a scripted site through the harvesting
 * door's own `hop` seam (no network). Everything else is the production path:
 * createSectionRecord, saveComponentData, the principal-scoped SQO dedup
 * searches under their advisory locks, cropCoinPair (ImageMagick), the media
 * ingest into the lane's marked suite media root, deleteSectionRecord.
 *
 * Cases:
 *  (a) one lot → exactly ONE object record, linked to ONE Auction (created with
 *      its Entity), fields written, both coin faces imported and linked;
 *  (b) a repeat commit creates nothing — on the (Auction, lot number) key, and
 *      on the canonical lot URL alone when the lot number differs;
 *  (c) a search batch ('Multiple auction houses') whose category does not
 *      split creates NO Entity and NO Auction (no sentinel junk records);
 *  (d) a failure on the SECOND face deletes the first face's image record and
 *      strips its portal locator — the pair is all-or-nothing.
 *
 * SCRATCH HYGIENE: `zzna` situation (→ matrix_test), records created at
 * runtime, swept by dropSituation (asserted 0 residue); media files named
 * `zzna…` swept from the lane's suite media root.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { sql } from '../../src/core/db/postgres.ts';
import type { HarvestDeps } from '../../src/core/harvest/harvest.ts';
import { stagingDir } from '../../src/core/media/ingest/add_file.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import type { PinnedHopRequest, PinnedHopResponse } from '../../src/core/security/ssrf_guard.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import type { ToolActionContext } from '../../src/core/tools/module.ts';
import {
	type AcquisitionTargets,
	tool,
	withAcquisitionSeamForTests,
} from '../../tools/tool_numisdata_acquisition/server/index.ts';

const TLD = 'zzna';
const USER_ID = -1;

const TARGETS: AcquisitionTargets = {
	object: 'zzna1',
	weight: 'zzna2',
	diameter: 'zzna3',
	inventoryNumber: 'zzna4',
	dateText: 'zzna5',
	auctionRelation: 'zzna6',
	obverseDesign: 'zzna7',
	reverseDesign: 'zzna8',
	publicRemark: 'zzna9',
	sourceUri: 'zzna10',
	typeRelation: 'zzna11',
	obversePortal: 'zzna12',
	reversePortal: 'zzna13',
	auctionSection: 'zzna20',
	auctionCompany: 'zzna21',
	auctionNumberTitle: 'zzna22',
	auctionCode: 'zzna23',
	entitySection: 'zzna30',
	entityName: 'zzna31',
	typeSection: 'zzna40',
	typeCode: 'zzna41',
	typeCatalogueRelation: 'zzna42',
	catalogueSection: 'zzna50',
	catalogueName: 'zzna51',
	imageSection: 'zzna60',
	imageComponent: 'zzna61',
};

/** A reverse portal no ontology node backs: its add_new_element fails, AFTER the obverse landed. */
const MISSING_PORTAL = 'zzna99';

const component = (tipo: string, parent: string, model: string, translatable = false) => ({
	tipo,
	parent,
	model,
	is_translatable: translatable,
	term: { 'lg-eng': `zz ${tipo}`, 'lg-spa': `zz ${tipo}` },
});
const section = (tipo: string) => ({
	tipo,
	parent: 'test1',
	model: 'section',
	term: { 'lg-eng': `zz ${tipo}`, 'lg-spa': `zz ${tipo}` },
});

/** A face portal's explicit request_config: its one target is the image section. */
const imagePortalConfig = {
	source: {
		request_config: [
			{ sqo: { section_tipo: [{ source: 'section', value: [TARGETS.imageSection] }] } },
		],
	},
};

const SITUATION = situation({
	tld: TLD,
	name: 'numisdata acquisition commit',
	nodes: [
		section(TARGETS.object),
		component(TARGETS.weight, TARGETS.object, 'component_number'),
		component(TARGETS.diameter, TARGETS.object, 'component_number'),
		component(TARGETS.inventoryNumber, TARGETS.object, 'component_input_text'),
		component(TARGETS.dateText, TARGETS.object, 'component_input_text', true),
		component(TARGETS.auctionRelation, TARGETS.object, 'component_autocomplete'),
		component(TARGETS.obverseDesign, TARGETS.object, 'component_text_area', true),
		component(TARGETS.reverseDesign, TARGETS.object, 'component_text_area', true),
		component(TARGETS.publicRemark, TARGETS.object, 'component_text_area', true),
		component(TARGETS.sourceUri, TARGETS.object, 'component_iri'),
		component(TARGETS.typeRelation, TARGETS.object, 'component_autocomplete'),
		// The face portals TARGET the image section (as the real numisdata portals
		// target rsc170): an add_new_element outside a portal's target_sections is
		// refused (T0-2 / D2), so the situation declares what the install declares.
		{
			...component(TARGETS.obversePortal, TARGETS.object, 'component_portal'),
			properties: imagePortalConfig,
		},
		{
			...component(TARGETS.reversePortal, TARGETS.object, 'component_portal'),
			properties: imagePortalConfig,
		},
		section(TARGETS.auctionSection),
		component(TARGETS.auctionCompany, TARGETS.auctionSection, 'component_autocomplete'),
		component(TARGETS.auctionNumberTitle, TARGETS.auctionSection, 'component_input_text'),
		component(TARGETS.auctionCode, TARGETS.auctionSection, 'component_input_text', true),
		section(TARGETS.entitySection),
		component(TARGETS.entityName, TARGETS.entitySection, 'component_input_text'),
		section(TARGETS.typeSection),
		component(TARGETS.typeCode, TARGETS.typeSection, 'component_input_text'),
		component(TARGETS.typeCatalogueRelation, TARGETS.typeSection, 'component_select'),
		section(TARGETS.catalogueSection),
		component(TARGETS.catalogueName, TARGETS.catalogueSection, 'component_input_text'),
		section(TARGETS.imageSection),
		component(TARGETS.imageComponent, TARGETS.imageSection, 'component_image'),
		// The image section's button_new. Each face's portal add_new_element is a
		// TOOL create (T0-2 / D3 REVISED): SECTION level + target_sections, it does
		// not ask the button; the node keeps the section create-able at the user
		// New-button doors too.
		component('zzna62', TARGETS.imageSection, 'button_new'),
	],
});

const IMAGE_URL = 'https://www.jesusvico.com/zz/coin_pair.png';
let coinPair: Uint8Array;

/** A scripted image site through the harvesting door's own `hop` seam (no socket). */
function scriptedSite(): HarvestDeps {
	const hop = async (request: PinnedHopRequest): Promise<PinnedHopResponse> => {
		const found = request.url.toString() === IMAGE_URL;
		const headers = new Headers(found ? { 'content-type': 'image/png' } : {});
		return {
			status: found ? 200 : 404,
			headers,
			location: null,
			bytes: found ? coinPair : new Uint8Array(0),
			truncated: false,
			bodySkipped: false,
		};
	};
	return { hop, sleep: async () => {}, setTimer: () => {} };
}

async function contextFor(options: Record<string, unknown>): Promise<ToolActionContext> {
	return {
		principal: await resolvePrincipal(USER_ID),
		userId: USER_ID,
		options,
		background: false,
	};
}

interface LotResult {
	section_id: number | null;
	error: unknown;
	skipped: boolean;
	auction_section_id: number | null;
	auction_created: boolean | null;
	images_created: string[] | null;
	images_error: unknown;
	images_orphaned: number[];
}

/** Run commit_lots with the tool rebound to the situation (and `targets` overrides). */
async function commit(
	options: Record<string, unknown>,
	targets: Partial<AcquisitionTargets> = {},
): Promise<LotResult[]> {
	const action = tool.apiActions?.commit_lots as {
		handler: (context: ToolActionContext) => Promise<unknown>;
	};
	const response = (await withAcquisitionSeamForTests(
		{ targets: { ...TARGETS, ...targets }, harvest: scriptedSite() },
		async () => action.handler(await contextFor(options)),
	)) as { ok: boolean; data: { results: LotResult[] } };
	expect(response.ok).toBe(true);
	return response.data.results;
}

/** The section ids a section holds now. */
async function idsOf(sectionTipo: string): Promise<number[]> {
	const table = (await getMatrixTableFromTipo(sectionTipo)) as string;
	const rows = (await sql.unsafe(
		`SELECT section_id FROM "${table}" WHERE section_tipo = $1 ORDER BY section_id`,
		[sectionTipo],
	)) as { section_id: number }[];
	return rows.map((row) => Number(row.section_id));
}

/** How many image-section ids the allocator has handed out (matrix_counter.value). */
async function mintedImageIds(): Promise<number> {
	const rows =
		(await sql`SELECT value FROM matrix_counter WHERE tipo = ${TARGETS.imageSection}`) as {
			value: number;
		}[];
	return Number(rows[0]?.value ?? 0);
}

/** One stored relation component of a record, as the matrix holds it. */
async function relationOf(
	sectionTipo: string,
	sectionId: number,
	tipo: string,
): Promise<unknown[]> {
	const table = (await getMatrixTableFromTipo(sectionTipo)) as string;
	const rows = (await sql.unsafe(
		`SELECT relation->$1 AS items FROM "${table}" WHERE section_tipo = $2 AND section_id = $3`,
		[tipo, sectionTipo, sectionId],
	)) as { items: unknown }[];
	const items = rows[0]?.items;
	return Array.isArray(items) ? items : [];
}

/** Remove every file this gate's ingest put under the lane's suite media root. */
function sweepMedia(dir: string | null): void {
	if (dir === null) return;
	let entries: import('node:fs').Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) sweepMedia(path);
		else if (entry.name.startsWith(TLD)) rmSync(path, { force: true });
	}
}

const AUCTION = {
	auctionHouse: 'Zz Numismatic House',
	auctionNumber: '180',
	title: 'Zz spring sale',
	sourceDomain: 'jesusvico.com',
};

/** A jesusvico lot of sale 180 (its canonical URL is rebuilt from `lotIdentifier`). */
const lot = (lotNumber: string, lotId = lotNumber) => ({
	lotIdentifier: `jesusvico:180:${lotId}`,
	lotNumber,
	description: 'A/ Laureate head right. R/ Eagle standing left.',
	weight: '3.85 g',
	diameter: '18 mm',
	images: [{ sourceUrl: IMAGE_URL }],
});

beforeAll(async () => {
	expect(config.media.rootPath, 'no suite media root — the preload did not arm it').not.toBeNull();
	await ensureSituation(SITUATION);
	// Two coin-sized blobs on white (each well over crop_50's 30000 px area floor):
	// what cropCoinPair splits into obverse + reverse.
	const magick = Bun.spawnSync([
		'magick',
		'-size',
		'1000x500',
		'xc:white',
		'-fill',
		'gray30',
		'-draw',
		'circle 250,250 250,80',
		'-draw',
		'circle 750,250 750,80',
		'png:-',
	]);
	expect(magick.exitCode).toBe(0);
	coinPair = new Uint8Array(magick.stdout);
}, 60000);

afterAll(async () => {
	sweepMedia(config.media.rootPath);
	// The tool's own staging directory under the suite root (its `.names` map included).
	rmSync(stagingDir(USER_ID, 'numisdata_acquisition'), { recursive: true, force: true });
	expect(await dropSituation(SITUATION)).toBe(0);
});

describe('commit_lots writes through the engine, once per lot', () => {
	test('(a) one lot: ONE object record, ONE Auction (+ Entity), fields and both faces linked', async () => {
		const [result] = await commit({
			lots: [lot('215')],
			auction: AUCTION,
			company_selection: { create: true, name: AUCTION.auctionHouse },
		});
		expect(result?.error).toBeNull();
		expect(result?.skipped).toBe(false);
		expect(result?.images_error).toBeNull();
		const objectId = result?.section_id as number;
		expect(await idsOf(TARGETS.object)).toEqual([objectId]);
		expect(result?.auction_created).toBe(true);
		const auctionIds = await idsOf(TARGETS.auctionSection);
		expect(auctionIds).toEqual([result?.auction_section_id as number]);
		expect((await idsOf(TARGETS.entitySection)).length).toBe(1);
		// The lot is linked to THAT Auction, and the Auction to its Entity.
		const auctionLink = await relationOf(TARGETS.object, objectId, TARGETS.auctionRelation);
		expect(auctionLink).toMatchObject([
			{ section_tipo: TARGETS.auctionSection, section_id: auctionIds[0] },
		]);
		expect(
			await relationOf(TARGETS.auctionSection, auctionIds[0] as number, TARGETS.auctionCompany),
		).toHaveLength(1);
		// Both faces: two image records, one per portal.
		expect(result?.images_created).toHaveLength(2);
		const images = await idsOf(TARGETS.imageSection);
		expect(images).toHaveLength(2);
		expect(await relationOf(TARGETS.object, objectId, TARGETS.obversePortal)).toMatchObject([
			{ section_tipo: TARGETS.imageSection },
		]);
		expect(await relationOf(TARGETS.object, objectId, TARGETS.reversePortal)).toMatchObject([
			{ section_tipo: TARGETS.imageSection },
		]);
	}, 120000);

	test('(b) a repeat commit creates nothing: (Auction, lot number) key, then the URL key alone', async () => {
		const before = {
			objects: await idsOf(TARGETS.object),
			auctions: await idsOf(TARGETS.auctionSection),
			images: await idsOf(TARGETS.imageSection),
		};
		const options = {
			auction: AUCTION,
			company_selection: { create: true, name: AUCTION.auctionHouse },
		};
		const [repeat] = await commit({ ...options, lots: [lot('215')] });
		expect(repeat?.skipped).toBe(true);
		expect(repeat?.section_id).toBe(before.objects[0] as number);
		// Same lot identity (same canonical URL), a lot number the lot key never saw.
		const [byUrl] = await commit({ ...options, lots: [lot(' 9215 ', '215')] });
		expect(byUrl?.skipped).toBe(true);
		expect(byUrl?.section_id).toBe(before.objects[0] as number);
		expect(await idsOf(TARGETS.object)).toEqual(before.objects);
		expect(await idsOf(TARGETS.auctionSection)).toEqual(before.auctions);
		expect(await idsOf(TARGETS.imageSection)).toEqual(before.images);
	}, 120000);

	test('(c) a search batch whose category does not split: no Entity, no Auction', async () => {
		const entities = await idsOf(TARGETS.entitySection);
		const auctions = await idsOf(TARGETS.auctionSection);
		const [result] = await commit({
			lots: [{ ...lot('31', '31'), lotIdentifier: undefined, category: 'Roman Republic' }],
			auction: {
				auctionHouse: 'Multiple auction houses',
				auctionNumber: 'zz-search-hash',
				sourceDomain: 'biddr.com',
			},
		});
		expect(result?.error).toBeNull();
		expect(result?.auction_section_id).toBeNull();
		expect(await idsOf(TARGETS.entitySection)).toEqual(entities);
		expect(await idsOf(TARGETS.auctionSection)).toEqual(auctions);
		// The lot itself was still created, unlinked.
		expect(
			await relationOf(TARGETS.object, result?.section_id as number, TARGETS.auctionRelation),
		).toEqual([]);
	}, 120000);

	test('(d) the SECOND face fails: the first face’s image record and its locator are gone', async () => {
		const imagesBefore = await idsOf(TARGETS.imageSection);
		const mintedBefore = await mintedImageIds();
		const [result] = await commit(
			{
				lots: [lot('77')],
				auction: AUCTION,
				company_selection: { create: true, name: AUCTION.auctionHouse },
			},
			{ reversePortal: MISSING_PORTAL },
		);
		expect(result?.error).toBeNull(); // the lot itself is real and complete
		expect(result?.images_created).toBeNull();
		expect(result?.images_error).not.toBeNull();
		expect(result?.images_orphaned).toEqual([]);
		// Anti-vacuity: the obverse record WAS minted (the failure is the second face's,
		// not an early crop/fetch refusal that never reached a record)…
		expect(await mintedImageIds()).toBe(mintedBefore + 1);
		// …and no image record survives the failed pair, nor the lot's obverse locator.
		expect(await idsOf(TARGETS.imageSection)).toEqual(imagesBefore);
		expect(
			await relationOf(TARGETS.object, result?.section_id as number, TARGETS.obversePortal),
		).toEqual([]);
	}, 120000);
});
