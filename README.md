# @cocreate/api

A dynamic, multi-tenant API execution gateway, proxy engine, and webhook orchestration routing layer. It securely manages distributed integration architectures, allowing applications to configure, evaluate, and execute complex third-party API configurations and multi-step macro workflows on the fly. By coupling an Abstract Syntax Tree (AST) evaluation sandbox (`NativeSandbox`) with strict tenant environmental isolation, it transforms declarative configurations into low-latency outbound integrations and secure inbound webhooks without introducing cross-tenant data leaks.

---

## Table of Contents

* [Features](https://www.google.com/search?q=%23features)
* [Dynamic Operations Sandbox](https://www.google.com/search?q=%23dynamic-operations-sandbox)
* [Installation](https://www.google.com/search?q=%23installation)
* [Usage](https://www.google.com/search?q=%23usage)
* [How it Works](https://www.google.com/search?q=%23how-it-works)
* [Architecture and Payload Specs](https://www.google.com/search?q=%23architecture-and-payload-specs)
* [Security Implementations](https://www.google.com/search?q=%23security-implementations)
* [How to Contribute](https://www.google.com/search?q=%23how-to-contribute)
* [License](https://www.google.com/search?q=%23license)

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

The engine evaluates standard properties and custom functional variables using a predefined sandbox layer. This allows configuration profiles to extract fields safely on the fly:

| Core Operator Scope | Extracted Source Value |
| --- | --- |
| **`$data`** | Extracts standard key parameters from the active input execution payload (`data`). |
| **`$event`** | Parses raw, incoming JSON parameters transmitted via active webhook streams. |
| **`$actions`** | Exposes an array of historical execution artifacts from previous macro pipeline links. |
| **`$request` / `$header**` | Exposes underlying HTTP request properties, methods, and incoming network parameters. |
| **`$jwt`** | Triggers an active cryptographic signing loop, building a secure JWT token from properties. |

---

## Installation

```bash
npm install @cocreate/api

```

---

## Usage

### Module Initialization

Bind the API framework directly during the bootstrapping phase of your core `CoCreateServer` application matrix:

```javascript
import apiGateway from '@cocreate/api';
import { CoCreateServer } from '@cocreate/server';

// Boot the primary application server instance
const serverContext = await CoCreateServer.start();

// Initialize the API engine and register WebSocket listeners
await apiGateway.init(serverContext);

```

### Direct Programmatic API Execution

Execute complex third-party outbound macro operations using unified integration objects:

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
4. **AST Matrix Processing:** The router recursively scans headers, parameters, and bodies via `processOperators()`. Found strings matching active variables (e.g., `$` prefixes) are securely compiled in the isolated `NativeSandbox` environment.
5. **Outbound Network Fetching:** The system builds the options profile, forcefully sets content headers, maps an `AbortController` timeout circuit breaker (15-second cutoff), and runs the task using the system runtime's native `fetch` framework.
6. **Payload Delivery & Webhook Dispatching:** Webhook targets matching inbound edge rules check security values, run validation rules using timing-safe comparisons, execute steps sequentially, and output structural streams.

---

## Architecture and Payload Specs

### Unified Payload Object Schema

The data engine relies heavily on structural, flat parameter objects passed down into the execution chain:

| Field Element | Type | Role |
| --- | --- | --- |
| `organization_id` | `String` | **Required.** Targets the root tenant profile partition mapping to execution databases. |
| `method` | `String` | **Required.** The provider identity string (e.g., `"stripe"`) used to fetch integration credentials. |
| `endpoint` | `String` | **Required.** The operational HTTP verb and route mapping (e.g., `"POST /v1/customers"`) used to match configurations in the endpoints database. |
| `[providerName]` | `Object` | The input context object named after your provider (e.g., `stripe: { ... }`) holding parameters processed by the AST engine. |

### Context Engine Parameter Schema

The API processing network builds a dedicated execution block on every mutation cycle:

| Field Element | Type | Role |
| --- | --- | --- |
| `data` | `Object` | Input variable parameters sent down from the parent action payload. |
| `event` | `Object` | The compiled incoming request body extracted from active webhook pipelines. |
| `actions` | `Array` | A running chronological memory matrix containing results of completed steps. |
| `organization_id` | `String` | **Required.** Lockout identifier tracking root workspace context. |
| `host` | `String` | The edge routing host domain verifying tenant environment isolation boundaries. |
| `crud` / `wsManager` | `Object` | Bound links to internal database adapters and WebSocket server channels. |

---

## Security Implementations

> [!WARNING]
> To prevent config-driven cross-tenant data leaks or privilege escalations, parent context variables and authenticated socket bounds take absolute priority over raw incoming payload attributes.

### Context Sandboxing

Local interface methods (such as direct actions on `crud` or `wsManager`) intercept arguments inside the execution layer. Even if a configuration profile passes a malicious tenant parameter inside an AST macro string, the sandbox engine explicitly overwrites the parameters on execution to align with the sealed context of the authenticated user.

### Timing-Safe Signature Verification

Inbound webhook channels configured with `authenticate` properties execute validation algorithms using a cryptographically secure fixed-time comparison script (`crypto.timingSafeEqual`). This completely mitigates timing-attack vectors targeting system endpoints.

---

## How to Contribute

We encourage contribution to our libraries (you might even score some nifty swag), please see our [CONTRIBUTING.md](https://cocreatejs.com/docs/api/contributing) guide for details. We want this library to be community-driven, and CoCreate led. We need your help to realize this goal.

---

## License

This software is dual-licensed under the GNU Affero General Public License version 3 (AGPLv3) and a commercial license.

* **Open Source Use:** For open-source projects and non-commercial use, this software is available under the AGPLv3. For the full license text, see the LICENSE file.
* **Commercial Use:** For-profit companies and individuals intending to use this software for commercial purposes must obtain a commercial license. The commercial license is available when you sign up for an API key on our website.