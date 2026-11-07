// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/* global page_globals */
/*eslint no-undef: "error"*/

/**
 * CALENDAR_POPUP — the built-in date/time picker for component_date.
 *
 * WHY THIS EXISTS (2026-10): the component used to open flatpickr (4.6.13,
 * last released 2022, repo last pushed 2024, 860 open issues). Beyond the
 * upstream decay, flatpickr's grammar never fitted `dd_date`: its year token
 * is a literal `\d{4}`, so a BCE year like `-205` is UNPARSEABLE — the picker
 * silently opened at *today* and any click overwrote the typed value with a
 * full CE date — and a partial date (`2022`, `04/2022`) could not be produced
 * by the calendar at all. It was also never localized (English month names,
 * Sunday-first weeks, regardless of the UI language) and its trigger was
 * mouse-only.
 *
 * WHAT THIS IS. A small, dependency-free picker that speaks `dd_date`
 * directly:
 *   - a SIGNED year field (any integer — BCE and far-past years included) with
 *     a CE/BCE era toggle and decade steps;
 *   - a LOCALIZED month grid and day grid (Intl: month/weekday names, first
 *     day of the week) — the layout follows the interface language, never a
 *     hardcoded English one;
 *   - PROGRESSIVE PRECISION: the footer commits a year-only value (`2022`) or
 *     a year+month value (`04/2022`) from the current view, while the day grid
 *     commits a full date — exactly the partial dates `dd_date` stores;
 *   - a time picker (hour/minute/second selects — native controls, so phones
 *     get their own wheel UI) for the `time` / `time_range` modes;
 *   - full keyboard support (arrows/PageUp/PageDown/Home/End roving over one
 *     tab stop), touch-sized targets and a `popover`-based popup that rides
 *     the top layer, with a positioning fallback.
 *
 * THE POPUP IS THE ONLY THING THIS MODULE OWNS. It never formats a VALUE
 * string — the caller passes its ONE formatter (`format`) for the precision
 * chips and receives a plain `dd_date` partial through `on_select`; the
 * component's `date_to_string` stays the single date assembler of the client.
 * The grid math is integer-only (Howard Hinnant's days_from_civil /
 * civil_from_days, proleptic Gregorian): no `Date` year trap (0–99 → 1900s),
 * no timezone drift, exact for negative years. `Date` is used for *now* only.
 *
 * THEME. Every colour is a theme token (--bg_elevated, --fg_default,
 * --color_orange_dedalo with --fg_on_brand ink, …), so light and dark both
 * resolve here for free; styles live in component_date.less
 * (the popup is appended to <body>, outside `.component_date`).
 */

// imports
import { stop_page_shortcuts } from '../../common/js/utils/keyboard.js';

/**
 * LANG_TO_BCP47
 * Dédalo language codes are ISO 639-2 (`lg-eng`, `lg-spa`, …); Intl wants
 * BCP-47 (`en`, `es`, …). Exactly the languages the label catalog ships.
 * An unmapped code falls through to itself and then to page_globals.locale
 * (DEDALO_LOCALE), so an installation whose UI language has no entry here
 * still formats with its operator locale instead of silently using English.
 */
const LANG_TO_BCP47 = {
	ara: 'ar',
	ben: 'bn',
	cat: 'ca',
	chi: 'zh',
	deu: 'de',
	ell: 'el',
	eng: 'en',
	eus: 'eu',
	fra: 'fr',
	hin: 'hi',
	ita: 'it',
	jpn: 'ja',
	kor: 'ko',
	nep: 'ne',
	por: 'pt',
	rus: 'ru',
	spa: 'es',
	urd: 'ur',
};

/**
 * GET_LOCALE
 * The BCP-47 locale the calendar formats with, resolved once per popup:
 * the application language (mapped through LANG_TO_BCP47), then the operator
 * locale, then 'en'. A tag Intl refuses is skipped, never thrown.
 * @returns {string}
 */
