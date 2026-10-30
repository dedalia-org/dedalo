/**
 * publication_api widget — display-only panel (no execute action); its eager
 * catalog value comes from diffusion config constants (PHP get_ar_widgets).
 * Best-effort on the TS engine: domain/resolve_levels come from DEDALO_DIFFUSION_*
 * env, the publication languages from the ONE resolved set (config.diffusion.langs
 * — derived from the project languages when the key is unset), diffusion_map from
 * the ontology diffusion scan.
 * api_web_user_code_multiple = API_WEB_USER_CODE_MULTIPLE (config.diffusion
 * .publicationApiUsers): one Swagger-docu button per publication server API v1
 * database. publication_api_v2_url = DEDALO_PUBLICATION_API_V2_URL: one button to
 * the v2 API's own `<url>/docs`. Codes reach the client — safe only because the maintenance read is
 * global-admin-gated (core/area/read.ts).
 */

import type { WidgetModule } from './support.ts';

/**
 * LEDGER — coverage plan §4.4 D7, KNOWN-OPEN AND UNGATED. NOT an exempt adapter
 * shell (the critics RESCUED it from the §5 exempt list): the whole-body catch
 * below is an ERROR-ENVELOPE CHOICE with a wrong-output consequence. A THROWN
 * diffusion-map scan (`getSectionDiffusionMap` reading a broken ontology
 * diffusion config) collapses into a panel BYTE-IDENTICAL to "diffusion is not
 * configured" — the operator is told nothing is published here, and no error is
 * logged, raised or surfaced anywhere. Closing it means either taking the map
 * reader as a parameter and gating the catch arm against an injected thrower, or
 * distinguishing the two panels — the latter is a behaviour change and needs an
 * engineering/wire_contract/ entry.
 */
async function buildPublicationApiValue(): Promise<Record<string, unknown>> {
	try {
		const { readEnv } = await import('../../../config/env.ts');
		const { config } = await import('../../../config/config.ts');
		const { getSectionDiffusionMap } = await import('../../diffusion_bridge/diffusion_map.ts');
		const levelsRaw = readEnv('DEDALO_DIFFUSION_RESOLVE_LEVELS');
		const diffusionSections = [...(await getSectionDiffusionMap())];
		return {
			dedalo_diffusion_domain: readEnv('DEDALO_DIFFUSION_DOMAIN') ?? null,
			dedalo_diffusion_resolve_levels:
				levelsRaw !== undefined && levelsRaw !== '' ? Number(levelsRaw) : null,
			api_web_user_code_multiple: config.diffusion.publicationApiUsers,
			publication_api_v2_url: config.diffusion.publicationApiV2Url,
			// The ONE resolution of the publication languages (config.diffusion),
			// never a second parse of the raw key: the value may be a JSON array
			// (what the v6->v7 migration writes) and the hand `.split(',')` that
			// stood here turned `["lg-spa","lg-cat"]` into phantom codes.
			//
			// The UNSET case now DERIVES the project languages instead of reporting
			// []. The panel was the wrong one: the frozen oracle
			// (test/parity/fixtures/oracle_harvest/widgets_differential.json,
			// `dedalo_diffusion_langs`) shows the full derived set, i.e. the engine
			// publishes those languages whether or not the key is written — a panel
			// answering "no diffusion languages" contradicted what was published.
			dedalo_diffusion_langs: [...config.diffusion.langs],
			diffusion_map: { sections: diffusionSections, engine_reachable: null },
		};
	} catch {
		return {
			dedalo_diffusion_domain: null,
			dedalo_diffusion_resolve_levels: null,
			api_web_user_code_multiple: [],
			publication_api_v2_url: null,
			dedalo_diffusion_langs: [],
			diffusion_map: { sections: [], engine_reachable: null },
		};
	}
}

export const widget: WidgetModule = {
	spec: {
		id: 'publication_api',
		category: 'diffusion',
		label: { kind: 'literal', text: 'Publication server API' },
	},
	eagerValue: buildPublicationApiValue,
};
