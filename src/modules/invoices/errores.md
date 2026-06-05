[Nest] 2 - 06/05/2026, 12:00:47 PM WARN [OdooWebhookService] Estado en Odoo es 'draft', no 'posted'
[Nest] 2 - 06/05/2026, 12:00:47 PM LOG [AppLoggerService] POST /odoo/webhooks completed with status 201
[Nest] 2 - 06/05/2026, 12:00:47 PM LOG [InvoiceSchedulerService] 📝 Factura null tiene auto_invoice=true, emitiendo automáticamente...
XML-RPC Fault received: { struct: { member: [ [Object], [Object] ] } }
❌ Error emitiendo factura: Error: XML-RPC Fault: El diario requiere un tipo de documento pero no hay tipo de documento seleccionado en las facturas [191600]. (Code: 2)
Error parsing XML-RPC response: Error: XML-RPC Fault: El diario requiere un tipo de documento pero no hay tipo de documento seleccionado en las facturas [191600]. (Code: 2)
at XmlRpcClientHelper.parseXmlRpcResponse (/app/dist/modules/odoo/helpers/xml-rpc-client.helper.js:114:23)
at XmlRpcClientHelper.parseXmlRpcResponse (/app/dist/modules/odoo/helpers/xml-rpc-client.helper.js:114:23)
at XmlRpcClientHelper.methodCall (/app/dist/modules/odoo/helpers/xml-rpc-client.helper.js:33:21)
at XmlRpcClientHelper.methodCall (/app/dist/modules/odoo/helpers/xml-rpc-client.helper.js:33:21)
at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
at async OdooInvoicesService.postInvoice (/app/dist/modules/odoo/odoo-invoices.service.js:217:13)
at async InvoiceSchedulerService.sendInvoiceToOdoo (/app/dist/modules/invoices/invoice-scheduler.service.js:351:46)
at async InvoiceSchedulerService.processInvoicesToSend (/app/dist/modules/invoices/invoice-scheduler.service.js:75:32)
at async InvoiceSchedulerScheduler.sendInvoicesToOdooDaily (/app/dist/modules/invoices/invoice-scheduler.scheduler.js:54:28)
at async CronJob.<anonymous> (/app/node_modules/@nestjs/schedule/dist/schedule.explorer.js:119:17)
at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
at async OdooInvoicesService.postInvoice (/app/dist/modules/odoo/odoo-invoices.service.js:217:13)
at async InvoiceSchedulerService.sendInvoiceToOdoo (/app/dist/modules/invoices/invoice-scheduler.service.js:351:46)
at async InvoiceSchedulerService.processInvoicesToSend (/app/dist/modules/invoices/invoice-scheduler.service.js:75:32)
at async InvoiceSchedulerScheduler.sendInvoicesToOdooDaily (/app/dist/modules/invoices/invoice-scheduler.scheduler.js:54:28)
at async CronJob.<anonymous> (/app/node_modules/@nestjs/schedule/dist/schedule.explorer.js:119:17)
[Nest] 2 - 06/05/2026, 12:00:47 PM ERROR [InvoiceSchedulerService] ✗ Error al emitir factura null:
[Nest] 2 - 06/05/2026, 12:00:47 PM ERROR [InvoiceSchedulerService] Error: Error emitiendo factura en Odoo: XML-RPC Fault: El diario requiere un tipo de documento pero no hay tipo de documento seleccionado en las facturas [191600]. (Code: 2)
[Nest] 2 - 06/05/2026, 12:00:47 PM LOG [InvoiceSchedulerService] ✓ Procesamiento completado en 47.92s - Total: 6, Enviadas: 5, Errores: 1, Omitidas: 0
