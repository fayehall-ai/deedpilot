/*
 * No `server-only` guard — this runs from `scripts/cape-produce.ts` under tsx.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

/**
 * Publishing produced video to Vercel Blob.
 *
 * ## Why hosting is a separate step from producing
 *
 * `produce.ts` writes an MP4 to disk and records where it is. That is enough to
 * review a package and is deliberately all it was, because a produced artifact
 * and a *distributed* one are different commitments: the second puts a file at
 * a URL anyone holding it can fetch, and it costs storage and bandwidth on
 * every request thereafter. Keeping the upload behind its own module and its
 * own flag means encoding a hundred packages for review does not publish a
 * hundred videos.
 *
 * ## Public, and what that means
 *
 * The store is `public`. Vercel Blob URLs carry a random suffix so they are not
 * guessable, but anyone given the link can fetch it without credentials — which
 * is exactly what a course attachment needs, and is the reason the TDC workflow
 * ends with "loaded into the Upcoming Auctions Course as an attachment to the
 * corresponding county video".
 *
 * These are briefings about published government auctions. They contain no
 * personal data, no subscriber data, and no parcel-level advice. If that ever
 * changes, this is the module that has to change with it.
 *
 * ## Why the pathname is deterministic
 *
 * `cape/<state>-<county>-<saleDate>/<hash>.mp4`, where the hash identifies the
 * file's own bytes. Two consequences, both wanted: re-publishing an unchanged
 * video is a no-op rather than a second copy accruing storage, and a genuinely
 * new cut lands at a new URL instead of silently replacing the one already
 * embedded in a course. A link that quietly starts pointing at different
 * content is worse than a broken one, because nobody notices.
 */

export class BlobUnavailableError extends Error {}

export function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/** Content hash of a file, streamed so a large MP4 is never held in memory. */
async function fileHash(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on("data", (c) => hash.update(c))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return hash.digest("hex").slice(0, 16);
}

export interface PublishResult {
  url: string;
  pathname: string;
  bytes: number;
  /** True when the identical file was already at that pathname. */
  alreadyPublished: boolean;
}

/**
 * Upload a produced video and return its public URL.
 *
 * Streams rather than buffering: these run to several megabytes each and a
 * batch would otherwise hold every one of them in memory at once.
 */
export async function publishVideo(
  mp4Path: string,
  opts: { slug: string },
): Promise<PublishResult> {
  if (!blobConfigured()) {
    throw new BlobUnavailableError(
      "BLOB_READ_WRITE_TOKEN is not set. Run `vercel blob create-store <name> --access public` " +
        "or `vercel env pull` to fetch it.",
    );
  }

  const { put, head } = await import("@vercel/blob");

  const size = (await stat(mp4Path)).size;
  const hash = await fileHash(mp4Path);
  const pathname = `cape/${opts.slug}/${hash}.mp4`;

  /*
   * Ask before uploading. `put` with `addRandomSuffix: false` would happily
   * overwrite, and re-uploading several megabytes to produce a byte-identical
   * object is pure cost — a full re-run of 152 packages that changed nothing
   * would move half a gigabyte for no reason.
   */
  try {
    const existing = await head(pathname);
    if (existing && existing.size === size) {
      return { url: existing.url, pathname, bytes: size, alreadyPublished: true };
    }
  } catch {
    // `head` throws when the blob does not exist, which is the normal path.
  }

  const blob = await put(pathname, createReadStream(mp4Path), {
    access: "public",
    contentType: "video/mp4",
    /*
     * The pathname already carries a content hash, so a random suffix would
     * only make the URL unstable across identical uploads and defeat the
     * de-duplication above.
     */
    addRandomSuffix: false,
    /*
     * A year, because the content at this URL cannot change: a different cut
     * hashes differently and lands elsewhere. Long caching is safe precisely
     * because the name is derived from the bytes.
     */
    cacheControlMaxAge: 31_536_000,
  });

  return { url: blob.url, pathname, bytes: size, alreadyPublished: false };
}

/** Filesystem-and-URL-safe stem, matching the artifact directory name. */
export function publishSlug(mp4Path: string): string {
  return path.basename(path.dirname(mp4Path));
}
