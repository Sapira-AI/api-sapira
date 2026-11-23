import { toSalesforceId18 } from './salesforce-id';

describe('toSalesforceId18', () => {
	it('completa un id de 15 caracteres con su sufijo de verificación', () => {
		expect(toSalesforceId18('0015w00002mURaY')).toBe('0015w00002mURaYAAW');
		expect(toSalesforceId18('001RO00000OGBsv')).toBe('001RO00000OGBsvYAH');
	});

	it('deja igual un id de 18 y quita espacios alrededor', () => {
		expect(toSalesforceId18(' 0015w00002mURaYAAW ')).toBe('0015w00002mURaYAAW');
	});

	it('null si no es un id del CRM', () => {
		expect(toSalesforceId18('')).toBeNull();
		expect(toSalesforceId18(null)).toBeNull();
		expect(toSalesforceId18('CL-0021')).toBeNull();
		expect(toSalesforceId18('0015w00002mURaYA')).toBeNull();
	});
});
