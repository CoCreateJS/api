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

import { URL } from 'node:url';
import { getValueFromObject, objectToSearchParams, astAsync, security } from '@cocreate/utils';

// Core module references bound dynamically upon initialization
let server = null;
let wsManager = null;
let crud = null;

const API = {
    init,
    executeApi,
    request,
    security,
    makeHttpRequest,
    getApiConfig,
    normalizeConfig
};

/**
 * Binds server core services and registers WebSocket event handlers.
 * @param {Object} Server - Server core instance containing wsManager and crud
 * @returns {Object} Exported API service interface
 */
export async function init(Server) {
    server = Server;
    wsManager = server.wsManager;
    crud = server.crud;

    wsManager.on("api", (data) => {
        executeApi(data);
    });

    wsManager.on("endpoint", (data) => {
        executeApi(data);
    });

    return API;
}

/**
 * Normalizes raw API configuration structures into a uniform key/url/headers shape.
 * @param {string|Object} apiConfig - Raw configuration object or API key string
 * @param {string} name - Provider identifier
 * @returns {Object} Standardized configuration container
 */
export function normalizeConfig(apiConfig, name) {
    let key = null;
    let url = null;
    let headers = {};

    if (typeof apiConfig === 'string') {
        key = apiConfig;
    } else if (apiConfig && typeof apiConfig === 'object') {
        url = apiConfig.url;
        headers = apiConfig.headers || {};

        if (apiConfig.key) {
            if (typeof apiConfig.key === 'string') {
                key = apiConfig.key;
            } else if (typeof apiConfig.key === 'object') {
                key = apiConfig.key.apiKey || apiConfig.key.key || JSON.stringify(apiConfig.key);
            }
        } else if (apiConfig.apiKey) {
            key = apiConfig.apiKey;
        }

        if (apiConfig.url) url = apiConfig.url;
        if (apiConfig.headers) headers = { ...headers, ...apiConfig.headers };
    }

    return { key, url, headers };
}

/**
 * Constructs an isolated execution sandbox enforcing multi-tenant isolation via Proxy firewalls.
 * @param {Object} context - Execution context containing organization, host, data, and request info
 * @returns {Object} Secure sandbox context for AST execution
 */
function createSandbox(context) {
    // SECURITY FIREWALL: Proxy database calls to enforce multi-tenant isolation.
    const secureCrud = context.crud ? new Proxy(context.crud, {
        get(target, prop) {
            const original = target[prop];
            if (typeof original === 'function') {
                return function(...args) {
                    if (args.length === 0) {
                        args.push({
                            organization_id: context.organization_id,
                            host: context.host
                        });
                    } else if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
                        args[0].organization_id = context.organization_id;
                        args[0].host = context.host;
                    }
                    return original.apply(target, args);
                };
            }
            return original;
        }
    }) : undefined;

    // SECURITY FIREWALL: Proxy WebSocket manager calls for multi-tenant isolation.
    const secureWsManager = context.wsManager ? new Proxy(context.wsManager, {
        get(target, prop) {
            const original = target[prop];
            if (typeof original === 'function') {
                return function(...args) {
                    if (args.length === 0) {
                        args.push({
                            organization_id: context.organization_id,
                            host: context.host
                        });
                    } else if (args.length > 0 && typeof args[0] === 'object' && args[0] !== null) {
                        args[0].organization_id = context.organization_id;
                        args[0].host = context.host;
                    }
                    return original.apply(target, args);
                };
            }
            return original;
        }
    }) : undefined;

    // Only expose full server instance to platform admin organization
    const isPlatformOrg = server && server.organization_id && (context.organization_id === server.organization_id);

    const sandbox = {
        // Core Isolated Dynamic AST Scopes
        data: context.data,
        event: context.event,
        actions: context.actions,
        request: context.request,
        rawBody: context.rawBody,

        // Safe Proxied System Objects
        crud: secureCrud,
        socket: secureWsManager,
        wsManager: secureWsManager,

        // Security Utility Instance
        security,

        // Host Context Identifiers
        key: context.key,
        config: context.config,
        organization_id: context.organization_id,
        host: context.host,

        // Custom operators rewritten as sandbox properties
        api: {
            send: async (apiData) => {
                return await executeApi(apiData, context);
            }
        }
    };

    // Safely inject elevated server core only when authenticated context is root platform
    if (isPlatformOrg) {
        sandbox.server = server;
    }

    return sandbox;
}

/**
 * Resolves endpoint definitions, executes AST macros, or dispatches HTTP requests.
 * @param {Object} data - API execution payload containing directives
 * @param {Object} [parentContext=null] - Optional outer sandbox execution context
 * @returns {Promise<any>} Execution response payload
 */
