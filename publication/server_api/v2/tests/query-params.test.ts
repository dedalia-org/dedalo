import { describe, test, expect } from 'bun:test';
import { parseFilterParams, parseSort, buildWhere, buildOrder } from '../src/utils/query-params';
import { ValidationError } from '../src/errors';

const params = (qs: string) => new URLSearchParams(qs);

describe('parseFilterParams', () => {
  test('parses filter[field]=value as eq', () => {
    const conditions = parseFilterParams(params('filter[code]=OH-001'));
    expect(conditions).toEqual([{ field: 'code', operator: 'eq', values: ['OH-001'] }]);
  });

  test('parses filter[field][op]=value', () => {
    const conditions = parseFilterParams(params('filter[code][like]=OH-%25'));
    expect(conditions).toEqual([{ field: 'code', operator: 'like', values: ['OH-%'] }]);
  });

  test('parses multiple conditions as AND', () => {
    const conditions = parseFilterParams(params('filter[code][like]=OH-%25&filter[lang]=lg-eng'));
    expect(conditions.length).toBe(2);
    expect(conditions[0].field).toBe('code');
    expect(conditions[1]).toEqual({ field: 'lang', operator: 'eq', values: ['lg-eng'] });
  });

  test('repeated same-field keys produce separate conditions (range)', () => {
    const conditions = parseFilterParams(params('filter[date][gte]=1936&filter[date][lte]=1939'));
    expect(conditions).toEqual([
      { field: 'date', operator: 'gte', values: ['1936'] },
      { field: 'date', operator: 'lte', values: ['1939'] },
    ]);
  });

  test('values containing ":" and "," need no escaping', () => {
    const conditions = parseFilterParams(params('filter[title]=a:b,c'));
    expect(conditions[0].values).toEqual(['a:b,c']);
  });

  test('in operator splits pipe-separated values', () => {
    const conditions = parseFilterParams(params('filter[section_id][in]=1|2|3'));
    expect(conditions[0]).toEqual({ field: 'section_id', operator: 'in', values: ['1', '2', '3'] });
  });

  test('is_null ignores the value', () => {
    const conditions = parseFilterParams(params('filter[parent][is_null]='));
    expect(conditions[0]).toEqual({ field: 'parent', operator: 'is_null', values: [] });
  });

  test('ignores non-filter params', () => {
    const conditions = parseFilterParams(params('limit=10&sort=title&filter[code]=x'));
    expect(conditions.length).toBe(1);
  });

  test('rejects bare filter= param', () => {
    expect(() => parseFilterParams(params('filter=code:eq:x'))).toThrow(ValidationError);
  });

  test('rejects malformed filter key', () => {
    expect(() => parseFilterParams(params('filter[code][eq][extra]=x'))).toThrow(ValidationError);
  });

  test('rejects unknown operator', () => {
    expect(() => parseFilterParams(params('filter[code][lke]=x'))).toThrow(ValidationError);
  });

  test('rejects invalid field identifier', () => {
    expect(() => parseFilterParams(params('filter[co;de]=x'))).toThrow(ValidationError);
    expect(() => parseFilterParams(params('filter[1abc]=x'))).toThrow(ValidationError);
  });

  test('rejects empty in list', () => {
    expect(() => parseFilterParams(params('filter[id][in]='))).toThrow(ValidationError);
  });

  test('empty params produce no conditions', () => {
    expect(parseFilterParams(params(''))).toEqual([]);
  });
});

describe('parseSort', () => {
  test('plain field is ascending', () => {
    expect(parseSort('title')).toEqual([{ field: 'title', direction: 'ASC' }]);
  });

  test('leading minus is descending', () => {
    expect(parseSort('-date')).toEqual([{ field: 'date', direction: 'DESC' }]);
  });

  test('multiple fields', () => {
    expect(parseSort('title,-section_id')).toEqual([
      { field: 'title', direction: 'ASC' },
      { field: 'section_id', direction: 'DESC' },
    ]);
  });

  test('rejects invalid identifier', () => {
    expect(() => parseSort('title;DROP')).toThrow(ValidationError);
  });

  test('empty string yields no clauses', () => {
    expect(parseSort('')).toEqual([]);
    expect(parseSort(' , ')).toEqual([]);
  });
});

describe('buildWhere', () => {
  test('builds parameterized clauses for all operators', () => {
    const { sql, params: p } = buildWhere([
      { field: 'a', operator: 'eq', values: ['1'] },
      { field: 'b', operator: 'ne', values: ['2'] },
      { field: 'c', operator: 'gt', values: ['3'] },
      { field: 'd', operator: 'gte', values: ['4'] },
      { field: 'e', operator: 'lt', values: ['5'] },
      { field: 'f', operator: 'lte', values: ['6'] },
      { field: 'g', operator: 'like', values: ['x%'] },
      { field: 'h', operator: 'in', values: ['7', '8'] },
      { field: 'i', operator: 'not_in', values: ['9'] },
      { field: 'j', operator: 'is_null', values: [] },
      { field: 'k', operator: 'is_not_null', values: [] },
    ]);
    expect(sql).toBe(
      '`a` = ? AND `b` != ? AND `c` > ? AND `d` >= ? AND `e` < ? AND `f` <= ? AND `g` LIKE ? AND `h` IN (?,?) AND `i` NOT IN (?) AND `j` IS NULL AND `k` IS NOT NULL',
    );
    expect(p).toEqual(['1', '2', 3, 4, 5, 6, 'x%', '7', '8', '9']);
  });

  test('range operands: numbers bind as numbers (BC years in text columns), the rest as text', () => {
    const bound = (value: string) => buildWhere([{ field: 'd', operator: 'gte', values: [value] }]).params[0];
    expect(bound('-150')).toBe(-150);
    expect(bound('2.5')).toBe(2.5);
    expect(bound('1936-05-01')).toBe('1936-05-01');
    expect(bound('12a')).toBe('12a');
    expect(bound('99999999999999999999')).toBe('99999999999999999999');
    // equality keeps text: '0012' must not match '12'
    expect(buildWhere([{ field: 'd', operator: 'eq', values: ['0012'] }]).params[0]).toBe('0012');
  });

  test('empty conditions produce empty sql', () => {
    expect(buildWhere([])).toEqual({ sql: '', params: [] });
  });

  test('field names are validated even when conditions are built programmatically', () => {
    expect(() => buildWhere([{ field: 'x; DROP TABLE', operator: 'eq', values: ['1'] }])).toThrow(ValidationError);
  });
});

describe('buildOrder', () => {
  test('builds quoted ORDER BY', () => {
    expect(buildOrder([
      { field: 'title', direction: 'ASC' },
      { field: 'date', direction: 'DESC' },
    ])).toBe('`title` ASC, `date` DESC');
  });

  test('empty clauses produce empty string', () => {
    expect(buildOrder([])).toBe('');
  });
});
