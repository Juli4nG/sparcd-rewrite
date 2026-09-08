// The page-driving helper every step goes through. Keeps the Gherkin steps
// declarative: they say what happened, this says how.

import { expect, type Locator, type Page } from '@playwright/test';
import type { S3Mock } from './s3mock';

export const APP_PATH = '/sparcd-exploration/uploader/';
export const S3_ORIGIN = 'http://localhost:5311';
export const ACCESS_KEY = 'AKIATESTKEY0001';
export const SECRET_KEY = 'test-secret-key';

export type FileSpec = {
  /** Path within the dropped folder, e.g. `SDCARD/DCIM/IMG_0001.JPG`. */
  path: string;
  mime?: string;
  bytes?: Buffer;
  /** Generate this many zero bytes in the page instead of transferring them. */
  zeroBytes?: number;
  /** Append this many zero bytes after `bytes` (cheap way to make a big file). */
  padBytes?: number;
  /** Hand the scanner something that is not a readable File, so Inspect fails. */
  broken?: boolean;
};

export type OpenOptions = {
  /** Simulate a browser with no folder picker at all (phone-shaped). */
  noFolderPicker?: boolean;
};

type WireFile = { path: string; mime: string; b64?: string; zeroBytes?: number; padBytes?: number; broken?: boolean };

export class App {
  opened = false;
  /** The last folder handed to the app, so a batch can be re-scanned. */
  lastSpecs: FileSpec[] = [];
  /** Scratch space for values a scenario needs to carry between steps. */
  readonly notes: Record<string, unknown> = {};

  constructor(
    public readonly page: Page,
    public readonly s3: S3Mock,
  ) {}

  // --- lifecycle -----------------------------------------------------------

