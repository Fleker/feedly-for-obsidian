export interface RequestUrlParam {
	url: string;
	method?: string;
	contentType?: string;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
	throw?: boolean;
}

export interface RequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	json: any;
	text: string;
}

export class Notice {
	message: string;
	constructor(message: string, _timeout?: number) {
		this.message = message;
	}
	setMessage(message: string): this {
		this.message = message;
		return this;
	}
	hide(): void {}
}

export async function requestUrl(request: RequestUrlParam | string): Promise<RequestUrlResponse> {
	const param: RequestUrlParam = typeof request === 'string' ? { url: request } : request;
	const headers: Record<string, string> = { ...(param.headers ?? {}) };
	if (param.contentType && !headers['Content-Type'] && !headers['content-type']) {
		headers['Content-Type'] = param.contentType;
	}

	const response = await fetch(param.url, {
		method: param.method ?? 'GET',
		headers,
		body: param.body as any,
	});

	const arrayBuffer = await response.arrayBuffer();
	const text = new TextDecoder('utf-8').decode(arrayBuffer);
	let json: any = undefined;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		// Non-JSON response
	}

	if (param.throw !== false && response.status >= 400) {
		throw new Error(`Request failed, status ${response.status}: ${text}`);
	}

	const responseHeaders: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		responseHeaders[key] = value;
	});

	return {
		status: response.status,
		headers: responseHeaders,
		arrayBuffer,
		json,
		text,
	};
}