export const get_locale = () => {
	const candidates = [];

	const app_lang =
		typeof page_globals !== 'undefined' &&
		(page_globals.dedalo_application_lang || page_globals.dedalo_data_lang)
			? String(page_globals.dedalo_application_lang || page_globals.dedalo_data_lang).replace(
					/^lg-/,
					'',
				)
			: null;
	if (app_lang) {
		candidates.push(LANG_TO_BCP47[app_lang] || app_lang);
	}
	if (typeof page_globals !== 'undefined' && page_globals.locale) {
		candidates.push(String(page_globals.locale).replace('_', '-'));
	}
	candidates.push('en');

	for (const candidate of candidates) {
		try {
			new Intl.DateTimeFormat(candidate);
			return candidate;
		} catch {
			// structurally invalid tag: try the next candidate
		}
	}

	return 'en';
}; //end get_locale

/**
 * IS_LEAP_YEAR
 * Proleptic Gregorian leap rule. Correct for negative years (the remainder of
 * an exact multiple is 0 or -0, both `=== 0`).
 * @param {number} year
 * @returns {boolean}
 */
const is_leap_year = (year) => {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}; //end is_leap_year

/**
 * DAYS_IN_MONTH
 * @param {number} year - any signed integer
 * @param {number} month - 1..12
 * @returns {number}
 */
const days_in_month = (year, month) => {
	if (month === 2) {
		return is_leap_year(year) ? 29 : 28;
	}
	return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}; //end days_in_month

/**
 * DAYS_FROM_CIVIL (Howard Hinnant)
 * Days since 1970-01-01 for a proleptic-Gregorian civil date — exact for every
 * integer year, which is precisely what a BCE-capable calendar needs and what
 * `Date` cannot give.
 * @param {number} year
 * @param {number} month - 1..12
 * @param {number} day
 * @returns {number}
 */
const days_from_civil = (year, month, day) => {
	const y = year - (month <= 2 ? 1 : 0);
	const era = Math.floor(y / 400);
	const yoe = y - era * 400;
	const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
	return era * 146097 + doe - 719468;
}; //end days_from_civil

/**
 * CIVIL_FROM_DAYS (Howard Hinnant)
 * The inverse of days_from_civil.
 * @param {number} z - days since 1970-01-01
 * @returns {{year:number, month:number, day:number}}
 */
const civil_from_days = (z) => {
	const days = z + 719468;
	const era = Math.floor(days / 146097);
	const doe = days - era * 146097;
	const yoe = Math.floor(
		(doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
	);
	const y = yoe + era * 400;
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
	const mp = Math.floor((5 * doy + 2) / 153);
	const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
	const month = mp + (mp < 10 ? 3 : -9);

	return {
		year: y + (month <= 2 ? 1 : 0),
		month: month,
		day: day,
	};
}; //end civil_from_days

/**
 * WEEKDAY_OF
 * 0 = Sunday … 6 = Saturday. Derived from the epoch-day count, so it is valid
 * for every year the calendar can show (negative included).
 * @param {number} year
 * @param {number} month
 * @param {number} day
 * @returns {number}
 */
const weekday_of = (year, month, day) => {
	return (((days_from_civil(year, month, day) + 4) % 7) + 7) % 7;
}; //end weekday_of

/**
 * FIRST_DAY_OF_WEEK
 * The locale's first day of the week (0 = Sunday), from Intl.Locale's weekInfo
 * where available. Fallback (browsers without weekInfo): Sunday for US English,
 * Monday otherwise — ISO 8601, which is what a heritage catalog should assume.
 * @param {string} locale
 * @returns {number}
 */
const first_day_of_week = (locale) => {
	try {
		const info = new Intl.Locale(locale);
		const week_info = typeof info.getWeekInfo === 'function' ? info.getWeekInfo() : info.weekInfo;
		if (week_info?.firstDay) {
			return week_info.firstDay % 7;
		}
	} catch {
		// next fallback
	}

	return /^en-us/i.test(locale) ? 0 : 1;
}; //end first_day_of_week

/**
 * BUILD_WEEKDAYS
 * The 7 localized weekday headers in display order, each carrying its short and
 * long name and its weekday index (0 = Sunday). Names come from dates in a
 * fixed week (2023-12-31 = Sunday … 2024-01-06 = Saturday) formatted with
 * `timeZone:'UTC'`, so nothing here depends on the machine's clock or zone.
 * @param {string} locale
 * @param {number} first_day - 0 = Sunday
 * @returns {Array<{weekday:number, short:string, long:string}>}
 */
const build_weekdays = (locale, first_day) => {
	const short_fmt = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
	const long_fmt = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });

	const weekdays = [];
	for (let i = 0; i < 7; i++) {
		const weekday = (first_day + i) % 7;
		const day_offset = weekday === 0 ? -1 : weekday - 1; // Sunday → 2023-12-31
		const date = new Date(Date.UTC(2024, 0, 1 + day_offset));
		weekdays.push({
			weekday: weekday,
			short: short_fmt.format(date),
			long: long_fmt.format(date),
		});
	}

	return weekdays;
}; //end build_weekdays

