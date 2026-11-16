/**
 * LINK fields of the shared mapped-import executor (import_execute.ts
 * `MappedRecord.links`): a TEXT that names a record of another section — the
 * Zotero `container-title` names a Series — resolved to a locator INSIDE the
 * importing record's transaction. Replaces PHP tool_import_zotero
 * get_section_id_from_zotero_container_title (a `limit 1` search: two Series of
 * one name linked an arbitrary one) + its unattributed create.
 *
 * THE LAW, per link:
 *   1. THE FIELD IS ASKED OF THE WRITE DOOR FIRST: a link the importer may not
 *      write creates nothing.
 *   2. FOUND BY EXACT NAME (`findSectionIdByCode`: the engine search, scoped to
 *      the importer, decided by a byte-exact second read). A name held by two
 *      records names neither — the FIELD is refused, nothing is created.
 *   3. ELSE CREATED, asked of the door (the section, then the name pair), born
 *      with the run's birth marker (`bulkProcessId` — reverting the run removes
 *      it) and named in the same transaction. A rolled-back record takes its
 *      created link with it.
 *   4. SERIALIZED: the name is advisory-locked (`lockLinkNames`, sorted, before
 *      the record's first write), so two records — of one run or of two
 *      concurrent runs — naming the same absent record create it ONCE.
 */

import { getComponentModel } from '../components/registry.ts';
import { acquireNodeLock } from '../db/postgres.ts';
import { DedaloError, isDedaloError } from '../errors/index.ts';
import { getModelByTipo, getTranslatableByTipo } from '../ontology/resolver.ts';
import { createSectionRecord } from '../section/record/create_record.ts';
import { saveComponentData } from '../section/record/save_component.ts';
import type { Principal } from '../security/permissions.ts';
import { authorizeSectionTarget } from '../security/write_door.ts';
import { findSectionIdByCode, textAsParagraph } from './import_code_lookup.ts';
import type { ConformFailure } from './import_data.ts';
import type { LinkField, MappedField } from './import_execute.ts';
import { isFieldWriteRefusal } from './import_field_refusal.ts';

/** The link's advisory-lock key (its own key space in the target section). */
function linkLockKey(link: LinkField): string {
	return `name:${link.target.componentTipo}:${link.text}`;
}

/**
 * Lock every link name of a record, once each, in SORTED order — called
 * before the record's first write, after its label locks (import_execute.ts
 * writeMappedRecord: one global order).
 */
export async function lockLinkNames(links: readonly LinkField[]): Promise<void> {
	const keys = new Map<string, LinkField>();
	for (const link of links) keys.set(`${link.target.sectionTipo}\u0000${linkLockKey(link)}`, link);
	for (const key of [...keys.keys()].sort()) {
		const link = keys.get(key) as LinkField;
		await acquireNodeLock(link.target.sectionTipo, linkLockKey(link));
	}
}

/** What resolving a record's links needs of the record being written. */
export interface LinkScope {
	principal: Principal;
	bulkProcessId: number;
	dataLang: string;
	/** The executor's write-door question for one field (its refusal sentence, or null). */
	fieldRefusal: (componentTipo: string) => Promise<string | null>;
}

/** One report line (the executor addresses it to the record). */
type ReportLine = Omit<ConformFailure, 'section_id'>;

/** The door's refusal for one link create, as a sentence — or null. */
async function createRefusal(link: LinkField, principal: Principal): Promise<string | null> {
	const door = { level: 2, door: 'import_execute.link_create' };
	try {
		await authorizeSectionTarget(principal, { section_tipo: link.target.sectionTipo }, door);
		await authorizeSectionTarget(
			principal,
			{ section_tipo: link.target.sectionTipo, tipo: link.target.componentTipo },
			door,
		);
		return null;
	} catch (error) {
		if (!isFieldWriteRefusal(error)) throw error;
		return `IGNORED: '${link.text}' names no record of ${link.target.sectionTipo}, and the importer may not create one there (${error.code}) — the field was NOT written`;
	}
}

/** The name as the name component stores it (an HTML component holds a paragraph). */
async function storedName(link: LinkField): Promise<string> {
	const model = await getModelByTipo(link.target.componentTipo);
	const html = model !== null && getComponentModel(model)?.render === 'html';
	return html ? textAsParagraph(link.text) : link.text;
}

/** Create the named record (birth-marked) and write its name. Throws when the name save is refused. */
async function createNamedRecord(link: LinkField, scope: LinkScope): Promise<number> {
	const { sectionTipo, componentTipo } = link.target;
	const sectionId = await createSectionRecord(
		sectionTipo,
		scope.principal.userId,
		new Date(),
		undefined,
		{ bulkProcessId: scope.bulkProcessId },
	);
	const translatable = await getTranslatableByTipo(componentTipo);
	const outcome = await saveComponentData({
		componentTipo,
		sectionTipo,
		sectionId,
		lang: translatable ? scope.dataLang : 'lg-nolan',
		changedData: [{ action: 'set_data', id: null, value: [{ value: await storedName(link) }] }],
		userId: scope.principal.userId,
		bulkProcessId: scope.bulkProcessId,
	});
	if (outcome.ok === false) {
		// The record rolls back with the nameless record it would otherwise keep.
		throw new DedaloError('record.save_failed', {
			message: `the new ${sectionTipo} record for '${link.text}' could not be named: ${outcome.message}`,
			coordinates: { section_tipo: sectionTipo, tipo: componentTipo },
		});
	}
	return sectionId;
}

/** The existing record the link names (null = none), or the ambiguity refusal. */
async function existingLinked(
	link: LinkField,
	principal: Principal,
): Promise<number | null | string> {
	try {
		return await findSectionIdByCode(link.target, link.text, principal);
	} catch (error) {
		if (!isDedaloError(error) || error.code !== 'resource.conflict') throw error;
		return `IGNORED: ${error.publicMessage ?? error.message} — the link was NOT written`;
	}
}

/** The record the link names: found, created, or the refusal sentence. */
async function linkedRecord(link: LinkField, scope: LinkScope): Promise<number | string> {
	const found = await existingLinked(link, scope.principal);
	if (found !== null) return found;
	const refusal = await createRefusal(link, scope.principal);
	return refusal ?? createNamedRecord(link, scope);
}

/**
 * The record's links as mapped fields (locator JSON, one field per component,
 * several links into one component accumulate). A refused link is reported
 * through `report` and contributes nothing. Runs inside the record's
 * transaction, after `lockLinkNames`.
 */
export async function resolveLinkFields(
	links: readonly LinkField[],
	scope: LinkScope,
	report: (line: ReportLine) => void,
): Promise<MappedField[]> {
	const byTipo = new Map<string, MappedField>();
	for (const link of links) {
		const line = { data: link.text, component_tipo: link.component_tipo };
		const doorRefusal = await scope.fieldRefusal(link.component_tipo);
		const target = doorRefusal ?? (await linkedRecord(link, scope));
		if (typeof target === 'string') {
			report({ ...line, msg: target });
			continue;
		}
		const value = JSON.stringify([{ section_tipo: link.target.sectionTipo, section_id: target }]);
		const field = byTipo.get(link.component_tipo);
		if (field === undefined)
			byTipo.set(link.component_tipo, { component_tipo: link.component_tipo, values: [value] });
		else field.values.push(value);
	}
	return [...byTipo.values()];
}
