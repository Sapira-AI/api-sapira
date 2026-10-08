import { rowsOf } from './query-rows';

describe('rowsOf', () => {
	it('UPDATE/DELETE … RETURNING ([rows, rowCount]) → las filas', () => {
		expect(rowsOf([[{ id: 'a' }, { id: 'b' }], 2])).toEqual([{ id: 'a' }, { id: 'b' }]);
	});

	it('UPDATE/DELETE sin filas afectadas ([[], 0]) → vacío', () => {
		expect(rowsOf([[], 0])).toEqual([]);
	});

	it('SELECT/INSERT (filas planas) → las mismas filas', () => {
		expect(rowsOf([{ id: 'a' }])).toEqual([{ id: 'a' }]);
		expect(rowsOf([])).toEqual([]);
	});

	it('cualquier otra cosa → vacío', () => {
		expect(rowsOf(undefined)).toEqual([]);
		expect(rowsOf(null)).toEqual([]);
		expect(rowsOf({ rows: [] })).toEqual([]);
	});
});
