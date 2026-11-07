// Cetus Remote relay.
//
// A Mac connects as the *server* of a room (one Durable Object per server id)
// and phones connect as *clients*. The relay only shuttles bytes: everything a
// phone and the Mac say to each other is a Noise_NK session negotiated end to
// end (see backend/src/remote_secure.rs), so the relay never sees plaintext and
// can't impersonate the Mac — the phone pins the Mac's static key from the QR.
//
// Wire format between relay and the Mac (binary frames):
//   [kind:u8][client id:16 bytes][payload…]
//   kind 1 = client opened, 2 = data, 3 = client closed
// Clients just exchange raw binary payloads.

interface Env {
  ROOM: DurableObjectNamespace;
}

const OPEN = 1;
const DATA = 2;
const CLOSE = 3;
const CID_LEN = 16;
const MAX_FRAME = 1 << 20;
/** Close code a client sees when its Mac isn't connected. */
const MAC_OFFLINE = 4404;
const BAD_KEY = 4403;

const SID_RE = /^[0-9a-f]{32}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("cetus relay ok\n", {
        headers: { "content-type": "text/plain" },
      });
    }
    const role =
      url.pathname === "/v1/server"
        ? "server"
        : url.pathname === "/v1/client"
          ? "client"
          : null;
    if (!role) return new Response("not found", { status: 404 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const sid = url.searchParams.get("sid") ?? "";
    if (!SID_RE.test(sid)) return new Response("bad sid", { status: 400 });
    const stub = env.ROOM.get(env.ROOM.idFromName(sid));
    return stub.fetch(request);
  },
};

type Attachment = { role: "server" } | { role: "client"; cid: string };

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return hex(new Uint8Array(d));
}

function frame(kind: number, cid: string, payload?: ArrayBuffer | Uint8Array): Uint8Array {
  const body = payload ? new Uint8Array(payload) : new Uint8Array(0);
  const out = new Uint8Array(1 + CID_LEN + body.length);
  out[0] = kind;
  out.set(unhex(cid), 1);
  out.set(body, 1 + CID_LEN);
  return out;
}

function toBytes(msg: string | ArrayBuffer): Uint8Array {
  return typeof msg === "string" ? new TextEncoder().encode(msg) : new Uint8Array(msg);
}

export class Room implements DurableObject {
  constructor(
    private state: DurableObjectState,
    _env: Env,
  ) {}

  /** The live Mac socket. A replaced one lingers in the list while closing. */
  private server(except?: WebSocket): WebSocket | undefined {
    return this.state
      .getWebSockets("server")
      .filter((s) => s !== except && s.readyState === WebSocket.OPEN)
      .at(-1);
  }

  private client(cid: string): WebSocket | undefined {
    return this.state.getWebSockets(`c:${cid}`)[0];
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [outer, inner] = [pair[0], pair[1]];

    if (url.pathname === "/v1/server") {
      // The first Mac to claim a room fixes its key (trust on first use). A
      // stranger can't take over a claimed room, and even an unclaimed one
      // gets nothing: phones verify the Mac's Noise static key end to end.
      const key = url.searchParams.get("key") ?? "";
      if (key.length < 32) return new Response("bad key", { status: 400 });
      const keyHash = await sha256Hex(key);
      const stored = await this.state.storage.get<string>("keyHash");
      if (stored && stored !== keyHash) {
        this.state.acceptWebSocket(inner, ["rejected"]);
        inner.close(BAD_KEY, "room claimed by another key");
        return new Response(null, { status: 101, webSocket: outer });
      }
      if (!stored) await this.state.storage.put("keyHash", keyHash);
      // One Mac per room: a reconnect replaces the stale socket.
      for (const old of this.state.getWebSockets("server")) {
        try {
          old.close(1012, "replaced");
        } catch {}
      }
      this.state.acceptWebSocket(inner, ["server"]);
      inner.serializeAttachment({ role: "server" } satisfies Attachment);
      // Clients that were waiting on the old socket are gone from its view;
      // drop them so they reconnect and re-handshake.
      for (const ws of this.state.getWebSockets()) {
        const a = ws.deserializeAttachment() as Attachment | null;
        if (a?.role === "client") {
          try {
            ws.close(1012, "mac reconnected");
          } catch {}
        }
      }
      return new Response(null, { status: 101, webSocket: outer });
    }

    // Client.
    const server = this.server();
    const cid = hex(crypto.getRandomValues(new Uint8Array(CID_LEN)));
    this.state.acceptWebSocket(inner, ["client", `c:${cid}`]);
    inner.serializeAttachment({ role: "client", cid } satisfies Attachment);
    if (!server) {
      inner.close(MAC_OFFLINE, "mac offline");
    } else {
      server.send(frame(OPEN, cid));
    }
    return new Response(null, { status: 101, webSocket: outer });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a) return;
    const bytes = toBytes(message);
    if (bytes.length > MAX_FRAME) {
      ws.close(1009, "frame too large");
      return;
    }
    if (a.role === "client") {
      const server = this.server();
      if (!server) {
        ws.close(MAC_OFFLINE, "mac offline");
        return;
      }
      server.send(frame(DATA, a.cid, bytes));
      return;
    }
    // From the Mac: route by client id.
    if (bytes.length < 1 + CID_LEN) return;
    const kind = bytes[0];
    const cid = hex(bytes.subarray(1, 1 + CID_LEN));
    const client = this.client(cid);
    if (!client) {
      if (kind === DATA) ws.send(frame(CLOSE, cid));
      return;
    }
    if (kind === DATA) client.send(bytes.subarray(1 + CID_LEN));
    else if (kind === CLOSE) client.close(1000, "closed by mac");
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.closed(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {}
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.closed(ws);
  }

  private closed(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a) return;
    if (a.role === "client") {
      this.server()?.send(frame(CLOSE, a.cid));
    } else if (a.role === "server" && !this.server(ws)) {
      // Mac gone: tell every phone so it can show "Mac offline" and retry.
      for (const c of this.state.getWebSockets("client")) {
        try {
          c.close(MAC_OFFLINE, "mac offline");
        } catch {}
      }
    }
  }
}
