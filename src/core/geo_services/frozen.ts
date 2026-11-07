/**
 * A TABLE NOBODY CAN EDIT AT RUN TIME.
 *
 * `Object.freeze` is shallow: freezing the table of services leaves every row, every `fixed`
 * tuple, every parameter list and every answer spec writable, and the table is exported — a
 * tool that imports it could set `GEO_ORIGINS.nominatim.base = 'https://elsewhere.example'`
 * and `buildGeoUrl` would build that address (its own check compares the URL with the very
 * row that was just edited), so the cataloguer's query text would go to a host of the
 * tool's choosing, which the guard would vet as public. "No override moves an endpoint" is
 * only true if the rows themselves cannot be written, so the table is frozen to its
 * leaves at module load (`table.ts`) and the gate walks it (`geo_services_native`).
 *
 * Functions are left alone: a check is a closure over its own grammar, reachable only as the
 * property of a frozen parameter definition, so it cannot be replaced. A RegExp is NOT made
 * safe by freezing, and that is why the table holds none: `RegExp.prototype.compile` assigns
 * the new pattern and only then fails on the frozen `lastIndex` (measured, Bun 1.4.4: the
 * pattern had changed when the TypeError arrived). Every pattern lives in a closure
 * (`token`, `matching` in `params.ts`), out of reach of anyone who imports the table; the gate
 * requires that no RegExp is reachable from it. A cycle is walked once.
 */

/** Freeze `value` and everything reachable from it by own properties; returns `value` itself. */
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
	if (value === null || typeof value !== 'object' || seen.has(value)) return value;
	seen.add(value);
	Object.freeze(value);
	for (const member of Object.values(value)) deepFreeze(member, seen);
	return value;
}
