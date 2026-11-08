/**
 * A VALUE THAT FITS THE BOX IS DRAWN WHOLE (install campaign C4, U26x86 F6):
 * the Services screen's 32-character socket default sat in a 34-cell box with
 * the caret at its end, and the leading `/` was scrolled off — a sysadmin
 * read a relative path. Measured on the drawn segments.
 */

import { describe, expect, test } from 'bun:test';
import { valueBox } from '../../src/core/install/ui/widgets/field_parts.ts';

const drawn = (text: string, caret: number, width: number): string =>
	valueBox(text, caret, width)
		.map((segment) => segment.text)
		.join('');

describe('the value box scrolls only what does not fit', () => {
	const socket = '/run/dedalo-museo/dedalo_ts.sock';

	test('exactly room characters before the caret: all drawn, the box width kept', () => {
		expect(socket).toHaveLength(32);
		const line = drawn(socket, socket.length, 34);
		expect(line).toBe(` ${socket}▏`);
		expect(Array.from(line)).toHaveLength(34);
	});

	test('one character more than room: only the first scrolls off', () => {
		const longer = `x${socket}`;
		expect(drawn(longer, longer.length, 34)).toBe(` ${socket}▏`);
	});

	test('caret anywhere in a longer value: the row never overflows the box', () => {
		const long = `${socket}/123456789`;
		for (let caret = 0; caret <= long.length; caret += 1) {
			expect(Array.from(drawn(long, caret, 34)), `caret ${caret}`).toHaveLength(34);
		}
	});

	test('caret at the start: the head drawn, the tail cut to the box', () => {
		const line = drawn(socket, 0, 20);
		expect(line.startsWith(' ▏/run/')).toBe(true);
		expect(Array.from(line)).toHaveLength(20);
	});
});
