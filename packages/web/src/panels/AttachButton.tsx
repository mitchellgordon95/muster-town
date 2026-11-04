/** "Attach": picks a screenshot or video and uploads it into the text box, like pasting or dropping one (mediaPaste.ts). */
export function AttachButton({ media, disabled, small }: { media: { pick: () => void; uploading: number }; disabled?: boolean; small?: boolean }) {
  return (
    <button type="button" className={small ? "btn sm" : "btn"} disabled={disabled} onClick={media.pick}
      title="Attach a screenshot or short video (PNG, JPEG, GIF, WebP, WebM, MP4; up to 8 MiB). You can also paste or drop one into the box.">
      {media.uploading > 0 ? "Uploading…" : "Attach"}
    </button>
  );
}
