/********************************************************************************
 * Copyright (C) 2023 CoCreate and Contributors.
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
 *
 ********************************************************************************/

// Commercial Licensing Information:
// For commercial use of this software without the copyleft provisions of the AGPLv3,
// you must obtain a commercial license from CoCreate LLC.
// For details, visit <https://cocreate.app/licenses/> or contact us at sales@cocreate.app.

import crypto from 'node:crypto';
import { URL, URLSearchParams } from 'node:url';
import Config from '@cocreate/config';
import { getValueFromObject, objectToSearchParams } from '@cocreate/utils';

// Core module references bound dynamically upon initialization
let server = null;
let wsManager = null;
let crud = null;

const NativeSandbox = {
    Math,
    Number,
    String,
    Boolean,
    Date,
    JSON,
    Array,
    Object,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    btoa: (str) => Buffer.from(String(str)).toString("base64"),
    atob: (b64) => Buffer.from(String(b64), "base64").toString("utf-8"),
    concat: (...args) => args.flat().map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(''),
    formUrlencode: (obj) => {
        if (!obj || typeof obj !== 'object') return String(obj || '');
        const params = new URLSearchParams();
        for (const [key, val] of Object.entries(obj)) {
            params.append(key, typeof val === 'object' ? JSON.stringify(val) : String(val));
        }
        return params.toString();
    }
};

const API = {
    init,
    executeApi,
    request,
    generateJWT,
    verifySignature,
    makeHttpRequest,
    processOperators,
    processOperator,
    getApiConfig,
    normalizeConfig
};

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

export async function executeApi(data, parentContext = null) {
    try {
        // SECURITY FIREWALL: Parent contexts and authenticated socket boundaries take absolute priority 
        // over raw payload elements to prevent config-driven cross-tenant data leaks or privilege escalations.
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
            host: host, // Carry host forward
            $filter: {
                query: { endpoint: data.endpoint, organization_id: orgId },
                limit: 1
            }
        };
        const endpointResponse = await crud.send(endpointQuery);
        const endpointConfig = endpointResponse?.object?.[0] || {};

        // Fetch provider credentials with full environmental scope intact
        const rawApiConfig = await getApiConfig({ organization_id: orgId, host }, providerName);
        if (!rawApiConfig) {
            throw new Error(`Connection setting not registered for provider: '${providerName}'.`);
        }
        const apiConfig = normalizeConfig(rawApiConfig, providerName);

        // Share parent context if executing within a nested macro frame
        const apiContext = parentContext || {
            data: data,
            event: {},
            actions: [],
            organization_id: orgId,
            host: host, // Lock host context into AST evaluation loop
            crud,
            wsManager,
            key: apiConfig.key,
            config: apiConfig
        };

        const actions = endpointConfig.actions || endpointConfig.action;
        if (actions) {
            if (Array.isArray(actions)) {
                for (let i = 0; i < actions.length; i++) {
                    const result = await processOperators(apiContext, actions[i]);
                    apiContext.actions.push(result); // Saved flattened memory profile
                }
                const finalMacroResult = apiContext.actions[apiContext.actions.length - 1];
                if (finalMacroResult !== undefined) {
                    data[providerName] = finalMacroResult;
                }
            } else {
                const result = await processOperators(apiContext, actions);
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

        // --- Standard Outbound Construction Path ---
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
        headers = await processOperators(apiContext, headers);

        const timeout = 15000;
        let options = { method: httpMethod, headers, timeout };

        if (!["GET", "HEAD"].includes(httpMethod) && data[providerName]) {
            const bodyPayload = await processOperators(apiContext, data[providerName]);
            
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
            host: hostname, // Maintain active host environment
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
            host: hostname, // Propagate verified edge hostname
            organization: organization,
            organization_id: organization._id,
            crud: crud,
            wsManager: wsManager
        };

        context.request.query = queryParams;

        if (webhookConfig.authenticate) {
            const auth = webhookConfig.authenticate;
            if (auth.method === "webhooks.constructEvent" && Array.isArray(auth.parameters)) {
                const resolvedParams = await processOperators(context, [...auth.parameters]);
                const payload = resolvedParams[0];
                const signature = resolvedParams[1];
                const secret = resolvedParams[2];

                if (!verifySignature(payload, signature, secret, "sha256")) {
                    res.writeHead(401, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ error: "Unauthorized access: signature verification failed." }));
                }
            }
        }

        let executeOperations = null;
        const actionConfig = webhookConfig.action;

        if (actionConfig) {
            if (typeof actionConfig === 'string') {
                const actionName = await processOperators(context, actionConfig);
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
                    const stepResult = await processOperators(context, executeOperations[i]);
                    context.actions.push(stepResult);
                }
            } else if (typeof executeOperations === 'object' && executeOperations !== null) {
                const stepResult = await processOperators(context, [executeOperations]);
                context.actions.push(stepResult);
            }
        }

        // Native Stream Inspection: Fall back to default 200 OK only if actions did not write or end the stream
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

