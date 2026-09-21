/*
 * No `server-only` guard — the producer CLI delivers from a laptop with this as
 * well as the render cron, and the frameworks will reuse it.
 */
import { createSign } from "node:crypto";
import { open, stat } from "node:fs/promises";

/**
 * Deliver files into the team's CAPE folder on Google Drive.
 *
 * ## Why a service account, and why not `googleapis`
 *
 * The cron has no person to click "allow", so it authenticates as a service
 * account: a JSON key in `GOOGLE_SERVICE_ACCOUNT_JSON`, exchanged for an access
 * token by signing a JWT (RFC 7523) with the key's own private key. That is one
 * `createSign` call and one POST, and it is all the auth this needs. The
 * official `googleapis` client is tens of megabytes of generated code for
 * hundreds of APIs, and it would ride in the same function bundle as a static
 * ffmpeg under a 250 MB ceiling.
 *
 * ## Why every call says `supportsAllDrives`
 *
 * The destination is a shared drive ("Tax Deed Collective - The Boys"), and the
 * Drive API treats shared-drive items as invisible unless each request opts in.
 * A request that forgets does not fail — it answers "not found", or lists an
 * empty folder, and the code goes on to create a duplicate of something that
 * already exists. So the flags are added by the one function every request goes
 * through rather than remembered per call.
 *
 * ## Setup
 *
 *  - `GOOGLE_SERVICE_ACCOUNT_JSON`: the whole key file, as JSON (or base64 of it).
 *  - `GOOGLE_DRIVE_CAPE_FOLDER_ID`: the CAPE folder's id, from its URL.
 *  - Add the service account's `client_email` to the shared drive (or to the
 *    CAPE folder) as a Content manager. Without that it can see nothing.
 *
 * ## Why replace rather than add
 *
 * A re-cut of Fulton's briefing should be the same file with new content, so a
 * link already sent to someone keeps working and the folder does not fill with
 * `Fulton_County_GA_2026-10-06 (3).mp4`. `upsertFile` looks for a same-named
 * file in the subfolder and updates its bytes in place (keeping its id and
 * link), and only creates one when there is none.
 */

const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** Full Drive scope: `drive.file` cannot see folders and files a person made. */
const SCOPE = "https://www.googleapis.com/auth/drive";

/**
 * Upload chunk size. Drive requires a multiple of 256 KiB for every chunk but
 * the last; 8 MiB puts a 25 MB briefing across four requests, so a dropped
 * connection costs one chunk rather than the whole file.
 */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
const CHUNK_QUANTUM = 256 * 1024;

export class DriveNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(`Drive delivery not configured — set ${missing.join(" and ")}`);
    this.name = "DriveNotConfiguredError";
  }
}

export class DriveError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DriveError";
  }
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function missingEnv(): string[] {
  const missing: string[] = [];
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim()) missing.push("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!process.env.GOOGLE_DRIVE_CAPE_FOLDER_ID?.trim()) missing.push("GOOGLE_DRIVE_CAPE_FOLDER_ID");
  return missing;
}

/** Both variables present. Says nothing about whether the key works. */
export function driveConfigured(): boolean {
  return missingEnv().length === 0;
}

function assertConfigured(): void {
  const missing = missingEnv();
  if (missing.length) throw new DriveNotConfiguredError(missing);
}

/**
 * Parse the key, tolerating the two ways it gets mangled on its way into an
 * environment variable: base64-encoded to dodge quoting, or with the private
 * key's newlines double-escaped so they arrive as a literal backslash-n.
 */
export function parseServiceAccount(raw: string): ServiceAccount {
  const text = raw.trim().startsWith("{") ? raw.trim() : Buffer.from(raw.trim(), "base64").toString("utf8");
  let json: Partial<ServiceAccount>;
  try {
    json = JSON.parse(text) as Partial<ServiceAccount>;
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (or base64 of JSON)");
  }
  if (!json.client_email || !json.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON has no client_email/private_key — is it a service-account key?");
  }
  return {
    client_email: json.client_email,
    private_key: json.private_key.includes("\\n") ? json.private_key.replace(/\\n/g, "\n") : json.private_key,
    token_uri: json.token_uri,
  };
}

function account(): ServiceAccount {
  assertConfigured();
  return parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
}

/** The address to share the CAPE folder with, for error messages and setup. */
export function driveServiceAccountEmail(): string | null {
  try {
    return account().client_email;
  } catch {
    return null;
  }
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/** The signed assertion exchanged for an access token. Exported for the test. */
export function signJwt(sa: ServiceAccount, nowSec: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: sa.token_uri ?? "https://oauth2.googleapis.com/token",
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(sa.private_key, "base64url");
  return `${header}.${claims}.${signature}`;
}

let token: { value: string; expiresAt: number } | null = null;
let root: { id: string; driveId: string | null } | null = null;
const folders = new Map<string, string>();

/** Forget cached tokens and folder ids. For tests, and after an env change. */
export function resetDriveCache(): void {
  token = null;
  root = null;
  folders.clear();
}

async function accessToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  const sa = account();
  const res = await fetch(sa.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signJwt(sa, Math.floor(Date.now() / 1000)),
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !body.access_token) {
    throw new DriveError(
      res.status,
      `Google refused the service account token (${res.status}): ${body.error_description ?? body.error ?? "no detail"}`,
    );
  }
  token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return token.value;
}

