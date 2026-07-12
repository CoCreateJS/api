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

const API = {
    init,
    executeProxy,
    request,
    generateJWT,
    verifySignature,
    formatRequestBody,
    makeHttpRequest,
    processOperators,
    processOperator,
    getApiConfig,
    normalizeConfig
};

/**
 * Initializes the API Gateway execution environment.
 * @param {Object} Server - CoCreateServer context instance.
 * @returns {Promise<Object>} Fully initialized API module context.
 */
export async function init(Server) {
    server = Server;
    wsManager = server.wsManager;
    crud = server.crud;

    wsManager.on("api", (data) => {
        executeProxy(data);
    });

    wsManager.on("endpoint", (data) => {
        executeProxy(data);
    });

    console.log("[@cocreate/api] Gateway successfully initialized with adaptive API normalizers.");
    return API;
}

export function normalizeConfig(apiConfig, name, env = 'production') {
    let key = null;
    let webhooks = null;
    let url = null;
    let headers = {};
    let authType = "none";
    let headerName = null;
    let endpoint = null;

    if (typeof apiConfig === 'string') {
        key = apiConfig;
    } else if (apiConfig && typeof apiConfig === 'object') {
        url = apiConfig.url;
        headers = apiConfig.headers || {};
        authType = apiConfig.authType || "none";
        headerName = apiConfig.headerName || null;
        endpoint = apiConfig.endpoint || {};

        let targetBlock = apiConfig;
        if (apiConfig[env]) {
            targetBlock = apiConfig[env];
        }

        if (typeof targetBlock === 'string') {
            key = targetBlock;
        } else if (targetBlock && typeof targetBlock === 'object') {
            if (targetBlock.key) {
                if (typeof targetBlock.key === 'string') {
                    key = targetBlock.key;
                } else if (typeof targetBlock.key === 'object') {
                    key = targetBlock.key.apiKey || targetBlock.key.key || JSON.stringify(targetBlock.key);
                }
            } else if (targetBlock.apiKey) {
                key = targetBlock.apiKey;
            }

            webhooks = targetBlock.webhooks || apiConfig.webhooks;
            if (targetBlock.url) url = targetBlock.url;
            if (targetBlock.headers) headers = { ...headers, ...targetBlock.headers };
            if (targetBlock.authType) authType = targetBlock.authType;
            if (targetBlock.headerName) headerName = targetBlock.headerName;
            if (targetBlock.endpoint) endpoint = { ...endpoint, ...targetBlock.endpoint };
        }
    }

    return { key, webhooks, url, headers, authType, headerName, endpoint };
}

