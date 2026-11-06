/********************************************************************************
 * Copyright (C) 2023-2026 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 ********************************************************************************/

/**
 * @file Core API Handler module for dynamic multi-tenant integrations, webhook routing, and AST macro pipeline execution.
 * @module @cocreate/api-handler
 */

import { URL } from 'node:url';
import {
    objectToSearchParams,
    searchParamsToObject,
    astAsync,
    security
} from '@cocreate/utils';

let server = null;
let crud = null;

function sendToServer(data) {
    const envelope = { ...data };
    delete envelope.socket;
    return server.send(envelope);
}

const API = {
    send,
    http,
    webhook,
    getApiConfig
};

/**
 * Binds server core services. Socket access is resolved when a request runs.
 *
 * @async
 * @param {Object} Server - Core server instance containing CRUD and, later, a socket manager on workers.
 * @param {Object} Server.crud - Database CRUD service operator.
 * @returns {Promise<Object>} Exported API interface.
 * @public
 * @environment server
 */
export async function init(Server) {
    server = Server;
    crud = server.crud;

    return API;
}

/**
 * Creates a Proxy firewall wrapper to automatically inject multi-tenant scope parameters (`organization_id` and `host`) into target method invocations.
 *
 * @param {Object} target - Target service instance to proxy (e.g., crud or wsManager).
 * @param {string} orgId - Multi-tenant organization identifier.
 * @param {string} host - Host domain identifier.
 * @returns {Proxy|undefined} Proxied target service with auto-injected tenant parameters, or undefined if target is falsy.
 * @private
 * @environment server
 */
function createTenantProxy(target, orgId, host) {
    if (!target) return undefined;
    return new Proxy(target, {
        get(targetObj, prop) {
            const original = targetObj[prop];
            if (typeof original === 'function') {
                return function (...args) {
                    if (args.length === 0) {
                        args.push({ organization_id: orgId, host });
                    } else if (typeof args[0] === 'object' && args[0] !== null) {
                        args[0].organization_id = orgId;
                        args[0].host = host;
                    }
                    return original.apply(targetObj, args);
                };
            }
            return original;
        }
    });
}

/**
 * Constructs an isolated execution sandbox enforcing multi-tenant isolation via proxy firewalls for AST operations.
 *
 * @param {Object} context - Raw execution context.
 * @param {Object} [context.payload] - Execution payload data object.
 * @param {Object} [context.event] - Webhook or inbound trigger event data.
 * @param {Object} [context.request] - Incoming HTTP request object.
 * @param {Object} [context.response] - Outgoing HTTP response object.
 * @param {Object} [context.crud] - Database service interface instance.
 * @param {Object} [context.wsManager] - WebSocket manager instance.
 * @param {string} [context.key] - Provider key/credential string.
 * @param {Object} [context.config] - Full provider API configuration object.
 * @param {string} context.organization_id - Target multi-tenant organization ID.
 * @param {string} context.host - Target host domain.
 * @returns {Object} Secure AST execution sandbox object containing firewalled utilities.
 * @private
 * @environment server
 */
function createSandbox(context) {
    const isPlatformOrg = server?.organization_id && (context.organization_id === server.organization_id);
    const secureCrud = createTenantProxy(context.crud, context.organization_id, context.host);
    const secureWs = createTenantProxy({ send: payload => server.send(payload) }, context.organization_id, context.host);

    const sandbox = {
        // Provider fields are configuration variables. For example, a
        // provider record containing `token` exposes `$token` to its AST
        // expressions. Trusted runtime bindings below remain authoritative.
        ...(context.config || {}),
        payload: context.payload,
        data: context.data || context.payload,
        event: context.event,
        request: context.request,
        response: context.response,
        header: context.request?.headers || context.header || {},
        searchParams: context.searchParams,
        objectToSearchParams,
        searchParamsToObject,
        Buffer,

        crud: secureCrud,
        socket: secureWs,
        wsManager: secureWs,
        security,

        key: context.key,
        config: context.config,
        organization_id: context.organization_id,
        host: context.host,

        api: {
            /**
             *
 * @public
 * @environment server
 */
            send: (apiData) => send(apiData, context)
        }
    };

    // Preserve privileged runtime bindings even when an evaluated record has
    // ordinary fields with the same names (for example api: "stripe"). The AST
    // resolver prefers the dollar-prefixed binding for operators such as
    // $api.send, while output fields may continue using their natural names.
    Object.assign(sandbox, {
        $payload: sandbox.payload,
        $data: sandbox.data,
        $event: sandbox.event,
        $request: sandbox.request,
        $response: sandbox.response,
        $header: sandbox.header,
        $crud: sandbox.crud,
        $socket: sandbox.socket,
        $wsManager: sandbox.wsManager,
        $security: sandbox.security,
        $config: sandbox.config,
        $api: sandbox.api
    });

    if (isPlatformOrg) {
        sandbox.server = server;
    }

    return sandbox;
}

