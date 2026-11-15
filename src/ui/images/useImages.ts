import { useEffect, useState } from "react";
import { observeTasks } from "@daily/plugin-sdk";
import type { ImageAsset, ImageLibrary } from "../../images/schema";
import { imageDataUrl, loadImageLibrary, subscribeImageLibrary } from "../../images/store";

const EMPTY: ImageLibrary = { version: 1, style: "", assets: [] };

/** The work's image library, kept current as images are added from anywhere in this window. */
export function useImageLibrary(projectId: string | undefined): ImageLibrary {
  const [library, setLibrary] = useState<ImageLibrary>(EMPTY);
  useEffect(() => {
    if (!projectId) { setLibrary(EMPTY); return; }
    let alive = true;
    const load = () => { void loadImageLibrary(projectId).then((next) => { if (alive) setLibrary(next); }).catch(() => undefined); };
    load();
    let cursor = 0;
    const stopTasks = observeTasks({ scope: projectId }, (tasks) => {
      const latest = Math.max(0, ...tasks.filter((task) => task.status === "completed").map((task) => task.cursor));
      if (latest > cursor) { cursor = latest; load(); }
    });
    const stop = subscribeImageLibrary((changed) => { if (changed === projectId) load(); });
    return () => { alive = false; stop(); stopTasks(); };
  }, [projectId]);
  return library;
}

export function useImageUrl(projectId: string | undefined, asset: ImageAsset | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const id = asset?.id;
  useEffect(() => {
    setUrl(null);
    setFailed(false);
    if (!projectId || !asset) return;
    let alive = true;
    imageDataUrl(projectId, asset).then((value) => { if (alive) setUrl(value); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
    // The file of an asset never changes, so its id identifies the image.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, id]);
  return { url, failed };
}

/** Data URLs for several assets at once; missing or unreadable ones are left out. */
export function useAssetUrls(projectId: string | undefined, assetIds: string[]): Map<string, string> {
  const library = useImageLibrary(projectId);
  const [urls, setUrls] = useState<Map<string, string>>(new Map());
  const key = assetIds.join(",");
  useEffect(() => {
    if (!projectId) { setUrls(new Map()); return; }
    let alive = true;
    const wanted = [...new Set(key ? key.split(",") : [])];
    void Promise.all(wanted.map(async (id) => {
      const asset = library.assets.find((item) => item.id === id);
      if (!asset) return null;
      try { return [id, await imageDataUrl(projectId, asset)] as const; } catch { return null; }
    })).then((pairs) => { if (alive) setUrls(new Map(pairs.filter((pair): pair is readonly [string, string] => Boolean(pair)))); });
    return () => { alive = false; };
  }, [projectId, key, library.assets]);
  return urls;
}
