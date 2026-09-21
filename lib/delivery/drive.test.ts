/**
 * Drive delivery, against a fake Google.
 * Run: npx tsx lib/delivery/drive.test.ts
 *
 * No network and no credentials: `fetch` is replaced with a small in-memory
 * Drive that records every request. What is asserted is what cannot be checked
 * without a real key — that the token request is a correctly signed JWT, that
 * every Drive call carries the shared-drive flags (miss one and a shared drive
 * answers "not found" instead of failing), that an existing "videos" folder is
 * found rather than duplicated, and that a re-upload replaces a file's bytes in
 * place through a chunked resumable session.
 */
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DriveNotConfiguredError,
  driveConfigured,
  isDriveLink,
  parseServiceAccount,
  q,
  resetDriveCache,
  resolveSubfolder,
  subfolderAliases,
  upsertFile,
} from "./drive";

let passed = 0;
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  passed++;
}

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA = {
  type: "service_account",
  client_email: "cape-render@example.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  token_uri: "https://oauth2.googleapis.com/token",
};
const CAPE = "capeFolder123";
const SHARED_DRIVE = "sharedDrive0";
const FOLDER = "application/vnd.google-apps.folder";

// ---------------------------------------------------------------------------
// A fake Drive
// ---------------------------------------------------------------------------

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  bytes: Buffer;
  modifiedTime: string;
}

interface Logged {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Buffer;
}

let files: FakeFile[] = [];
let log: Logged[] = [];
let sessions = new Map<string, { fileId: string | null; meta: Record<string, unknown>; total: number; got: Buffer[] }>();
let nextId = 1;
/** When set, the next upload chunk fails with a 503 — the resume path. */
let failNextChunk = false;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => (out[k] = v));
  return out;
}

function parentsFrom(query: string): string | null {
  return /'([^']+)' in parents/.exec(query)?.[1] ?? null;
}

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  const body = init?.body ? Buffer.from(init.body as Uint8Array | string) : Buffer.alloc(0);
  const headers = headersOf(init);
  log.push({ method, url, headers, body });

  // --- token ---
  if (url.href === SA.token_uri) {
    const form = new URLSearchParams(body.toString());
    if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") return json({ error: "bad grant" }, 400);
    const [h, c, s] = (form.get("assertion") ?? "").split(".");
    const ok = createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url"));
    if (!ok) return json({ error: "invalid_grant", error_description: "bad signature" }, 400);
    return json({ access_token: "tok-1", expires_in: 3600 });
  }

  if (headers.authorization !== "Bearer tok-1" && !url.pathname.startsWith("/session/")) {
    return json({ error: "unauthenticated" }, 401);
  }

  // --- resumable session bytes ---
  if (url.pathname.startsWith("/session/")) {
    const sess = sessions.get(url.pathname.slice("/session/".length));
    if (!sess) return json({ error: "gone" }, 404);
    const received = sess.got.reduce((n, b) => n + b.length, 0);
    const range = headers["content-range"] ?? "";
    if (range.startsWith("bytes */")) {
      return new Response(null, { status: 308, headers: received ? { range: `bytes=0-${received - 1}` } : {} });
    }
    if (failNextChunk) {
      failNextChunk = false;
      return new Response("backend error", { status: 503 });
    }
    const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
    if (!m || Number(m[1]) !== received) return new Response(`bad range ${range} at ${received}`, { status: 400 });
    sess.got.push(body);
    const now = received + body.length;
    if (now < sess.total) return new Response(null, { status: 308, headers: { range: `bytes=0-${now - 1}` } });

    const bytes = Buffer.concat(sess.got);
    let file: FakeFile;
    if (sess.fileId) {
      file = files.find((f) => f.id === sess.fileId)!;
      file.bytes = bytes;
      file.modifiedTime = new Date().toISOString();
    } else {
      file = {
        id: `f${nextId++}`,
        name: String(sess.meta.name),
        mimeType: String(sess.meta.mimeType),
        parents: sess.meta.parents as string[],
        bytes,
        modifiedTime: new Date().toISOString(),
      };
      files.push(file);
    }
    return json({ id: file.id, name: file.name, webViewLink: `https://drive.google.com/file/d/${file.id}/view` }, sess.fileId ? 200 : 201);
  }

  // Every real Drive call must opt into shared drives.
  if (url.searchParams.get("supportsAllDrives") !== "true") return json({ error: "not found" }, 404);

  // --- upload session open ---
  if (url.pathname.startsWith("/upload/drive/v3/files")) {
    const fileId = url.pathname.split("/")[5] ?? null;
    const sid = `s${nextId++}`;
    sessions.set(sid, {
      fileId,
      meta: JSON.parse(body.toString() || "{}"),
      total: Number(headers["x-upload-content-length"]),
      got: [],
    });
    return new Response(null, { status: 200, headers: { location: `https://www.googleapis.com/session/${sid}` } });
  }

  // --- metadata ---
  if (url.pathname === `/drive/v3/files/${CAPE}` && method === "GET") {
    return json({ id: CAPE, name: "CAPE", mimeType: FOLDER, driveId: SHARED_DRIVE });
  }
  if (url.pathname === "/drive/v3/files" && method === "GET") {
    const query = url.searchParams.get("q") ?? "";
    if (url.searchParams.get("includeItemsFromAllDrives") !== "true") return json({ files: [] });
    if (url.searchParams.get("corpora") !== "drive" || url.searchParams.get("driveId") !== SHARED_DRIVE) return json({ files: [] });
    const parent = parentsFrom(query);
    let hits = files.filter((f) => parent && f.parents.includes(parent));
    if (query.includes(`mimeType = '${FOLDER}'`)) hits = hits.filter((f) => f.mimeType === FOLDER);
    if (query.includes(`mimeType != '${FOLDER}'`)) hits = hits.filter((f) => f.mimeType !== FOLDER);
    const name = /name = '((?:[^'\\]|\\.)*)'/.exec(query)?.[1]?.replace(/\\(.)/g, "$1");
    if (name) hits = hits.filter((f) => f.name === name);
    return json({ files: hits.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime })) });
  }
  if (url.pathname === "/drive/v3/files" && method === "POST") {
    const meta = JSON.parse(body.toString()) as { name: string; mimeType: string; parents: string[] };
    const file: FakeFile = { id: `d${nextId++}`, name: meta.name, mimeType: meta.mimeType, parents: meta.parents, bytes: Buffer.alloc(0), modifiedTime: "" };
    files.push(file);
    return json({ id: file.id, name: file.name });
  }

  return json({ error: `unhandled ${method} ${url.pathname}` }, 500);
}

