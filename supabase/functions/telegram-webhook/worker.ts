// VPS'dagi yordamchi xizmat (server/worker): katta fayldan ovozni ajratib beradi.

import { WORKER_URL, workerKey } from "./telegram.ts";

export type Prepared =
  | { status: "ready"; id: string; size: number; duration: number | null }
  | { status: "pending" }
  | { status: "error"; error: string };

/** Faylni tayyorlashni so'raydi. Xizmat ~60 s kutadi; ulgurmasa "pending" — keyinroq yana so'raymiz. */
export async function prepareAudio(fileId: string): Promise<Prepared> {
  const res = await fetch(`${WORKER_URL}/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bulut-key": await workerKey() },
    body: JSON.stringify({ file_id: fileId }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`worker prepare ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await res.json();
}

export async function downloadAudio(id: string): Promise<Uint8Array> {
  const res = await fetch(`${WORKER_URL}/audio/${id}.ogg`, { headers: { "x-bulut-key": await workerKey() } });
  if (!res.ok) throw new Error(`worker audio ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
