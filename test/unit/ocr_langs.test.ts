/**
 * T0-11 D3 — the ONE map from a Dédalo language to its Tesseract model and the
 * OS package shipping it (src/core/media/engine/ocr_langs.ts). Pure: no DB, no
 * binary. The OCR door, the installer plan and system_info all read this map.
 */

import { describe, expect, test } from 'bun:test';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { INSTALL_LANG_CODES } from '../../src/core/install/lang_catalog.ts';
import {
	debianTesseractPackage,
	requireTesseractModel,
	rhelTesseractPackage,
	TESSERACT_MODELS,
	TESSERACT_OSD_MODEL,
	tesseractModelFor,
} from '../../src/core/media/engine/ocr_langs.ts';

describe('ocr_langs: Dédalo lang → Tesseract model', () => {
	test('strip lg- when the code is a Tesseract model', () => {
		expect(tesseractModelFor('lg-eng')).toBe('eng');
		expect(tesseractModelFor('lg-spa')).toBe('spa');
		expect(tesseractModelFor('lg-cat')).toBe('cat');
	});

	test('the explicit exceptions: Valencian reads Catalan, Chinese reads Simplified', () => {
		expect(tesseractModelFor('lg-vlca')).toBe('cat');
		expect(tesseractModelFor('lg-zho')).toBe('chi_sim');
		expect(tesseractModelFor('lg-cmn')).toBe('chi_sim');
		expect(tesseractModelFor('lg-chi')).toBe('chi_sim');
	});

	test('no model → null, never an identity guess', () => {
		expect(tesseractModelFor('lg-xyz')).toBeNull();
		expect(tesseractModelFor('spa')).toBeNull(); // not a Dédalo code
		expect(tesseractModelFor('lg-osd')).toBeNull(); // osd is not a language
		expect(TESSERACT_MODELS.has(TESSERACT_OSD_MODEL)).toBe(false);
	});

	test('requireTesseractModel refuses loudly with request.invalid_options', () => {
		expect(requireTesseractModel('lg-vlca')).toBe('cat');
		let caught: unknown;
		try {
			requireTesseractModel('lg-xyz');
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(DedaloError);
		expect((caught as DedaloError).code).toBe('request.invalid_options');
	});

	test('every language the installer offers has a model (else the plan only TELLS it)', () => {
		// Floor: the catalog really was read (an empty list would pass vacuously).
		expect(INSTALL_LANG_CODES.length).toBeGreaterThan(5);
		const without = INSTALL_LANG_CODES.filter((code) => tesseractModelFor(code) === null);
		expect(without).toEqual([]);
	});
});

describe('ocr_langs: model → package', () => {
	test('Debian/Ubuntu: tesseract-ocr-<model>, underscores as dashes', () => {
		expect(debianTesseractPackage('spa')).toBe('tesseract-ocr-spa');
		expect(debianTesseractPackage('chi_sim')).toBe('tesseract-ocr-chi-sim');
		expect(debianTesseractPackage(TESSERACT_OSD_MODEL)).toBe('tesseract-ocr-osd');
	});

	test('RHEL family: tesseract-langpack-<model>; osd is its own package', () => {
		expect(rhelTesseractPackage('spa')).toBe('tesseract-langpack-spa');
		expect(rhelTesseractPackage('chi_sim')).toBe('tesseract-langpack-chi_sim');
		expect(rhelTesseractPackage(TESSERACT_OSD_MODEL)).toBe('tesseract-osd');
	});
});
