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
let wsManager = null;
let crud = null;

const API = {
    send,
    webhook,
    getApiConfig
};

/**
 * Binds server core services and registers WebSocket event handlers for API dispatch.
 *
 * @async
 * @param {Object} Server - Core server instance containing wsManager and crud instances.
 * @param {Object} Server.wsManager - WebSocket event emitter manager.
 * @param {Object} Server.crud - Database CRUD service operator.
 * @returns {Promise<Object>} Exported operational API interface object (`{ send, getApiConfig }`).
 */
export async function init(Server) {
    server = Server;
    wsManager = server.wsManager;
    crud = server.crud;

    wsManager.on("api", send);

    return API;
}

/**
 * Creates a Proxy firewall wrapper to automatically inject multi-tenant scope parameters (`organization_id` and `host`) into target method invocations.
 *
 * @param {Object} target - Target service instance to proxy (e.g., crud or wsManager).
 * @param {string} orgId - Multi-tenant organization identifier.
 * @param {string} host - Host domain identifier.
 * @returns {Proxy|undefined} Proxied target service with auto-injected tenant parameters, or undefined if target is falsy.
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
 */
function createSandbox(context) {
    const isPlatformOrg = server?.organization_id && (context.organization_id === server.organization_id);
    const secureCrud = createTenantProxy(context.crud, context.organization_id, context.host);
    const secureWs = createTenantProxy(context.wsManager, context.organization_id, context.host);

    const sandbox = {
        payload: context.payload,
        event: context.event,
        request: context.request,
        response: context.response,
        header: context.request?.headers || context.header || {},
        searchParams: context.searchParams,
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
            send: (apiData) => send(apiData, context)
        }
    };

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
 * @param {Object} [data.socket] - WebSocket client reference for real-time response emit.
 * @param {string} [data.organization_id] - Multi-tenant organization identifier.
 * @param {string} [data.host] - Target host domain.
 * @param {Object|null} [parentContext=null] - Outer sandbox execution context when nested.
 * @returns {Promise<Object>} The mutated execution envelope, with response content assigned to `data.data`.
 * @throws {Error} If required directives are missing, provider configuration is invalid, or HTTP dispatch fails.
 */
export async function send(data, parentContext = null) {
    try {
        const orgId = parentContext?.organization_id || data.socket?.organization_id || data.organization_id;
        const host = parentContext?.host || data.socket?.host || data.host;

        const apiName = data.api?.trim() || "";
        const endpoint = data.endpoint?.trim() || "";
        const payloadUrl = data.url?.trim() || "";
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
        let request = {
            ...data,
            ...endpointConfig,
            method: endpointConfig.method?.trim() || apiConfig.method?.trim() || data.method?.trim(),
            endpoint: endpointConfig.endpoint || apiConfig.endpoint || endpoint,
            url: endpointConfig.url?.trim() || apiConfig.url?.trim() || payloadUrl,
            headers: {
                ...(data.headers || {}),
                ...(apiConfig.headers || {}),
                ...(endpointConfig.headers || {})
            },
            timeout: endpointConfig.timeout ?? apiConfig.timeout ?? data.timeout ?? 15000,
            searchParams: endpointConfig.searchParams ?? apiConfig.searchParams ?? data.searchParams,
            data: endpointConfig.data ?? apiConfig.data ?? data.data
        };

        request = await astAsync({
            executeAST: request,
            sandbox: createSandbox(apiContext)
        });

        if (request.resolved) {
            data.data = request.data
            if (data.socket && wsManager) {
                wsManager.send(data);
            }
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
                options.body = JSON.stringify(request.data);
                if (!options.headers["Content-Type"]) {
                    options.headers["Content-Type"] = "application/json; charset=utf-8";
                }
            } else {
                options.body = String(request.data);
            }
        }

        const response = await makeHttpRequest(url, options);
        data.data = await response.json();

        if (data.socket && wsManager) {
            wsManager.send(data);
        }
        return data;
    } catch (error) {
        if (!Array.isArray(data.error)) {
            data.error = data.error ? [data.error] : [];
        }
        data.error.push(error.message);

        if (error.response) {
            data.status = error.response.status;
            data.statusText = error.response.statusText;
            data.responseData = error.response.data;
        }
        if (data.socket && wsManager) {
            wsManager.send(data);
        }
        throw error;
    }
}

/**
 * Processes incoming HTTP webhook requests, verifies HMAC/JWT security signatures, and executes pipelines.
 *
 * @async
 * @param {Object} req - Native Node.js HTTP incoming request stream.
 * @param {Object} res - Native Node.js HTTP server response stream.
 * @returns {Promise<void>}
 */
export async function webhook(req, res) {
    try {
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
            const error = new Error(`HTTP error! Status: ${response.status} ${response.statusText}`);
            error.response = {
                status: response.status,
                statusText: response.statusText,
                data: text
            };
            throw error;
        }
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
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
