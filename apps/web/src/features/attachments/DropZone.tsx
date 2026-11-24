// The drop zone (SPEC-014 §3.1, §7; PLAN-014 S5): while files are dragged over the issue page a
// layer says where they go; dropped anywhere but an editor, they become attachments. The editor
// takes a file dropped on it as an inline upload (SPEC-013 E11) and marks the drop handled
// (`defaultPrevented`), so the page leaves it alone.
import { Paperclip } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import styles from './attachments.module.css';

/** The parts of a drag event the zone reads. */
export interface DragLike {
  readonly target: unknown;
  readonly defaultPrevented: boolean;
  readonly dataTransfer: Pick<DataTransfer, 'types' | 'files'> | null;
  preventDefault(): void;
}

/** Whether the drag carries files (not text or a link being moved). */
export const carriesFiles = (event: Pick<DragLike, 'dataTransfer'>): boolean =>
  event.dataTransfer !== null && Array.from(event.dataTransfer.types).includes('Files');

/** A drop inside an editor or a text field is that field's. */
function inEditor(target: unknown): boolean {
  return (
    target instanceof Element &&
    target.closest('[contenteditable="true"], input, textarea') !== null
  );
}

/** The files of a drop the page takes, or undefined when it isn't the page's. */
export function droppedFiles(event: DragLike): File[] | undefined {
  if (event.defaultPrevented || !carriesFiles(event) || inEditor(event.target)) return undefined;
  const files = Array.from(event.dataTransfer?.files ?? []);
  return files.length === 0 ? undefined : files;
}

export function DropZone({
  subject,
  onFiles,
}: {
  /** "ENG-42", for the layer's text. */
  subject: string;
  onFiles: (files: readonly File[]) => void;
}) {
  const [shown, setShown] = useState(false);
  const latest = useRef(onFiles);
  useEffect(() => {
    latest.current = onFiles;
  });

  useEffect(() => {
    // Enter and leave fire for every element crossed: count them, so the layer stays up.
    let depth = 0;
    const onEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth += 1;
      setShown(true);
    };
    const onLeave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setShown(false);
    };
    const onOver = (event: DragEvent) => {
      // Allows the drop; an editor under the pointer still handles its own.
      if (carriesFiles(event) && !inEditor(event.target)) event.preventDefault();
    };
    const onDrop = (event: DragEvent) => {
      depth = 0;
      setShown(false);
      const files = droppedFiles(event);
      if (files === undefined) return;
      event.preventDefault();
      latest.current(files);
    };
    const onEnd = () => {
      depth = 0;
      setShown(false);
    };
    document.addEventListener('dragenter', onEnter);
    document.addEventListener('dragleave', onLeave);
    document.addEventListener('dragover', onOver);
    document.addEventListener('drop', onDrop);
    document.addEventListener('dragend', onEnd);
    return () => {
      document.removeEventListener('dragenter', onEnter);
      document.removeEventListener('dragleave', onLeave);
      document.removeEventListener('dragover', onOver);
      document.removeEventListener('drop', onDrop);
      document.removeEventListener('dragend', onEnd);
    };
  }, []);

  if (!shown) return null;
  return (
    <div className={styles.dropZone} aria-hidden="true" data-testid="attachment-drop-zone">
      <div className={styles.dropMessage}>
        <Paperclip />
        <span>{`Drop files to attach them to ${subject}`}</span>
      </div>
    </div>
  );
}