function reset(seed: FakeFile[] = []) {
  files = seed;
  log = [];
  sessions = new Map();
  failNextChunk = false;
  resetDriveCache();
}

globalThis.fetch = fakeFetch as typeof fetch;

async function main() {
  // --- configuration --------------------------------------------------------
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_DRIVE_CAPE_FOLDER_ID;
  assert(!driveConfigured(), "unconfigured without env");
  try {
    await resolveSubfolder("Video");
    assert(false, "should have thrown when unconfigured");
  } catch (e) {
    assert(e instanceof DriveNotConfiguredError, "throws DriveNotConfiguredError");
    assert(/Drive delivery not configured/.test((e as Error).message), "message says not configured");
    assert(/GOOGLE_SERVICE_ACCOUNT_JSON/.test((e as Error).message), "message names the variable");
  }

  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify(SA);
  process.env.GOOGLE_DRIVE_CAPE_FOLDER_ID = CAPE;
  assert(driveConfigured(), "configured with both env vars");

  // Key tolerance: base64 of the JSON, and double-escaped newlines.
  const b64 = parseServiceAccount(Buffer.from(JSON.stringify(SA)).toString("base64"));
  assert(b64.client_email === SA.client_email, "base64-encoded key parses");
  const escaped = parseServiceAccount(JSON.stringify({ ...SA, private_key: SA.private_key.replace(/\n/g, "\\n") }));
  assert(escaped.private_key === SA.private_key, "double-escaped newlines are repaired");

  assert(q("Prince George's") === "'Prince George\\'s'", "query literal escapes a quote");
  assert(subfolderAliases("Video").join() === "video,videos", "Video aliases");
  assert(subfolderAliases("Frameworks").join() === "framework,frameworks", "plural input aliases");
  assert(isDriveLink("https://drive.google.com/file/d/x/view"), "drive link recognised");
  assert(!isDriveLink("https://abc.public.blob.vercel-storage.com/cape/x.mp4"), "blob URL is not a drive link");

  // --- existing folder under a different case and plural --------------------
  reset([{ id: "vid1", name: "videos", mimeType: FOLDER, parents: [CAPE], bytes: Buffer.alloc(0), modifiedTime: "" }]);
  const video = await resolveSubfolder("Video");
  assert(video === "vid1", `finds existing 'videos' folder case-insensitively (got ${video})`);
  assert(!log.some((l) => l.method === "POST" && l.url.pathname === "/drive/v3/files"), "did not create a duplicate folder");
  const tokenCall = log.find((l) => l.url.href === SA.token_uri);
  assert(tokenCall, "requested a token");
  const claims = JSON.parse(
    Buffer.from(new URLSearchParams(tokenCall.body.toString()).get("assertion")!.split(".")[1], "base64url").toString(),
  );
  assert(claims.iss === SA.client_email, "JWT iss is the service account");
  assert(claims.scope === "https://www.googleapis.com/auth/drive", "JWT asks for the drive scope");
  assert(claims.aud === SA.token_uri && claims.exp - claims.iat === 3600, "JWT aud and lifetime");
  for (const l of log.filter((x) => x.url.host === "www.googleapis.com")) {
    assert(l.url.searchParams.get("supportsAllDrives") === "true", `supportsAllDrives on ${l.method} ${l.url.pathname}`);
  }
  const listing = log.find((l) => l.method === "GET" && l.url.pathname === "/drive/v3/files")!;
  assert(listing.url.searchParams.get("includeItemsFromAllDrives") === "true", "list includes shared drives");
  assert(listing.url.searchParams.get("driveId") === SHARED_DRIVE, "list scoped to the CAPE folder's shared drive");

  // Cached for the process: a second resolve makes no Drive calls.
  const before = log.length;
  await resolveSubfolder("video");
  assert(log.length === before, "folder id cached");

  // --- missing folder is created with the exact name ------------------------
  reset();
  const fw = await resolveSubfolder("Framework");
  const created = files.find((f) => f.id === fw);
  assert(created?.name === "Framework" && created.mimeType === FOLDER, "creates 'Framework' when absent");
  assert(created.parents[0] === CAPE, "created under the CAPE folder");

  // --- new file: chunked resumable upload, with one 503 mid-way -------------
  reset();
  const dir = mkdtempSync(path.join(os.tmpdir(), "drive-test-"));
  const mp4 = path.join(dir, "Fulton_County_GA_2026-10-06.mp4");
  const bytes = Buffer.alloc(700 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  writeFileSync(mp4, bytes);

  failNextChunk = false;
  const first = await upsertFile("Video", "Fulton_County_GA_2026-10-06.mp4", { path: mp4 }, "video/mp4", { chunkBytes: 256 * 1024 });
  assert(first.created, "first upload creates the file");
  assert(first.webViewLink === `https://drive.google.com/file/d/${first.id}/view`, "returns webViewLink");
  const stored = files.find((f) => f.id === first.id)!;
  assert(stored.bytes.equals(bytes), "uploaded bytes are intact");
  assert(stored.parents[0] === files.find((f) => f.name === "Video")!.id, "file lands in the Video subfolder");
  const open = log.find((l) => l.url.pathname === "/upload/drive/v3/files")!;
  assert(open.method === "POST" && open.url.searchParams.get("uploadType") === "resumable", "opens a resumable session with POST");
  assert(open.headers["x-upload-content-length"] === String(bytes.length), "declares the total length");
  const ranges = log.filter((l) => l.url.pathname.startsWith("/session/")).map((l) => l.headers["content-range"]);
  assert(
    ranges.join() === "bytes 0-262143/716800,bytes 262144-524287/716800,bytes 524288-716799/716800",
    `chunks in 256 KiB quanta (got ${ranges.join()})`,
  );

  // --- same name again: replace in place, surviving a 503 -------------------
  log = [];
  const v2 = Buffer.from(bytes.map((b) => 255 - b));
  failNextChunk = true;
  const second = await upsertFile("Video", "Fulton_County_GA_2026-10-06.mp4", v2, "video/mp4", { chunkBytes: 256 * 1024 });
  assert(!second.created && second.id === first.id, "second upload updates the same file id");
  assert(files.filter((f) => f.name === "Fulton_County_GA_2026-10-06.mp4").length === 1, "no duplicate file");
  assert(files.find((f) => f.id === first.id)!.bytes.equals(v2), "content replaced after a 503 and a resume");
  const patch = log.find((l) => l.url.pathname === `/upload/drive/v3/files/${first.id}`)!;
  assert(patch.method === "PATCH", "update opens its session with PATCH on the file id");
  assert(log.some((l) => l.headers["content-range"] === `bytes */${v2.length}`), "asked the session where it got to after the 503");

  console.log(`drive.test: ${passed} assertions passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