/**
 * MONTH_NAME
 * Localized month name. Formats a fixed mid-month date (2024) so only the
 * month/month-name is asked of Intl — never a BCE year it cannot format.
 * @param {string} locale
 * @param {number} month - 1..12
 * @returns {string}
 */
const month_name = (locale, month) => {
	const fmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' });
	return fmt.format(new Date(Date.UTC(2024, month - 1, 15)));
}; //end month_name

/**
 * SUPPORTS_POPOVER
 * Native popover in the top layer: light-dismiss (click outside), Escape and
 * stacking for free. Without it the popup is a fixed-position div with a
 * pointerdown/keydown fallback (same contract, no top layer).
 */
const SUPPORTS_POPOVER =
	typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function';

/** The ONE open popup (a date range has two fields; only one picker may open). */
let current_controller = null;

/** Gap between the trigger and the popup, px. */
const POPUP_GAP = 6;

/** Minimum distance the popup keeps from the viewport edges, px. */
const VIEWPORT_MARGIN = 8;

/**
 * PLACE_POPUP
 * Position the fixed popup against its anchor: centred below it, flipped above
 * when there is no room, clamped to the viewport. Called on open and on every
 * scroll/resize while visible.
 * @param {HTMLElement} popup
 * @param {HTMLElement} anchor
 * @returns {void}
 */
const place_popup = (popup, anchor) => {
	if (!anchor.isConnected) {
		return;
	}

	const rect = anchor.getBoundingClientRect();
	const width = popup.offsetWidth;
	const height = popup.offsetHeight;
	const vw = document.documentElement.clientWidth;
	const vh = document.documentElement.clientHeight;

	let left = rect.left + rect.width / 2 - width / 2;
	left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - width - VIEWPORT_MARGIN));

	let top = rect.bottom + POPUP_GAP;
	if (top + height > vh - VIEWPORT_MARGIN) {
		const above = rect.top - POPUP_GAP - height;
		top =
			above >= VIEWPORT_MARGIN ? above : Math.max(VIEWPORT_MARGIN, vh - VIEWPORT_MARGIN - height);
	}

	popup.style.left = `${Math.round(left)}px`;
	popup.style.top = `${Math.round(top)}px`;
}; //end place_popup

/**
 * OPEN_POPUP
 * Create, show and anchor a popup. Returns a controller `{popup, close}`; the
 * caller fills `popup` inside `build(popup, close)` and the controller closes
 * any other open popup first (one at a time).
 *
 * Close paths, all landing in the same `finalize`:
 *   - native popover: light dismiss / Escape → the element's `toggle` event;
 *   - fallback: document pointerdown outside / Escape keydown;
 *   - anchor detached or scrolled away;
 *   - explicit `close()` from a selection or a button.
 *
 * @param {Object} options
 *   @param {HTMLElement} options.anchor       - trigger the popup hangs off
 *   @param {string}      options.class_name   - popup variant class
 *   @param {string}      [options.label]      - accessible popup name
 *   @param {Function}    options.build        - (popup, close) => HTMLElement|null
 *                                              (returned node receives focus)
 *   @param {Function}    [options.on_close]   - called once after teardown
 * @returns {{popup:HTMLElement, close:Function, reposition:Function}}
 */
