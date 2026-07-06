/**
 * useCanvasPaste — 画布粘贴处理
 * 支持：截图粘贴、PDF 文件、图片路径、URL、纯文本
 */
import { useCallback, useRef } from 'react';
import type { Node } from '@xyflow/react';
import { saveImageToVault } from '../../lib/tauri';

interface CanvasPasteParams {
  reactFlowInstance: any;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
  lang: string;
  vaultPath: string | null;
}

export function useCanvasPaste({ reactFlowInstance, setNodes, showToast, lang, vaultPath }: CanvasPasteParams) {
  const mousePositionRef = useRef<{ x: number; y: number }>({ x: window.innerWidth / 2, y: window.innerHeight / 2 });

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    mousePositionRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handlePaste = useCallback(async (e: ClipboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement)?.isContentEditable) return;

    const position = reactFlowInstance.screenToFlowPosition(mousePositionRef.current);
    const genId = () => `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    // 1. 剪贴板图片（截图）
    const items = e.clipboardData?.items;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) continue;
          try {
            const reader = new FileReader();
            const base64 = await new Promise<string>((resolve, reject) => {
              reader.onload = () => resolve((reader.result as string).split(',')[1]);
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
            const ext = blob.type.split('/')[1] || 'png';
            if (vaultPath) {
              const savedPath = await saveImageToVault(vaultPath, `attachments/paste-${Date.now()}.${ext}`, base64);
              setNodes(nds => nds.concat({
                id: genId(), type: 'image', position,
                width: 300, height: 220, style: { width: 300, height: 220 },
                data: { file: savedPath },
              }));
              showToast(lang === 'zh' ? '已粘贴图片' : 'Image pasted', 'success');
            } else {
              showToast(lang === 'zh' ? '请先设置 Vault 路径' : 'Set vault path first', 'error');
            }
          } catch (err) {
            showToast(`Paste image failed: ${err}`, 'error');
          }
          return;
        }
      }
    }

    // 2. 粘贴文件（如从资源管理器拖入 PDF）
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      let created = false;
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const ext = file.name.split('.').pop()?.toLowerCase() || '';
        if (ext === 'pdf') {
          e.preventDefault();
          setNodes(nds => nds.concat({
            id: genId(), type: 'pdf', position: { x: position.x, y: position.y + i * 470 },
            width: 420, height: 450, style: { width: 420, height: 450 },
            data: { file: (file as any).path || file.name, lang },
          }));
          created = true;
        }
      }
      if (created) {
        showToast(lang === 'zh' ? '已粘贴 PDF 卡片' : 'PDF card pasted', 'success');
        return;
      }
    }

    // 3. 剪贴板文本
    const text = e.clipboardData?.getData('text/plain')?.trim();
    if (!text) return;

    // 3a. PDF 路径
    if (/^[A-Za-z]:\\.*\.pdf$|^\/.*\.pdf$|^\\\\.*\.pdf$/i.test(text)) {
      e.preventDefault();
      setNodes(nds => nds.concat({
        id: genId(), type: 'pdf', position,
        width: 420, height: 450, style: { width: 420, height: 450 },
        data: { file: text, lang },
      }));
      showToast(lang === 'zh' ? '已粘贴 PDF 卡片' : 'PDF card pasted', 'success');
      return;
    }

    // 3b. 图片路径
    if (/^[A-Za-z]:\\.*\.(png|jpg|jpeg|gif|webp|bmp|svg)$|^\/.*\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(text)) {
      e.preventDefault();
      setNodes(nds => nds.concat({
        id: genId(), type: 'image', position,
        width: 300, height: 220, style: { width: 300, height: 220 },
        data: { file: text },
      }));
      showToast(lang === 'zh' ? '已粘贴图片' : 'Image pasted', 'success');
      return;
    }

    // 3c. URL
    if (/^(https?:\/\/|www\.)[^\s]+$/i.test(text)) {
      e.preventDefault();
      const finalUrl = /^https?:\/\//i.test(text) ? text : 'https://' + text;
      setNodes(nds => nds.concat({
        id: genId(), type: 'web', position,
        width: 360, height: 280, style: { width: 360, height: 280 },
        data: { url: finalUrl, lang },
      }));
      showToast(lang === 'zh' ? '已粘贴网页卡片' : 'Web card pasted', 'success');
      return;
    }

    // 3d. 纯文本 → 便签
    e.preventDefault();
    setNodes(nds => nds.concat({
      id: genId(), type: 'text', position,
      width: 260, height: 200, style: { width: 260, height: 200 },
      data: { text: text.length > 2000 ? text.slice(0, 2000) + '…' : text, color: '#fef08a' },
    }));
    showToast(lang === 'zh' ? '已粘贴文本卡片' : 'Text card pasted', 'success');
  }, [reactFlowInstance, setNodes, lang, vaultPath, showToast]);

  return { handlePaste, handleMouseMove };
}
