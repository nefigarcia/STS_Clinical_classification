"use client";

export class ClientApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    cache: "no-store",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const reasons = (data?.details as { reasons?: string[] } | undefined)?.reasons;
    throw new ClientApiError(res.status, [data?.error ?? res.statusText, ...(reasons ?? [])].join(" — "), data?.details);
  }
  return data as T;
}

/**
 * Upload a file in chunks (each below serverless body limits) and finalize it.
 * Returns the server's completion payload (preview for tabular files).
 */
export async function chunkedUpload<T>(
  file: File,
  meta: { kind: string; dataClassification: string },
  onProgress: (pct: number) => void,
): Promise<T & { id: string }> {
  const init = await api<{ id: string; chunkBytes: number; expectedChunks: number }>("/api/upload", {
    method: "POST",
    json: { fileName: file.name, sizeBytes: file.size, ...meta },
  });
  for (let i = 0; i < init.expectedChunks; i++) {
    const blob = file.slice(i * init.chunkBytes, Math.min(file.size, (i + 1) * init.chunkBytes));
    let attempt = 0;
    for (;;) {
      try {
        await api(`/api/upload/${init.id}/chunk?index=${i}`, { method: "PUT", body: blob, headers: { "content-type": "application/octet-stream" } });
        break;
      } catch (e) {
        if (++attempt > 3) throw e;
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
    onProgress(Math.round(((i + 1) / init.expectedChunks) * 90));
  }
  const done = await api<T>(`/api/upload/${init.id}/complete`, { method: "POST" });
  onProgress(100);
  return { ...(done as T), id: init.id };
}