const open_popup = (options) => {
	// one picker at a time (the next open closes the previous)
	if (current_controller) {
		current_controller.close();
	}

	const anchor = options.anchor;

	const popup = document.createElement('div');
	popup.className = `dd_calendar_popup ${options.class_name || ''}`;
	popup.setAttribute('role', 'dialog');
	if (options.label) {
		popup.setAttribute('aria-label', options.label);
	}
	document.body.appendChild(popup);

	let closed = false;

	const close = (close_options = {}) => {
		finalize(close_options);
	};

	const finalize = (close_options = {}) => {
		if (closed) {
			return;
		}
		closed = true;

		window.removeEventListener('resize', reposition);
		window.removeEventListener('scroll', on_scroll, true);
		document.removeEventListener('pointerdown', on_outside_pointerdown, true);
		document.removeEventListener('keydown', on_escape_keydown, true);

		if (SUPPORTS_POPOVER) {
			if (popup.matches(':popover-open')) {
				popup.hidePopover();
			}
		}
		popup.remove();

		if (current_controller === controller) {
			current_controller = null;
		}

		if (typeof options.on_close === 'function') {
			options.on_close();
		}

		// focus back to the field on an explicit close (selection / Escape), so
		// the user can keep typing; NEVER on light dismiss (a tap elsewhere must
		// not pop a phone keyboard).
		if (close_options.focus_back && options.return_focus?.isConnected) {
			options.return_focus.focus({ preventScroll: true });
		}
	};

	const reposition = () => {
		if (!anchor.isConnected) {
			close();
			return;
		}
		place_popup(popup, anchor);
	};

	// anchor scrolled out of the viewport entirely → close (its field is gone
	// from view; keeping a floating picker would point at nothing)
	const on_scroll = () => {
		if (!anchor.isConnected) {
			close();
			return;
		}
		const rect = anchor.getBoundingClientRect();
		const off_screen = rect.bottom < 0 || rect.top > window.innerHeight;
		if (off_screen) {
			close();
			return;
		}
		reposition();
	};

	const on_outside_pointerdown = (e) => {
		if (!popup.contains(e.target) && !anchor.contains(e.target)) {
			close();
		}
	};

	const on_escape_keydown = (e) => {
		if (e.key === 'Escape') {
			close({ focus_back: true });
		}
	};

	const controller = { popup, close, reposition };

	// build content BEFORE showing so the first measure is the real size
	const initial_focus = options.build(popup, close);

	if (SUPPORTS_POPOVER) {
		popup.setAttribute('popover', 'auto');
		// native light-dismiss / Escape land here
		popup.addEventListener('toggle', (e) => {
			if (e.newState === 'closed') {
				finalize();
			}
		});
		popup.showPopover();
	} else {
		popup.classList.add('open');
		document.addEventListener('pointerdown', on_outside_pointerdown, true);
		document.addEventListener('keydown', on_escape_keydown, true);
	}

	window.addEventListener('resize', reposition);
	window.addEventListener('scroll', on_scroll, true);

	place_popup(popup, anchor);

	if (initial_focus && typeof initial_focus.focus === 'function') {
		initial_focus.focus({ preventScroll: true });
	}

	current_controller = controller;

	return controller;
}; //end open_popup

/**
 * MAKE_BUTTON
 * Small factory for the popup's native buttons (native = the tripwire's
 * keyboard-activable contract and the browser's own Enter/Space handling).
 * @param {Object} options - {class_name, text, aria_label, parent}
 * @returns {HTMLButtonElement}
 */
const make_button = (options) => {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = options.class_name || '';
	if (options.text !== undefined && options.text !== null) {
		button.textContent = options.text;
	}
	if (options.aria_label) {
		button.setAttribute('aria-label', options.aria_label);
	}
	if (options.parent) {
		options.parent.appendChild(button);
	}

	return button;
}; //end make_button