export async function executeApi(data, parentContext = null) {
    try {
        const orgId = parentContext?.organization_id || data.socket?.organization_id || data.organization_id;
        const host = parentContext?.host || data.socket?.host || data.host;

        // PATH A: Native Execution of a Pre-prepared HTTP Request Object
        if (data.url && data.method) {
            const timeout = data.timeout || 15000;
            const options = {
                method: data.method.toUpperCase(),
                headers: data.headers || {},
                timeout
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

        const endpointQuery = {
            method: 'object.read',
            array: 'endpoints',
            organization_id: orgId,
            host: host,
            $filter: {
                query: { endpoint: data.endpoint, organization_id: orgId },
                limit: 1
            }
        };
        const endpointResponse = await crud.send(endpointQuery);
        const endpointConfig = endpointResponse?.object?.[0] || {};

        const rawApiConfig = await getApiConfig({ organization_id: orgId, host }, providerName);
        if (!rawApiConfig) {
            throw new Error(`Connection setting not registered for provider: '${providerName}'.`);
        }
        const apiConfig = normalizeConfig(rawApiConfig, providerName);

        const apiContext = parentContext || {
            data: data,
            event: {},
            actions: [],
            organization_id: orgId,
            host: host,
            crud,
            wsManager,
            key: apiConfig.key,
            config: apiConfig
        };

        const actions = endpointConfig.actions || endpointConfig.action;
        if (actions) {
            if (Array.isArray(actions)) {
                for (let i = 0; i < actions.length; i++) {
                    const result = await astAsync({ executeAST: actions[i], sandbox: createSandbox(apiContext) });
                    apiContext.actions.push(result);
                }
                const finalMacroResult = apiContext.actions[apiContext.actions.length - 1];
                if (finalMacroResult !== undefined) {
                    data[providerName] = finalMacroResult;
                }
            } else {
                const result = await astAsync({ executeAST: actions, sandbox: createSandbox(apiContext) });
                apiContext.actions.push(result);
                if (result !== undefined) {
                    data[providerName] = result;
                }
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

        if (data[providerName] && data[providerName].$searchParams) {
            url += objectToSearchParams(data[providerName].$searchParams);
            delete data[providerName].$searchParams;
        }

        let headers = { ...(apiConfig.headers || {}), ...(endpointConfig.headers || {}) };
        headers = await astAsync({ executeAST: headers, sandbox: createSandbox(apiContext) });

        const timeout = 15000;
        let options = { method: httpMethod, headers, timeout };

        if (!["GET", "HEAD"].includes(httpMethod) && data[providerName]) {
            const bodyPayload = await astAsync({ executeAST: data[providerName], sandbox: createSandbox(apiContext) });
            
            if (typeof bodyPayload === 'object' && bodyPayload !== null) {
                options.body = JSON.stringify(bodyPayload);
                if (!headers["Content-Type"]) {
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
        data.error = error.message;
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
 * Processes incoming HTTP webhook requests, validates security signatures, and executes pipelines.
 * @param {Object} req - HTTP request object
 * @param {Object} res - HTTP response object
 */
export async function request(req, res) {
    try {
        const urlObject = new URL(`http://${req.headers.host}${req.url}`);
        const hostname = urlObject.hostname;

        let organization;
        try {
            organization = await crud.getOrganization({ host: hostname });
        } catch (error) {
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
                query: { 
                    path: webhookPath, 
                    organization_id: organization._id 
                },
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

        const queryParams = Object.fromEntries(urlObject.searchParams.entries());

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
            rawBody: rawBody,
            host: hostname,
            organization: organization,
            organization_id: organization._id,
            crud: crud,
            wsManager: wsManager
        };

        context.request.query = queryParams;

        if (webhookConfig.authenticate) {
            const auth = webhookConfig.authenticate;
            if (auth.method === "webhooks.constructEvent" && Array.isArray(auth.parameters)) {
                const resolvedParams = await astAsync({ executeAST: [...auth.parameters], sandbox: createSandbox(context) });
                const payload = resolvedParams[0];
                const signature = resolvedParams[1];
                const secret = resolvedParams[2];

                const computedSignature = security.createWebhookSignature(payload, secret, { format: 'github' });
                const expectedSignature = String(signature);

                if (!security.timingSafeEqual(computedSignature, expectedSignature)) {
                    res.writeHead(401, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ error: "Unauthorized access: signature verification failed." }));
                }
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
            if (Array.isArray(executeOperations)) {
                for (let i = 0; i < executeOperations.length; i++) {
                    const stepResult = await astAsync({ executeAST: executeOperations[i], sandbox: createSandbox(context) });
                    context.actions.push(stepResult);
                }
            } else if (typeof executeOperations === 'object' && executeOperations !== null) {
                const stepResult = await astAsync({ executeAST: [executeOperations], sandbox: createSandbox(context) });
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

// Re-export security library instance
export { security };

/**
 * Low-level HTTP dispatch utility wrapping global fetch with AbortController timeout handling.
 * @param {string} url - Target URL endpoint
 * @param {Object} options - Fetch options (method, headers, body, signal, timeout)
 * @returns {Promise<Response>} Native fetch response instance
 */
export async function makeHttpRequest(url, options) {
    let controller, timeoutId;
    if (global.AbortController) {
        controller = new global.AbortController();
        timeoutId = setTimeout(() => controller.abort(), options.timeout || 15000);
        options.signal = controller.signal;
    }

    const fetchFn = global.fetch;
    if (typeof fetchFn !== "function") {
        throw new Error("System runtime environment is missing a valid HTTP fetch implementation.");
    }

    try {
        const response = await fetchFn(url, options);
        if (timeoutId) clearTimeout(timeoutId);

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
        if (timeoutId) clearTimeout(timeoutId);
        throw error;
    }
}

/**
 * Queries database storage for provider connection credentials and API configuration.
 * @param {Object} data - Context query parameters (organization_id, host)
 * @param {string} name - API provider name
 * @returns {Promise<Object>} API provider configuration object
 */
export async function getApiConfig(data, name) {
    let orgId = data.organization_id;
    let host = data.host;
    
    if (!orgId) {
        const organization = await crud.getOrganization(data);
        if (organization.error) throw new Error(organization.error);
        orgId = organization._id;
    }

    const query = {
        method: 'object.read',
        array: 'apis',
        organization_id: orgId,
        host: host,
        $filter: {
            query: { name: name, organization_id: orgId },
            limit: 1
        }
    };
    
    const response = await crud.send(query);
    const apiConfig = response?.object?.[0];

    if (!apiConfig) throw new Error(`Integration settings are missing for provider: '${name}'`);
    return apiConfig;
}

export default API;