/** Every Drive URL goes through here, so the shared-drive flags cannot be forgotten. */
function driveUrl(base: string, params: Record<string, string> = {}): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("supportsAllDrives", "true");
  return u.toString();
}

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${await accessToken()}`, ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new DriveError(res.status, `Drive ${init.method ?? "GET"} ${new URL(url).pathname} → ${res.status}: ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** Drive query literal: backslash and single quote are escaped with a backslash. */
export function q(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  webViewLink?: string;
  modifiedTime?: string;
  driveId?: string;
}

/** The CAPE folder, and which shared drive it sits in. Checked once per process. */
async function capeRoot(): Promise<{ id: string; driveId: string | null }> {
  if (root) return root;
  assertConfigured();
  const id = process.env.GOOGLE_DRIVE_CAPE_FOLDER_ID!.trim();
  let meta: DriveFile;
  try {
    meta = await call<DriveFile>(driveUrl(`${DRIVE}/files/${encodeURIComponent(id)}`, { fields: "id,name,mimeType,driveId" }));
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) {
      throw new DriveError(
        404,
        `The service account ${driveServiceAccountEmail() ?? "(unknown)"} cannot see the CAPE folder ${id}. ` +
          `Add it to the shared drive, or share the folder with it, as a Content manager.`,
      );
    }
    throw e;
  }
  if (meta.mimeType && meta.mimeType !== FOLDER_MIME) {
    throw new DriveError(400, `GOOGLE_DRIVE_CAPE_FOLDER_ID ${id} is a ${meta.mimeType}, not a folder`);
  }
  root = { id: meta.id, driveId: meta.driveId ?? null };
  return root;
}

/** List params: search the shared drive the CAPE folder is in, not the account's own. */
function listParams(r: { driveId: string | null }, query: string, fields: string): Record<string, string> {
  return {
    q: query,
    fields: `nextPageToken,files(${fields})`,
    pageSize: "1000",
    includeItemsFromAllDrives: "true",
    ...(r.driveId ? { corpora: "drive", driveId: r.driveId } : { corpora: "user" }),
  };
}

async function list(query: string, fields = "id,name,mimeType,webViewLink,modifiedTime"): Promise<DriveFile[]> {
  const r = await capeRoot();
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = listParams(r, query, fields);
    if (pageToken) params.pageToken = pageToken;
    const page = await call<{ files?: DriveFile[]; nextPageToken?: string }>(driveUrl(`${DRIVE}/files`, params));
    out.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/**
 * The names a subfolder may already go by.
 *
 * The folder was made by hand, so "Video" might be "Videos", "video" or "VIDEOS"
 * — and creating a second folder beside one that exists under a slightly
 * different name is exactly the mess this is meant to avoid.
 */
export function subfolderAliases(name: string): string[] {
  const base = name.trim().replace(/s$/i, "").toLowerCase();
  return [base, `${base}s`];
}

/**
 * Resolve a subfolder of CAPE by name, creating it when absent.
 *
 * Matched case-insensitively against singular and plural; created with the
 * exact name given ("Video", "Framework") when nothing matches.
 */
export async function resolveSubfolder(name: string): Promise<string> {
  const r = await capeRoot();
  const key = `${r.id}/${name.toLowerCase()}`;
  const cached = folders.get(key);
  if (cached) return cached;

  const aliases = subfolderAliases(name);
  const children = await list(`${q(r.id)} in parents and mimeType = ${q(FOLDER_MIME)} and trashed = false`, "id,name");
  const hit = aliases
    .map((a) => children.find((c) => c.name.trim().toLowerCase() === a))
    .find((c): c is DriveFile => Boolean(c));

  const id =
    hit?.id ??
    (
      await call<DriveFile>(driveUrl(`${DRIVE}/files`, { fields: "id,name" }), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [r.id] }),
      })
    ).id;

  folders.set(key, id);
  return id;
}

export type UploadSource = Buffer | Uint8Array | { path: string };

export interface UpsertResult {
  id: string;
  name: string;
  webViewLink: string;
  /** False when an existing same-named file had its content replaced. */
  created: boolean;
  bytes: number;
}

