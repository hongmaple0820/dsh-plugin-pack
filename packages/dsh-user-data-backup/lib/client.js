window.__ModuleLoader__.load({ id: "@local/dsh-user-data-backup", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.js
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react3 = __toESM(require("react"), 1);
var import_dsh_client_ui_primitives3 = require("@deepseek-ai/dsh-client-ui-primitives");

// src/client.css
var client_default = "/* Every color, radius, and focus ring resolves through host --dsw-* tokens, so this section follows the active theme and the dsh-claude-style shapes. */\n\n.local-user-data {\n  box-sizing: border-box;\n  display: flex;\n  flex-direction: column;\n  gap: 16px;\n  width: 100%;\n  max-width: 880px;\n  min-width: 0;\n  min-height: 0;\n  margin-inline: auto;\n  padding-block: 8px;\n  color: var(--dsw-alias-label-primary);\n  font-size: 13px;\n  line-height: 22px;\n}\n\n.local-user-data *,\n.local-user-data *::before,\n.local-user-data *::after {\n  box-sizing: border-box;\n}\n\n/* Settings type scale: 16/24 title, 14/22 intro, 13/22 body. */\n.local-user-data .local-user-data-head {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  min-width: 0;\n}\n\n.local-user-data h2 {\n  margin: 0;\n  font-size: 16px;\n  line-height: 24px;\n  font-weight: 500;\n}\n\n.local-user-data h3 {\n  margin: 0;\n  font-size: 14px;\n  line-height: 22px;\n  font-weight: 500;\n}\n\n.local-user-data h4,\n.local-user-data legend {\n  margin: 0;\n  padding: 0;\n  font-size: 13px;\n  line-height: 22px;\n  font-weight: 500;\n}\n\n.local-user-data p {\n  margin: 0;\n  min-width: 0;\n}\n\n.local-user-data .local-user-data-intro {\n  font-size: 14px;\n  line-height: 22px;\n  color: var(--dsw-alias-label-tertiary);\n}\n\n/* One card per section, with an outline that always reads heavier than its inner separators. */\n.local-user-data > section {\n  display: flex;\n  flex-direction: column;\n  gap: 12px;\n  min-width: 0;\n  min-height: 0;\n  padding: 16px;\n  border: 0.5px solid var(--dsw-alias-settings-card-stroke);\n  border-radius: var(--dsw-radius-xl);\n  background: var(--dsw-alias-settings-card-fill);\n}\n\n.local-user-data ul {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  margin: 0;\n  min-width: 0;\n  padding-inline-start: 20px;\n}\n\n.local-user-data li {\n  min-width: 0;\n  overflow-wrap: anywhere;\n}\n\n/* auto-fit keeps two columns on a wide panel and one on a narrow one, without a width breakpoint. */\n.local-user-data fieldset {\n  display: grid;\n  grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));\n  gap: 8px;\n  min-width: 0;\n  margin: 0;\n  padding: 0;\n  border: 0;\n}\n\n.local-user-data fieldset > fieldset,\n.local-user-data fieldset > p,\n.local-user-data .local-user-data-option-wide {\n  grid-column: 1 / -1;\n}\n\n.local-user-data .local-user-data-option {\n  display: flex;\n  align-items: flex-start;\n  gap: 8px;\n  min-width: 0;\n  padding: 8px 12px;\n  border: 0.5px solid var(--dsw-alias-settings-card-stroke);\n  border-radius: var(--dsw-radius-md);\n  background: var(--dsw-alias-bg-base);\n  cursor: pointer;\n}\n\n/* Selected options must read at a glance: accent tint plus a doubled 1px outline, not a hairline colour change. */\n.local-user-data .local-user-data-option:has(:checked) {\n  border-color: var(--dsw-alias-border-selected);\n  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-selected);\n  background: var(--dsw-alias-interactive-bg-hover-accent);\n  font-weight: 500;\n}\n\n.local-user-data .local-user-data-checks {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 8px 16px;\n  min-width: 0;\n}\n\n.local-user-data .local-user-data-check {\n  display: inline-flex;\n  align-items: center;\n  gap: 6px;\n  min-width: 0;\n  cursor: pointer;\n}\n\n.local-user-data .local-user-data-field,\n.local-user-data .local-user-data-file {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  min-width: 0;\n}\n\n.local-user-data input:not([type=checkbox]):not([type=file]),\n.local-user-data select {\n  box-sizing: border-box;\n  width: 100%;\n  max-width: 100%;\n  min-width: 0;\n  height: 32px;\n  padding: 0 10px;\n  border: 0.5px solid var(--dsw-alias-border-l3);\n  border-radius: var(--dsw-radius-sm);\n  background: var(--dsw-alias-bg-base);\n  color: inherit;\n  font: inherit;\n}\n\n/* The native file control is styled into the same 32px field as inputs and selects; it stays a real input so the keyboard reaches it. */\n.local-user-data input[type=file] {\n  box-sizing: border-box;\n  width: 100%;\n  max-width: 100%;\n  min-width: 0;\n  height: 32px;\n  padding: 0;\n  border: 0.5px solid var(--dsw-alias-border-l3);\n  border-radius: var(--dsw-radius-sm);\n  background: var(--dsw-alias-bg-base);\n  color: var(--dsw-alias-label-secondary);\n  font: inherit;\n  cursor: pointer;\n}\n\n.local-user-data input[type=checkbox] {\n  flex: none;\n  margin: 0;\n  accent-color: var(--dsw-alias-brand-primary);\n}\n\n.local-user-data :focus-visible {\n  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));\n  outline-offset: 2px;\n}\n\n/* Feedback rows: one shape, with the tone carrying severity. */\n.local-user-data [role=status],\n.local-user-data [role=alert] {\n  min-width: 0;\n  padding: 8px 12px;\n  border: 0.5px solid var(--dsw-alias-settings-card-stroke);\n  border-radius: var(--dsw-radius-md);\n  background: var(--dsw-alias-bg-base);\n}\n\n.local-user-data [role=status] {\n  color: var(--dsw-alias-label-secondary);\n}\n\n.local-user-data [role=alert] {\n  border-color: var(--dsw-alias-state-error-secondary);\n  color: var(--dsw-alias-state-error-primary);\n}\n\n/* Long previews scroll inside their card instead of widening it. */\n.local-user-data .local-user-data-scroll {\n  min-width: 0;\n  min-height: 0;\n  max-width: 100%;\n  max-height: min(360px, 60vh);\n  overflow: auto;\n  overscroll-behavior: contain;\n}\n\n.local-user-data .local-user-data-table {\n  width: 100%;\n  min-width: 0;\n  border-collapse: collapse;\n  font: inherit;\n  font-variant-numeric: tabular-nums;\n}\n\n.local-user-data .local-user-data-table th,\n.local-user-data .local-user-data-table td {\n  padding: 6px 8px;\n  text-align: start;\n  vertical-align: top;\n  overflow-wrap: anywhere;\n}\n\n/* Narrow windows shrink the path column; the short columns stay on one line instead of breaking inside words. */\n.local-user-data .local-user-data-table th:not(:first-child),\n.local-user-data .local-user-data-table td:not(:first-child) {\n  white-space: nowrap;\n  overflow-wrap: normal;\n}\n\n.local-user-data .local-user-data-table thead th {\n  font-weight: 500;\n  color: var(--dsw-alias-label-tertiary);\n  border-bottom: 0.5px solid var(--dsw-alias-border-l2);\n}\n\n.local-user-data .local-user-data-table tbody tr + tr > * {\n  border-top: 0.5px solid var(--dsw-alias-border-l2);\n}\n\n.local-user-data .local-user-data-path {\n  overflow-wrap: anywhere;\n  color: var(--dsw-alias-label-secondary);\n}\n\n.local-user-data .local-user-data-actions {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n}\n\n.local-user-data .local-user-data-destination {\n  min-width: 0;\n  border: 0.5px solid var(--dsw-alias-settings-card-stroke);\n  border-radius: var(--dsw-radius-md);\n  background: var(--dsw-alias-bg-base);\n}\n\n.local-user-data .local-user-data-destination > summary {\n  padding: 8px 12px;\n  border-radius: inherit;\n  font-weight: 500;\n  cursor: pointer;\n}\n\n.local-user-data .local-user-data-destination > fieldset {\n  padding: 4px 12px 12px;\n}\n\n.local-user-data .local-user-data-remote-list {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  min-height: 0;\n  max-height: min(320px, 50vh);\n  margin: 0;\n  padding: 0;\n  list-style: none;\n  overflow-y: auto;\n  overscroll-behavior: contain;\n}\n\n.local-user-data .local-user-data-remote-item {\n  display: flex;\n  flex-wrap: wrap;\n  align-items: center;\n  gap: 8px;\n  min-width: 0;\n  padding: 8px 12px;\n  border: 0.5px solid var(--dsw-alias-settings-card-stroke);\n  border-radius: var(--dsw-radius-md);\n  background: var(--dsw-alias-bg-base);\n}\n\n.local-user-data .local-user-data-remote-name {\n  flex: 1 1 200px;\n  min-width: 0;\n  overflow-wrap: anywhere;\n  font-variant-numeric: tabular-nums;\n}\n\n.local-user-data input[type=file]::file-selector-button {\n  height: 100%;\n  margin: 0 10px 0 0;\n  padding: 0 12px;\n  border: 0;\n  border-inline-end: 0.5px solid var(--dsw-alias-border-l3);\n  border-radius: var(--dsw-radius-sm) 0 0 var(--dsw-radius-sm);\n  background: var(--dsw-alias-interactive-bg-hover-solid);\n  color: var(--dsw-alias-label-primary);\n  font: inherit;\n  cursor: pointer;\n}\n\n@media (hover: hover) {\n  .local-user-data .local-user-data-option:not(:has(:checked)):hover,\n  .local-user-data .local-user-data-check:hover,\n  .local-user-data .local-user-data-destination > summary:hover,\n  .local-user-data input[type=file]::file-selector-button:hover {\n    background: var(--dsw-alias-interactive-bg-hover);\n  }\n}\n\n@media (pointer: coarse) {\n  .local-user-data input:not([type=checkbox]),\n  .local-user-data select {\n    height: auto;\n    min-height: 44px;\n    font-size: 16px;\n  }\n\n  .local-user-data button,\n  .local-user-data summary,\n  .local-user-data .local-user-data-option,\n  .local-user-data .local-user-data-check {\n    min-height: 44px;\n  }\n}\n";

// src/remote-client.js
var import_react = __toESM(require("react"), 1);
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
var remoteCopy = {
  en: {
    destination: "Destination settings",
    remote: "Remote backups",
    remoteIntro: "Save a WebDAV or S3-compatible destination. Secrets are stored in the host credential provider. Automatic backups exclude credentials.",
    kind: "Storage type",
    endpoint: "HTTPS endpoint",
    prefix: "Backup directory",
    bucket: "Bucket",
    region: "Region",
    pathStyle: "Use path-style S3 URLs",
    username: "Username",
    password: "Password",
    accessKey: "Access key",
    secretKey: "Secret key",
    sessionToken: "Session token (optional)",
    secretHint: "Leave secret fields empty to keep their saved values.",
    keep: "Backups to keep",
    interval: "Automatic backup interval (minutes; 0 turns it off)",
    saveRemote: "Save destination",
    testRemote: "Test saved destination",
    pushRemote: "Back up now",
    listRemote: "Refresh backups",
    downloadRemote: "Download",
    previewRemote: "Preview restore",
    deleteRemote: "Delete",
    confirmDeleteRemote: "Confirm deletion",
    cancelRemote: "Cancel",
    noBackups: "No remote backups found.",
    remoteSaved: "Destination saved.",
    remotePassed: "Destination is reachable.",
    remotePushed: "Backup uploaded and verified.",
    remoteDeleted: "Backup deleted.",
    remoteBusy: "A remote operation is running.",
    remoteNever: "No backup has run yet.",
    remoteLast: "Last backup",
    remoteNext: "Next automatic backup",
    remoteFailed: "Remote operation failed. Check destination access and saved credentials.",
    remoteRetentionFailed: "The new backup was verified, but old backups could not all be removed.",
    remoteComponents: "Components for remote backups",
    remoteUnconfigured: "Save a destination before using remote backups."
  },
  zh: {
    destination: "\u76EE\u6807\u8BBE\u7F6E",
    remote: "\u8FDC\u7A0B\u5907\u4EFD",
    remoteIntro: "\u4FDD\u5B58 WebDAV \u6216\u517C\u5BB9 S3 \u7684\u76EE\u6807\u3002\u5BC6\u94A5\u4FDD\u5B58\u5728\u5BBF\u4E3B\u51ED\u636E\u670D\u52A1\u4E2D\uFF0C\u81EA\u52A8\u5907\u4EFD\u4E0D\u5305\u542B\u51ED\u636E\u3002",
    kind: "\u5B58\u50A8\u7C7B\u578B",
    endpoint: "HTTPS \u5730\u5740",
    prefix: "\u5907\u4EFD\u76EE\u5F55",
    bucket: "\u5B58\u50A8\u6876",
    region: "\u533A\u57DF",
    pathStyle: "\u4F7F\u7528 S3 \u8DEF\u5F84\u5F62\u5F0F\u5730\u5740",
    username: "\u7528\u6237\u540D",
    password: "\u5BC6\u7801",
    accessKey: "\u8BBF\u95EE\u5BC6\u94A5\u6807\u8BC6",
    secretKey: "\u8BBF\u95EE\u5BC6\u94A5",
    sessionToken: "\u4E34\u65F6\u4EE4\u724C\uFF08\u53EF\u9009\uFF09",
    secretHint: "\u5BC6\u94A5\u8F93\u5165\u7559\u7A7A\u65F6\u4FDD\u7559\u5DF2\u4FDD\u5B58\u7684\u503C\u3002",
    keep: "\u4FDD\u7559\u5907\u4EFD\u6570\u91CF",
    interval: "\u81EA\u52A8\u5907\u4EFD\u95F4\u9694\uFF08\u5206\u949F\uFF0C0 \u8868\u793A\u5173\u95ED\uFF09",
    saveRemote: "\u4FDD\u5B58\u76EE\u6807",
    testRemote: "\u6D4B\u8BD5\u5DF2\u4FDD\u5B58\u76EE\u6807",
    pushRemote: "\u7ACB\u5373\u5907\u4EFD",
    listRemote: "\u5237\u65B0\u5907\u4EFD\u5217\u8868",
    downloadRemote: "\u4E0B\u8F7D",
    previewRemote: "\u9884\u89C8\u6062\u590D",
    deleteRemote: "\u5220\u9664",
    confirmDeleteRemote: "\u786E\u8BA4\u5220\u9664",
    cancelRemote: "\u53D6\u6D88",
    noBackups: "\u8FDC\u7AEF\u6682\u65E0\u5907\u4EFD\u3002",
    remoteSaved: "\u76EE\u6807\u5DF2\u4FDD\u5B58\u3002",
    remotePassed: "\u76EE\u6807\u53EF\u4EE5\u8BBF\u95EE\u3002",
    remotePushed: "\u5907\u4EFD\u5DF2\u4E0A\u4F20\u5E76\u901A\u8FC7\u56DE\u8BFB\u6821\u9A8C\u3002",
    remoteDeleted: "\u5907\u4EFD\u5DF2\u5220\u9664\u3002",
    remoteBusy: "\u6B63\u5728\u6267\u884C\u8FDC\u7A0B\u64CD\u4F5C\u3002",
    remoteNever: "\u5C1A\u672A\u6267\u884C\u8FC7\u5907\u4EFD\u3002",
    remoteLast: "\u6700\u8FD1\u5907\u4EFD",
    remoteNext: "\u4E0B\u6B21\u81EA\u52A8\u5907\u4EFD",
    remoteFailed: "\u8FDC\u7A0B\u64CD\u4F5C\u5931\u8D25\u3002\u8BF7\u68C0\u67E5\u76EE\u6807\u8BBF\u95EE\u6743\u9650\u548C\u4FDD\u5B58\u7684\u51ED\u636E\u3002",
    remoteRetentionFailed: "\u65B0\u5907\u4EFD\u5DF2\u901A\u8FC7\u6821\u9A8C\uFF0C\u4F46\u672A\u80FD\u6E05\u7406\u5168\u90E8\u8FC7\u671F\u5907\u4EFD\u3002",
    remoteComponents: "\u8FDC\u7A0B\u5907\u4EFD\u5185\u5BB9",
    remoteUnconfigured: "\u8BF7\u5148\u4FDD\u5B58\u76EE\u6807\u518D\u4F7F\u7528\u8FDC\u7A0B\u5907\u4EFD\u3002"
  }
};
var API = "/api/local-user-data.remote.";
var h = import_react.default.createElement;
function RemoteSection({ t, disabled, parameters, onPreview, onBusy }) {
  const [status, setStatus] = (0, import_react.useState)(null);
  const [config, setConfig] = (0, import_react.useState)({ kind: "webdav", endpoint: "", prefix: "dsh-backups", bucket: "", region: "us-east-1", keep: 20, intervalMs: 0, components: ["profile", "settings"] });
  const [secrets, setSecrets] = (0, import_react.useState)({});
  const [items, setItems] = (0, import_react.useState)(null);
  const [deleting, setDeleting] = (0, import_react.useState)(null);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [message, setMessage] = (0, import_react.useState)(null);
  const [error, setError] = (0, import_react.useState)(null);
  const controller = (0, import_react.useRef)(null);
  const download = (0, import_react.useRef)(null);
  const call = async (action2, signal, body) => {
    const response = await fetch(API + action2, { signal, credentials: "same-origin", ...body === void 0 ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } });
    if (response.headers.get("content-type")?.startsWith("application/zip") && response.ok) return response.blob();
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
  };
  (0, import_react.useEffect)(() => {
    const abort = new AbortController();
    void call("status", abort.signal).then((value) => {
      if (abort.signal.aborted) return;
      setStatus(value);
      if (value.config !== null) setConfig(value.config);
    }).catch((failure) => {
      if (!abort.signal.aborted) setError(failure.message);
    });
    return () => {
      abort.abort();
      controller.current?.abort();
      if (download.current) URL.revokeObjectURL(download.current);
    };
  }, []);
  const run = async (task) => {
    if (controller.current !== null || disabled) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    onBusy(true);
    setError(null);
    setMessage(null);
    try {
      await task(abort.signal);
      const value = await call("status", abort.signal);
      if (!abort.signal.aborted) setStatus(value);
    } catch (failure) {
      if (!abort.signal.aborted) setError(failure.message);
    } finally {
      controller.current = null;
      if (!abort.signal.aborted) {
        setBusy(false);
        onBusy(false);
      }
    }
  };
  const field = (key, type = "text", secret = false) => h(
    "label",
    { key, className: "local-user-data-field" },
    t(key),
    " ",
    h("input", {
      type,
      autoComplete: secret ? "new-password" : "off",
      value: secret ? secrets[key] ?? "" : config[key] ?? "",
      onChange: (event) => secret ? setSecrets({ ...secrets, [key]: event.target.value }) : setConfig({ ...config, [key]: type === "number" ? Number(event.target.value) : event.target.value })
    })
  );
  const action = (key, task, needsSaved = true) => h(import_dsh_client_ui_primitives.Button, { disabled: disabled || busy || needsSaved && !status?.config, onClick: () => void run(task) }, t(key));
  return h(
    "section",
    { "aria-label": t("remote"), "aria-busy": busy },
    h("h3", null, t("remote")),
    h("p", null, t("remoteIntro")),
    h(
      "details",
      { className: "local-user-data-destination" },
      h("summary", null, t("destination")),
      h(
        "fieldset",
        { disabled: disabled || busy },
        h("label", { className: "local-user-data-field" }, t("kind"), " ", h("select", { "aria-label": t("kind"), value: config.kind, onChange: (event) => setConfig({ ...config, kind: event.target.value }) }, h("option", { value: "webdav" }, "WebDAV"), h("option", { value: "s3" }, "S3"))),
        field("endpoint", "url"),
        field("prefix"),
        config.kind === "webdav" ? h(import_react.default.Fragment, null, field("username", "text", true), field("password", "password", true)) : h(
          import_react.default.Fragment,
          null,
          field("bucket"),
          field("region"),
          field("accessKey", "password", true),
          field("secretKey", "password", true),
          field("sessionToken", "password", true),
          h("label", { className: "local-user-data-check" }, h("input", { type: "checkbox", checked: config.forcePathStyle === true, onChange: (event) => setConfig({ ...config, forcePathStyle: event.target.checked }) }), " ", t("pathStyle"))
        ),
        h("p", null, t("secretHint")),
        field("keep", "number"),
        h("label", { className: "local-user-data-field" }, t("interval"), " ", h("input", {
          type: "number",
          min: 0,
          max: 43200,
          value: config.intervalMs / 6e4,
          onChange: (event) => setConfig({ ...config, intervalMs: Number(event.target.value) * 6e4 })
        })),
        h("fieldset", { className: "local-user-data-checks" }, h("legend", null, t("remoteComponents")), ...["profile", "settings", "sessions"].map((component) => h(
          "label",
          { key: component, className: "local-user-data-check" },
          h("input", { type: "checkbox", checked: config.components.includes(component), onChange: (event) => setConfig({ ...config, components: event.target.checked ? [...config.components, component] : config.components.filter((value) => value !== component) }) }),
          " ",
          t(component)
        )))
      ),
      h("p", null, action("saveRemote", async (signal) => {
        const value = await call("save", signal, { config, secrets });
        if (!signal.aborted) {
          setConfig(value.config);
          setSecrets({});
          setItems(null);
          setMessage("remoteSaved");
        }
      }, false))
    ),
    h(
      "p",
      { className: "local-user-data-actions" },
      action("testRemote", async (signal) => {
        await call("run", signal, { action: "test" });
        if (!signal.aborted) setMessage("remotePassed");
      }),
      " ",
      action("pushRemote", async (signal) => {
        await call("run", signal, { action: "push" });
        if (!signal.aborted) {
          setItems(null);
          setMessage("remotePushed");
        }
      }),
      " ",
      action("listRemote", async (signal) => {
        const value = await call("run", signal, { action: "list" });
        if (!signal.aborted) setItems(value);
      })
    ),
    status?.config ? h(
      "p",
      null,
      status.last === null ? t("remoteNever") : `${t("remoteLast")}: ${new Date(status.last.at).toLocaleString()}${status.last.success ? "" : ` \xB7 ${t("remoteFailed")}`}`,
      status.nextAt === null ? null : ` \xB7 ${t("remoteNext")}: ${new Date(status.nextAt).toLocaleString()}`
    ) : h("p", null, t("remoteUnconfigured")),
    status?.last?.retentionFailed ? h("p", { role: "status" }, t("remoteRetentionFailed")) : null,
    busy ? h("p", { role: "status" }, t("remoteBusy")) : null,
    message ? h("p", { role: "status" }, t(message)) : null,
    error ? h("p", { role: "alert" }, `${t("failed")}: ${error}`) : null,
    items?.length === 0 ? h("p", null, t("noBackups")) : null,
    items === null ? null : h("ul", { className: "local-user-data-remote-list" }, ...items.map((item) => h(
      "li",
      { key: item.name, className: "local-user-data-remote-item" },
      h("span", { className: "local-user-data-remote-name" }, item.name, ` (${item.bytes.toLocaleString()} B)`),
      " ",
      action("downloadRemote", async (signal) => {
        const blob = await call("run", signal, { action: "download", name: item.name });
        if (signal.aborted) return;
        if (download.current) URL.revokeObjectURL(download.current);
        download.current = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = download.current;
        link.download = item.name;
        document.body.append(link);
        link.click();
        link.remove();
      }),
      " ",
      action("previewRemote", async (signal) => {
        const value = await call("run?" + parameters(), signal, { action: "preview", name: item.name });
        if (!signal.aborted) onPreview(value);
      }),
      " ",
      deleting === item.name ? h(
        import_react.default.Fragment,
        null,
        action("confirmDeleteRemote", async (signal) => {
          await call("run", signal, { action: "delete", name: item.name });
          if (!signal.aborted) {
            setDeleting(null);
            setItems(items.filter((value) => value.name !== item.name));
            setMessage("remoteDeleted");
          }
        }),
        " ",
        h(import_dsh_client_ui_primitives.Button, { disabled: disabled || busy, onClick: () => setDeleting(null) }, t("cancelRemote"))
      ) : h(import_dsh_client_ui_primitives.Button, { disabled: disabled || busy, onClick: () => setDeleting(item.name) }, t("deleteRemote"))
    )))
  );
}

// src/browser-preferences-client.js
var import_react2 = __toESM(require("react"), 1);
var import_dsh_client_ui_primitives2 = require("@deepseek-ai/dsh-client-ui-primitives");

// src/browser-preferences.js
var VIEW = "dsh-claude-style.session-browser-view";
var PROJECTS = "dsh-claude-style.session-browser-projects";
var preferenceFileLimit = 256 * 1024;
function validatePreferences(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length !== 3 || data.version !== 1 || !["attention", "projects", "all"].includes(data.view) || !Array.isArray(data.projects) || data.projects.length > 256 || data.projects.some((id) => typeof id !== "string" || id.length === 0 || id.length > 200) || new Set(data.projects).size !== data.projects.length) throw new Error("Invalid sidebar preferences");
  return { version: 1, view: data.view, projects: [...data.projects] };
}
function snapshot(storage) {
  return [storage.getItem(VIEW), storage.getItem(PROJECTS)];
}
function exportPreferences(storage) {
  const [view, projects] = snapshot(storage);
  return validatePreferences({ version: 1, view: view ?? "attention", projects: JSON.parse(projects ?? "[]") });
}
function previewPreferences(storage, data) {
  const next = validatePreferences(data);
  const before = snapshot(storage);
  let used = false;
  return {
    view: next.view,
    count: next.projects.length,
    apply() {
      if (used) throw new Error("Sidebar preference preview has expired");
      used = true;
      if (snapshot(storage).some((value, index) => value !== before[index])) throw new Error("Sidebar preferences changed after preview");
      storage.setItem(PROJECTS, JSON.stringify(next.projects));
      try {
        storage.setItem(VIEW, next.view);
      } catch (error) {
        try {
          if (before[1] === null) storage.removeItem(PROJECTS);
          else storage.setItem(PROJECTS, before[1]);
        } catch (recoveryError) {
          throw new AggregateError([error, recoveryError], "Sidebar preferences may have been partially restored");
        }
        throw error;
      }
    }
  };
}