/**
 * Resolves endpoint definitions, executes AST macro actions, or dispatches outgoing HTTP requests.
 *
 * @async
 * @param {Object} data - Execution directive payload.
 * @param {string} [data.url] - Optional pre-formatted target HTTP endpoint URL (Direct Execution Path).
 * @param {string} [data.api] - API configuration name (e.g., 'stripe-test').
 * @param {string} [data.method] - HTTP method (e.g., 'post'). A matched endpoint configuration may override it.
 * @param {string} [data.endpoint] - Stored endpoint name (e.g., 'create-customer') or direct API path (e.g., '/v1/customers').
 * @param {*} [data.data] - Request content passed to the external API.
 * @param {Object} [data.searchParams] - Query parameters appended to the request URL.
 * @param {Object} [data.headers] - Custom HTTP header directives.
 * @param {number} [data.timeout=15000] - Request timeout in milliseconds.
 * @param {string} [data.organization_id] - Multi-tenant organization identifier.
 * @param {string} [data.host] - Target host domain.
 * @param {Object|null} [parentContext=null] - Outer sandbox execution context when nested.
 * @returns {Promise<Object>} The mutated execution envelope, with response content assigned to `data.data`.
 * @throws {Error} If required directives are missing, provider configuration is invalid, or HTTP dispatch fails.
 * @public
 * @environment server
 */
