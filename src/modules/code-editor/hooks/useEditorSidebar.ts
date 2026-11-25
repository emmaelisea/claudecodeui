import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Project,CodeEditorDiffInfo,CodeEditorFile } from '@/shared/types';

type UseEditorSidebarOptions = {
  selectedProject: Project | null;
  isMobile: boolean;
  initialWidth?: number;
};

export const useEditorSidebar = ({
  selectedProject,
  isMobile,
  initialWidth = 600,
}: UseEditorSidebarOptions) => {
  const { t } = useTranslation('codeEditor');
  const [editingFile, setEditingFile] = useState<CodeEditorFile | null>(null);
  const [editorWidth, setEditorWidth] = useState(initialWidth);
  const [editorExpanded, setEditorExpanded] = useState(false);
  // Tracks the active split-pane drag, including whether a release moved at all.
  const [resizeDrag, setResizeDrag] = useState<{ pointerId: number; startX: number } | null>(null);
  const [hasManualWidth, setHasManualWidth] = useState(false);
  const resizeHandleRef = useRef<HTMLDivElement | null>(null);
  // Whether the open editor's buffer differs from disk, as reported by
  // CodeEditor. A ref rather than state or a dependency: it is only read inside
  // `handleFileOpen`, and keeping it out of that callback's dependency list
  // keeps the callback stable for the memoised chat and tree consumers.
  const hasUnsavedChangesRef = useRef(false);
  // The open file, mirrored for the same reason: `handleFileOpen` has to know
  // which file is on screen without re-creating itself whenever it changes.
  const editingFileRef = useRef<CodeEditorFile | null>(null);

  useEffect(() => {
    editingFileRef.current = editingFile;
  }, [editingFile]);

  const handleUnsavedChangesChange = useCallback((hasUnsavedChanges: boolean) => {
    hasUnsavedChangesRef.current = hasUnsavedChanges;
  }, []);

  // Returns whether the file was opened, i.e. false when the user kept the
  // unsaved buffer, so callers can skip follow-ups such as switching tabs.
  const handleFileOpen = useCallback(
    (filePath: string, diffInfo: CodeEditorDiffInfo | null = null, line: number | null = null): boolean => {
      // Only the open file of the same project (nested projects share absolute
      // paths) without a diff payload reuses the buffer; any other open reloads
      // it and would lose unsaved edits, so it asks like closing does.
      const openFile = editingFileRef.current;
      const reusesBuffer = openFile !== null
        && openFile.path === filePath
        && openFile.projectId === selectedProject?.projectId
        && !openFile.diffInfo
        && !diffInfo;
      if (
        openFile !== null
        && !reusesBuffer
        && hasUnsavedChangesRef.current
        // No inline fallback here on purpose: CodeEditor's `requestClose` owns
        // the one for this key, and two copies would eventually disagree.
        && !window.confirm(t('unsavedChanges.confirmClose'))
      ) {
        return false;
      }

      const normalizedPath = filePath.replace(/\\/g, '/');
      const fileName = normalizedPath.split('/').pop() || filePath;

      setEditingFile({
        name: fileName,
        path: filePath,
        // DB projectId is forwarded to the editor so it can read/save files
        // via `/api/file-tree/projects/:projectId/file` endpoints.
        projectId: selectedProject?.projectId,
        diffInfo,
        line,
      });
      return true;
    },
    [selectedProject?.projectId, t],
  );

  const handleCloseEditor = useCallback(() => {
    setEditingFile(null);
    setEditorExpanded(false);
  }, []);

  const handleToggleEditorExpand = useCallback(() => {
    setEditorExpanded((previous) => !previous);
  }, []);

  const handleResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isMobile || !event.isPrimary || event.button !== 0) {
        return;
      }

      // Until the first drag, a fill-space tab (Files) lays the editor out with
      // flex and never writes `editorWidth`, which still holds `initialWidth`.
      // Seed it with the width on screen so switching to the fixed-width layout
      // doesn't snap the editor to the default before the pointer moves. Both
      // updates land in the same render, so the stale width is never painted.
      const editorPane = resizeHandleRef.current?.nextElementSibling;
      if (editorPane instanceof HTMLElement) {
        setEditorWidth(editorPane.getBoundingClientRect().width);
      }

      event.preventDefault();
      // The fixed hit area also keeps Chromium's embedded PDF viewer from
      // intercepting the drag before it reaches the captured pointer.
      event.currentTarget.dataset.resizing = 'true';
      event.currentTarget.setPointerCapture(event.pointerId);
      // After first drag interaction, the editor width is user-controlled.
      setHasManualWidth(true);
      setResizeDrag({ pointerId: event.pointerId, startX: event.clientX });
    },
    [isMobile],
  );

  useEffect(() => {
    const handle = resizeHandleRef.current;
    const mainContainer = handle?.parentElement?.parentElement;
    if (!resizeDrag || !handle || !mainContainer) {
      return undefined;
    }
    const { pointerId, startX } = resizeDrag;

    // `editorWidth` is read by WorkspaceMain, so every commit re-renders the
    // whole workspace including the chat transcript. A high-polling-rate mouse
    // fires several pointermove events per frame, so the width is coalesced to one
    // commit per frame — the same visual result for a fraction of the renders.
    let pendingWidth: number | null = null;
    let frameHandle: number | null = null;

    const commitPendingWidth = () => {
      frameHandle = null;
      if (pendingWidth !== null) {
        setEditorWidth(pendingWidth);
        pendingWidth = null;
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      const containerRect = mainContainer.getBoundingClientRect();
      const newWidth = containerRect.right - event.clientX;
      const maxWidth = containerRect.width * 0.8;
      pendingWidth = Math.min(maxWidth, Math.max(300, newWidth));
      if (frameHandle === null) {
        frameHandle = requestAnimationFrame(commitPendingWidth);
      }
    };

    const finishResize = () => setResizeDrag(null);
    const handlePointerEnd = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if (event.type === 'pointerup' && event.clientX !== startX) handlePointerMove(event);
      finishResize();
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerEnd);
    document.addEventListener('pointercancel', handlePointerEnd);
    document.addEventListener('lostpointercapture', handlePointerEnd);
    window.addEventListener('blur', finishResize);
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      if (frameHandle !== null) {
        cancelAnimationFrame(frameHandle);
      }
      // Land on the last position the pointer reached rather than the last
      // frame that happened to commit.
      commitPendingWidth();
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerEnd);
      document.removeEventListener('pointercancel', handlePointerEnd);
      document.removeEventListener('lostpointercapture', handlePointerEnd);
      window.removeEventListener('blur', finishResize);
      delete handle.dataset.resizing;
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
    };
  }, [resizeDrag]);

  return {
    editingFile,
    editorWidth,
    editorExpanded,
    hasManualWidth,
    resizeHandleRef,
    handleFileOpen,
    handleCloseEditor,
    handleToggleEditorExpand,
    handleResizeStart,
    handleUnsavedChangesChange,
  };
};
