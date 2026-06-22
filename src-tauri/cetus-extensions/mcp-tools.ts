/**
 * cetus mcp-tools — lets the agent manage the user's MCP servers from inside a
 * normal conversation. The store write happens in Rust through the hidden
 * "__cetus_mcp__" host tunnel; Settings → MCP reloads when the host emits
 * mcp_updated.
 */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { callHost, HOST_TUNNELS, toolResult, type HostTunnelContext } from "./bridge/protocol";

interface HostReply {
  ok: boolean;
  error?: string;
  note?: string;
  mcpServer?: unknown;
  mcpServers?: unknown[];
  deleted?: string;
}

function hostCall(exCtx: HostTunnelContext, payload: unknown): Promise<HostReply> {
  return callHost(exCtx, HOST_TUNNELS.mcp, payload);
}

const serverFields = {
  name: Type.Optional(Type.String({ description: "Human-visible MCP server name, e.g. GitHub, Gmail, Filesystem." })),
  transport: Type.Optional(Type.String({ description: "Transport: 'stdio' for a local command or 'http' for a remote MCP endpoint." })),
  command: Type.Optional(Type.String({ description: "For stdio: executable name/path, e.g. npx, node, uvx." })),
  args: Type.Optional(Type.Array(Type.String(), { description: "For stdio: command arguments, one array item per argv entry." })),
  env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "For stdio: environment variables." })),
  url: Type.Optional(Type.String({ description: "For http: MCP endpoint URL, e.g. https://example.com/mcp." })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "For http: request headers." })),
  auth: Type.Optional(Type.String({ description: "For http: pass 'oauth' to let Cetus/mcporter handle OAuth; omit/empty for static headers or no auth." })),
  oauthClientId: Type.Optional(Type.String({ description: "Optional OAuth client id. Most MCP servers support dynamic registration, so omit unless required." })),
  oauthScope: Type.Optional(Type.String({ description: "Optional OAuth scope string." })),
  enabled: Type.Optional(Type.Boolean({ description: "Whether this MCP server is enabled. Defaults to true on create." })),
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "manage_mcp",
    label: "Manage MCP",
    description:
      "Create, list, update, enable/disable, or delete the user's MCP servers " +
      "in Cetus Settings → MCP. Use this when the user asks to add/configure/" +
      "remove MCP, or when a task requires a new MCP server. Changes are saved " +
      "to Cetus's MCP source store, exported to mcp.json, and immediately show " +
      "in Settings → MCP. Existing conversations keep their frozen MCP tool set; " +
      "newly added tools load in the next conversation.\n" +
      "- op 'list': returns MCP server ids and config.\n" +
      "- op 'create': needs name, transport, and either command/args (stdio) or url (http).\n" +
      "- op 'update': pass id plus only fields to change.\n" +
      "- op 'set_enabled': pass id and enabled.\n" +
      "- op 'delete': pass id.",
    promptSnippet:
      "Manage the user's MCP servers with manage_mcp (op create/list/update/set_enabled/delete) instead of editing mcp.json by hand.",
    parameters: Type.Object({
      op: Type.String({ description: "One of: 'create', 'list', 'update', 'set_enabled', 'delete'." }),
      id: Type.Optional(Type.String({ description: "MCP server id (from op 'list'); required for update/set_enabled/delete." })),
      ...serverFields,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, exCtx) {
      return toolResult(await hostCall(exCtx as HostTunnelContext, params));
    },
  });
}
