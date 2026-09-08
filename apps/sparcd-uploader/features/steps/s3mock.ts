// An in-memory, path-style S3 served through `page.route`. The app signs every
// request with SigV4, so the `authorization` header is what tells an S3 call
// apart from a Vite asset request on the same origin — anything unsigned falls
// through to the dev server untouched.

import type { Page, Route } from '@playwright/test';

export type StoredObject = {
  body: Buffer;
  contentType: string;
  meta: Record<string, string>;
  etag: string;
};

export type PutRecord = {
  bucket: string;
  key: string;
  size: number;
  body: string; // utf-8 view; only meaningful for the metadata files
  ifNoneMatch?: string;
  ifMatch?: string;
  meta: Record<string, string>;
};

export type S3Error = { status: number; code: string; message?: string };

/** Per-key hook: return an error to fail the call, or undefined to let it run. */
export type PutHook = (
  bucket: string,
  key: string,
  body: Buffer,
) => S3Error | undefined | Promise<S3Error | undefined>;

const XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/';

const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const errorBody = (code: string, message: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEscape(
    message,
  )}</Message><Resource>/</Resource><RequestId>test</RequestId></Error>`;

let etagCounter = 0;
let mpuCounter = 0;
const nextEtag = (): string => `"etag-${++etagCounter}"`;

export class S3Mock {
  buckets: string[] = [];
  objects = new Map<string, StoredObject>();

  /** Every PUT the app issued, in order. Empty after a dry run, by construction. */
  puts: PutRecord[] = [];
  gets: string[] = [];
  heads: string[] = [];
  /** Every listing the app issued, as `bucket/prefix`. */
  lists: string[] = [];

  /** Buckets whose object reads fail with 403 (simulating IAM/CORS refusal). */
  unreadable = new Set<string>();
  /** Object keys (`bucket/key`) whose GET/HEAD fails with 403. */
  unreadableKeys = new Set<string>();

  putHooks: PutHook[] = [];

  /** Artificial latency on every object write, for observing a run in flight. */
  putDelayMs = 0;

  /**
   * Hold matching PUTs after storage records them but before S3 responds. This
   * lets scenarios observe or cancel a real in-flight write without racing the
   * whole upload against wall-clock timing.
   */
  holdPut?: (bucket: string, key: string) => boolean;

  private heldPutResolvers: (() => void)[] = [];

  /** Fires once an object has been stored — lets a scenario corrupt it. */
  afterPut?: (bucket: string, key: string, obj: StoredObject) => void;

  /** Fires after a GET has been served — lets a scenario change it underneath. */
  onGet?: (bucket: string, key: string) => void;

  /** Simulate a backend that refuses to honour `IfMatch` (501 NotImplemented). */
  rejectConditionalReplace = false;

  /** In-flight multipart uploads, keyed by upload id. */
  multipart = new Map<
    string,
    { bucket: string; key: string; meta: Record<string, string>; contentType: string; parts: Map<number, Buffer> }
  >();

  private objKey(bucket: string, key: string): string {
    return `${bucket}/${key}`;
  }

  put(bucket: string, key: string, body: string | Buffer, opts: { contentType?: string; meta?: Record<string, string> } = {}): void {
    if (!this.buckets.includes(bucket)) this.buckets.push(bucket);
    this.objects.set(this.objKey(bucket, key), {
      body: Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'),
      contentType: opts.contentType ?? 'application/octet-stream',
      meta: opts.meta ?? {},
      etag: nextEtag(),
    });
  }

  get(bucket: string, key: string): StoredObject | undefined {
    return this.objects.get(this.objKey(bucket, key));
  }

  text(bucket: string, key: string): string | undefined {
    return this.get(bucket, key)?.body.toString('utf8');
  }

  has(bucket: string, key: string): boolean {
    return this.objects.has(this.objKey(bucket, key));
  }

  delete(bucket: string, key: string): void {
    this.objects.delete(this.objKey(bucket, key));
  }

  /** Keys written by the app during this scenario, in write order. */
  writtenKeys(): string[] {
    return this.puts.map((p) => `${p.bucket}/${p.key}`);
  }

  releaseHeldPuts(): void {
    const resolvers = this.heldPutResolvers.splice(0);
    for (const resolve of resolvers) resolve();
  }

  private async maybeHoldPut(bucket: string, key: string): Promise<boolean> {
    if (!this.holdPut?.(bucket, key)) return false;
    await new Promise<void>((resolve) => {
      this.heldPutResolvers.push(resolve);
    });
    return true;
  }

  private async fulfillHeldPut(route: Route, response: Parameters<Route['fulfill']>[0], held: boolean): Promise<void> {
    try {
      await route.fulfill(response);
    } catch (err) {
      if (held) return;
      throw err;
    }
  }

  addBucket(name: string): void {
    if (!this.buckets.includes(name)) this.buckets.push(name);
  }

  // --- request handling ----------------------------------------------------

  private listBuckets(): string {
    const rows = this.buckets
      .map(
        (b) =>
          `<Bucket><Name>${xmlEscape(b)}</Name><CreationDate>2024-01-01T00:00:00.000Z</CreationDate></Bucket>`,
      )
      .join('');
    return `<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult xmlns="${XMLNS}"><Owner><ID>test</ID><DisplayName>test</DisplayName></Owner><Buckets>${rows}</Buckets></ListAllMyBucketsResult>`;
  }

  private listObjects(bucket: string, prefix: string, delimiter: string | null): string {
    const contents: string[] = [];
    const prefixes = new Set<string>();
    for (const [full, obj] of this.objects) {
      if (!full.startsWith(`${bucket}/`)) continue;
      const key = full.slice(bucket.length + 1);
      if (!key.startsWith(prefix)) continue;
      if (delimiter) {
        const rest = key.slice(prefix.length);
        const i = rest.indexOf(delimiter);
        if (i >= 0) {
          prefixes.add(prefix + rest.slice(0, i + delimiter.length));
          continue;
        }
      }
      contents.push(
        `<Contents><Key>${xmlEscape(key)}</Key><LastModified>2024-01-01T00:00:00.000Z</LastModified><ETag>${xmlEscape(
          obj.etag,
        )}</ETag><Size>${obj.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`,
      );
    }
    const cp = [...prefixes]
      .sort()
      .map((p) => `<CommonPrefixes><Prefix>${xmlEscape(p)}</Prefix></CommonPrefixes>`)
      .join('');
    return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="${XMLNS}"><Name>${xmlEscape(
      bucket,
    )}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${
      contents.length + prefixes.size
    }</KeyCount><MaxKeys>1000</MaxKeys>${
      delimiter ? `<Delimiter>${xmlEscape(delimiter)}</Delimiter>` : ''
    }<IsTruncated>false</IsTruncated>${contents.join('')}${cp}</ListBucketResult>`;
  }

  async install(page: Page, origin: string): Promise<void> {
    const originRe = new RegExp(`^${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`);
    await page.route(originRe, async (route) => {
      const req = route.request();
      const auth = req.headers()['authorization'] ?? '';
      if (!auth.startsWith('AWS4-HMAC')) {
        await route.fallback();
        return;
      }
      const url = new URL(req.url());
      const path = decodeURIComponent(url.pathname).replace(/^\//, '');
      const slash = path.indexOf('/');
      const bucket = slash < 0 ? path : path.slice(0, slash);
      const key = slash < 0 ? '' : path.slice(slash + 1);
      const method = req.method();

      const fail = (e: S3Error) =>
        route.fulfill({
          status: e.status,
          contentType: 'application/xml',
          headers: { 'x-amz-request-id': 'test' },
          body: errorBody(e.code, e.message ?? e.code),
        });

      // ListBuckets — the only request against the endpoint root.
      if (bucket === '') {
        await route.fulfill({ status: 200, contentType: 'application/xml', body: this.listBuckets() });
        return;
      }

      if (method === 'GET' && key === '' ) {
        const prefix = url.searchParams.get('prefix') ?? '';
        const delimiter = url.searchParams.get('delimiter');
        this.lists.push(`${bucket}/${prefix}`);
        if (this.unreadable.has(bucket)) {
          await fail({ status: 403, code: 'AccessDenied', message: 'Access Denied' });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/xml',
          body: this.listObjects(bucket, prefix, delimiter),
        });
        return;
      }

      if (method === 'GET' || method === 'HEAD') {
        (method === 'GET' ? this.gets : this.heads).push(`${bucket}/${key}`);
        if (this.unreadable.has(bucket) || this.unreadableKeys.has(`${bucket}/${key}`)) {
          await fail({ status: 403, code: 'AccessDenied', message: 'Access Denied' });
          return;
        }
        const obj = this.get(bucket, key);
        if (!obj) {
          await fail({ status: 404, code: 'NoSuchKey', message: 'The specified key does not exist.' });
          return;
        }
        const headers: Record<string, string> = {
          etag: obj.etag,
          'content-length': String(obj.body.length),
          'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
          'accept-ranges': 'bytes',
        };
        for (const [k, v] of Object.entries(obj.meta)) headers[`x-amz-meta-${k}`] = v;
        await route.fulfill({
          status: 200,
          contentType: obj.contentType,
          headers,
          body: method === 'HEAD' ? Buffer.alloc(0) : obj.body,
        });
        if (method === 'GET') this.onGet?.(bucket, key);
        return;
      }

      // --- multipart (any body over 8 MiB takes this path) ------------------
      const uploadId = url.searchParams.get('uploadId');
      if (method === 'POST' && url.searchParams.has('uploads')) {
        const meta: Record<string, string> = {};
        for (const [h, v] of Object.entries(req.headers())) {
          if (h.startsWith('x-amz-meta-')) meta[h.slice('x-amz-meta-'.length)] = v;
        }
        const id = `mpu-${++mpuCounter}`;
        this.multipart.set(id, {
          bucket,
          key,
          meta,
          contentType: req.headers()['content-type'] ?? 'application/octet-stream',
          parts: new Map(),
        });
        await route.fulfill({
          status: 200,
          contentType: 'application/xml',
          body: `<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult xmlns="${XMLNS}"><Bucket>${xmlEscape(
            bucket,
          )}</Bucket><Key>${xmlEscape(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        });
        return;
      }

      if (method === 'PUT' && uploadId && url.searchParams.has('partNumber')) {
        const mpu = this.multipart.get(uploadId);
        if (!mpu) {
          await fail({ status: 404, code: 'NoSuchUpload', message: uploadId });
          return;
        }
        const partNumber = Number(url.searchParams.get('partNumber'));
        mpu.parts.set(partNumber, req.postDataBuffer() ?? Buffer.alloc(0));
        await route.fulfill({ status: 200, headers: { etag: `"part-${uploadId}-${partNumber}"` }, body: '' });
        return;
      }

      if (method === 'POST' && uploadId) {
        const mpu = this.multipart.get(uploadId);
        if (!mpu) {
          await fail({ status: 404, code: 'NoSuchUpload', message: uploadId });
          return;
        }
        if (req.headers()['if-none-match'] === '*' && this.get(bucket, key)) {
          await fail({ status: 412, code: 'PreconditionFailed', message: 'Object already exists' });
          return;
        }
        const ordered = [...mpu.parts.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
        const body = Buffer.concat(ordered);
        this.multipart.delete(uploadId);
        this.put(bucket, key, body, { contentType: mpu.contentType, meta: mpu.meta });
        this.afterPut?.(bucket, key, this.get(bucket, key)!);
        this.puts.push({ bucket, key, size: body.length, body: '', meta: mpu.meta });
        const held = await this.maybeHoldPut(bucket, key);
        await this.fulfillHeldPut(route, {
          status: 200,
          contentType: 'application/xml',
          body: `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult xmlns="${XMLNS}"><Bucket>${xmlEscape(
            bucket,
          )}</Bucket><Key>${xmlEscape(key)}</Key><ETag>${xmlEscape(
            this.get(bucket, key)!.etag,
          )}</ETag></CompleteMultipartUploadResult>`,
        }, held);
        return;
      }

      if (method === 'PUT') {
        if (this.putDelayMs) await new Promise((r) => setTimeout(r, this.putDelayMs));
        const body = req.postDataBuffer() ?? Buffer.alloc(0);
        const meta: Record<string, string> = {};
        for (const [h, v] of Object.entries(req.headers())) {
          if (h.startsWith('x-amz-meta-')) meta[h.slice('x-amz-meta-'.length)] = v;
        }
        for (const hook of this.putHooks) {
          const err = await hook(bucket, key, body);
          if (err) {
            await fail(err);
            return;
          }
        }
        const ifNoneMatch = req.headers()['if-none-match'];
        const ifMatch = req.headers()['if-match'];
        if (ifMatch !== undefined && this.rejectConditionalReplace) {
          await fail({ status: 501, code: 'NotImplemented', message: 'IfMatch is not supported here' });
          return;
        }
        const existing = this.get(bucket, key);
        if (ifNoneMatch === '*' && existing) {
          await fail({ status: 412, code: 'PreconditionFailed', message: 'At least one of the pre-conditions you specified did not hold' });
          return;
        }
        if (ifMatch !== undefined && (!existing || existing.etag !== ifMatch)) {
          await fail({ status: 412, code: 'PreconditionFailed', message: 'ETag mismatch' });
          return;
        }
        this.put(bucket, key, body, { contentType: req.headers()['content-type'], meta });
        this.afterPut?.(bucket, key, this.get(bucket, key)!);
        this.puts.push({
          bucket,
          key,
          size: body.length,
          body: body.toString('utf8'),
          ifNoneMatch,
          ifMatch,
          meta,
        });
        const held = await this.maybeHoldPut(bucket, key);
        await this.fulfillHeldPut(route, {
          status: 200,
          headers: { etag: this.get(bucket, key)!.etag },
          body: '',
        }, held);
        return;
      }

      await fail({ status: 405, code: 'MethodNotAllowed', message: method });
    });
  }
}