export async function send(data, parentContext = null) {
    try {
        const wsManager = server?.wsManager;
        const orgId = parentContext?.organization_id || data.organization_id;
        const host = parentContext?.host || data.host;

        const apiName = data.api?.trim() || "";
        const endpoint = data.endpoint?.trim() || "";
        const payloadUrl = typeof data.url === "string"
            ? data.url.trim()
            : data.url || "";
        const apiConfig = apiName
            ? await getApiConfig({ organization_id: orgId, host }, apiName)
            : {};

        if (!endpoint && !payloadUrl && !apiConfig.endpoint && !apiConfig.url) {
            throw new Error("API execution request requires either 'endpoint' or 'url'.");
        }

        let endpointConfig = {};

        // Every endpoint value can identify a reusable endpoint configuration.
        // When no matching name exists, the value itself becomes the API path.
        if (endpoint && apiConfig._id) {
            const endpointFilter = {
                api_id: apiConfig._id,
                name: endpoint,
                enabled: true
            };
            if (data.method?.trim()) {
                endpointFilter.method = data.method.trim().toLowerCase();
            }

            const endpointQuery = {
                method: 'object.read',
                array: 'endpoints',
                organization_id: orgId,
                host,
                filter: {
                    query: endpointFilter,
                    limit: 1
                }
            };

            const endpointResponse = await crud.send(endpointQuery);
            endpointConfig = endpointResponse?.object?.[0] || {};
        }

        const apiContext = {
            ...(parentContext || {}),
            payload: data,
            event: parentContext?.event || {},
            organization_id: orgId,
            host,
            crud: parentContext?.crud || crud,
            wsManager: parentContext?.wsManager || wsManager,
            key: apiConfig.key,
            config: apiConfig
        };

        // Requests layer from general to specific: payload, API configuration,
        // then the matched endpoint as the authoritative macro override.
        const requestData = endpointConfig.data ?? apiConfig.data ?? data.data;
        const {
            headers: providerHeaders,
            data: providerData,
            endpoint: providerEndpoint,
            url: providerUrl,
            method: providerMethod,
            ...providerVariables
        } = apiConfig;
        let request = {
            // Provider-native variables must exist in the execution envelope
            // before endpoint and header AST expressions are evaluated.
            ...providerVariables,
            ...data,
            ...endpointConfig,
            method: endpointConfig.method?.trim() || apiConfig.method?.trim() || data.method?.trim(),
            endpoint: endpointConfig.endpoint || apiConfig.endpoint || endpoint,
            // URL configurations may be AST objects. Preserve them until the
            // request is evaluated, then normalize the resolved string below.
            url: endpointConfig.url || apiConfig.url || payloadUrl,
            headers: {
                ...(data.headers || {}),
                ...(providerHeaders || {}),
                ...(endpointConfig.headers || {})
            },
            timeout: endpointConfig.timeout ?? apiConfig.timeout ?? data.timeout ?? 15000,
            searchParams: endpointConfig.searchParams ?? apiConfig.searchParams ?? data.searchParams
        };

        // Request data may depend on named actions, so append it after the
        // endpoint definition to preserve sequential AST evaluation.
        delete request.data;
        request.data = requestData;

        request = await astAsync({
            executeAST: request,
            // `$data` is the caller's original API envelope. Endpoint records
            // map from it while provider fields remain top-level variables.
            sandbox: createSandbox(apiContext)
        });

        if (request.resolved) {
            data.data = request.data
            sendToServer(data);
            return data;
        }

        let url = request.url?.trim();
        if (!url) {
            throw new Error(`Configuration missing 'url' for API '${apiName || "direct"}'.`);
        }

        if (request.endpoint) {
            url = url.endsWith("/") ? url.slice(0, -1) : url;
            url += request.endpoint.startsWith("/") ? request.endpoint : `/${request.endpoint}`;
        }

        const searchParams = objectToSearchParams(request.searchParams);
        url += searchParams && url.includes("?") ? `&${searchParams.slice(1)}` : searchParams;

        const resolvedHttpMethod = request.method?.trim().toUpperCase();
        if (!resolvedHttpMethod) {
            throw new Error(`Configuration missing 'method' for API '${apiName || "direct"}'.`);
        }
        const options = {
            method: resolvedHttpMethod,
            headers: request.headers,
            timeout: request.timeout
        };

        if (!["GET", "HEAD"].includes(resolvedHttpMethod) && request.data !== undefined) {
            if (typeof request.data === 'object' && request.data !== null) {
                options.body = request.encoding === "form"
                    ? objectToSearchParams(request.data, false)
                    : JSON.stringify(request.data);
                if (!options.headers["Content-Type"] && !options.headers["content-type"]) {
                    options.headers["Content-Type"] = "application/json; charset=utf-8";
                }
            } else {
                options.body = String(request.data);
            }
        }

        const response = await makeHttpRequest(url, options);
        data.data = await parseResponseData(response);

        sendToServer(data);
        return data;
    } catch (error) {
        const wsManager = server?.wsManager;
        if (!Array.isArray(data.error)) {
            data.error = data.error ? [data.error] : [];
        }
        data.error.push(error.message);

        if (error.response) {
            data.status = error.response.status;
            data.statusText = error.response.statusText;
            data.responseData = error.response.data;
        }
        sendToServer(data);
        return data;
    }
}

/**
 * Handles inbound API HTTP requests, resolves host scope and authorizes before execution.
 * @param {object} req - Native HTTP request.
 * @param {object} res - Native HTTP response.
 * @param {object} [parsedInput] - Body already read by the manager HTTP entrance.
 * @param {Function} [execute] - Trusted dispatcher invoked only after request authorization.
 * @returns {Promise<object|undefined>} Successful execution result, otherwise undefined.
 * @public
 * @environment server
 */
