import { clientLifecycleSql } from './client-lifecycle';

describe('clientLifecycleSql', () => {
	const sql = clientLifecycleSql('cl');

	it('evalúa en orden: vigente sin término → por terminar → en implementación → churn → prospecto', () => {
		const order = ["THEN 'active'", "THEN 'ending'", "THEN 'onboarding'", "THEN 'churned'", "ELSE 'prospect'"].map((token) => sql.indexOf(token));

		expect(order.every((position) => position > 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	it('las facturas solo cuentan como relación pasada, nunca como vigencia', () => {
		const [vigencia] = sql.split("THEN 'onboarding'");

		expect(vigencia).not.toContain('FROM invoices');
		expect(sql).toContain("lc_inv.status NOT IN ('Por Emitir', 'Cancelada')");
		expect(sql).toContain("lc_sub.status IN ('active', 'past_due')");
	});

	it('usa alias propios: se puede incluir en una consulta que llama `c` al cliente', () => {
		const embedded = clientLifecycleSql('c');

		expect(embedded).not.toMatch(/FROM (contracts|subscriptions|invoices|mrr_legacy) (c|s|i|m)\b/);
		expect(embedded).toContain('lc_ct.client_id = c.id');
	});
});
