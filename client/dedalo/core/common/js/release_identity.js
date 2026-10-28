// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0

/**
 * RELEASE_IDENTITY (client)
 * `page_globals.dedalo_version` is the engine's RELEASE IDENTITY — what the
 * program calls itself (server: src/core/update/release_identity.ts):
 *   '7.0.0'          an exact stable release
 *   '7.0.0-beta.6'   an exact prerelease (alpha|beta|rc)
 *   '7.0.1-dev'      anything untagged (the NEXT triple; no data version of its own)
 * It is for DISPLAY. Every question that compares, migrates or crosses to
 * another server asks the DATA triple ('7.0.0') instead — read through
 * data_version_of, never by splitting the identity on dots: '7.0.0-beta.6'
 * splits into ['7','0','0-beta','6'], and that NaN once sent every page to the
 * update-data widget and let an ontology needing 7.0.1 pass as supported.
 *
 * Dependency-free on purpose: the boot path (render_page.js) and the
 * maintenance widgets import it, and a hermetic gate imports it directly
 * (test/unit/client_release_identity.test.ts).
 */

// The one grammar, mirrored from release_identity.ts (RELEASE_VERSION_RE + the
// dev form). The gate holds this mirror against the server's ordering fixture.
const IDENTITY_RE =
	/^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-(?:alpha|beta|rc)\.(?:0|[1-9]\d*))?$/;

/**
 * DATA_VERSION_OF
 * The data triple a RELEASE identity belongs to. A developer identity
 * ('7.0.1-dev') names the NEXT triple, not a data version: it answers '' here,
 * as the server's parseVersionString refuses it. The served page_globals carry
 * the data triple (dedalo_data_version) for that case.
 * @param {string|null|undefined} version - a release identity, e.g. '7.0.0-beta.6'
 * @returns {string} '7.0.0', or '' when the value is no release identity or is a developer one
 */
export const data_version_of = (version) => {
	const match = IDENTITY_RE.exec(String(version ?? ''));
	return match ? match[1] : '';
}; //end data_version_of

/**
 * CODE_SATISFIES
 * True when the running code's data triple is at least `required_version`
 * ('6.2.5', or a shorter 'major.minor'), compared numerically per segment
 * ('6.10.0' > '6.9.0'). A code identity that is no release identity, or a
 * requirement that is not numeric, can not be shown to satisfy anything:
 * false — never waved through on a NaN.
 * @param {string|null|undefined} required_version
 * @param {string|null|undefined} code_identity - page_globals.dedalo_version
 * @returns {boolean}
 */
export const code_satisfies = (required_version, code_identity) => {
	const code_data = data_version_of(code_identity);
	if (code_data === '') {
		return false;
	}
	const required_text = String(required_version ?? '');
	// Digits and dots only: '' and '7.x' are no requirement (Number('') is 0, not NaN).
	if (!/^\d+(\.\d+)*$/.test(required_text)) {
		return false;
	}
	const required = required_text.split('.').map(Number);
	const current = code_data.split('.').map(Number);
	for (let i = 0; i < required.length; i++) {
		const have = current[i] ?? 0;
		if (have > required[i]) {
			return true;
		}
		if (have < required[i]) {
			return false;
		}
	}
	return true;
}; //end code_satisfies

// @license-end