export async function http(req, res, parsedInput, execute = request => server.api.send(request)) {
    const reply = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return reply(405, { error: 'Use POST for this operation.' });
    }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return reply(415, { error: 'An application/json body is required.' });
    }
    let input = parsedInput;
    try {
        if (input === undefined) {
            const chunks = [];
            let size = 0;
            for await (const chunk of req) {
                const buffer = Buffer.from(chunk);
                size += buffer.length;
                if (size > 1024 * 1024) return reply(413, { error: 'Request body exceeds 1 MiB.' });
                chunks.push(buffer);
            }
            input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    } catch {
        return reply(400, { error: 'A JSON object is required.' });
    }

    const bearer = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const apikey = bearer || input.apikey;
    if ((apikey !== undefined && (typeof apikey !== 'string' || !apikey.trim())) ||
        (bearer && input.apikey !== undefined && input.apikey !== bearer)) {
        return reply(401, { error: 'A valid API key is required.' });
    }

    try {
        const host = new URL(`https://${req.headers.host}`).hostname;
        const organization = await server.crud.getOrganization({ host });
        if (!organization?._id || organization.error) return reply(404, { error: 'Organization not found.' });
        if (typeof input.api !== 'string' || !input.api.trim() ||
            typeof input.endpoint !== 'string' || !input.endpoint.trim() ||
            typeof input.method !== 'string' || !input.method.trim()) {
            return reply(400, { error: 'api, endpoint and method are required.' });
        }
        const envelope = pickHttpFields(input, ['api', 'endpoint', 'method', 'data', 'region', 'headers', 'searchParams', 'timeout']);
        // Scope and identity are server-resolved, never supplied by the caller.
        Object.assign(envelope, { organization_id: organization._id, host, apikey });
        const request = await server.authorize?.request(envelope);
        if (!request) return reply(403, { error: 'Operation is not authorized.' });
        const result = await execute(request);
        const failed = result?.success === false || hasHttpErrors(result?.error);
        reply(failed ? 400 : 200, result);
        return failed ? undefined : result;
    } catch (error) {
        if (error.code === 'AUTHORIZATION_DENIED') return reply(403, { error: error.message });
        return reply(500, { error: 'Unable to process the operation.' });
    }
}

function hasHttpErrors(error) {
    return Array.isArray(error) ? error.length > 0 : Boolean(error);
}

function pickHttpFields(input, fields) {
    return Object.fromEntries(fields.filter(field => Object.hasOwn(input, field)).map(field => [field, input[field]]));
}

/**
 * Processes incoming HTTP webhook requests, verifies HMAC/JWT security signatures, and executes pipelines.
 *
 * @async
 * @param {Object} req - Native Node.js HTTP incoming request stream.
 * @param {Object} res - Native Node.js HTTP server response stream.
 * @returns {Promise<void>}
 * @public
 * @environment server
 */
export async function webhook(req, res) {
    try {
        const wsManager = server?.wsManager;
        const urlObject = new URL(`http://${req.headers.host}${req.url}`);
        const hostname = urlObject.hostname;

        let organization;
        try {
            organization = await crud.getOrganization({ host: hostname });
        } catch {
            res.writeHead(404, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Organization mapping not found" }));
        }

        const webhookPath = urlObject.pathname.replace(/^\/webhooks\//, "");

        const webhookQuery = {
            method: 'object.read',
            array: 'webhooks',
            organization_id: organization._id,
            host: hostname,
            filter: {
                query: { path: webhookPath, enabled: true },
                limit: 1
            }
        };

        const webhookResponse = await crud.send(webhookQuery);
        const webhookConfig = webhookResponse?.object?.[0];

        if (!webhookConfig) {
            res.writeHead(404, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: `Webhook configuration for path '${webhookPath}' not found.` }));
        }

        let apiConfig = {};
        if (webhookConfig.api_id) {
            const apiResponse = await crud.send({
                method: 'object.read',
                array: 'apis',
                organization_id: organization._id,
                host: hostname,
                filter: {
                    query: { _id: webhookConfig.api_id, enabled: true },
                    limit: 1
                }
            });
            apiConfig = apiResponse?.object?.[0] || {};
        }

        const context = {
            request: req,
            response: res,
            searchParams: searchParamsToObject(urlObject.searchParams),
            host: hostname,
            organization,
            organization_id: organization._id,
            crud,
            wsManager,
            key: apiConfig.key,
            config: apiConfig
        };

        const result = await astAsync({
            executeAST: webhookConfig,
            sandbox: createSandbox(context)
        });

        if (res && !res.writableEnded) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                message: "Webhook processed successfully",
                payload: result
            }));
        }
    } catch (error) {
        if (res && !res.writableEnded) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid webhook request format", message: error.message }));
        }
    }
}

