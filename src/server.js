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
import { objectToSearchParams, astAsync, security } from '@cocreate/utils';

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
    wsManager.on("endpoint", send);

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
 * @param {Object} [context.data] - Execution payload data object.
 * @param {Object} [context.event] - Webhook or inbound trigger event data.
 * @param {Array<any>} [context.actions] - Collected AST macro execution results.
 * @param {Object} [context.request] - Incoming HTTP request object.
 * @param {Object} [context.response] - Outgoing HTTP response object.
 * @param {string} [context.rawBody] - Unparsed HTTP request string payload.
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
        data: context.data,
        event: context.event,
        actions: context.actions,
        request: context.request,
        response: context.response,
        header: context.request?.headers || context.header || {},
        rawBody: context.rawBody,

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
 * @param {string} [data.method] - Provider or HTTP method directive (e.g., 'stripe' or 'GET').
 * @param {string} [data.endpoint] - API endpoint action directive (e.g., 'POST /customers').
 * @param {Object} [data.headers] - Custom HTTP header directives.
 * @param {number} [data.timeout=15000] - Request timeout in milliseconds.
 * @param {Object|string} [data.body] - Inbound request body payload.
 * @param {Object} [data.socket] - WebSocket client reference for real-time response emit.
 * @param {string} [data.organization_id] - Multi-tenant organization identifier.
 * @param {string} [data.host] - Target host domain.
 * @param {Object|null} [parentContext=null] - Outer sandbox execution context when nested.
 * @returns {Promise<any>} Response payload from executed AST macros or HTTP request.
 * @throws {Error} If required directives are missing, provider configuration is invalid, or HTTP dispatch fails.
 */
