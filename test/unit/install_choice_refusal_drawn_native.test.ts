/**
 * A REFUSED CHOICE IS DRAWN WITH ITS REASON (install campaign C4, DEB13 F1/F3):
 * on a development checkout the Image screen refuses Build (Docker has no
 * nightly images); the walker re-asked with the refusal attached, but the
 * choice widget never drew a question's errors — the cursor snapped back to
 * Custom with no word why. Measured on the widget's own drawn lines.
 */

import { describe, expect, test } from 'bun:test';
import { imageSourceRefusedFor } from '../../src/core/install/installer_identity.ts';
import type { Question } from '../../src/core/install/screen_model.ts';
import type { DrawContext } from '../../src/core/install/ui/widget.ts';
import { choiceField } from '../../src/core/install/ui/widgets/choice.ts';
import type { ReleaseIdentity } from '../../src/core/update/release_identity.ts';

const DEV = { kind: 'dev', version: '7.0.0-dev' } as unknown as ReleaseIdentity;
const CTX = { width: 100, layout: { descLines: 4 } } as unknown as DrawContext;

function imageQuestion(value: string, errors: string[], answered: boolean): Question {
	return {
		id: 'image_source',
		kind: 'choice',
		label: 'Image',
		description: 'Where the stack image comes from.',
		value,
		default: 'custom',
		answered,
		errors,
		options: [
			{ value: 'official', label: 'Official', description: '', marks: [] },
			{ value: 'custom', label: 'Custom', description: '', marks: [] },
			{ value: 'build', label: 'Build', description: '', marks: [] },
		],
	} as unknown as Question;
}

const drawnText = (question: Question): string =>
	choiceField(question, () => {})
		.lines(CTX)
		.lines.map((line) => line.map((segment) => segment.text).join(''))
		.join('\n');

describe('the choice widget draws the refusal of the answer just given', () => {
	const refusal = imageSourceRefusedFor('build', DEV);

	test('a development identity refuses Build, saying why', () => {
		expect(refusal).toContain('Docker has no nightly images');
		expect(refusal).toContain('a local build of it is not an image install');
	});

	test('Build refused → the reason is on screen (and the cursor is back on the default)', () => {
		const text = drawnText(imageQuestion('build', [refusal as string], true));
		expect(text).toContain('✗ Docker has no nightly images');
		expect(text).toMatch(/❯\s*◉ Custom/);
	});

	test('positive control: no error, no ✗ line (the assertion above is not vacuous)', () => {
		expect(drawnText(imageQuestion('custom', [], true))).not.toContain('✗');
	});

	test('an unanswered question draws no error (only after an answer)', () => {
		expect(drawnText(imageQuestion('build', [refusal as string], false))).not.toContain('✗');
	});
});