/**
 * Low-level HTTP dispatch utility wrapping native `fetch` with AbortController timeout handling.
 *
 * @async
 * @param {string} url - Absolute target URL endpoint.
 * @param {Object} [options={}] - Fetch request options (method, headers, body, signal).
 * @param {number} [options.timeout=15000] - Timeout threshold in milliseconds before aborting.
 * @returns {Promise<Response>} Native fetch Response instance.
 * @throws {Error} Throws HTTP error status or network timeout error.
 * @public
 * @environment server
 */
export async function makeHttpRequest(url, options) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeout || 15000);
    options.signal = controller.signal;

    try {
        const response = await fetch(url, options);
        clearTimeout(timeoutId);

        if (!response.ok) {
            const text = await response.text();
            const providerError = parseXmlError(text);
            const detail = providerError?.message;
            const code = providerError?.code;
            const error = new Error(
                detail
                    ? `${code ? `${code}: ` : ""}${detail}`
                    : `HTTP error! Status: ${response.status} ${response.statusText}`
            );
            error.response = {
                status: response.status,
                statusText: response.statusText,
                data: text,
                error: providerError
            };
            throw error;
        }
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

function decodeXmlText(value) {
    if (value === undefined) return undefined;
    return value
        .replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

function getXmlTagValue(xml, tagName) {
    if (!xml || typeof xml !== "string") return undefined;
    const match = xml.match(
        new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i")
    );
    return match ? decodeXmlText(match[1].trim()) : undefined;
}

function parseXmlError(text) {
    if (!text || typeof text !== "string" || !text.trimStart().startsWith("<")) {
        return undefined;
    }

    const code = getXmlTagValue(text, "Code");
    const message = getXmlTagValue(text, "Message");
    const requestId = getXmlTagValue(text, "RequestId") ||
        getXmlTagValue(text, "RequestID");

    if (!code && !message && !requestId) return undefined;
    return { code, message, requestId };
}

async function parseResponseData(response) {
    const text = await response.text();
    if (!text) return null;

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * Queries database storage for provider connection credentials and API configuration settings.
 *
 * @async
 * @param {Object} data - Context object containing search criteria.
 * @param {string} [data.organization_id] - Target organization ID (resolves via hostname if absent).
 * @param {string} [data.host] - Target host domain.
 * @param {string} name - API provider identifier (e.g., 'stripe', 'openai', 'twilio').
 * @returns {Promise<Object>} Standardized API configuration object containing key, url, and headers.
 * @throws {Error} If organization mapping fails or integration settings do not exist.
 * @public
 * @environment server
 */
export async function getApiConfig(data, name) {
    let { organization_id: orgId, host } = data || {};

    if (!orgId) {
        const organization = await crud.getOrganization(data);
        if (organization?.error) throw new Error(organization.error);
        orgId = organization._id;
    }

    const query = {
        method: 'object.read',
        array: 'apis',
        organization_id: orgId,
        host,
        filter: {
            query: { name, enabled: true },
            limit: 1
        }
    };

    const response = await crud.send(query);
    const apiConfig = response?.object?.[0];

    if (!apiConfig) {
        throw new Error(`Integration settings are missing for provider: '${name}'`);
    }

    return apiConfig;
}

export default {
    init
};

/**
 * Default export contract for this module.
 *
 * @name api-default-export
 * @kind member
 * @default-export
 * @environment server
 * @example
 * ```json
 * "{ init }"
 * ```
 */
