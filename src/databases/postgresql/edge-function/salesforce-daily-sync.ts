import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
	if (req.method === 'OPTIONS') {
		return new Response(null, { headers: corsHeaders });
	}

	try {
		const supabaseAdmin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');

		console.log('🔄 Iniciando sincronización diaria de Salesforce...');

		// Obtener todas las conexiones activas de Salesforce
		const { data: connections, error: connError } = await supabaseAdmin
			.from('salesforce_connections')
			.select('*, company_holdings(id, name)')
			.eq('is_active', true);

		if (connError) {
			throw new Error(`Error obteniendo conexiones: ${connError.message}`);
		}

		if (!connections || connections.length === 0) {
			console.log('ℹ️ No hay conexiones activas de Salesforce');
			return new Response(JSON.stringify({ success: true, message: 'No hay conexiones activas', synced: 0 }), {
				headers: { ...corsHeaders, 'Content-Type': 'application/json' },
				status: 200,
			});
		}

		console.log(`📊 Encontradas ${connections.length} conexiones activas`);

		const results = [];

		// Sincronizar cada holding
		for (const connection of connections) {
			try {
				console.log(`\n🏢 Sincronizando holding: ${connection.holding_id}`);

				// Calcular rango de fechas: ayer
				const yesterday = new Date();
				yesterday.setDate(yesterday.getDate() - 1);
				const dateFrom = yesterday.toISOString().split('T')[0];
				const dateTo = dateFrom; // Mismo día

				console.log(`📅 Rango de fechas: ${dateFrom} a ${dateTo}`);

				// Query para obtener oportunidades del día anterior
				// Replica la lógica de la sincronización manual
				const soql = `
          SELECT 
            Id, Name, AccountId, Type, CloseDate, StageName, IsWon, IsClosed,
            Amount, CurrencyIsoCode, 
            Modalidad_de_pago__c, Forma_de_pago__c, Contrato__c, 
            Orden_de_compra__c, QuoteProjectManager__c, QuoteBillingEmail__c,
            id_largo_oportunidad__c,
            Account.Id, Account.Name, Account.BillingCountry
          FROM Opportunity
          WHERE CloseDate = ${dateFrom}
            AND (StageName = 'Ganado' OR StageName = 'Closed Won' OR StageName = 'Cerrada Win')
            AND IsDeleted = false
          ORDER BY CloseDate DESC
          LIMIT 1000
        `;

				console.log('🔍 Ejecutando query SOQL...');
				const queryUrl = `${connection.instance_url}/services/data/v58.0/query?q=${encodeURIComponent(soql)}`;

				const response = await fetch(queryUrl, {
					method: 'GET',
					headers: {
						Authorization: `Bearer ${connection.access_token}`,
						'Content-Type': 'application/json',
					},
				});

				if (!response.ok) {
					const errorText = await response.text();
					console.error(`❌ Error en query Salesforce: ${errorText}`);

					// Si el token expiró, intentar refrescar
					if (response.status === 401 && connection.refresh_token) {
						console.log('🔑 Token expirado, intentando refrescar...');

						const refreshParams = new URLSearchParams({
							grant_type: 'refresh_token',
							client_id: connection.client_id,
							client_secret: connection.client_secret,
							refresh_token: connection.refresh_token,
						});

						const refreshResponse = await fetch(`${connection.login_url}/services/oauth2/token`, {
							method: 'POST',
							headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
							body: refreshParams.toString(),
						});

						if (refreshResponse.ok) {
							const refreshData = await refreshResponse.json();
							console.log('✅ Token refrescado exitosamente');

							// Actualizar token en BD
							await supabaseAdmin
								.from('salesforce_connections')
								.update({
									access_token: refreshData.access_token,
									token_issued_at: new Date(parseInt(refreshData.issued_at)),
									last_sync_at: new Date(),
								})
								.eq('holding_id', connection.holding_id);

							// Reintentar query con nuevo token
							const retryResponse = await fetch(queryUrl, {
								method: 'GET',
								headers: {
									Authorization: `Bearer ${refreshData.access_token}`,
									'Content-Type': 'application/json',
								},
							});

							if (!retryResponse.ok) {
								throw new Error(`Query falló después de refresh: ${await retryResponse.text()}`);
							}

							const retryData = await retryResponse.json();
							const opportunities = retryData.records || [];
							const opportunitiesCount = opportunities.length;

							console.log(`📦 Encontradas ${opportunitiesCount} oportunidades (después de refresh), guardando en cache...`);

							// Guardar cada oportunidad en la tabla cache
							let savedCount = 0;
							for (const opp of opportunities) {
								try {
									const cacheData = {
										holding_id: connection.holding_id,
										salesforce_id: opp.Id,
										salesforce_account_id: opp.AccountId,
										opportunity_name: opp.Name,
										account_name: opp.Account?.Name || 'Sin cuenta',
										account_country: opp.Account?.BillingCountry || null,
										opportunity_type: opp.Type,
										stage_name: opp.StageName,
										is_won: opp.IsWon || false,
										is_closed: opp.IsClosed || false,
										amount: opp.Amount || 0,
										currency_iso_code: opp.CurrencyIsoCode || 'USD',
										close_date: opp.CloseDate,
										id_largo_oportunidad__c: opp.id_largo_oportunidad__c,
										modalidad_de_pago__c: opp.Modalidad_de_pago__c,
										forma_de_pago__c: opp.Forma_de_pago__c,
										contrato__c: opp.Contrato__c,
										orden_de_compra__c: opp.Orden_de_compra__c,
										quote_project_manager__c: opp.QuoteProjectManager__c,
										quote_billing_email__c: opp.QuoteBillingEmail__c,
										line_items_count: 0,
										line_items: [],
										sync_date: dateFrom,
									};

									const { error: upsertError } = await supabaseAdmin.from('salesforce_opportunities_cache').upsert(cacheData, {
										onConflict: 'holding_id,salesforce_id',
										ignoreDuplicates: false,
									});

									if (!upsertError) savedCount++;
								} catch (error: any) {
									console.error(`❌ Error procesando oportunidad ${opp.Id}:`, error.message);
								}
							}

							console.log(`✅ Holding ${connection.holding_id}: ${savedCount}/${opportunitiesCount} oportunidades guardadas`);

							results.push({
								holding_id: connection.holding_id,
								opportunities: opportunitiesCount,
								saved: savedCount,
								success: true,
							});

							continue;
						} else {
							throw new Error('Refresh token también expiró');
						}
					}

					throw new Error(`Query falló: ${errorText}`);
				}

				const data = await response.json();
				const opportunities = data.records || [];
				const opportunitiesCount = opportunities.length;

				console.log(`📦 Encontradas ${opportunitiesCount} oportunidades, guardando en cache...`);

				// Guardar cada oportunidad en la tabla cache
				let savedCount = 0;
				for (const opp of opportunities) {
					try {
						// Preparar datos para insertar
						const cacheData = {
							holding_id: connection.holding_id,
							salesforce_id: opp.Id,
							salesforce_account_id: opp.AccountId,
							opportunity_name: opp.Name,
							account_name: opp.Account?.Name || 'Sin cuenta',
							account_country: opp.Account?.BillingCountry || null,
							opportunity_type: opp.Type,
							stage_name: opp.StageName,
							is_won: opp.IsWon || false,
							is_closed: opp.IsClosed || false,
							amount: opp.Amount || 0,
							currency_iso_code: opp.CurrencyIsoCode || 'USD',
							close_date: opp.CloseDate,
							id_largo_oportunidad__c: opp.id_largo_oportunidad__c,
							modalidad_de_pago__c: opp.Modalidad_de_pago__c,
							forma_de_pago__c: opp.Forma_de_pago__c,
							contrato__c: opp.Contrato__c,
							orden_de_compra__c: opp.Orden_de_compra__c,
							quote_project_manager__c: opp.QuoteProjectManager__c,
							quote_billing_email__c: opp.QuoteBillingEmail__c,
							line_items_count: 0,
							line_items: [],
							sync_date: dateFrom,
						};

						// Upsert en la tabla cache (insertar o actualizar si ya existe)
						const { error: upsertError } = await supabaseAdmin.from('salesforce_opportunities_cache').upsert(cacheData, {
							onConflict: 'holding_id,salesforce_id',
							ignoreDuplicates: false,
						});

						if (upsertError) {
							console.error(`❌ Error guardando oportunidad ${opp.Id}:`, upsertError.message);
						} else {
							savedCount++;
						}
					} catch (error: any) {
						console.error(`❌ Error procesando oportunidad ${opp.Id}:`, error.message);
					}
				}

				// Actualizar last_sync_at
				await supabaseAdmin.from('salesforce_connections').update({ last_sync_at: new Date() }).eq('holding_id', connection.holding_id);

				console.log(`✅ Holding ${connection.holding_id}: ${savedCount}/${opportunitiesCount} oportunidades guardadas en cache`);

				results.push({
					holding_id: connection.holding_id,
					opportunities: opportunitiesCount,
					saved: savedCount,
					success: true,
				});
			} catch (error: any) {
				console.error(`❌ Error en holding ${connection.holding_id}:`, error.message);
				results.push({
					holding_id: connection.holding_id,
					error: error.message,
					success: false,
				});
			}
		}

		const successCount = results.filter((r) => r.success).length;
		const totalOpportunities = results.reduce((sum, r) => sum + (r.opportunities || 0), 0);

		console.log(`\n✅ Sincronización completada: ${successCount}/${connections.length} holdings exitosos`);
		console.log(`📊 Total de oportunidades encontradas: ${totalOpportunities}`);

		return new Response(
			JSON.stringify({
				success: true,
				message: 'Sincronización diaria completada',
				holdings_synced: successCount,
				total_holdings: connections.length,
				total_opportunities: totalOpportunities,
				results: results,
			}),
			{
				headers: { ...corsHeaders, 'Content-Type': 'application/json' },
				status: 200,
			}
		);
	} catch (error: any) {
		console.error('❌ Error en sincronización diaria:', error);
		return new Response(
			JSON.stringify({
				success: false,
				error: error.message,
			}),
			{
				headers: { ...corsHeaders, 'Content-Type': 'application/json' },
				status: 500,
			}
		);
	}
});
