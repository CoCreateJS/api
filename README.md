# @cocreate/api

A dynamic, multi-tenant API execution gateway, proxy engine, and webhook orchestration routing layer. It securely manages distributed integration architectures, allowing applications to configure, evaluate, and execute complex third-party API configurations and multi-step macro workflows on the fly. By coupling an Abstract Syntax Tree (AST) evaluation sandbox (`NativeSandbox`) with strict tenant environmental isolation, it transforms declarative configurations into low-latency outbound integrations and secure inbound webhooks without introducing cross-tenant data leaks.

---

## Documentation

For complete API references, integration guides, webhook configuration, and usage examples, visit the **[CoCreate API Documentation](https://cocreatejs.com/docs/api)**.

## Table of Contents

- [Documentation](#documentation)
- [Features](#features)
- [Dynamic Operations Sandbox](#dynamic-operations-sandbox)
- [Installation](#installation)
- [Usage](#usage)
- [How it Works](#how-it-works)
- [Architecture and Payload Specs](#architecture-and-payload-specs)
- [Security Implementations](#security-implementations)
- [How to Contribute](#how-to-contribute)
- [License](#license)

---

## Features

* **Abstract Syntax Tree (AST) Micro-Operators:** Evaluates functional configuration contexts inline, supporting expressive syntax tags (like `$data`, `$event`, `$actions`, and `$request`) along with custom business logic operators.
* **Tenant Environmental Isolation Firewall:** Guarantees cryptographic data partitioning by intercepting execution matrices and forcefully injecting bound `organization_id` and verified `host` values into core operations.
* **Real-Time WebSocket Integration Matrix:** Seamlessly hooks into live server networks (`wsManager`), listening for incoming `api` and `endpoint` actions and streaming real-time operational state payloads directly back to the client.
* **Dual Outbound Execution Vectors:** Wire-speeds native, pre-constructed HTTP payloads instantly, or dynamically builds custom multi-step outbound integrations by resolving runtime metadata against persistence layers.
* **Cryptographic Signatures & JWT Orchestration:** Features native, low-latency hooks to generate JSON Web Tokens (`$jwt`) using HMAC-SHA256, alongside timing-attack-safe webhook signature verification (`verifySignature`).
* **Sealed AST Runtime Sandbox:** Features a hardened utility matrix containing sandboxed global objects (`JSON`, `Array`, `Math`) and helper methods (like Base64 encoding/decoding and URL encoders), safely wrapping calculations outside the global scope.
* **Native Edge Stream Inspection:** Inspects active server response buffers automatically, failing back to a clean 200 OK only if macro pipelines didn't forcefully complete or close the stream.

---

## Dynamic Operations Sandbox

The engine evaluates standard properties and custom functional variables using a predefined sandbox layer. This allows configuration profiles to extract fields safely on the fly.

| Core Operator Scope | Extracted Source Value |
| --- | --- |
| **`$data`** | Extracts standard key parameters from the active input execution payload (`data`). |
| **`$event`** | Parses raw incoming JSON parameters transmitted via active webhook streams. |
| **`$actions`** | Exposes an array of historical execution artifacts from previous macro pipeline links. |
| **`$request` / `$header`** | Exposes underlying HTTP request properties, methods, and incoming network parameters. |
| **`$jwt`** | Triggers an active cryptographic signing loop, building a secure JWT token from properties. |

---

## Installation

```bash
npm install @cocreate/api
```

---

## Usage

### Module Initialization

Bind the API framework directly during the bootstrapping phase of your core `CoCreateServer` application matrix.

```javascript
import apiGateway from '@cocreate/api';
import { CoCreateServer } from '@cocreate/server';

// Boot the primary application server instance
const serverContext = await CoCreateServer.start();

// Initialize the API engine and register WebSocket listeners
await apiGateway.init(serverContext);
```

### Direct Programmatic API Execution

Execute complex third-party outbound macro operations using unified integration objects.

```javascript
import apiGateway from '@cocreate/api';

// The method identifies the provider credentials, and the endpoint resolves the data model
const payload = {
  organization_id: "64b9a32e18f21bc56789abcd",
  method: "stripe",
  endpoint: "POST /v1/customers",
  stripe: {
    email: "$data.userEmail",
    metadata: {
      workspace: "production"
    }
  },
  userEmail: "developer@cocreate.app"
};

const result = await apiGateway.executeApi(payload);
```

---

## How it Works

1. **Bootstrap & Event Binding:** During `init()`, the module hooks directly into the server's WebSocket framework (`wsManager`), capturing incoming `api` and `endpoint` event signals to route them to the execution handler.
2. **Context and Firewall Initialization:** For every outbound execution, the engine evaluates the parameters against a parent context firewall. Security profiles match inbound connections against verified socket bounds, locking `organization_id` and `host` configurations.
3. **Macro Configuration Resolving:** The engine sends queries through the CRUD synchronization layer to match configuration files against stored endpoints or active integration details inside the database collection.
4. **AST Matrix Processing:** The router recursively scans headers, parameters, and bodies via `processOperators()`. Found strings matching active variables (such as `$` prefixes) are securely compiled in the isolated `NativeSandbox` environment.
5. **Outbound Network Fetching:** The system builds the request profile, forcefully sets content headers, maps an `AbortController` timeout circuit breaker (15-second cutoff), and executes the request using the runtime's native `fetch` implementation.
6. **Payload Delivery & Webhook Dispatching:** Webhook targets matching inbound edge rules validate security values, execute configured workflows sequentially, and return structured responses.

---

## Architecture and Payload Specs

### Unified Payload Object Schema

The API engine relies on flat, declarative payload objects passed through the execution pipeline.

| Field Element | Type | Role |
| --- | --- | --- |
| `organization_id` | `String` | **Required.** Targets the tenant profile used to resolve integrations and credentials. |
| `method` | `String` | **Required.** Provider identity (for example `"stripe"`). |
| `endpoint` | `String` | **Required.** HTTP method and route used to locate the configured endpoint (for example `"POST /v1/customers"`). |
| `[providerName]` | `Object` | Provider-specific input object (for example `stripe`) that is processed through the AST engine. |

### Context Engine Parameter Schema

The API engine creates an execution context for every request.

| Field Element | Type | Role |
| --- | --- | --- |
| `data` | `Object` | Input payload supplied to the execution pipeline. |
| `event` | `Object` | Parsed webhook request body. |
| `actions` | `Array` | Results accumulated from previous workflow steps. |
| `organization_id` | `String` | Tenant identifier. |
| `host` | `String` | Verified tenant host used for isolation. |
| `crud` / `wsManager` | `Object` | References to the CRUD layer and WebSocket manager. |

---

## Security Implementations

> [!WARNING]
> Parent execution context always overrides incoming payload values to prevent cross-tenant access or privilege escalation.

### Context Sandboxing

Internal services such as `crud` and `wsManager` intercept execution arguments and automatically enforce the authenticated tenant context. Even if a malicious configuration attempts to override tenant information, the runtime replaces it with the verified execution context.

### Timing-Safe Signature Verification

Inbound webhooks configured with authentication rules are validated using `crypto.timingSafeEqual`, preventing timing attacks during signature verification.

---

## How to Contribute

We encourage contributions to all CoCreate libraries. Please see our **[CONTRIBUTING.md](https://github.com/CoCreate-app/CoCreate-api/blob/master/CONTRIBUTING.md)** guide for development workflows and contribution guidelines.

If you discover a bug or would like to request a feature, please open an issue on our **[GitHub Issues](https://github.com/CoCreate-app/CoCreate-api/issues)** tracker.

For complete API documentation, integration examples, and webhook guides, visit:

https://cocreatejs.com/docs/api

---

## License

This software is dual-licensed under the GNU Affero General Public License version 3 (AGPLv3) and a commercial license.

- **Open Source Use:** For open-source projects and non-commercial use, this software is available under the AGPLv3. For the full license text, see the LICENSE file.
- **Commercial Use:** Commercial users must obtain a commercial license. Commercial licenses are available when signing up for an API key through the CoCreate platform.