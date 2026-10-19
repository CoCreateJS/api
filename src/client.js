/*globals CustomEvent, config*/
import { getValueFromObject, dotNotationToObject } from "@cocreate/utils";
import Observer from "@cocreate/observer";
import Socket from "@cocreate/socket-client";
import Actions from "@cocreate/actions";
import { render } from "@cocreate/render";
import "@cocreate/element-prototype";

function getEndpointGroup({ name, action, element, form }) {
	const operation = String(action || "").replaceAll('"', '\\"');
	const operationSelector = operation ? `[${name}="${operation}"]` : null;
	const endpointSelector = `[${name}-endpoint]`;
	return (
		(operationSelector && element?.closest(operationSelector)) ||
		element?.closest(endpointSelector) ||
		(operationSelector && form?.matches?.(operationSelector) ? form : null) ||
		(form?.matches?.(endpointSelector) ? form : null)
	);
}

function getGroupElements({ name, action, element, form, response = false }) {
	const group = getEndpointGroup({ name, action, element, form });
	const stateAttribute = `${name}-${response ? "response" : "request"}`;
	let elements = [];

	if (group) {
		elements = [group, ...group.querySelectorAll(`[${name}-key]`)].filter(
			(candidate) =>
				getEndpointGroup({ name, action, element: candidate, form }) === group &&
				candidate.getAttribute(stateAttribute) !== "false"
		);
	} else if (form) {
		const selector = `[${name}="${action}"]:not([${stateAttribute}="false"])`;
		if (form.matches?.(selector)) elements.push(form);
		elements.push(...form.querySelectorAll(selector));
	}

	return elements.length ? elements : element ? [element] : [];
}

