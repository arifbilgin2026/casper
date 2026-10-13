/* söyle — the server. One process, three jobs:
 *
 *   - serve the two static files the browser needs;
 *   - a tiny JSON auth API (signup / login / logout / me);
 *   - one authenticated websocket per session, owned by a Game.
 *
 *     python? no — see README. This is the TypeScript implementation; the
 *     original Python prototype lives in the git history.
 *
 *     npm start            →  http://localhost:8600
 */
import { readFileSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

import {
  checkPassword, clearCookie, cookieValue, hashPassword, makeSession,
  readSession, sessionCookie,
} from "./auth.js";
import { Game } from "./game.js";
import type { Card, Lang } from "./persona.js";
import { makeStore, User } from "./store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8600);
const NO_LLM = process.env.SOYLE_NO_LLM === "1";
const LANGS: Lang[] = ["tr", "ru", "en"];
const VOICES: Record<Lang, string> = {
  tr: "Et3hA9mm8aHhswBL5jmC",
  ru: "GN4wbsbejSnGSa1AzjH5",
  en: "21m00Tcm4TlvDq8ikWAM",
};

interface DeckFile {
  words: Card[];
  phrases: Record<"ask" | "yes" | "again", string[]>;
}
const DECKS = Object.fromEntries(LANGS.map((l) => [l, JSON.parse(
  readFileSync(path.join(HERE, "..", "decks", `words_${l}.json`), "utf8"),
) as DeckFile])) as Record<Lang, DeckFile>;

const store = makeStore();

// ── the little JSON API ───────────────────────────────────────────────────

function body(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((ok) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 4096) req.destroy(); });
    req.on("end", () => { try { ok(JSON.parse(data)); } catch { ok({}); } });
  });
}

function json(res: ServerResponse, code: number, obj: unknown, cookie?: string): void {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers["set-cookie"] = cookie;
  res.writeHead(code, headers);
  res.end(JSON.stringify(obj));
}

async function me(req: IncomingMessage): Promise<User | null> {
  const email = readSession(cookieValue(req.headers.cookie, "sid"));
  return email ? store.get(email) : null;
}

const STATIC: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "application/javascript; charset=utf-8"],
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (url.pathname === "/health") { res.writeHead(200); res.end("ok\n"); return; }

    const fileEntry = STATIC[url.pathname];
    if (fileEntry && req.method === "GET") {
      const [file, type] = fileEntry;
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(readFileSync(path.join(HERE, "..", "web", file)));
      return;
    }

    if (url.pathname === "/api/signup" && req.method === "POST") {
      const b = await body(req);
      const email = (b.email ?? "").trim().toLowerCase();
      const lang = LANGS.includes(b.lang as Lang) ? (b.lang as Lang) : "tr";
      if (!/^\S+@\S+\.\S+$/.test(email)) return json(res, 400, { error: "bad email" });
      if ((b.password ?? "").length < 6) return json(res, 400, { error: "password too short" });
      const user: User = {
        email, pw: hashPassword(b.password!), childName: (b.childName ?? "").trim() || "kiddo",
        lang, stars: 0, mastered: [], createdAt: new Date().toISOString(),
      };
      if (!await store.create(user)) return json(res, 409, { error: "account exists" });
      return json(res, 200, publicUser(user), sessionCookie(makeSession(email)));
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      const b = await body(req);
      const email = (b.email ?? "").trim().toLowerCase();
      const user = await store.get(email);
      if (!user || !checkPassword(b.password ?? "", user.pw)) {
        return json(res, 401, { error: "wrong email or password" });
      }
      return json(res, 200, publicUser(user), sessionCookie(makeSession(email)));
    }

    if (url.pathname === "/api/logout" && req.method === "POST") {
      return json(res, 200, {}, clearCookie());
    }

    if (url.pathname === "/api/me" && req.method === "GET") {
      const user = await me(req);
      return user ? json(res, 200, publicUser(user)) : json(res, 401, { error: "not signed in" });
    }

    if (url.pathname === "/api/lang" && req.method === "POST") {
      const user = await me(req);
      if (!user) return json(res, 401, { error: "not signed in" });
      const b = await body(req);
      if (!LANGS.includes(b.lang as Lang)) return json(res, 400, { error: "bad lang" });
      await store.setLang(user.email, b.lang as Lang);
      return json(res, 200, { ...publicUser(user), lang: b.lang });
    }

    res.writeHead(404); res.end();
  } catch (e) {
    console.log("http error:", e);
    if (!res.headersSent) json(res, 500, { error: "server error" });
  }
});

function publicUser(u: User) {
  return { email: u.email, childName: u.childName, lang: u.lang,
           stars: u.stars, mastered: u.mastered.length };
}

// ── the game socket: one per child, refused without a session ────────────

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", async (req, socket, head) => {
  const email = readSession(cookieValue(req.headers.cookie, "sid"));
  const user = email ? await store.get(email) : null;
  if (!user) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => { void session(ws, req, user); });
});

async function session(ws: WebSocket, req: IncomingMessage, user: User): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const lang = (LANGS.includes(url.searchParams.get("lang") as Lang)
    ? url.searchParams.get("lang") : user.lang) as Lang;
  const deck = DECKS[lang];
  const game = new Game(lang, deck.words, deck.phrases, VOICES[lang], {
    sendJson: (o) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); },
    sendPcm: (b) => { if (ws.readyState === WebSocket.OPEN) ws.send(b); },
    onStar: (word) => { void store.addStar(user.email, word); },
    log: (line) => console.log(`[${user.email}] ${line}`),
  }, { noLlm: NO_LLM, startScore: user.stars });

  try {
    await game.start();
  } catch (e) {
    console.log("session start failed:", e);
    ws.close(1011, "voice backend unavailable");
    return;
  }
  ws.on("message", (data, isBinary) => {
    if (isBinary) game.feed(Buffer.from(data as Buffer));
    else if (String(data) === "next") game.next();
  });
  ws.on("close", () => game.close());
}

server.listen(PORT, () => {
  console.log(`söyle → http://localhost:${PORT}           (profile language)`);
  console.log(`       → /?lang=tr | /?lang=ru | /?lang=en  (override)`);
  if (NO_LLM) console.log("       model disabled (SOYLE_NO_LLM=1): canned lines only");
});