export async function send(data, parentContext = null) {
    try {
        const orgId = parentContext?.organization_id || data.socket?.organization_id || data.organization_id;
        const host = parentContext?.host || data.socket?.host || data.host;

        // PATH A: Native Execution of a Pre-prepared HTTP Request Object
        if (data.url && data.method) {
            const options = {
                method: data.method.toUpperCase(),
                headers: data.headers || {},
                timeout: data.timeout || 15000
            };

            if (data.body) {
                options.body = typeof data.body === 'object' ? JSON.stringify(data.body) : data.body;
            }

            const response = await makeHttpRequest(data.url, options);
            const responsePayload = await response.json();

            if (data.socket && wsManager) {
                data.response = responsePayload;
                wsManager.send(data);
            }
            return responsePayload;
        }

        // PATH B: Standard Dynamic Configuration Resolve & Execute
        if (!data.method || !data.endpoint) {
            throw new Error("API execution request is missing 'method' or 'endpoint' directives.");
        }

        const providerName = data.method.split(/[./]/)[0];
        const httpMethod = data.endpoint.split(" ")[0].toUpperCase();

        const apiConfig = await getApiConfig({ organization_id: orgId, host }, providerName);

        const endpointQuery = {
            method: 'object.read',
            array: 'endpoints',
            organization_id: orgId,
            host,
            $filter: {
                query: { api_id: apiConfig._id, endpoint: data.endpoint, enabled: true },
                limit: 1
            }
        };

        const endpointResponse = await crud.send(endpointQuery);
        const endpointConfig = endpointResponse?.object?.[0] || {};

        const apiContext = parentContext || {
            data,
            event: {},
            actions: [],
            organization_id: orgId,
            host,
            crud,
            wsManager,
            key: apiConfig.key,
            config: apiConfig
        };

        const rawActions = endpointConfig.actions || endpointConfig.action;
        if (rawActions) {
            const actionList = Array.isArray(rawActions) ? rawActions : [rawActions];
            for (const actionItem of actionList) {
                const result = await astAsync({ executeAST: actionItem, sandbox: createSandbox(apiContext) });
                apiContext.actions.push(result);
            }

            const finalMacroResult = apiContext.actions[apiContext.actions.length - 1];
            if (finalMacroResult !== undefined) {
                data[providerName] = finalMacroResult;
            }

            if (data.socket && wsManager) {
                wsManager.send(data);
            }
            return;
        }

        if (!apiConfig.url) {
            throw new Error(`Configuration missing 'url' base for provider '${providerName}'.`);
        }

        let url = apiConfig.url.endsWith("/") ? apiConfig.url.slice(0, -1) : apiConfig.url;
        let endpointPath = endpointConfig.path || data.endpoint.split(" ")[1];
        url += endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;

        if (data[providerName]?.$searchParams) {
            url += objectToSearchParams(data[providerName].$searchParams);
            delete data[providerName].$searchParams;
        }

        let headers = { ...(apiConfig.headers || {}), ...(endpointConfig.headers || {}) };
        headers = await astAsync({ executeAST: headers, sandbox: createSandbox(apiContext) });

        const options = { method: httpMethod, headers, timeout: 15000 };

        if (!["GET", "HEAD"].includes(httpMethod) && data[providerName]) {
            const bodyPayload = await astAsync({ executeAST: data[providerName], sandbox: createSandbox(apiContext) });

            if (typeof bodyPayload === 'object' && bodyPayload !== null) {
                options.body = JSON.stringify(bodyPayload);
                if (!options.headers["Content-Type"]) {
                    options.headers["Content-Type"] = "application/json; charset=utf-8";
                }
            } else {
                options.body = String(bodyPayload);
            }
        }

        const response = await makeHttpRequest(url, options);
        const responsePayload = await response.json();
        data[providerName] = responsePayload;

        if (data.socket && wsManager) {
            wsManager.send(data);
        }
        return responsePayload;
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
            $filter: {
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

        let rawBody = "";
        await new Promise((resolve, reject) => {
            req.on("data", (chunk) => { rawBody += chunk.toString(); });
            req.on("end", resolve);
            req.on("error", reject);
        });

        let parsedEvent = {};
        if (rawBody) {
            try {
                parsedEvent = JSON.parse(rawBody);
            } catch {
                parsedEvent = { rawBody };
            }
        }

        const context = {
            data: {},
            event: parsedEvent,
            actions: [],
            request: req,
            response: res,
            rawBody,
            host: hostname,
            organization,
            organization_id: organization._id,
            crud,
            wsManager
        };

        context.request.query = Object.fromEntries(urlObject.searchParams.entries());

        if (webhookConfig.authenticate?.method === "webhooks.constructEvent" && Array.isArray(webhookConfig.authenticate.parameters)) {
            const resolvedParams = await astAsync({ executeAST: [...webhookConfig.authenticate.parameters], sandbox: createSandbox(context) });
            const [payload, signature, secret] = resolvedParams;

            const computedSignature = security.createWebhookSignature(payload, secret, { format: 'github' });

            if (!security.timingSafeEqual(computedSignature, String(signature))) {
                res.writeHead(401, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: "Unauthorized access: signature verification failed." }));
            }
        }

        let executeOperations = null;
        const actionConfig = webhookConfig.action;

        if (actionConfig) {
            if (typeof actionConfig === 'string') {
                const actionName = await astAsync({ executeAST: actionConfig, sandbox: createSandbox(context) });
                if (actionName && webhookConfig.actions?.[actionName]) {
                    executeOperations = webhookConfig.actions[actionName];
                }
            } else {
                executeOperations = actionConfig;
            }
        }

        if (executeOperations) {
            const opsList = Array.isArray(executeOperations) ? executeOperations : [executeOperations];
            for (const op of opsList) {
                const stepResult = await astAsync({ executeAST: Array.isArray(op) ? op : [op], sandbox: createSandbox(context) });
                context.actions.push(stepResult);
            }
        }

        if (res && !res.writableEnded) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                message: "Webhook processed successfully",
                payload: context.actions[context.actions.length - 1] || {}
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
        $filter: {
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