// src/browser-preferences-client.js
var browserCopy = {
  en: {
    browserPreferences: "Browser sidebar preferences",
    browserScope: "This separate JSON file contains only the sidebar view and selected project identifiers. It does not include other browser storage or go to a remote destination.",
    browserExport: "Download sidebar preferences",
    browserFile: "Choose sidebar preferences JSON",
    browserApply: "Restore sidebar preferences",
    browserRestored: "Sidebar preferences restored. Reload this page to use them.",
    browserInvalid: "Could not read or validate the sidebar preferences file.",
    browserChanged: "Could not restore the preferences. Check current storage and preview again.",
    browserSaveFailed: "Could not export the current sidebar preferences.",
    browserProjects: "Selected projects",
    browserAttention: "Attention",
    browserAll: "All",
    browserProjectsView: "Projects"
  },
  zh: {
    browserPreferences: "\u6D4F\u89C8\u5668\u4FA7\u680F\u504F\u597D",
    browserScope: "\u6B64\u72EC\u7ACB JSON \u6587\u4EF6\u53EA\u5305\u542B\u4FA7\u680F\u89C6\u56FE\u548C\u6240\u9009\u9879\u76EE\u6807\u8BC6\uFF0C\u4E0D\u5305\u542B\u5176\u4ED6\u6D4F\u89C8\u5668\u6570\u636E\uFF0C\u4E5F\u4E0D\u4F1A\u4E0A\u4F20\u5230\u8FDC\u7A0B\u4F4D\u7F6E\u3002",
    browserExport: "\u4E0B\u8F7D\u4FA7\u680F\u504F\u597D",
    browserFile: "\u9009\u62E9\u4FA7\u680F\u504F\u597D JSON \u6587\u4EF6",
    browserApply: "\u6062\u590D\u4FA7\u680F\u504F\u597D",
    browserRestored: "\u4FA7\u680F\u504F\u597D\u5DF2\u6062\u590D\u3002\u5237\u65B0\u6B64\u9875\u9762\u540E\u751F\u6548\u3002",
    browserInvalid: "\u65E0\u6CD5\u8BFB\u53D6\u6216\u9A8C\u8BC1\u4FA7\u680F\u504F\u597D\u6587\u4EF6\u3002",
    browserChanged: "\u65E0\u6CD5\u6062\u590D\u4FA7\u680F\u504F\u597D\uFF0C\u8BF7\u68C0\u67E5\u5F53\u524D\u5B58\u50A8\u5E76\u91CD\u65B0\u9884\u89C8\u3002",
    browserSaveFailed: "\u65E0\u6CD5\u5BFC\u51FA\u5F53\u524D\u4FA7\u680F\u504F\u597D\u3002",
    browserProjects: "\u6240\u9009\u9879\u76EE\u6570",
    browserAttention: "\u5173\u6CE8",
    browserAll: "\u5168\u90E8",
    browserProjectsView: "\u9879\u76EE"
  }
};
var viewCopy = { attention: "browserAttention", all: "browserAll", projects: "browserProjectsView" };
function BrowserPreferencesSection({ t }) {
  const [plan, setPlan] = (0, import_react2.useState)(null);
  const [notice, setNotice] = (0, import_react2.useState)(null);
  const generation = (0, import_react2.useRef)(0);
  const h2 = import_react2.default.createElement;
  const download = () => {
    try {
      const bytes = JSON.stringify(exportPreferences(localStorage), null, 2);
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/json" }));
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = "dsh-sidebar-preferences.json";
        link.click();
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      setNotice(null);
    } catch {
      setNotice("browserSaveFailed");
    }
  };
  const choose = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    const reading = ++generation.current;
    setPlan(null);
    setNotice(null);
    if (file === void 0) return;
    try {
      if (file.size > preferenceFileLimit) throw new Error("Sidebar preference file exceeds the size limit");
      const data = JSON.parse(await file.text());
      if (reading === generation.current) setPlan(previewPreferences(localStorage, data));
    } catch {
      if (reading === generation.current) setNotice("browserInvalid");
    }
  };
  return h2(
    "section",
    { "aria-label": t("browserPreferences") },
    h2("h3", null, t("browserPreferences")),
    h2("p", null, t("browserScope")),
    h2("p", null, h2(import_dsh_client_ui_primitives2.Button, { onClick: download }, t("browserExport"))),
    h2("label", null, t("browserFile"), " ", h2("input", { type: "file", accept: ".json,application/json", onChange: choose })),
    plan === null ? null : h2(
      "div",
      null,
      h2("p", null, t(viewCopy[plan.view]), " \xB7 ", t("browserProjects"), ": ", plan.count.toLocaleString()),
      h2(import_dsh_client_ui_primitives2.Button, { onClick: () => {
        setPlan(null);
        try {
          plan.apply();
          setNotice("browserRestored");
        } catch {
          setNotice("browserChanged");
        }
      } }, t("browserApply"))
    ),
    notice === null ? null : h2("p", { role: notice === "browserRestored" ? "status" : "alert" }, t(notice))
  );
}