const CoCreateApi = {
	modules: {},

	init: function (moduleConfig) {
		if (!moduleConfig) {
			let elements = document.querySelectorAll("[api], [module]");
			for (let i = 0; i < elements.length; i++) {
				let name =
					elements[i].getAttribute("api") ||
					elements[i].getAttribute("module");
				this.register({ name, endPoints: {} });
			}
		} else {
			let { name, endPoints, options } = moduleConfig;
			this.register({ name, endPoints, options });
			if (options && options.socket !== false && !Socket.sockets.size)
				Socket.create({ prefix: "api" });
		}
	},

	register: function ({ name, endPoints, options }) {
		const self = this;
		if (typeof this.modules[name] === "undefined") {
			this.modules[name] = { name, endPoints, options };

			Actions.init({
				name,
				callback: (action) => {
					action.form = action.form || document;
					return self.request({
						...action,
						action: action.method,
						method: undefined,
						type: "action"
					});
				}
			});

			const inputEvent = (element) => {
				element.addEventListener("input", (e) => {
					if (!e.detail || (e.detail && e.detail.skip != true)) {
						self.request({ name, element, type: "input" });
					}
				});
			};

			let elements = document.querySelectorAll(
				`[${name}], [${name}-endpoint]`
			);
			for (let i = 0; i < elements.length; i++) {
				inputEvent(elements[i]);
				this.request({ name, element: elements[i], type: "onload" });
			}

			Observer.init({
				name: `${name}NodeObserver`,
				types: ["addedNodes"],
				selector: `[${name}], [${name}-endpoint]`,
				callback: function (mutation) {
					inputEvent(mutation.target);
					self.request({
						name,
						element: mutation.target,
						type: "nodeObserver"
					});
				}
			});

			Observer.init({
				name: `${name}AttributeObserver`,
				types: ["attributes"],
				attributeFilter: [name, `${name}-endpoint`, `${name}-method`],
				callback: function (mutation) {
					self.request({
						name,
						element: mutation.target,
						type: "attributeObserver"
					});
				}
			});
		}
	},

	request: async function (object) {
		if (object.element) {
			if (!object.action)
				object.action = object.element.getAttribute(object.name);
			const group = getEndpointGroup(object);
			if (!object.endpoint)
				object.endpoint =
					group?.getAttribute(`${object.name}-endpoint`) || object.action;
			if (!object.method)
				object.method = group?.getAttribute(`${object.name}-method`);
			if (!object.key)
				object.key = object.element.getAttribute(`${object.name}-key`);
			if (!object.event)
				object.event = object.element.getAttribute(
					`${object.name}-event`
				);
		}

		if (
			this.modules[object.name][object.action] &&
			this.modules[object.name][object.action].request
		)
			this.modules[object.name][object.action].request(object);
		else if (
			(!object.event && object.type === "action") ||
			(object.event && object.event.includes(object.type))
		) {
			object.data = await CoCreateApi.getData(object);
			if (
				object.action ||
				object.endpoint ||
				object.method ||
				Object.keys(object.data).length
			)
				return CoCreateApi.send(object);
		}
	},

	response: function (object) {
		const name = object.name;
		const action = object.action;
		const response = object.data;
		const data = response.data;
		if (this.modules[name][action] && this.modules[name][action].response)
			this.modules[name][action].response(data);
		else if (response.error) {
			object.abort?.({
				code: "api-request-failed",
				message: response.error?.message || String(response.error),
				cause: response.error
			});
			render({
				selector: `[template*='${name}']`,
				data: [
					{
						type: name,
						action,
						method: object.method,
						status: "failed",
						message: response.error
					}
				]
			});
			object.element?.dispatchEvent(
				new CustomEvent("error", {
					detail: { error: response.error, data: response }
				})
			);
		} else {
			CoCreateApi.setData(object);

			object.element.dispatchEvent(
				new CustomEvent(object.endEvent, {
					detail: {
						data: object
					}
				})
			);
		}
	},

	send: async function (object) {
		const isDataObject = object.data &&
			typeof object.data === "object" &&
			!Array.isArray(object.data);
		const data = isDataObject ? { ...object.data } : object.data;
		const request = {
			api: object.name,
			method: object.method,
			endpoint: object.endpoint,
			data,
			broadcast: false,
			broadcastClient: false
		};

		for (const directive of ["url", "headers", "timeout", "searchParams"]) {
			const value = object[directive] ?? (isDataObject ? data[directive] : undefined);
			if (value !== undefined) request[directive] = value;
			if (isDataObject) delete data[directive];
		}

		try {
			object.data = await Socket.send(request);
		} catch (error) {
			object.data = { error: error?.message || String(error) };
		}
		this.response(object);
	},

	getData: async function ({ name, action, element, form }) {
		let data = {};

		if (!form && element) form = element.closest("form");
		if (!form) form = document;

		const elements = getGroupElements({
			name,
			action,
			element,
			form
		});

		for (let i = 0; i < elements.length; i++) {
			if (!elements[i] || elements[i].closest("[template]")) continue;
				let key = elements[i].getAttribute(`${name}-key`);
				if (key) {
					let value = await elements[i].getValue();
				if (key.endsWith("[]")) {
					if (!data[key]) data[key] = [];

					if (Array.isArray(value)) data[key].push(...value);
					else data[key].push(value);
				} else data[key] = value;
			}

			if (
				elements[i].getAttribute("query") &&
				elements[i].getAttribute("query") !== "false"
			) {
				data.query = true;
			}
		}

		let params = {},
			hasParams = false;
		for (let i = 0; true; i++) {
			if (`$param[${i}]` in data) {
				params[`$param[${i}]`] = data[`$param[${i}]`];
				delete data[`$param[${i}]`];
				hasParams = true;
			} else {
				break;
			}
		}
		data = dotNotationToObject(data);
		if (hasParams) data = { ...params, ...data };

		return data;
	},

	setData: function (object) {
		const name = object.name;
		const data = object.data.data;
		let form = object.form;
		if (!form) form = document;

		const elements = getGroupElements({
			name,
			action: object.action,
			element: object.element,
			form,
			response: true
		});
		if (!elements.length) return;

		for (let i = 0; i < elements.length; i++) {
			if (elements[i].hasAttribute("actions")) continue;
			let key = elements[i].getAttribute(`${name}-key`);
			if (key) {
				let templateid = elements[i].getAttribute("template_id");
				if (templateid) {
					let items = document.querySelectorAll(
						`[templateid="${templateid}"]`
					);
					for (let item of items) item.remove();
					render({
						selector: `[template="${templateid}"]`,
						data
					});
				} else if (elements[i].renderValue) {
					if (key === "{}") {
						elements[i].renderValue(data);
					} else {
						let value = getValueFromObject(data, key);
						if (typeof value === "function") {
							value = value(); // Call the function and assign its return value.
						}
						elements[i].renderValue(value);
					}
				} else {
					if (key === "{}") elements[i].setValue(data);
					else {
						let value = getValueFromObject(data, key);
						if (typeof value === "function") {
							value = value(); // Call the function and assign its return value.
						}
						elements[i].setValue(value);
					}
				}
			}
		}
	}
};

Observer.init({
	name: `apiNodeObserver`,
	types: ["addedNodes"],
	selector: "[module], [api]",
	callback: function (mutation) {
		let name =
			mutation.target.getAttribute("api") ||
			mutation.target.getAttribute("module");
		CoCreateApi.register({ name, endPoints: {} });
	}
});

CoCreateApi.init();

export default CoCreateApi;