export async function executeProxy(data) {
    try {
        if (!data.method || !data.endpoint) {
            throw new Error("Proxy request is missing 'method' or 'endpoint' directives.");
        }

        const name = data.method.split(/[./]/)[0];
        const httpMethod = data.endpoint.split(" ")[0].toUpperCase();

        const rawApiConfig = await getApiConfig(data, name);
        if (!rawApiConfig) {
            throw new Error(`Configuration not registered for provider: '${name}'.`);
        }

        const env = data.env || process.env.NODE_ENV || 'production';
        const apiConfig = normalizeConfig(rawApiConfig, name, env);
        if (!apiConfig.url) {
            throw new Error(`Configuration missing 'url' base for provider '${name}'.`);
        }

        const override = apiConfig.endpoint?.[data.endpoint] || {};
        let url = apiConfig.url.endsWith("/") ? apiConfig.url.slice(0, -1) : apiConfig.url;

        let endpointPath = override.path || data.endpoint.split(" ")[1];
        url += endpointPath.startsWith("/") ? endpointPath : `/${endpointPath}`;

        if (data[name] && data[name].$searchParams) {
            url += objectToSearchParams(data[name].$searchParams);
            delete data[name].$searchParams;
        }

        let headers = { ...(apiConfig.headers || {}), ...(override.headers || {}) };

        // Process operators inside outbound headers (Resolves $jwt, $concat, $base64, keys, etc.)
        headers = await processOperators(data, {}, headers);

        const authType = apiConfig.authType;
        if (apiConfig.key && authType && authType !== "none" && !headers["Authorization"]) {
            if (authType === "bearer") {
                headers["Authorization"] = `Bearer ${apiConfig.key}`;
            } else if (authType === "custom-header" && apiConfig.headerName) {
                headers[apiConfig.headerName] = apiConfig.key;
            }
        }

        let formatType = data.formatType || "json";
        const timeout = 15000;
        let options = { method: httpMethod, headers, timeout };

        if (!["GET", "HEAD"].includes(httpMethod) && data[name]) {
            // Process operators inside the outbound request body payload dynamically!
            data[name] = await processOperators(data, {}, data[name]);
            const { body, contentTypeHeader } = formatRequestBody(data[name], formatType);
            options.body = body;
            if (contentTypeHeader && !headers["Content-Type"]) {
                options.headers["Content-Type"] = contentTypeHeader;
            }
        }

        const response = await makeHttpRequest(url, options);
        data[name] = await response.json();

        if (wsManager) {
            wsManager.send(data);
        }
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

        const pathSegments = urlObject.pathname.split("/");
        const apiName = pathSegments[2];
        const webhookName = pathSegments[3];

        if (!organization.apis || !organization.apis[apiName]) {
            res.writeHead(404, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: `Provider configuration '${apiName}' not found.` }));
        }

        const rawApiConfig = organization.apis[apiName];
        const env = req.headers['x-env'] || process.env.NODE_ENV || 'production';
        const apiConfig = normalizeConfig(rawApiConfig, apiName, env);
        const webhookConfig = rawApiConfig.webhooks?.[webhookName];

        if (!webhookConfig) {
            res.writeHead(404, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: `Webhook endpoint configuration '${webhookName}' not found.` }));
        }

        let rawBody = "";
        await new Promise((resolve, reject) => {
            req.on("data", (chunk) => { rawBody += chunk.toString(); });
            req.on("end", resolve);
            req.on("error", reject);
        });

        const dataContext = {
            req,
            res,
            host: hostname,
            organization,
            organization_id: organization._id,
            rawBody
        };

        if (webhookConfig.authenticate) {
            const auth = webhookConfig.authenticate;
            if (auth.method === "webhooks.constructEvent" && Array.isArray(auth.parameters)) {
                const resolvedParams = await processOperators(dataContext, {}, [...auth.parameters]);
                const payload = resolvedParams[0];
                const signature = resolvedParams[1];
                const secret = resolvedParams[2];

                if (!verifySignature(payload, signature, secret, "sha256")) {
                    res.writeHead(401, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ error: "Unauthorized access: signature verification failed." }));
                }
            }
        }

        let parsedEvent = {};
        if (rawBody) {
            try {
                parsedEvent = JSON.parse(rawBody);
            } catch {
                parsedEvent = { rawBody };
            }
        }

        let eventNameKey = webhookConfig.eventNameKey || rawApiConfig.eventNameKey;
        let eventName = getValueFromObject(parsedEvent, eventNameKey);

        if (eventName && webhookConfig.events?.[eventName]) {
            let executeOperations = webhookConfig.events[eventName];
            await processOperators(dataContext, parsedEvent, executeOperations);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Webhook processed successfully" }));
    } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid webhook request format", message: error.message }));
    }
}

export async function processOperators(data, event, execute) {
    if (Array.isArray(execute)) {
        // Evaluate items within an array
        let evaluatedArray = [];
        for (let index = 0; index < execute.length; index++) {
            evaluatedArray[index] = await processOperators(data, event, execute[index]);
        }
        return evaluatedArray;
    } else if (typeof execute === "object" && execute !== null) {
        const keys = Object.keys(execute);
        const operatorKey = keys.find(k => k.startsWith("$") && !["$storage", "$database", "$array", "$filter"].includes(k));
        
        // Collapse single-operator objects (e.g., { "$jwt": { ... } } or { "$concat": [ ... ] })
        // This preserves the exact return type (Object, Buffer, String) natively!
        if (operatorKey && keys.length === 1) {
            return await processOperator(data, event, operatorKey, execute[operatorKey]);
        }

        // Create a fresh object to safely assign dynamically evaluated keys
        let evaluatedObject = {};
        
        for (let key of keys) {
            let finalKey = key;

            // 1. Dynamic Key Resolution
            // If the key is an operator, evaluate it to figure out what the key name should be.
            if (key.startsWith("$") && !["$storage", "$database", "$array", "$filter"].includes(key)) {
                let resolvedKey = await processOperator(data, event, key, execute[key]);
                // Keys must evaluate to Strings or Numbers.
                if (typeof resolvedKey === "string" || typeof resolvedKey === "number") {
                    finalKey = String(resolvedKey);
                }
            }

            // 2. Dynamic Value Resolution
            let finalValue = execute[key];
            if (typeof finalValue === "string" && finalValue.startsWith("$") && !["$storage", "$database", "$array", "$filter"].includes(finalValue)) {
                finalValue = await processOperator(data, event, finalValue);
            } else if (Array.isArray(finalValue) || (typeof finalValue === "object" && finalValue !== null)) {
                finalValue = await processOperators(data, event, finalValue);
            }

            // Assign the evaluated value to the evaluated key
            evaluatedObject[finalKey] = finalValue;
        }
        
        return evaluatedObject;
    } else if (typeof execute === "string" && execute.startsWith("$") && !["$storage", "$database", "$array", "$filter"].includes(execute)) {
        return await processOperator(data, event, execute);
    }

    return execute;
}

