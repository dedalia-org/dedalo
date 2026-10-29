/**
 * Login element context (PHP login::get_structure_context) — what the `start`
 * action returns when NO session exists, so the client renders the login form
 * instead of the default section (page.js builds whatever element the start
 * context describes).
 *
 * Shape (captured from live PHP): {typo:'ddo', type:'login', tipo:'dd229',
 * lang, mode:'edit', model:'login', label, properties:{login_items, info}}.
 * - login_items: the ontology CHILDREN of dd229 (user/password/email inputs +
 *   the login button), each enriched with its runtime model and app-lang label;
 * - info: entity/code-version/build/data-version/ontology-version rows shown
 *   under the form.
 */

import { config } from '../../../config/config.ts';
import { sql } from '../../db/postgres.ts';
import { getModelByTipo } from '../../ontology/resolver.ts';
import { contextLabelOf } from '../../resolve/structure_context.ts';
import { DEDALO_BUILD, DEDALO_ENGINE_VERSION } from '../../update/build_stamp.ts';
import { DEDALO_DATA_VERSION, formatVersion } from '../../update/version.ts';

/** The login element ontology tipo (PHP login::get_login_tipo). */
const LOGIN_TIPO = 'dd229';

/** One login form item: a child component of the login element. */
interface LoginItem {
	tipo: string;
	model: string | null;
	label: string | null;
}

/** Build the login structure context (see module doc for the captured shape). */
export async function buildLoginContext(): Promise<Record<string, unknown>> {
	// login_items: ontology children of dd229, in tree order.
	const children = (await sql`
		SELECT tipo FROM dd_ontology WHERE parent = ${LOGIN_TIPO} ORDER BY order_number, id
	`) as { tipo: string }[];
	const loginItems: LoginItem[] = [];
	for (const child of children) {
		loginItems.push({
			tipo: child.tipo,
			model: await getModelByTipo(child.tipo),
			label: await contextLabelOf(child.tipo),
		});
	}

	// info rows: install identity + versions (values mirror environment.ts).
	const dd1 = (await sql`
		SELECT properties FROM dd_ontology WHERE tipo = 'dd1' LIMIT 1
	`) as { properties: { version?: string; date?: string } | null }[];
	const info: Record<string, unknown>[] = [
		{ type: 'dedalo_entity', label: 'Dédalo entity', value: config.identity.entityLabel },
		{ type: 'version', label: 'Code version', value: DEDALO_ENGINE_VERSION },
		{ type: 'version', label: 'Code Build', value: DEDALO_BUILD }, // release commit date; null on dev
		{ type: 'data_version', label: 'Data version', value: formatVersion(DEDALO_DATA_VERSION) },
		{
			type: 'version',
			label: 'Ontology version',
			value: [dd1[0]?.properties?.version ?? null, dd1[0]?.properties?.date ?? null],
		},
	];

	return {
		typo: 'ddo',
		type: 'login',
		tipo: LOGIN_TIPO,
		lang: config.menu.applicationLang,
		mode: 'edit',
		model: 'login',
		label: await contextLabelOf(LOGIN_TIPO),
		properties: { login_items: loginItems, info },
	};
}
