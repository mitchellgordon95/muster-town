/**
 * Paste or drop a screenshot or video into a text box (docs/multimedia.md): it uploads as the signed-in human through
 * `POST /api/media` and the box gets `![name](/api/media/mf_….png)` at the cursor. While it uploads, a placeholder
 * stands where the markdown will go, so typing on meanwhile is safe. The server checks the type by magic bytes and
 * the limits; the client only pre-checks type and size to fail fast.
 */
import { useRef, useState, type ClipboardEvent, type Dispatch, type DragEvent, type SetStateAction } from "react";
import { api } from "../api";
import { store } from "../state";

const MEDIA_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp", "video/webm", "video/mp4"];
const MAX_BYTES = 8 * 1024 * 1024;

const mediaFiles = (list: FileList | null | undefined): File[] => [...(list ?? [])].filter((f) => MEDIA_MIME.includes(f.type));
const altOf = (f: File) => f.name && f.name !== "image.png" ? f.name.replace(/\.[a-z0-9]+$/i, "").replace(/[[\]\n]/g, " ").slice(0, 80) : "";

/** `{...media.props}` on a <textarea> whose value is `setText`'s state. `media.uploading` counts uploads in flight. */
export function useMediaPaste(setText: Dispatch<SetStateAction<string>>) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [uploading, setUploading] = useState(0);
  const [over, setOver] = useState(false);

  const upload = (files: File[]) => {
    const el = ref.current;
    let at = el ? el.selectionStart : -1;
    for (const f of files) {
      if (f.size > MAX_BYTES) { store.toast(`${f.name || "That file"} is ${(f.size / 1048576).toFixed(1)} MiB; the limit is 8 MiB.`, "bad"); continue; }
      const mark = `![Uploading ${f.name || f.type}… ${Math.random().toString(36).slice(2, 8)}]()`;
      const pos = at;
      setText((t) => {
        const i = pos < 0 || pos > t.length ? t.length : pos;
        const pre = i > 0 && t[i - 1] !== "\n" ? "\n" : "";
        return `${t.slice(0, i)}${pre}${mark}\n${t.slice(i)}`;
      });
      if (at >= 0) at += mark.length + 2;
      setUploading((n) => n + 1);
      api().uploadMedia(f, altOf(f))
        .then((r) => setText((t) => t.replace(mark, () => r.markdown)))
        .catch((err) => { setText((t) => t.replace(`${mark}\n`, "").replace(mark, "")); store.toast(`Upload failed: ${String((err as Error).message ?? err)}`, "bad"); })
        .finally(() => setUploading((n) => n - 1));
    }
  };

  const props = {
    ref,
    onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = mediaFiles(e.clipboardData?.files);
      if (!files.length) return;
      e.preventDefault();
      upload(files);
    },
    onDragOver: (e: DragEvent<HTMLTextAreaElement>) => {
      if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
      e.preventDefault();
      if (!over) setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent<HTMLTextAreaElement>) => {
      setOver(false);
      const all = [...(e.dataTransfer?.files ?? [])];
      if (!all.length) return;
      e.preventDefault();
      const files = mediaFiles(e.dataTransfer?.files);
      if (files.length < all.length) store.toast("Only PNG, JPEG, GIF, WebP, WebM and MP4 files can be attached.", "bad");
      if (files.length) upload(files);
    },
    "data-drop": over ? "over" : undefined,
  };
  return { props, uploading };
}