export async function processOperators(context, execute) {
    if (Array.isArray(execute)) {
        let evaluatedArray = [];
        for (let index = 0; index < execute.length; index++) {
            evaluatedArray[index] = await processOperators(context, execute[index]);
        }
        return evaluatedArray;
    } else if (typeof execute === "object" && execute !== null) {
        const keys = Object.keys(execute);
        const operatorKey = keys.find(k => k.startsWith("$") && !["$storage", "$database", "$array", "$filter"].includes(k));
        
        if (operatorKey && keys.length === 1) {
            return await processOperator(context, operatorKey, execute[operatorKey]);
        }

        let evaluatedObject = {};
        for (let key of keys) {
            let finalKey = key;

            if (key.startsWith("$") && !["$storage", "$database", "$array", "$filter"].includes(key)) {
                let resolvedKey = await processOperator(context, key);
                if (typeof resolvedKey === "string" || typeof resolvedKey === "number") {
                    finalKey = String(resolvedKey);
                }
            }

            let finalValue = execute[key];
            if (typeof finalValue === "string" && finalValue.startsWith("$") && !["$storage", "$database", "$array", "$filter"].includes(finalValue)) {
                finalValue = await processOperator(context, finalValue);
            } else if (Array.isArray(finalValue) || (typeof finalValue === "object" && finalValue !== null)) {
                finalValue = await processOperators(context, finalValue);
            }

            evaluatedObject[finalKey] = finalValue;
        }
        
        return evaluatedObject;
    } else if (typeof execute === "string" && execute.startsWith("$") && !["$storage", "$database", "$array", "$filter"].includes(execute)) {
        return await processOperator(context, execute);
    }

    return execute;
}