export async function processOperator(data, event, operator, context) {
    let result;
    if (operator.startsWith("$data.")) {
        return getValueFromObject(data, operator.substring(6));
    } else if (operator.startsWith("$req")) {
        return getValueFromObject(data, operator.substring(1));
    } else if (operator.startsWith("$header")) {
        return getValueFromObject(data.req, operator.substring(1));
    } else if (operator.startsWith("$rawBody")) {
        return getValueFromObject(data, operator.substring(1));
    } else if (operator.startsWith("$crud")) {
        let results = context;
        let isObject = false;
        if (!Array.isArray(results)) {
            isObject = true;
            results = [results];
        }

        for (let i = 0; i < results.length; i++) {
            results[i] = await processOperators(data, event, results[i]);
            results[i] = await crud.send(results[i]);
            if (operator.startsWith("$crud.")) {
                results[i] = getValueFromObject(results[i], operator.substring(6));
            }
            results[i] = await processOperators(data, event, results[i]);
        }

        if (isObject) results = results[0];
        return results;
    } else if (operator.startsWith("$socket")) {
        context = await processOperators(data, event, context);
        result = await wsManager.send(context);
        if (operator.startsWith("$socket.")) {
            result = getValueFromObject(result, operator.substring(8));
        }
        return await processOperators(data, event, result);
    } else if (operator.startsWith("$event")) {
        if (operator.startsWith("$event.")) {
            result = getValueFromObject(event, operator.substring(7));
        }
        return await processOperators(data, event, result);
    } else if (operator === "$jwt") {
        // Resolves declarative JWT parameters into an active cryptographic string signature
        const config = await processOperators(data, event, context);
        const privateKey = config.privateKey;
        if (!privateKey) throw new Error("Missing cryptographic signing key inside $jwt context parameters");
        return generateJWT(config, privateKey);
    } else if (operator === "$concat") {
        // Concatenates an array of strings/operators, e.g., ["Bearer ", { "$jwt": { ... } }]
        const elements = await processOperators(data, event, context);
        if (Array.isArray(elements)) {
            return elements.join("");
        }
        return String(elements);
    } else if (operator === "$base64") {
        // Base64 encodes a dynamic string context (ideal for Basic Authentication)
        const value = await processOperators(data, event, context);
        return Buffer.from(String(value)).toString("base64");
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
        
        // Use timingSafeEqual to prevent timing attacks
        return crypto.timingSafeEqual(
            Buffer.from(expectedSignature),
            Buffer.from(signature)
        );
    } catch (err) {
        console.error('[@cocreate/api] Failed signature verification:', err);
        return false;
    }
}

export function formatRequestBody(payload, formatType = "json") {
    let body = null;
    let contentTypeHeader = null;

    try {
        switch (formatType.toLowerCase()) {
            case "json":
                body = JSON.stringify(payload);
                contentTypeHeader = "application/json; charset=utf-8";
                break;
            case "form-urlencoded":
                body = new URLSearchParams(payload).toString();
                contentTypeHeader = "application/x-www-form-urlencoded; charset=utf-8";
                break;
            case "text":
                body = typeof payload === "string" ? payload : JSON.stringify(payload);
                contentTypeHeader = "text/plain; charset=utf-8";
                break;
            default:
                body = JSON.stringify(payload);
                contentTypeHeader = "application/json; charset=utf-8";
        }
    } catch (error) {
        console.error(`[@cocreate/api] Error formatting body structure as ${formatType}:`, error);
    }

    return { body, contentTypeHeader };
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
    const organization = await crud.getOrganization(data);
    if (organization.error) throw new Error(organization.error);
    if (!organization.apis) throw new Error("Missing secure api configuration block in organization profile.");
    if (!organization.apis[name]) throw new Error(`Integration settings are missing for provider: '${name}'`);
    return organization.apis[name];
}

export default API;