  async open(opts: OpenOptions = {}): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    await this.s3.install(this.page, S3_ORIGIN);
    // Stand in for the OS folder dialog: showDirectoryPicker hands back a
    // handle over whatever folder the test last supplied. Same class of trick
    // as the synthetic DataTransfer used for drag-and-drop.
    await this.page.addInitScript(() => {
      class SparcdFakeFileHandle {
        kind = 'file';
        constructor(
          public name: string,
          public _file: File,
        ) {}
        async getFile(): Promise<File> {
          return this._file;
        }
      }
      class SparcdFakeDirHandle {
        kind = 'directory';
        _children = new Map<string, unknown>();
        constructor(public name: string) {}
        async *values(): AsyncGenerator<unknown> {
          for (const child of this._children.values()) yield child;
        }
        async queryPermission(): Promise<string> {
          return 'granted';
        }
        async requestPermission(): Promise<string> {
          return 'granted';
        }
      }
      const w = window as unknown as Record<string, unknown>;
      w.SparcdFakeFileHandle = SparcdFakeFileHandle;
      w.SparcdFakeDirHandle = SparcdFakeDirHandle;
      w.__pickedFolder = null;
      w.showDirectoryPicker = async () => {
        if (!w.__pickedFolder) throw new DOMException('The user aborted a request.', 'AbortError');
        return w.__pickedFolder;
      };
    });
    if (opts.noFolderPicker) {
      await this.page.addInitScript(() => {
        // A device that cannot present a folder picker: no File System Access
        // API and a coarse pointer.
        // @ts-expect-error deleting an optional capability
        delete window.showDirectoryPicker;
        const real = window.matchMedia.bind(window);
        window.matchMedia = (q: string) =>
          q.includes('pointer: coarse')
            ? ({
                matches: true,
                media: q,
                onchange: null,
                addEventListener() {},
                removeEventListener() {},
                addListener() {},
                removeListener() {},
                dispatchEvent: () => false,
              } as unknown as MediaQueryList)
            : real(q);
      });
    }
    await this.page.goto(APP_PATH);
  }

  /** Re-open the app in the same context (same storage), e.g. after a reload. */
  async reopen(): Promise<void> {
    await this.page.reload({ waitUntil: 'load' });
    await expect(this.page.locator('#root')).toBeAttached();
  }

  /**
   * Stand in for closing the last tab and opening a fresh one. The session is
   * held in sessionStorage, which is per-tab, so emptying it and reloading is
   * exactly what a new tab sees: localStorage survives to pre-fill the form,
   * and with no other tab open there is nothing to relay the secret.
   */
  async reopenInNewTab(): Promise<void> {
    await this.page.evaluate(() => sessionStorage.clear());
    await this.reopen();
  }

  async openSecondTab(): Promise<Page> {
    const page = await this.page.context().newPage();
    await this.s3.install(page, S3_ORIGIN);
    await page.goto(APP_PATH);
    // The live cross-tab relay is a BroadcastChannel round trip; give the new
    // tab room to receive it before anything asserts on the result.
    await expect(page.locator('#root')).not.toBeEmpty({ timeout: 30_000 });
    return page;
  }

  // --- connection ----------------------------------------------------------

  connectForm(): Locator {
    return this.page.locator('form[aria-label*="Connect"]');
  }

  async fillConnection(fields: { endpoint?: string; accessKey?: string; secretKey?: string } = {}): Promise<void> {
    await this.page.fill('#endpoint', fields.endpoint ?? S3_ORIGIN);
    await this.page.fill('#accessKey', fields.accessKey ?? ACCESS_KEY);
    await this.page.fill('#secretKey', fields.secretKey ?? SECRET_KEY);
  }

  async connect(fields?: { endpoint?: string; accessKey?: string; secretKey?: string }): Promise<void> {
    await this.open();
    await expect(this.connectForm()).toBeVisible();
    await this.fillConnection(fields);
    await this.page.getByLabel('Remember endpoint & access key on this device').check();
    await this.page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(this.page.getByRole('button', { name: 'Logout' })).toBeVisible();
  }

  async disconnectFromHeader(): Promise<void> {
    await this.page.getByRole('button', { name: 'Logout' }).click();
  }

  // --- navigation ----------------------------------------------------------

  async gotoSection(label: 'New upload' | 'History' | 'Settings'): Promise<void> {
    await this.page.locator('nav[aria-label="Sections"]').getByRole('button', { name: label }).click();
  }

  stepChip(label: string): Locator {
    return this.page.locator('ol[aria-label="Upload steps"] li', { hasText: label });
  }

  /** The wizard step the indicator is currently marking active. */
  activeStep(): Locator {
    return this.page.locator('ol[aria-label="Upload steps"] span.bg-mark');
  }

  async expectStep(label: 'Files' | 'Inspect' | 'Assign' | 'Upload'): Promise<void> {
    await expect(this.activeStep()).toContainText(label);
  }

  // --- the batch -----------------------------------------------------------

  private toWire(specs: FileSpec[]): WireFile[] {
    return specs.map((s) => ({
      path: s.path,
      mime: s.mime ?? (s.path.toLowerCase().endsWith('.mp4') ? 'video/mp4' : s.path.toLowerCase().match(/\.jpe?g$/) ? 'image/jpeg' : ''),
      b64: s.bytes ? s.bytes.toString('base64') : undefined,
      zeroBytes: s.zeroBytes,
      padBytes: s.padBytes,
      broken: s.broken,
    }));
  }

  /** Drag a folder onto the drop zone, via a synthetic DataTransfer of entries. */
  async dropFolder(specs: FileSpec[], opts: { readDelayMs?: number } = {}): Promise<void> {
    await this.buildFolder(specs, { drop: true, readDelayMs: opts.readDelayMs ?? 0 });
  }

  /**
   * Make the folder dialog ready to hand this folder back, without scanning it.
   * `addInitScript` re-runs on every navigation, so the picked folder is gone
   * after a reload — anything that navigates and then reselects needs this.
   */
  async seedPickedFolder(specs: FileSpec[]): Promise<void> {
    await this.buildFolder(specs, { drop: false, readDelayMs: 0 });
  }

  private async buildFolder(
    specs: FileSpec[],
    opts: { drop: boolean; readDelayMs: number },
  ): Promise<void> {
    this.lastSpecs = specs;
    await this.page.evaluate(async (payload: { entries: WireFile[]; readDelayMs: number; drop: boolean }) => {
      const { entries, readDelayMs, drop } = payload;
      const decode = (e: WireFile): BlobPart[] => {
        if (e.zeroBytes !== undefined) return [new Uint8Array(e.zeroBytes)];
        const bin = atob(e.b64 ?? '');
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return e.padBytes ? [out, new Uint8Array(e.padBytes)] : [out];
      };

      type Node = { children: Map<string, Node>; file?: File };
      const root: Node = { children: new Map() };
      for (const e of entries) {
        const segs = e.path.split('/').filter(Boolean);
        let node = root;
        for (let i = 0; i < segs.length; i++) {
          const seg = segs[i];
          if (!node.children.has(seg)) node.children.set(seg, { children: new Map() });
          node = node.children.get(seg)!;
          if (i === segs.length - 1) {
            node.file = e.broken
              ? ({ name: seg, type: e.mime, size: 1234 } as unknown as File)
              : new File(decode(e), seg, e.mime ? { type: e.mime } : undefined);
          }
        }
      }

      const makeEntry = (name: string, node: Node, fullPath: string): unknown => {
        if (node.file) {
          const file = node.file;
          return {
            isFile: true,
            isDirectory: false,
            name,
            fullPath,
            file: (cb: (f: File) => void) => cb(file),
          };
        }
        return {
          isFile: false,
          isDirectory: true,
          name,
          fullPath,
          createReader: () => {
            let served = false;
            return {
              readEntries: (cb: (batch: unknown[]) => void) => {
                const deliver = () => {
                  if (served) {
                    cb([]);
                    return;
                  }
                  served = true;
                  cb([...node.children].map(([n, child]) => makeEntry(n, child, `${fullPath}/${n}`)));
                };
                if (readDelayMs > 0) setTimeout(deliver, readDelayMs);
                else deliver();
              },
            };
          },
        };
      };

      const roots = [...root.children].map(([n, child]) => makeEntry(n, child, `/${n}`));
      const items = roots.map((r) => ({ webkitGetAsEntry: () => r }));
      const dataTransfer = { items: Object.assign(items, { length: items.length }) };

      // The same folder, in the shape showDirectoryPicker would hand back.
      const w = window as unknown as Record<string, any>;
      if (w.SparcdFakeDirHandle) {
        const toHandle = (name: string, node: Node): unknown => {
          if (node.file) return new w.SparcdFakeFileHandle(name, node.file);
          const dir = new w.SparcdFakeDirHandle(name);
          for (const [n, child] of node.children) dir._children.set(n, toHandle(n, child));
          return dir;
        };
        const [rootName, rootNode] = [...root.children][0];
        w.__pickedFolder = toHandle(rootName, rootNode);
      }

      if (!drop) return;
      const zone = document.querySelector('[aria-label^="Drop a folder"]')!;
      const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer });
      zone.dispatchEvent(ev);
    }, { entries: this.toWire(specs), readDelayMs: opts.readDelayMs, drop: opts.drop });
  }

  // --- the uploader ↔ tagger hand-off ---------------------------------------

  /** Stand in for the Tagger, which is a different app on the same origin. */
  async stubTagger(): Promise<void> {
    await this.page.route(/\/sparcd-exploration\/tagger\//, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>tagger</title><body>tagger stub</body>',
      }),
    );
  }

  /** Every hand-off record, with blobs reduced to whether they are there. */
  async readFlipRecords(): Promise<Record<string, any>[]> {
    return this.page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      if (!dbs.some((d) => d.name === 'sparcd-flip')) return [];
      const open = indexedDB.open('sparcd-flip');
      const db: IDBDatabase = await new Promise((resolve) => {
        open.onsuccess = () => resolve(open.result);
      });
      const req = db.transaction('records', 'readonly').objectStore('records').getAll();
      const rows: Record<string, any>[] = await new Promise((resolve) => {
        req.onsuccess = () => resolve(req.result);
      });
      db.close();
      return rows.map((r) => ({
        ...r,
        dirHandle: !!r.dirHandle,
        files: (r.files as Record<string, unknown>[]).map((f) => ({ ...f, thumb: !!f.thumb })),
      }));
    });
  }

  /** Stand in for what the Tagger writes back into the record. */
  async patchFlipRecord(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.page.evaluate(
      async ({ id, patch }: { id: string; patch: Record<string, unknown> }) => {
        const open = indexedDB.open('sparcd-flip');
        const db: IDBDatabase = await new Promise((resolve) => {
          open.onsuccess = () => resolve(open.result);
        });
        const store = db.transaction('records', 'readwrite').objectStore('records');
        const existing: Record<string, unknown> = await new Promise((resolve) => {
          const req = store.get(id);
          req.onsuccess = () => resolve(req.result);
        });
        await new Promise<void>((resolve) => {
          const req = store.put({ ...existing, ...patch });
          req.onsuccess = () => resolve();
        });
        db.close();
      },
      { id, patch },
    );
  }

  /**
   * Change what the folder dialog will hand back next time — a file with new
   * bytes, or (with `bytes: null`) a file that is no longer there.
   */
  async editPickedFolder(relPath: string, bytes: Buffer | null): Promise<void> {
    await this.page.evaluate(
      ({ relPath, b64 }: { relPath: string; b64: string | null }) => {
        const w = window as unknown as Record<string, any>;
        const segments = relPath.split('/').slice(1);
        let dir = w.__pickedFolder;
        for (const seg of segments.slice(0, -1)) dir = dir._children.get(seg);
        const name = segments[segments.length - 1];
        if (b64 === null) {
          dir._children.delete(name);
          return;
        }
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        dir._children.set(name, new w.SparcdFakeFileHandle(name, new File([out], name, { type: 'image/jpeg' })));
      },
      { relPath, b64: bytes ? bytes.toString('base64') : null },
    );
  }

  /** Simulate a browser with no File System Access API and a coarse pointer. */
  async makeFolderPickerUnavailable(): Promise<void> {
    await this.page.addInitScript(() => {
      // @ts-expect-error removing an optional capability
      delete window.showDirectoryPicker;
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q: string) =>
        q.includes('pointer: coarse')
          ? ({
              matches: true,
              media: q,
              onchange: null,
              addEventListener() {},
              removeEventListener() {},
              addListener() {},
              removeListener() {},
              dispatchEvent: () => false,
            } as unknown as MediaQueryList)
          : real(q);
    });
    await this.reopen();
    if (await this.connectForm().isVisible()) {
      await this.fillConnection();
      await this.page.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(this.page.getByRole('button', { name: 'Logout' })).toBeVisible();
    }
  }

  /** Dismiss the next fallback file picker synchronously without a cancel
   * event, matching the ordering in Safari <=16 and Firefox <=90. */
  async dismissFallbackPickerWithoutCancel(): Promise<void> {
    await this.page.evaluate(() => {
      const original = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
        if (this.type === 'file') {
          HTMLInputElement.prototype.click = original;
          window.dispatchEvent(new Event('focus'));
          return;
        }
        original.call(this);
      };
    });
  }

  /**
   * Choose a folder through the rendered `<input webkitdirectory>` — the same
   * path the "Choose folder" button takes when the durable picker is absent.
   * Files are materialised on disk so the browser fills in webkitRelativePath.
   */
  async writeFolderToDisk(specs: FileSpec[], dir: string): Promise<string> {
    const fs = await import('node:fs/promises');
    const nodePath = await import('node:path');
    await fs.rm(dir, { recursive: true, force: true });
    for (const spec of specs) {
      const full = nodePath.join(dir, ...spec.path.split('/').slice(1));
      await fs.mkdir(nodePath.dirname(full), { recursive: true });
      const body = spec.bytes ?? Buffer.alloc(spec.zeroBytes ?? 0);
      await fs.writeFile(full, spec.padBytes ? Buffer.concat([body, Buffer.alloc(spec.padBytes)]) : body);
    }
    return dir;
  }

  async pickFolder(specs: FileSpec[], dir: string): Promise<void> {
    await this.writeFolderToDisk(specs, dir);
    await this.page.locator('input[type="file"]').first().setInputFiles(dir);
  }

  async readBundleRecords(): Promise<Record<string, unknown>[]> {
    return this.page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      if (!dbs.some((d) => d.name === 'sparcd-uploader')) return [];
      const open = indexedDB.open('sparcd-uploader');
      const db: IDBDatabase = await new Promise((resolve) => {
        open.onsuccess = () => resolve(open.result);
      });
      if (!db.objectStoreNames.contains('bundles')) return [];
      const req = db.transaction('bundles', 'readonly').objectStore('bundles').getAll();
      return new Promise((resolve) => {
        req.onsuccess = () => resolve(req.result as Record<string, unknown>[]);
      });
    });
  }

  /** Choose individual files through the plain (non-directory) file input. */
  async pickFiles(specs: FileSpec[]): Promise<void> {
    await this.page.locator('input[type="file"]').first().setInputFiles(
      specs.map((s) => ({
        name: s.path.split('/').pop()!,
        mimeType: s.mime ?? (s.path.toLowerCase().endsWith('.mp4') ? 'video/mp4' : 'image/jpeg'),
        buffer: s.bytes ?? Buffer.alloc(s.zeroBytes ?? 0),
      })),
    );
  }

  /**
   * Drop a raw list of file entries — no directory tree — so a listing can
   * legitimately repeat the same path twice, the way a real card reader can.
   */
  async dropRawEntries(specs: FileSpec[]): Promise<void> {
    this.lastSpecs = specs;
    await this.page.evaluate((entries: WireFile[]) => {
      const roots = entries.map((e) => {
        const bin = atob(e.b64 ?? '');
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const parts: BlobPart[] =
          e.zeroBytes !== undefined
            ? [new Uint8Array(e.zeroBytes)]
            : e.padBytes
              ? [bytes, new Uint8Array(e.padBytes)]
              : [bytes];
        const name = e.path.split('/').pop()!;
        const file = e.broken
          ? ({ name, type: e.mime, size: 1234 } as unknown as File)
          : new File(parts, name, e.mime ? { type: e.mime } : undefined);
        return {
          isFile: true,
          isDirectory: false,
          name,
          fullPath: `/${e.path}`,
          file: (cb: (f: File) => void) => cb(file),
        };
      });
      const items = roots.map((r) => ({ webkitGetAsEntry: () => r }));
      const dataTransfer = { items: Object.assign(items, { length: items.length }) };
      const zone = document.querySelector('[aria-label^="Drop a folder"]')!;
      const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer });
      zone.dispatchEvent(ev);
    }, this.toWire(specs));
  }

  fileListPane(): Locator {
    return this.page.locator('[aria-label^="Scanned files"]');
  }

  /** Wait until every file in the batch has finished the Inspect worker pass. */
  async waitForInspected(): Promise<void> {
    await expect(this.fileListPane()).toBeVisible({ timeout: 30_000 });
    await this.page.waitForFunction(
      () => {
        const t = document.body.innerText;
        return !/\d+\s+processing/.test(t) && !t.includes('Processing…') && !t.includes('Queued');
      },
      undefined,
      { timeout: 30_000 },
    );
  }

  /** One row per file currently drawn in the (virtualised) Inspect list. */
  async listedFiles(): Promise<
    {
      name: string;
      relPath: string;
      status: string;
      issues: string;
      timestamp: string;
      dimensions: string;
      sha256: string;
      hasThumbnail: boolean;
      /** The read-only species chips a batch back from the Tagger carries. */
      species: string;
    }[]
  > {
    return this.page.evaluate(() => {
      const root = document.querySelector('[aria-label^="Scanned files"]');
      if (!root) return [];
      return Array.from(root.querySelectorAll('div[style*="translateY"]')).map((wrapper) => {
        const row = wrapper.firstElementChild!;
        const kids = Array.from(row.children);
        const nameSpan = kids[1];
        const statusSpan = kids[kids.length - 1];
        const titled = Array.from(nameSpan.querySelectorAll('span[title]'));
        const inner = titled[0];
        const shaTitle = titled.find((s) => (s.getAttribute('title') ?? '').startsWith('sha256:'));
        const chips = nameSpan.querySelector('span[aria-label^="Species on"]');
        return {
          species: chips
            ? Array.from(chips.children)
                .map((c) => (c.textContent ?? '').trim())
                .join(', ')
            : '',
          name: inner?.textContent?.trim() ?? '',
          relPath: inner?.getAttribute('title') ?? '',
          status: (statusSpan.textContent ?? '').replace('✕', '').trim(),
          issues: statusSpan.querySelector('[title]')?.getAttribute('title') ?? '',
          timestamp: kids[2]?.textContent?.trim() ?? '',
          dimensions: kids[3]?.textContent?.trim() ?? '',
          sha256: (shaTitle?.getAttribute('title') ?? '').replace('sha256:', ''),
          hasThumbnail: kids[0]?.tagName === 'IMG' || !!kids[0]?.querySelector?.('img'),
        };
      });
    });
  }

  /** Rows the virtualiser has actually drawn — the whole point of virtualising. */
  async drawnRowCount(): Promise<number> {
    return this.page.evaluate(() => {
      const root = document.querySelector('[aria-label^="Scanned files"]');
      return root ? root.querySelectorAll('div[style*="translateY"]').length : 0;
    });
  }

  /** Step to a row with J and drop it with D — the list's keyboard affordances. */
  async dropFileFromList(index: number): Promise<void> {
    await this.fileListPane().focus();
    for (let i = 0; i < index; i++) await this.page.keyboard.press('j');
    await this.page.keyboard.press('d');
  }

  /** Set a React-controlled input's value the way a real keystroke would. */
  async setControlledValue(selector: string, value: string, nth = 0): Promise<void> {
    await this.page.evaluate(
      ({ selector, value, nth }) => {
        const el = document.querySelectorAll(selector)[nth] as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )!.set!;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      { selector, value, nth },
    );
  }

  /** The Inspect summary line ("N files · 1.2 KB · 1 warnings"). */
  async batchSummary(): Promise<string> {
    return this.page.evaluate(() => {
      const p = Array.from(document.querySelectorAll('p')).find((el) =>
        /\d+\s*files\s*·/.test(el.textContent ?? ''),
      );
      return p?.textContent ?? '';
    });
  }

  async fileCount(): Promise<number> {
    const m = /(\d+)\s*files/.exec(await this.batchSummary());
    return m ? Number(m[1]) : 0;
  }

  /** Read the persisted resume ledger straight out of IndexedDB. */
  async readBatchRecords(): Promise<Record<string, unknown>[]> {
    return this.page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      if (!dbs.some((d) => d.name === 'sparcd-uploader')) return [];
      const open = indexedDB.open('sparcd-uploader');
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      if (!db.objectStoreNames.contains('batches')) return [];
      const tx = db.transaction('batches', 'readonly');
      const req = tx.objectStore('batches').getAll();
      return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result as Record<string, unknown>[]);
        req.onerror = () => reject(req.error);
      });
    });
  }

  async readFileRecords(): Promise<Record<string, unknown>[]> {
    return this.page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      if (!dbs.some((d) => d.name === 'sparcd-uploader')) return [];
      const open = indexedDB.open('sparcd-uploader');
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      if (!db.objectStoreNames.contains('files')) return [];
      const tx = db.transaction('files', 'readonly');
      const req = tx.objectStore('files').getAll();
      return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result as Record<string, unknown>[]);
        req.onerror = () => reject(req.error);
      });
    });
  }

  async continueToAssign(): Promise<void> {
    await this.page.getByRole('button', { name: 'Continue' }).click();
    await expect(this.page.getByRole('heading', { name: 'Target collection' })).toBeVisible();
  }

  async continueToUpload(): Promise<void> {
    await this.page.getByRole('button', { name: 'Continue' }).click();
    await expect(this.page.getByRole('heading', { name: 'Upload', exact: true })).toBeVisible();
  }

  /** Throw the current batch away and scan a different one. */
  async rescan(specs: FileSpec[], opts: { raw?: boolean } = {}): Promise<void> {
    const startOver = this.page.getByRole('button', { name: 'Start over' });
    if (await startOver.isVisible().catch(() => false)) {
      await startOver.click();
      await this.expectStep('Files');
    }
    if (opts.raw) await this.dropRawEntries(specs);
    else await this.dropFolder(specs);
  }

  /** Inspect → Assign → Upload, filling in whatever Assign needs on the way. */
  async walkToUploadStep(
    opts: { deployment?: string; uploader?: string; description?: string } = {},
  ): Promise<void> {
    await expect(this.fileListPane()).toBeVisible({ timeout: 30_000 });
    await this.page.getByRole('button', { name: 'Continue' }).click();
    await expect(this.page.getByRole('heading', { name: 'Target collection' })).toBeVisible();
    await this.waitForCollections();
    await this.chooseDeployment(opts.deployment ?? 'Bear Canyon');
    if (opts.uploader !== undefined) await this.setUploader(opts.uploader);
    if (opts.description !== undefined) await this.setDescription(opts.description);
    await this.continueToUpload();
  }

  /** Back out to Drop, re-scan the same folder, and return to the Upload step. */
  async rescanFromUploadStep(): Promise<void> {
    await this.page.getByRole('button', { name: 'Back' }).click();
    await expect(this.page.getByRole('heading', { name: 'Target collection' })).toBeVisible();
    await this.page.getByRole('button', { name: 'Back' }).click();
    await expect(this.fileListPane()).toBeVisible();
    await this.rescan(this.lastSpecs);
    await expect(this.fileListPane()).toBeVisible();
    await this.page.getByRole('button', { name: 'Continue' }).click();
    await expect(this.page.getByRole('heading', { name: 'Target collection' })).toBeVisible();
    await this.continueToUpload();
  }

  // --- Assign --------------------------------------------------------------

  async waitForCollections(): Promise<void> {
    await expect(this.page.getByRole('button', { name: /Select a target collection|Alpha Collection|Beta Collection/ }).first()).toBeVisible({ timeout: 20_000 });
  }

  deploymentTrigger(): Locator {
    return this.page.locator('button[aria-haspopup="listbox"]').nth(1);
  }

  collectionTrigger(): Locator {
    return this.page.locator('button[aria-haspopup="listbox"]').first();
  }

  private async setListOpen(trigger: Locator, open: boolean): Promise<void> {
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    if (((await trigger.getAttribute('aria-expanded')) === 'true') !== open) await trigger.click();
  }

  async openCollectionList(): Promise<void> {
    await this.setListOpen(this.collectionTrigger(), true);
  }

  async closeCollectionList(): Promise<void> {
    await this.setListOpen(this.collectionTrigger(), false);
  }

  async openDeploymentList(): Promise<void> {
    await this.closeCollectionList();
    await this.setListOpen(this.deploymentTrigger(), true);
  }

  deploymentOptions(): Locator {
    return this.page.locator('ul[role="listbox"] li[role="option"]');
  }

  async chooseDeployment(name: string): Promise<void> {
    await this.openDeploymentList();
    await this.deploymentOptions().filter({ hasText: name }).first().click();
  }

  async setUploader(name: string): Promise<void> {
    await this.page.getByPlaceholder('e.g. John Doe').first().fill(name);
  }

  async setDescription(text: string): Promise<void> {
    await this.page.getByPlaceholder('What this batch is — site, date range, notes.').fill(text);
  }

  timeZoneSelect(): Locator {
    return this.page.locator('select').filter({ hasText: 'America' }).first();
  }

  continueButton(): Locator {
    return this.page.getByRole('button', { name: 'Continue' });
  }

  // --- Upload --------------------------------------------------------------

  dryRunCheckbox(): Locator {
    return this.page.getByLabel('Test the upload, nothing is written');
  }

  concurrencyModeRadio(mode: 'Adaptive (default)' | 'Manual'): Locator {
    return this.page.getByRole('radio', { name: mode });
  }

  /** The lane-count slider. Only rendered once concurrency is pinned to manual. */
  laneSlider(): Locator {
    return this.page.locator('input[type="range"]');
  }

  /** Settings → pin concurrency to a fixed lane count, then come back. Omit
   *  `lanes` to pin at whatever the current value is. */
  async pinConcurrency(lanes?: number): Promise<void> {
    await this.gotoSection('Settings');
    await this.concurrencyModeRadio('Manual').check();
    if (lanes !== undefined) await this.laneSlider().fill(String(lanes));
    await this.gotoSection('New upload');
  }

  async startRun(): Promise<void> {
    await this.page.getByRole('button', { name: /^Start (dry run|upload)$/ }).click();
  }

  runPhase(): Locator {
    return this.page.locator('section span.font-mono.uppercase').first();
  }

  async waitForRunPhase(
    phase: 'done' | 'partial' | 'error' | 'uploading' | 'publishing' | 'idle',
    timeout = 60_000,
  ): Promise<void> {
    await expect(this.runPhase()).toHaveText(phase, { timeout });
    // A real (non-dry-run) run reaching 'done' pops a confirmation dialog
    // whose backdrop covers the page — dismiss it so later steps can click
    // through, same as a user would.
    if (phase === 'done') {
      const dialog = this.page.getByRole('dialog', { name: 'Upload complete' });
      const ok = dialog.getByRole('button', { name: 'OK' });
      if (await ok.isVisible().catch(() => false)) {
        await ok.click();
        await expect(dialog).toBeHidden();
      }
    }
  }

  /** The collection picker on the History screen (a plain <select>). */
  publishedCollectionSelect(): Locator {
    return this.page.locator('select').filter({ hasText: 'Select a collection…' });
  }

  async logText(): Promise<string> {
    return this.page.evaluate(() => {
      const panels = Array.from(document.querySelectorAll('div'));
      const el = panels.find(
        (d) => d.className.includes('font-mono') && d.className.includes('text-[11.5px]'),
      );
      return el?.textContent ?? '';
    });
  }

  /**
   * Block the inspection result for `filename` from being dispatched until
   * `releaseHeldInspect` is called. Set this before dropping the batch so the
   * hook is in place before the worker finishes.
   */
  async holdInspect(filename: string): Promise<void> {
    await this.page.evaluate((name) => {
      const w = window as unknown as Record<string, unknown>;
      w.__inspectHoldResolvers = [] as (() => void)[];
      w.__holdInspectResult = (_id: string, fname: string): Promise<void> => {
        if (fname !== name) return Promise.resolve();
        return new Promise<void>((resolve) => {
          (w.__inspectHoldResolvers as (() => void)[]).push(resolve);
        });
      };
    }, filename);
  }

  /** Release all results held by `holdInspect` and clear the hook. */
  async releaseHeldInspect(): Promise<void> {
    await this.page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      w.__holdInspectResult = undefined;
      const resolvers = (w.__inspectHoldResolvers as (() => void)[]) ?? [];
      w.__inspectHoldResolvers = [];
      for (const r of resolvers) r();
    });
  }
}