export async function processOperator(context, operator, args) {
    if (args === undefined) {
        if (operator.startsWith("$data.")) {
            return getValueFromObject(context.data, operator.substring(6));
        } else if (operator === "$data") {
            return context.data;
        } else if (operator.startsWith("$event.")) {
            const result = getValueFromObject(context.event, operator.substring(7));
            return await processOperators(context, result);
        } else if (operator === "$event") {
            return await processOperators(context, context.event);
        } else if (operator.startsWith("$actions.")) {
            return getValueFromObject(context.actions, operator.substring(9));
        } else if (operator === "$actions") {
            return context.actions;
        } else if (operator.startsWith("$request.")) {
            return getValueFromObject(context.request, operator.substring(9));
        } else if (operator === "$request") {
            return context.request;
        } else if (operator.startsWith("$header.")) {
            const headerKey = operator.substring(8).toLowerCase();
            return context.request?.headers?.[headerKey];
        } else if (operator === "$rawBody") {
            return context.rawBody;
        }
    }

    if (operator === "$jwt") {
        const evaluatedContext = args !== undefined ? await processOperators(context, args) : {};
        const privateKey = evaluatedContext.privateKey;
        if (!privateKey) throw new Error("Missing cryptographic signing key inside $jwt context parameters");
        return generateJWT(evaluatedContext, privateKey);
    }

    const cleanPath = operator.startsWith("$") ? operator.substring(1) : operator;
    const parts = cleanPath.split('.');
    
    const Sandbox = {
        ...NativeSandbox,
        crud: context.crud,
        socket: context.wsManager,
        wsManager: context.wsManager,
        request: context.request,
        response: context.response,
        key: context.key,
        config: context.config,
        organization_id: context.organization_id,
        host: context.host, // Seal active host into AST sandbox environment
        api: {
            send: async (apiData) => {
                return await executeApi(apiData, context);
            }
        }
    };

    let target = Sandbox[parts[0]];
    let parentContext = Sandbox;

    if (target !== undefined) {
        for (let i = 1; i < parts.length; i++) {
            parentContext = target;
            target = target[parts[i]];
            if (target === undefined) break;
        }

        if (typeof target === 'function') {
            let argsArray = [];
            if (args !== undefined) {
                // Check if the argument is explicitly formatted using our human-friendly parameter operators
                if (typeof args === 'object' && args !== null && (args.$args !== undefined || args.$arguments !== undefined)) {
                    const explicitArgs = args.$args !== undefined ? args.$args : args.$arguments;
                    
                    if (Array.isArray(explicitArgs)) {
                        // Multi-parameter routing: Evaluate each index independently
                        argsArray = [];
                        for (let i = 0; i < explicitArgs.length; i++) {
                            argsArray.push(await processOperators(context, explicitArgs[i]));
                        }
                    } else {
                        // Single-parameter fallback: Spelled out explicitly but contains a single expression
                        const evaluatedSingle = await processOperators(context, explicitArgs);
                        argsArray = [evaluatedSingle];
                    }
                } else {
                    // Standard / Implicit routing: Treat the entire value as a single, isolated argument (arrays behave like arrays!)
                    const evaluatedSingle = await processOperators(context, args);
                    argsArray = [evaluatedSingle];
                }
            }
            
            // SECURITY FIREWALL: Forcefully overwrite parameters for local system calls 
            // to align with the sealed context of the authenticated user.
            if (parentContext === context.crud || parentContext === context.wsManager) {
                if (argsArray.length === 0) {
                    argsArray.push({
                        organization_id: context.organization_id,
                        host: context.host
                    });
                } else if (argsArray.length > 0 && typeof argsArray[0] === 'object' && argsArray[0] !== null) {
                    argsArray[0].organization_id = context.organization_id;
                    argsArray[0].host = context.host; // Lock environment isolation parameters down
                }
            }

            return await target.apply(parentContext, argsArray);
        } else if (target !== undefined) {
            return target;
        }
    }

    return operator;
}

export function generateJWT(config, secret) {
    try {
        const header = config.header || { alg: 'HS256', typ: 'JWT' };
        const payload = config.payload || {};
        
        const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
        const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
        
        const signatureInput = `${encodedHeader}.${encodedPayload}`;
        
        const hmac = crypto.createHmac('sha256', secret);
        hmac.update(signatureInput);
        const signature = hmac.digest('base64url');
        
        return `${signatureInput}.${signature}`;
    } catch (err) {
        console.error('[@cocreate/api] Failed to generate JWT:', err);
        throw err;
    }
}

export function verifySignature(payload, signature, secret, algorithm = 'sha256') {
    try {
        const hmac = crypto.createHmac(algorithm, secret);
        hmac.update(payload);
        const expectedSignature = hmac.digest('hex');
        
        return crypto.timingSafeEqual(
            Buffer.from(expectedSignature),
            Buffer.from(signature)
        );
    } catch (err) {
        console.error('[@cocreate/api] Failed signature verification:', err);
        return false;
    }
}

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

export async function getApiConfig(data, name) {
    let orgId = data.organization_id;
    let host = data.host;
    
    if (!orgId) {
        const organization = await crud.getOrganization(data); // uses host inside data to lookup org
        if (organization.error) throw new Error(organization.error);
        orgId = organization._id;
    }

    const query = {
        method: 'object.read',
        array: 'apis',
        organization_id: orgId,
        host: host, // Keep environment host isolation contact
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