/**
 * OPEN_DATE_PICKER
 * The dd_date calendar. Opens anchored to `options.anchor`; commits through
 * `options.on_select(dd_date_partial)` — a `{year}`, `{year, month}` or
 * `{year, month, day}` object, negative year for BCE — and closes.
 *
 * @param {Object} options
 *   @param {HTMLElement} options.anchor    - the trigger element
 *   @param {Object}      [options.initial] - dd_date partial the calendar opens on
 *                                            (`{year?, month?, day?}`, year signed)
 *   @param {Function}    [options.format]  - the caller's ONE formatter, used for
 *                                            the precision chips' labels
 *   @param {Function}    options.on_select - receives the dd_date partial
 *   @param {Object}      [options.labels]  - localized strings (see render_edit)
 *   @param {HTMLElement} [options.return_focus] - node to refocus on explicit close
 *   @param {Function}    [options.on_close]
 * @returns {Object} controller {popup, close}
 */
export const open_date_picker = (options = {}) => {
	const anchor = options.anchor;
	const initial = options.initial || {};
	const labels = options.labels || {};
	const format = options.format;

	const locale = get_locale();
	const first_day = first_day_of_week(locale);
	const weekdays = build_weekdays(locale, first_day);

	const now = new Date();
	const today = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };

	// selected: what the input currently holds, as far as it parsed
	const selected = {
		year: Number.isInteger(initial.year) ? initial.year : null,
		month: Number.isInteger(initial.month) ? initial.month : null,
		day: Number.isInteger(initial.day) ? initial.day : null,
	};

	// state: the view being shown + the focused day (roving tabindex)
	const state = {
		year: selected.year ?? today.year,
		month: selected.month ?? today.month,
		day:
			selected.day ??
			(selected.year === null || (selected.year === today.year && selected.month === today.month)
				? today.day
				: 1),
	};

	let day_buttons = [];

	const controller = open_popup({
		anchor: anchor,
		class_name: 'dd_date_picker',
		label: labels.calendar || 'Calendar',
		return_focus: options.return_focus,
		on_close: options.on_close,
		build: (popup, close) => {
			/**
			 * SELECT
			 * Commit a dd_date partial and close.
			 */
			const select = (dd_date) => {
				if (typeof options.on_select === 'function') {
					options.on_select(dd_date);
				}
				close({ focus_back: true });
			};

			// ---- header ------------------------------------------------
			const header = document.createElement('div');
			header.className = 'dp_header';
			popup.appendChild(header);

			// year row: decade step back, era toggle, year input, decade step forward
			const year_row = document.createElement('div');
			year_row.className = 'dp_row dp_row_year';
			header.appendChild(year_row);

			const decade_prev = make_button({
				class_name: 'dp_nav dp_decade',
				text: '\u00ab',
				aria_label: `${labels.previous || 'Previous'} 10 ${labels.years || 'years'}`,
				parent: year_row,
			});
			const era_button = make_button({
				class_name: 'dp_era',
				parent: year_row,
			});
			era_button.setAttribute('aria-pressed', state.year < 0 ? 'true' : 'false');

			const year_input = document.createElement('input');
			year_input.type = 'text';
			year_input.inputMode = 'numeric';
			year_input.className = 'dp_year';
			year_input.autocomplete = 'off';
			year_input.setAttribute('aria-label', labels.year || 'year');
			year_row.appendChild(year_input);

			const decade_next = make_button({
				class_name: 'dp_nav dp_decade',
				text: '\u00bb',
				aria_label: `${labels.next || 'Next'} 10 ${labels.years || 'years'}`,
				parent: year_row,
			});

			// month row: previous month, month name, next month
			const month_row = document.createElement('div');
			month_row.className = 'dp_row dp_row_month';
			header.appendChild(month_row);

			const month_label = document.createElement('span');
			month_label.className = 'dp_month_label';
			month_label.setAttribute('aria-live', 'polite');

			const month_prev = make_button({
				class_name: 'dp_nav dp_month',
				text: '\u2039',
				parent: month_row,
			});
			month_row.appendChild(month_label);
			const month_next = make_button({
				class_name: 'dp_nav dp_month',
				text: '\u203a',
				parent: month_row,
			});

			// ---- day grid ----------------------------------------------
			const table = document.createElement('table');
			table.className = 'dp_grid';
			popup.appendChild(table);

			const thead = document.createElement('thead');
			table.appendChild(thead);
			const head_row = document.createElement('tr');
			thead.appendChild(head_row);
			for (const weekday of weekdays) {
				const th = document.createElement('th');
				th.scope = 'col';
				th.className = 'dp_weekday';
				th.textContent = weekday.short;
				th.setAttribute('aria-label', weekday.long);
				head_row.appendChild(th);
			}

			const tbody = document.createElement('tbody');
			table.appendChild(tbody);

			// ---- footer: precision chips --------------------------------
			const footer = document.createElement('div');
			footer.className = 'dp_footer';
			popup.appendChild(footer);

			const today_button = make_button({
				class_name: 'dp_action dp_action_today',
				text: labels.today || 'Today',
				parent: footer,
			});

			const year_chip = make_button({
				class_name: 'dp_action dp_action_year',
				parent: footer,
			});
			const month_chip = make_button({
				class_name: 'dp_action dp_action_month',
				parent: footer,
			});

			/**
			 * CHIP_LABEL
			 * The partial value as the caller's formatter writes it, so the chip
			 * and the input can never disagree (BCE included).
			 */
			const chip_label = (dd_date, fallback) => {
				return typeof format === 'function' ? format(dd_date) : fallback;
			};

			// ---- rendering ------------------------------------------------

			/**
			 * FOCUS_DAY
			 * Move the roving focus to a day of the CURRENT view (re-render first
			 * when the month changed).
			 */
			const focus_day = (day) => {
				const button = day_buttons.find((item) => Number(item.dataset.day) === day);
				if (!button) {
					return;
				}
				for (const item of day_buttons) {
					item.tabIndex = item === button ? 0 : -1;
				}
				button.focus({ preventScroll: true });
			};

			/**
			 * RENDER
			 * Full re-render of the view chrome + grid for the current state.
			 * Called on open and after every navigation/era/selection change.
			 */
			const render = () => {
				// header
				const month_text = month_name(locale, state.month);
				month_label.textContent = `${month_text} ${state.year}`;
				year_input.value = String(state.year);
				era_button.textContent = state.year < 0 ? labels.bce || 'BCE' : labels.ce || 'CE';
				era_button.setAttribute('aria-pressed', state.year < 0 ? 'true' : 'false');
				month_prev.setAttribute(
					'aria-label',
					`${labels.previous || 'Previous'}: ${month_label.textContent}`,
				);
				month_next.setAttribute(
					'aria-label',
					`${labels.next || 'Next'}: ${month_label.textContent}`,
				);

				// grid — 6 fixed week rows so the popup never jumps in height
				day_buttons = [];
				const rows = 6;
				const total_days = days_in_month(state.year, state.month);
				const leading = (weekday_of(state.year, state.month, 1) - first_day + 7) % 7;

				tbody.replaceChildren();
				for (let row = 0; row < rows; row++) {
					const tr = document.createElement('tr');
					tbody.appendChild(tr);
					for (let column = 0; column < 7; column++) {
						const cell = document.createElement('td');
						tr.appendChild(cell);
						const day_number = row * 7 + column - leading + 1;
						if (day_number < 1 || day_number > total_days) {
							// blank cell: nothing outside the current month is
							// clickable (adjacent months have their own view; a
							// non-interactive filler keeps the grid shape)
							cell.className = 'dp_day_empty';
							continue;
						}

						const button = document.createElement('button');
						button.type = 'button';
						button.className = 'dp_day';
						button.dataset.day = String(day_number);
						button.textContent = String(day_number);
						const weekday_long = weekdays.find(
							(item) => item.weekday === weekday_of(state.year, state.month, day_number),
						);
						const weekday_prefix = weekday_long ? `${weekday_long.long} ` : '';
						button.setAttribute(
							'aria-label',
							`${weekday_prefix}${day_number} ${month_text} ${state.year}`,
						);
						if (
							state.year === today.year &&
							state.month === today.month &&
							day_number === today.day
						) {
							button.classList.add('dp_today');
						}
						if (
							state.year === selected.year &&
							state.month === selected.month &&
							day_number === selected.day
						) {
							button.classList.add('dp_selected');
							button.setAttribute('aria-current', 'date');
						}
						button.tabIndex = day_number === state.day ? 0 : -1;
						button.addEventListener('click', () => {
							select({ year: state.year, month: state.month, day: day_number });
						});
						cell.appendChild(button);
						day_buttons.push(button);
					}
				}

				// footer — the current view as committable precision
				year_chip.textContent = chip_label({ year: state.year }, String(state.year));
				year_chip.setAttribute('aria-label', `${labels.year || 'year'}: ${year_chip.textContent}`);
				month_chip.textContent = chip_label(
					{ year: state.year, month: state.month },
					`${state.month}/${state.year}`,
				);
				month_chip.setAttribute(
					'aria-label',
					`${labels.month || 'month'}: ${month_chip.textContent}`,
				);
			}; //end render

			/**
			 * GO_TO_DAYS
			 * Navigate the view by an epoch-day delta (grid arrows / Home / End).
			 * Exact for negative years: the civil conversion does the carrying.
			 */
			const go_to_days = (delta) => {
				const target = civil_from_days(days_from_civil(state.year, state.month, state.day) + delta);
				state.year = target.year;
				state.month = target.month;
				state.day = target.day;
				render();
				focus_day(state.day);
			};

			/**
			 * GO_TO_MONTH
			 * Navigate whole months (PageUp/PageDown + header arrows), clamping
			 * the focused day to the target month's length (Feb 29 → Feb 28).
			 */
			const go_to_month = (delta) => {
				let year = state.year;
				let month = state.month + delta;
				while (month < 1) {
					month += 12;
					year--;
				}
				while (month > 12) {
					month -= 12;
					year++;
				}
				state.year = year;
				state.month = month;
				state.day = Math.min(state.day, days_in_month(year, month));
				render();
				focus_day(state.day);
			};

			/**
			 * GO_TO_YEAR
			 * Navigate whole years (Shift+PageUp/PageDown, era toggle, decade
			 * buttons), clamping Feb 29 in a non-leap target.
			 */
			const go_to_year = (delta) => {
				state.year = state.year + delta;
				state.day = Math.min(state.day, days_in_month(state.year, state.month));
				render();
				focus_day(state.day);
			};

			// ---- events ---------------------------------------------------

			tbody.addEventListener('keydown', (e) => {
				stop_page_shortcuts(e);

				switch (e.key) {
					case 'ArrowLeft':
						e.preventDefault();
						go_to_days(-1);
						break;
					case 'ArrowRight':
						e.preventDefault();
						go_to_days(1);
						break;
					case 'ArrowUp':
						e.preventDefault();
						go_to_days(-7);
						break;
					case 'ArrowDown':
						e.preventDefault();
						go_to_days(7);
						break;
					case 'PageUp':
						e.preventDefault();
						e.shiftKey ? go_to_year(-1) : go_to_month(-1);
						break;
					case 'PageDown':
						e.preventDefault();
						e.shiftKey ? go_to_year(1) : go_to_month(1);
						break;
					case 'Home': {
						e.preventDefault();
						const offset = (weekday_of(state.year, state.month, state.day) - first_day + 7) % 7;
						go_to_days(-offset);
						break;
					}
					case 'End': {
						e.preventDefault();
						const offset = (weekday_of(state.year, state.month, state.day) - first_day + 7) % 7;
						go_to_days(6 - offset);
						break;
					}
				}
			});

			// Escape closes the picker WITHOUT letting the page-level handler
			// also deactivate the component behind it (one key, one action).
			// (The native popover light-dismiss would close it too; this stops
			// the event first and keeps focus restore in ONE place.)
			popup.addEventListener('keydown', (e) => {
				if (e.key === 'Escape') {
					e.stopPropagation();
					e.preventDefault();
					close({ focus_back: true });
				}
			});

			decade_prev.addEventListener('click', () => go_to_year(-10));
			decade_next.addEventListener('click', () => go_to_year(10));
			month_prev.addEventListener('click', () => go_to_month(-1));
			month_next.addEventListener('click', () => go_to_month(1));

			era_button.addEventListener('click', () => {
				if (state.year === 0) {
					return;
				}
				state.year = -state.year;
				render();
			});

			// year typing: commit on change (Enter/blur), restore on garbage
			year_input.addEventListener('keydown', (e) => {
				stop_page_shortcuts(e);
				if (e.key === 'Enter') {
					year_input.blur();
				}
			});
			year_input.addEventListener('change', () => {
				const parsed = parseInt(String(year_input.value).replace(',', '.'), 10);
				if (Number.isSafeInteger(parsed) && String(parsed) === String(year_input.value).trim()) {
					state.year = parsed;
					state.day = Math.min(state.day, days_in_month(state.year, state.month));
					render();
				} else {
					year_input.value = String(state.year);
				}
			});

			today_button.addEventListener('click', () => {
				select({ year: today.year, month: today.month, day: today.day });
			});
			year_chip.addEventListener('click', () => {
				select({ year: state.year });
			});
			month_chip.addEventListener('click', () => {
				select({ year: state.year, month: state.month });
			});

			render();

			// initial focus: the selected day, or the first day of the shown
			// month when the value carries no day (a partial date)
			const initial_day =
				day_buttons.find((item) => Number(item.dataset.day) === state.day) || day_buttons[0];

			return initial_day;
		},
	});

	return controller;
}; //end open_date_picker