// src/client.js
var API2 = "/api/local-user-data.";
var copy = {
  en: {
    backup: "Create a backup",
    restore: "Restore from a backup",
    selection: "Backup and restore contents",
    restoreIntro: "Choose a ZIP file, review the changes, then apply the preview.",
    nav: "Data management",
    intro: "Export this profile or preview a restore before writing changes. Backups can contain personal data.",
    profile: "Profile configuration",
    settings: "Settings",
    sessions: "Sessions",
    credentials: "Credentials (not encrypted)",
    credentialWarning: "I understand that exported credentials and recovery copies are not encrypted.",
    export: "Download backup",
    file: "Choose a ZIP backup",
    preview: "Preview restore",
    apply: "Apply this preview",
    changes: "Restore preview",
    complete: "Restore completed. Keep the recovery directory until you have checked the result.",
    partial: "Restore did not complete. Review the per-file results and recovery directory before continuing.",
    restartRequired: "Restart the host to reload the files that were restored.",
    failed: "Operation failed",
    working: "Working\u2026",
    unavailable: "The data management service is unavailable.",
    review: "Review the listed files, settings namespaces and warnings before applying. Profile changes require a restart.",
    result: "Operation results",
    empty: "No archive selected",
    tooLarge: "ZIP backup exceeds 64 MiB.",
    fileName: "File",
    action: "Change",
    bytes: "Bytes",
    namespace: "Settings section",
    recovery: "Recovery directory",
    written: "Restored",
    failedItem: "Failed",
    skipped: "Skipped",
    create: "Create",
    replace: "Replace",
    planExpiry: "This preview expires at",
    settingsChanged: "Settings to restore",
    noChanges: "No changes selected.",
    warningPartial: "Original values are saved privately before replacement. A restore can complete only in part.",
    warningExecutable: "Profile configuration can execute code after a restart. Import only backups you trust.",
    warningCredentials: "This archive and its recovery copy contain credentials without encryption.",
    warningProfileSecrets: "Masked profile values keep their current target values. Sequences with masked values are kept as a whole. Missing target values prevent this preview.",
    ...browserCopy.en,
    ...remoteCopy.en
  },
  zh: {
    backup: "\u521B\u5EFA\u5907\u4EFD",
    restore: "\u4ECE\u5907\u4EFD\u6062\u590D",
    selection: "\u5907\u4EFD\u4E0E\u6062\u590D\u5185\u5BB9",
    restoreIntro: "\u9009\u62E9 ZIP \u6587\u4EF6\uFF0C\u68C0\u67E5\u53D8\u66F4\u540E\u518D\u5E94\u7528\u9884\u89C8\u3002",
    nav: "\u6570\u636E\u7BA1\u7406",
    intro: "\u5BFC\u51FA\u5F53\u524D\u8D44\u6599\uFF0C\u6216\u5148\u9884\u89C8\u6062\u590D\u5185\u5BB9\u518D\u5199\u5165\u3002\u5907\u4EFD\u53EF\u80FD\u5305\u542B\u4E2A\u4EBA\u6570\u636E\u3002",
    profile: "\u914D\u7F6E\u6587\u4EF6",
    settings: "\u8BBE\u7F6E",
    sessions: "\u4F1A\u8BDD",
    credentials: "\u51ED\u636E\uFF08\u672A\u52A0\u5BC6\uFF09",
    credentialWarning: "\u6211\u7406\u89E3\u5BFC\u51FA\u7684\u51ED\u636E\u548C\u6062\u590D\u526F\u672C\u5747\u672A\u52A0\u5BC6\u3002",
    export: "\u4E0B\u8F7D\u5907\u4EFD",
    file: "\u9009\u62E9 ZIP \u5907\u4EFD",
    preview: "\u9884\u89C8\u6062\u590D",
    apply: "\u5E94\u7528\u6B64\u6B21\u9884\u89C8",
    changes: "\u6062\u590D\u9884\u89C8",
    complete: "\u6062\u590D\u5B8C\u6210\u3002\u68C0\u67E5\u7ED3\u679C\u524D\u8BF7\u4FDD\u7559\u6062\u590D\u76EE\u5F55\u3002",
    partial: "\u6062\u590D\u672A\u5B8C\u6210\u3002\u8BF7\u5148\u68C0\u67E5\u9010\u9879\u7ED3\u679C\u548C\u6062\u590D\u76EE\u5F55\uFF0C\u518D\u8FDB\u884C\u5176\u4ED6\u64CD\u4F5C\u3002",
    restartRequired: "\u8BF7\u91CD\u542F\u5BBF\u4E3B\uFF0C\u4EE5\u91CD\u65B0\u52A0\u8F7D\u5DF2\u6062\u590D\u7684\u6587\u4EF6\u3002",
    failed: "\u64CD\u4F5C\u5931\u8D25",
    working: "\u6B63\u5728\u5904\u7406\u2026",
    unavailable: "\u6570\u636E\u7BA1\u7406\u670D\u52A1\u5F53\u524D\u4E0D\u53EF\u7528\u3002",
    review: "\u8BF7\u6838\u5BF9\u6587\u4EF6\u3001\u8BBE\u7F6E\u547D\u540D\u7A7A\u95F4\u548C\u8B66\u544A\u540E\u518D\u5E94\u7528\u3002\u914D\u7F6E\u6587\u4EF6\u53D8\u66F4\u9700\u8981\u91CD\u542F\u751F\u6548\u3002",
    result: "\u64CD\u4F5C\u7ED3\u679C",
    empty: "\u5C1A\u672A\u9009\u62E9\u5F52\u6863",
    tooLarge: "ZIP \u5907\u4EFD\u8D85\u8FC7 64 MiB\u3002",
    fileName: "\u6587\u4EF6",
    action: "\u53D8\u66F4",
    bytes: "\u5B57\u8282\u6570",
    namespace: "\u8BBE\u7F6E\u5206\u533A",
    recovery: "\u6062\u590D\u76EE\u5F55",
    written: "\u5DF2\u6062\u590D",
    failedItem: "\u5931\u8D25",
    skipped: "\u5DF2\u8DF3\u8FC7",
    create: "\u65B0\u5EFA",
    replace: "\u66FF\u6362",
    planExpiry: "\u6B64\u6B21\u9884\u89C8\u5931\u6548\u65F6\u95F4",
    settingsChanged: "\u5F85\u6062\u590D\u8BBE\u7F6E",
    noChanges: "\u672A\u9009\u62E9\u53D8\u66F4\u3002",
    warningPartial: "\u66FF\u6362\u524D\u4F1A\u4FDD\u5B58\u79C1\u6709\u6062\u590D\u526F\u672C\uFF1B\u6062\u590D\u53EF\u80FD\u53EA\u5B8C\u6210\u90E8\u5206\u5185\u5BB9\u3002",
    warningExecutable: "\u914D\u7F6E\u6587\u4EF6\u53EF\u4EE5\u5728\u91CD\u542F\u540E\u6267\u884C\u4EE3\u7801\u3002\u8BF7\u4EC5\u5BFC\u5165\u4FE1\u4EFB\u7684\u5907\u4EFD\u3002",
    warningCredentials: "\u6B64\u6B21\u5F52\u6863\u53CA\u5176\u6062\u590D\u526F\u672C\u5305\u542B\u672A\u7ECF\u52A0\u5BC6\u7684\u51ED\u636E\u3002",
    warningProfileSecrets: "\u8131\u654F\u914D\u7F6E\u503C\u4FDD\u7559\u76EE\u6807\u673A\u5668\u7684\u5F53\u524D\u503C\uFF1B\u542B\u8131\u654F\u503C\u7684\u6570\u7EC4\u6574\u4F53\u4FDD\u7559\u3002\u76EE\u6807\u7F3A\u5C11\u76F8\u5E94\u503C\u65F6\u65E0\u6CD5\u751F\u6210\u6B64\u6B21\u9884\u89C8\u3002",
    ...browserCopy.zh,
    ...remoteCopy.zh
  }
};
var inject = ["slots", "locale"];
async function responseOf(response) {
  const result = await response.json();
  if (!response.ok && result.complete === void 0) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
var request = (action, options) => fetch(API2 + action, { credentials: "same-origin", ...options }).then(responseOf);
function DataSection({ t }) {
  const [components, setComponents] = (0, import_react3.useState)(["profile", "settings"]);
  const [confirmed, setConfirmed] = (0, import_react3.useState)(false);
  const [file, setFile] = (0, import_react3.useState)(null);
  const [plan, setPlan] = (0, import_react3.useState)(null);
  const [result, setResult] = (0, import_react3.useState)(null);
  const [error, setError] = (0, import_react3.useState)(null);
  const [busy, setBusy] = (0, import_react3.useState)(false);
  const [remoteBusy, setRemoteBusy] = (0, import_react3.useState)(false);
  const [context, setContext] = (0, import_react3.useState)(null);
  const controller = (0, import_react3.useRef)(null);
  const mounted = (0, import_react3.useRef)(true);
  const download = (0, import_react3.useRef)(null);
  (0, import_react3.useEffect)(() => {
    const abort = new AbortController();
    mounted.current = true;
    void request("context", { signal: abort.signal }).then((value) => {
      if (!abort.signal.aborted) setContext(value);
    }).catch((failure) => {
      if (!abort.signal.aborted) setError(failure.message);
    });
    return () => {
      mounted.current = false;
      abort.abort();
      controller.current?.abort();
      if (download.current !== null) URL.revokeObjectURL(download.current);
    };
  }, []);
  const run = async (task) => {
    if (controller.current !== null || remoteBusy) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      await task(abort.signal);
    } catch (failure) {
      if (mounted.current && !abort.signal.aborted) setError(failure.message);
    } finally {
      controller.current = null;
      if (mounted.current) setBusy(false);
    }
  };
  const parameters = () => new URLSearchParams({ components: components.join(","), credentialsConfirmed: String(confirmed) }).toString();
  const disabled = busy || remoteBusy || context === null || components.length === 0 || components.includes("credentials") && !confirmed;
  const h2 = import_react3.default.createElement;
  const choose = (value) => {
    setPlan(null);
    setResult(null);
    setComponents(value);
  };
  return h2(
    "section",
    { className: "local-user-data", "aria-busy": busy },
    h2("header", { className: "local-user-data-head" }, h2("h2", null, t("nav")), h2("p", { className: "local-user-data-intro" }, t("intro"))),
    h2(
      "section",
      null,
      h2("h3", null, t("selection")),
      h2(
        "fieldset",
        { disabled: busy || remoteBusy },
        ...["profile", "settings", "sessions", "credentials"].map((component) => h2(
          "label",
          { key: component, className: "local-user-data-option" },
          h2("input", {
            type: "checkbox",
            checked: components.includes(component),
            disabled: context !== null && !context.components.includes(component),
            onChange: (event) => choose(event.target.checked ? [...components, component] : components.filter((value) => value !== component))
          }),
          " ",
          t(component)
        )),
        components.includes("credentials") ? h2(
          "label",
          { className: "local-user-data-option local-user-data-option-wide" },
          h2("input", { type: "checkbox", checked: confirmed, onChange: (event) => {
            setConfirmed(event.target.checked);
            setPlan(null);
          } }),
          " ",
          t("credentialWarning")
        ) : null
      )
    ),
    h2(
      "section",
      null,
      h2("h3", null, t("backup")),
      h2("p", { className: "local-user-data-actions" }, h2(import_dsh_client_ui_primitives3.Button, { disabled, onClick: () => void run(async (signal) => {
        const response = await fetch(API2 + "export?" + parameters(), { signal, credentials: "same-origin" });
        if (!response.ok) {
          await responseOf(response);
          return;
        }
        const blob = await response.blob();
        if (signal.aborted) return;
        if (download.current !== null) URL.revokeObjectURL(download.current);
        const url = URL.createObjectURL(blob);
        download.current = url;
        const link = document.createElement("a");
        link.href = url;
        link.download = "dsh-user-data-" + (/* @__PURE__ */ new Date()).toISOString().replaceAll(":", "-") + ".zip";
        document.body.append(link);
        link.click();
        link.remove();
      }) }, t("export")))
    ),
    h2(
      "section",
      null,
      h2("h3", null, t("restore")),
      h2("p", null, t("restoreIntro")),
      h2("label", { className: "local-user-data-file" }, t("file"), h2("input", {
        type: "file",
        accept: ".zip,application/zip",
        disabled: busy || remoteBusy,
        onChange: (event) => {
          setFile(event.target.files?.[0] ?? null);
          setPlan(null);
          setResult(null);
        }
      })),
      h2("p", null, h2(import_dsh_client_ui_primitives3.Button, { disabled: disabled || file === null, onClick: () => void run(async (signal) => {
        setPlan(null);
        if (file.size > 64 * 1024 * 1024) throw new Error(t("tooLarge"));
        const bytes = await file.arrayBuffer();
        if (signal.aborted) return;
        const value = await request("preview?" + parameters(), { method: "POST", body: bytes, signal, headers: { "content-type": "application/zip" } });
        if (!signal.aborted) setPlan(value);
      }) }, t("preview")))
    ),
    context === null && error === null ? h2("p", { role: "status" }, t("working")) : null,
    error === null ? null : h2("p", { role: "alert" }, t("failed") + ": " + error),
    plan === null ? null : h2(
      "section",
      { "aria-label": t("changes") },
      h2("h3", null, t("changes")),
      h2("p", null, t("review")),
      h2("ul", null, ...(plan.warningCodes ?? []).map((key) => h2("li", { key }, t(key)))),
      h2("p", null, t("planExpiry") + ": " + new Date(plan.expiresAt).toLocaleString()),
      plan.files.length === 0 ? null : h2(
        "div",
        { className: "local-user-data-scroll" },
        h2(
          "table",
          { className: "local-user-data-table" },
          h2("thead", null, h2("tr", null, ...["fileName", "action", "bytes"].map((key) => h2("th", { key, scope: "col" }, t(key))))),
          h2("tbody", null, ...plan.files.map((item) => h2("tr", { key: item.name }, h2("td", null, item.name), h2("td", null, t(item.action)), h2("td", null, item.bytes.toLocaleString()))))
        )
      ),
      plan.settings.length === 0 ? null : h2("div", null, h2("h4", null, t("settingsChanged")), h2("ul", null, ...plan.settings.map((item) => h2("li", { key: item.namespace }, item.namespace)))),
      h2(import_dsh_client_ui_primitives3.Button, { disabled, onClick: () => void run(async (signal) => {
        const id = plan.planId;
        setPlan(null);
        const value = await request("apply", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ planId: id }) });
        if (!signal.aborted) setResult(value);
      }) }, t("apply"))
    ),
    result === null ? null : h2(
      "section",
      { "aria-label": t("result") },
      h2("p", { role: "status" }, t(result.complete ? "complete" : "partial")),
      result.restartRequired ? h2("p", null, t("restartRequired")) : null,
      ...[result.files, result.settings].map((group, index) => h2(
        "div",
        { key: index },
        group.recovery ? h2("p", { className: "local-user-data-path" }, t("recovery") + ": " + group.recovery) : null,
        group.error ? h2("p", { role: "alert" }, group.error) : null,
        group.skipped ? h2("p", null, t("skipped")) : null,
        h2("ul", null, ...group.results.map((item, itemIndex) => h2(
          "li",
          { key: itemIndex },
          item.name ?? item.namespace,
          ": ",
          t(item.status === "written" ? "written" : "failedItem"),
          item.error ? ` \xB7 ${item.error}` : ""
        )))
      ))
    ),
    h2(BrowserPreferencesSection, { t }),
    h2(RemoteSection, {
      t,
      disabled: busy || context === null,
      parameters,
      onBusy: setRemoteBusy,
      onPreview: (value) => {
        setPlan(value);
        setResult(null);
        setError(null);
      }
    })
  );
}
function apply(ctx) {
  const locale = "local.userData";
  const t = ctx.locale.bind(locale);
  ctx.effect(() => {
    const element = document.createElement("style");
    element.textContent = client_default;
    document.head.append(element);
    return () => element.remove();
  });
  ctx.effect(() => ctx.locale.register(locale, copy));
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "local-user-data",
    order: 42,
    label: () => t("nav"),
    locale
  }, DataSection));
}
return module.exports; } });
