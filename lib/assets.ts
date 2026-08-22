// Client-side asset library: files the user hands Scout ONCE (a song for
// playlist submissions, a portfolio PDF, a headshot) and expects it to keep
// forever and pull up whenever an application calls for it. IndexedDB, not
// localStorage: songs run megabytes and would blow the 5MB string quota.

export interface StoredAsset {
  name: string; // file name, also the key
  type: string; // MIME type
  size: number;
  addedAt: number;
  blob: Blob;
}

const DB = "scout-assets";
const STORE = "files";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE))
        req.result.createObjectStore(STORE, { keyPath: "name" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const r = run(t.objectStore(STORE));
        r.onsuccess = () => resolve(r.result as T);
        r.onerror = () => reject(r.error);
      })
  );
}

export async function saveAsset(file: File): Promise<void> {
  const rec: StoredAsset = {
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    addedAt: Date.now(),
    blob: file,
  };
  await tx("readwrite", (s) => s.put(rec));
}

export async function listAssets(): Promise<StoredAsset[]> {
  try {
    const all = await tx<StoredAsset[]>("readonly", (s) => s.getAll());
    return (all || []).sort((a, b) => b.addedAt - a.addedAt);
  } catch {
    return [];
  }
}

export async function removeAsset(name: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(name));
}

// Which stored assets an application likely needs, by loose kind matching:
// a playlist/music submission wants audio; anything wants documents.
export function assetsFor(kindText: string, assets: StoredAsset[]): StoredAsset[] {
  const t = kindText.toLowerCase();
  const wantsAudio = /playlist|song|track|music|dj|radio|sync|spotify|curator/.test(t);
  return assets.filter((a) => {
    const audio = a.type.startsWith("audio/");
    if (audio) return wantsAudio;
    return true; // documents are broadly useful
  });
}