interface ChunkReader {
  size: number;
  read(start: number, end: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

async function reader(source: UploadSource): Promise<ChunkReader> {
  if (source instanceof Uint8Array) {
    return { size: source.byteLength, read: async (s, e) => source.subarray(s, e), close: async () => {} };
  }
  const size = (await stat(source.path)).size;
  const fh = await open(source.path, "r");
  return {
    size,
    async read(s, e) {
      const buf = Buffer.alloc(e - s);
      let done = 0;
      while (done < buf.length) {
        const { bytesRead } = await fh.read(buf, done, buf.length - done, s + done);
        if (bytesRead === 0) break;
        done += bytesRead;
      }
      return buf.subarray(0, done);
    },
    close: () => fh.close(),
  };
}

/** Bytes Drive holds so far, from a 308's `Range: bytes=0-N`. */
function receivedFrom(res: Response): number {
  const m = /bytes=0-(\d+)/.exec(res.headers.get("range") ?? "");
  return m ? Number(m[1]) + 1 : 0;
}

/**
 * Send the bytes to an open resumable session.
 *
 * Chunked with `Content-Range`, reading each chunk from the source as it goes
 * so a large file is never held whole in memory. After a 5xx or a dropped
 * connection it asks the session how much arrived (`bytes *\/total`) and resumes
 * from there — the point of a resumable upload.
 */
async function sendChunks(session: string, src: ChunkReader, chunkBytes: number): Promise<DriveFile> {
  const total = src.size;
  let offset = 0;
  let failures = 0;
  let stalls = 0;

  for (;;) {
    const end = Math.min(offset + chunkBytes, total);
    let res: Response;
    try {
      const body = total === 0 ? new Uint8Array(0) : await src.read(offset, end);
      res = await fetch(session, {
        method: "PUT",
        redirect: "manual",
        headers: {
          "content-range": total === 0 ? "bytes */0" : `bytes ${offset}-${end - 1}/${total}`,
        },
        // A Buffer view is a valid body; the DOM typings only admit ArrayBuffer-backed views.
        body: body as Uint8Array<ArrayBuffer>,
        signal: AbortSignal.timeout(300_000),
      });
    } catch (e) {
      res = new Response(null, { status: 599, statusText: e instanceof Error ? e.message : String(e) });
    }

    if (res.status === 200 || res.status === 201) return (await res.json()) as DriveFile;
    if (res.status === 308) {
      const next = receivedFrom(res);
      /* A session that keeps acknowledging nothing new would loop forever. */
      stalls = next > offset ? 0 : stalls + 1;
      if (stalls > 5) throw new DriveError(308, `Drive upload stalled at ${offset}/${total} bytes`);
      offset = next;
      failures = 0;
      continue;
    }

    if ((res.status >= 500 || res.status === 429) && failures < 5) {
      failures++;
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** failures)));
      /* Ask the session where it got to before sending anything again. */
      const probe = await fetch(session, {
        method: "PUT",
        redirect: "manual",
        headers: { "content-range": `bytes */${total}` },
        body: new Uint8Array(0),
        signal: AbortSignal.timeout(60_000),
      }).catch(() => null);
      if (probe && (probe.status === 200 || probe.status === 201)) return (await probe.json()) as DriveFile;
      if (probe?.status === 308) offset = receivedFrom(probe);
      continue;
    }

    const detail = await res.text().catch(() => "");
    throw new DriveError(res.status, `Drive upload chunk at ${offset}/${total} → ${res.status}: ${detail.slice(0, 300)}`);
  }
}

/**
 * Put a file into a CAPE subfolder, replacing a same-named file's content.
 *
 * Resumable upload whatever the size: the session is opened with a POST (new
 * file) or PATCH (existing), and the bytes follow in chunks. Returns the file's
 * id and its `webViewLink`, which is what gets recorded and sent to people.
 */
export async function upsertFile(
  subfolder: string,
  name: string,
  source: UploadSource,
  mimeType: string,
  opts: { chunkBytes?: number } = {},
): Promise<UpsertResult> {
  const chunkBytes = Math.max(CHUNK_QUANTUM, Math.floor((opts.chunkBytes ?? DEFAULT_CHUNK_BYTES) / CHUNK_QUANTUM) * CHUNK_QUANTUM);
  const parent = await resolveSubfolder(subfolder);

  const existing = (
    await list(`${q(parent)} in parents and name = ${q(name)} and trashed = false and mimeType != ${q(FOLDER_MIME)}`)
  ).sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""))[0];

  const src = await reader(source);
  try {
    const fields = "id,name,webViewLink,size";
    const initUrl = existing
      ? driveUrl(`${UPLOAD}/files/${encodeURIComponent(existing.id)}`, { uploadType: "resumable", fields })
      : driveUrl(`${UPLOAD}/files`, { uploadType: "resumable", fields });

    const init = await fetch(initUrl, {
      method: existing ? "PATCH" : "POST",
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": mimeType,
        "x-upload-content-length": String(src.size),
      },
      /* On update the parent and name are already right; only the bytes change. */
      body: JSON.stringify(existing ? { mimeType } : { name, mimeType, parents: [parent] }),
      signal: AbortSignal.timeout(60_000),
    });
    const session = init.headers.get("location");
    if (!init.ok || !session) {
      const detail = await init.text().catch(() => "");
      throw new DriveError(init.status, `Drive could not open an upload for ${name} (${init.status}): ${detail.slice(0, 300)}`);
    }

    const file = await sendChunks(session, src, chunkBytes);
    return {
      id: file.id,
      name: file.name ?? name,
      webViewLink: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
      created: !existing,
      bytes: src.size,
    };
  } finally {
    await src.close();
  }
}

/** Whether a stored URL is a Drive delivery, as opposed to a Blob or local path. */
export function isDriveLink(url: string | null | undefined): boolean {
  return Boolean(url && /^https:\/\/(drive|docs)\.google\.com\//.test(url));
}