/**
 * OPEN_TIME_PICKER
 * The time picker: three native selects (hours/minutes/seconds, 24-hour), which
 * on phones get the OS's own wheel UI. Commits on every change through
 * `options.on_select({hour, minute, second})` and stays open until dismissed —
 * adjusting 14:30:00 is three touches, not three re-opens.
 *
 * @param {Object} options
 *   @param {HTMLElement} options.anchor    - the trigger element
 *   @param {Object}      [options.initial] - dd_time partial {hour?, minute?, second?}
 *   @param {Function}    options.on_select - receives the dd_time object
 *   @param {Object}      [options.labels]  - localized strings
 *   @param {HTMLElement} [options.return_focus]
 *   @param {Function}    [options.on_close]
 * @returns {Object} controller {popup, close}
 */
export const open_time_picker = (options = {}) => {
	const anchor = options.anchor;
	const initial = options.initial || {};
	const labels = options.labels || {};

	const now = new Date();
	const start = {
		hour: Number.isInteger(initial.hour) ? initial.hour : now.getHours(),
		minute: Number.isInteger(initial.minute) ? initial.minute : now.getMinutes(),
		second: Number.isInteger(initial.second) ? initial.second : now.getSeconds(),
	};

	const controller = open_popup({
		anchor: anchor,
		class_name: 'dd_time_picker',
		label: labels.time || 'Time',
		return_focus: options.return_focus,
		on_close: options.on_close,
		build: (popup) => {
			const row = document.createElement('div');
			row.className = 'dp_time_row';
			popup.appendChild(row);

			/**
			 * BUILD_SELECT
			 * One column of the picker. Native <select>: keyboard, screen readers
			 * and the phone wheel are the platform's, not ours.
			 */
			const build_select = (name, count, value, aria_label) => {
				const select = document.createElement('select');
				select.className = `dp_time_select dp_time_${name}`;
				select.setAttribute('aria-label', aria_label);
				for (let i = 0; i < count; i++) {
					const option = document.createElement('option');
					option.value = String(i);
					option.textContent = String(i).padStart(2, '0');
					if (i === value) {
						option.selected = true;
					}
					select.appendChild(option);
				}
				row.appendChild(select);
				return select;
			};

			const hour_select = build_select('hour', 24, start.hour, labels.hour || 'hour');
			const minute_select = build_select('minute', 60, start.minute, labels.minute || 'minute');
			const second_select = build_select('second', 60, start.second, labels.second || 'second');

			// commit on any change; the picker stays open for the next column
			const commit = () => {
				if (typeof options.on_select === 'function') {
					options.on_select({
						hour: Number(hour_select.value),
						minute: Number(minute_select.value),
						second: Number(second_select.value),
					});
				}
			};
			hour_select.addEventListener('change', commit);
			minute_select.addEventListener('change', commit);
			second_select.addEventListener('change', commit);

			return hour_select;
		},
	});

	return controller;
}; //end open_time_picker

// @license-end
