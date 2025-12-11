import { Injectable } from '@nestjs/common';
import { XMLParser } from 'fast-xml-parser';

@Injectable()
export class XmlRpcClientHelper {
	constructor(private readonly url: string) {}

	async methodCall(method: string, params: any[]): Promise<any> {
		const xmlPayload = this.buildXmlRpcRequest(method, params);

		const response = await fetch(this.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'text/xml',
				Accept: 'text/xml',
			},
			body: xmlPayload,
		});

		if (!response.ok) {
			throw new Error(`XML-RPC request failed: ${response.status} ${response.statusText}`);
		}

		const responseText = await response.text();

		return this.parseXmlRpcResponse(responseText);
	}

	private buildXmlRpcRequest(method: string, params: any[]): string {
		let xml = '<?xml version="1.0"?>\n<methodCall>\n';
		xml += `<methodName>${this.escapeXml(method)}</methodName>\n`;
		xml += '<params>\n';

		for (const param of params) {
			xml += '<param>\n';
			xml += this.valueToXml(param);
			xml += '</param>\n';
		}

		xml += '</params>\n</methodCall>';
		return xml;
	}

	private valueToXml(value: any): string {
		if (value === null || value === undefined) {
			return '<value><nil/></value>\n';
		}

		if (typeof value === 'string') {
			return `<value><string>${this.escapeXml(value)}</string></value>\n`;
		}

		if (typeof value === 'number') {
			if (Number.isInteger(value)) {
				return `<value><int>${value}</int></value>\n`;
			} else {
				return `<value><double>${value}</double></value>\n`;
			}
		}

		if (typeof value === 'boolean') {
			return `<value><boolean>${value ? '1' : '0'}</boolean></value>\n`;
		}

		if (Array.isArray(value)) {
			let xml = '<value><array><data>\n';
			for (const item of value) {
				xml += this.valueToXml(item);
			}
			xml += '</data></array></value>\n';
			return xml;
		}

		if (typeof value === 'object') {
			let xml = '<value><struct>\n';
			for (const [key, val] of Object.entries(value)) {
				xml += '<member>\n';
				xml += `<name>${this.escapeXml(key)}</name>\n`;
				xml += this.valueToXml(val);
				xml += '</member>\n';
			}
			xml += '</struct></value>\n';
			return xml;
		}

		return '<value><nil/></value>\n';
	}

	private parseXmlRpcResponse(xmlText: string): any {
		try {
			const parser = new XMLParser({
				ignoreAttributes: true,
				parseTagValue: true,
				trimValues: true,
				parseAttributeValue: false,
			});

			const result = parser.parse(xmlText);

			// Verificar si hay un methodResponse
			if (!result.methodResponse) {
				throw new Error('No methodResponse found in XML');
			}

			// Manejo de faults
			if (result.methodResponse.fault) {
				const faultValue = result.methodResponse.fault.value;
				console.error('XML-RPC Fault received:', faultValue);

				// Extraer faultCode y faultString de la estructura
				let faultCode = 'Unknown code';
				let faultString = 'Unknown fault';

				if (faultValue.struct?.member) {
					const members = Array.isArray(faultValue.struct.member) ? faultValue.struct.member : [faultValue.struct.member];
					for (const member of members) {
						if (member.name === 'faultCode') {
							faultCode = member.value.int || member.value;
						} else if (member.name === 'faultString') {
							faultString = member.value.string || member.value;
						}
					}
				}

				throw new Error(`XML-RPC Fault: ${faultString} (Code: ${faultCode})`);
			}

			// Respuesta exitosa
			if (result.methodResponse.params?.param?.value !== undefined) {
				const responseValue = this.extractXmlValue(result.methodResponse.params.param.value);

				return responseValue;
			}

			throw new Error('Invalid XML-RPC response format - no params found');
		} catch (error) {
			console.error('Error parsing XML-RPC response:', error);
			throw error;
		}
	}

	private extractXmlValue(value: any): any {
		if (value === null || value === undefined) {
			return null;
		}

		// Si es un valor simple, devolverlo
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			return value;
		}

		// Si tiene propiedades de tipo XML-RPC, extraer el valor
		if (value.int !== undefined) return parseInt(value.int);
		if (value.i4 !== undefined) return parseInt(value.i4);
		if (value.double !== undefined) return parseFloat(value.double);
		if (value.string !== undefined) return value.string;
		if (value.boolean !== undefined) return value.boolean === '1' || value.boolean === 1;
		if (value.nil !== undefined) return null;

		// Arrays
		if (value.array?.data) {
			const arrayData = value.array.data;
			if (arrayData.value) {
				// Si es un solo elemento, convertirlo a array
				const values = Array.isArray(arrayData.value) ? arrayData.value : [arrayData.value];
				return values.map((v) => this.extractXmlValue(v));
			}
			return [];
		}

		// Structs
		if (value.struct?.member) {
			const result: any = {};
			const members = Array.isArray(value.struct.member) ? value.struct.member : [value.struct.member];
			for (const member of members) {
				if (member.name && member.value !== undefined) {
					result[member.name] = this.extractXmlValue(member.value);
				}
			}
			return result;
		}

		// Si es un array directo
		if (Array.isArray(value)) {
			return value.map((v) => this.extractXmlValue(v));
		}

		// Si es un objeto, intentar extraer recursivamente
		if (typeof value === 'object') {
			const result: any = {};
			for (const [key, val] of Object.entries(value)) {
				result[key] = this.extractXmlValue(val);
			}
			return result;
		}

		return value;
	}

	private escapeXml(text: string): string {
		return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
	}
}
