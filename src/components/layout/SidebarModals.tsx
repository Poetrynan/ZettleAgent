import { Modal } from '../common/Modal';
import { t } from '../../lib/i18n';
import { DirTreeNode } from '../../lib/tauri';

interface SidebarModalsProps {
  createFileDialog: DirTreeNode | null;
  setCreateFileDialog: (v: DirTreeNode | null) => void;
  createFolderDialog: DirTreeNode | null;
  setCreateFolderDialog: (v: DirTreeNode | null) => void;
  renameDialog: DirTreeNode | null;
  setRenameDialog: (v: DirTreeNode | null) => void;
  deleteConfirm: DirTreeNode | null;
  setDeleteConfirm: (v: DirTreeNode | null) => void;
  deleteDailyConfirm: boolean;
  setDeleteDailyConfirm: (v: boolean) => void;
  removeVaultConfirm: { path: string; name: string } | null;
  setRemoveVaultConfirm: (v: { path: string; name: string } | null) => void;
  clearDirectoryConfirm: { node: DirTreeNode; fileCount: number } | null;
  setClearDirectoryConfirm: (v: { node: DirTreeNode; fileCount: number } | null) => void;
  inputName: string;
  setInputName: (v: string) => void;
  onHandleCreateFile: () => void | Promise<void>;
  onHandleCreateFolder: () => void | Promise<void>;
  onHandleRename: () => void | Promise<void>;
  onHandleDelete: () => void | Promise<void>;
  onHandleDeleteDaily?: () => void | Promise<void>;
  onHandleRemoveVault?: () => void | Promise<void>;
  onHandleClearDirectory?: () => void | Promise<void>;
  lang?: string;
}

export default function SidebarModals({
  createFileDialog,
  setCreateFileDialog,
  createFolderDialog,
  setCreateFolderDialog,
  renameDialog,
  setRenameDialog,
  deleteConfirm,
  setDeleteConfirm,
  deleteDailyConfirm,
  setDeleteDailyConfirm,
  removeVaultConfirm,
  setRemoveVaultConfirm,
  inputName,
  setInputName,
  onHandleCreateFile,
  onHandleCreateFolder,
  onHandleRename,
  onHandleDelete,
  onHandleDeleteDaily,
  onHandleRemoveVault,
  onHandleClearDirectory,
  clearDirectoryConfirm,
  setClearDirectoryConfirm,
  lang = 'zh',
}: SidebarModalsProps) {
  return (
    <>
      {/* Create File Modal */}
      <Modal
        isOpen={createFileDialog !== null}
        onClose={() => setCreateFileDialog(null)}
        title={t('sidebar.newFile')}
      >
        <div className="modal-content">
          <label className="label">{t('sidebar.fileName')}</label>
          <div className="modal-input-wrapper">
            <input
              type="text"
              className="input"
              value={inputName}
              onChange={(e) => setInputName(e.target.value)}
              placeholder={t('sidebar.enterName')}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') onHandleCreateFile();
              }}
            />
          </div>
          <div className="modal-input-hint">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 16v-4"/>
              <path d="M12 8h.01"/>
            </svg>
            <span>Tip: 自动添加 <code>.md</code> 扩展名</span>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setCreateFileDialog(null)}>
            {t('sidebar.cancel')}
          </button>
          <button className="btn btn-primary" onClick={onHandleCreateFile} disabled={!inputName.trim()} title={!inputName.trim() ? '请输入名称' : undefined}>
            {t('sidebar.confirm')}
          </button>
        </div>
      </Modal>

      {/* Create Folder Modal */}
      <Modal
        isOpen={createFolderDialog !== null}
        onClose={() => setCreateFolderDialog(null)}
        title={t('sidebar.newFolder')}
      >
        <div className="modal-content">
          <label className="label">{t('sidebar.folderName')}</label>
          <div className="modal-input-wrapper modal-input-wrapper--folder">
            <input
              type="text"
              className="input"
              value={inputName}
              onChange={(e) => setInputName(e.target.value)}
              placeholder={t('sidebar.enterName')}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') onHandleCreateFolder();
              }}
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setCreateFolderDialog(null)}>
            {t('sidebar.cancel')}
          </button>
          <button className="btn btn-primary" onClick={onHandleCreateFolder} disabled={!inputName.trim()} title={!inputName.trim() ? '请输入名称' : undefined}>
            {t('sidebar.confirm')}
          </button>
        </div>
      </Modal>

      {/* Rename Modal */}
      <Modal
        isOpen={renameDialog !== null}
        onClose={() => setRenameDialog(null)}
        title={t('sidebar.rename')}
      >
        <div className="modal-content">
          <label className="label">
            {renameDialog?.is_dir ? t('sidebar.folderName') : t('sidebar.fileName')}
          </label>
          <div className={`modal-input-wrapper ${renameDialog?.is_dir ? 'modal-input-wrapper--folder' : ''}`}>
            <input
              type="text"
              className="input"
              value={inputName}
              onChange={(e) => setInputName(e.target.value)}
              placeholder={t('sidebar.enterName')}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') onHandleRename();
              }}
            />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setRenameDialog(null)}>
            {t('sidebar.cancel')}
          </button>
          <button className="btn btn-primary" onClick={onHandleRename} disabled={!inputName.trim()} title={!inputName.trim() ? '请输入名称' : undefined}>
            {t('sidebar.confirm')}
          </button>
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={deleteConfirm !== null}
        onClose={() => setDeleteConfirm(null)}
        title={t('sidebar.deleteConfirmTitle')}
      >
        <div className="modal-content">
          <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-base)' }}>
            {t('sidebar.deleteConfirmMsg').replace('{name}', deleteConfirm?.name || '')}
          </p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setDeleteConfirm(null)}>
            {t('sidebar.cancel')}
          </button>
          <button className="btn btn-danger" onClick={onHandleDelete}>
            {t('sidebar.confirm')}
          </button>
        </div>
      </Modal>

      {/* Delete Daily Notes Folder Confirmation Modal */}
      <Modal
        isOpen={deleteDailyConfirm}
        onClose={() => setDeleteDailyConfirm(false)}
        title={lang === 'zh' ? '删除日记文件夹' : 'Delete Daily Notes Folder'}
      >
        <div className="modal-content">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: '16px' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <div>
              <p style={{ color: 'var(--text-primary)', fontSize: 'var(--text-base)', fontWeight: 500, marginBottom: '8px' }}>
                {lang === 'zh' ? '确定要删除日记文件夹吗？' : 'Are you sure you want to delete the daily notes folder?'}
              </p>
              <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
                {lang === 'zh'
                  ? '此操作将永久删除日记文件夹及其中的所有日记文件。此操作不可恢复。'
                  : 'This will permanently delete the daily notes folder and all notes within it. This action cannot be undone.'}
              </p>
            </div>
          </div>
          <div style={{ background: 'var(--bg-tertiary)', padding: '12px', borderRadius: '8px', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            <strong style={{ color: 'var(--text-primary)' }}>{lang === 'zh' ? '提示：' : 'Tip: '}</strong>
            {lang === 'zh'
              ? '所有日记都存储在此文件夹中。删除后，您可以在桌面重新创建日记文件夹。'
              : 'All daily notes are stored in this folder. After deletion, you can recreate the daily notes folder on your desktop.'}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setDeleteDailyConfirm(false)}>
            {lang === 'zh' ? '取消' : 'Cancel'}
          </button>
          <button className="btn btn-danger" onClick={onHandleDeleteDaily}>
            {lang === 'zh' ? '删除文件夹' : 'Delete Folder'}
          </button>
        </div>
      </Modal>

      {/* Remove Vault from Workspace Confirmation Modal */}
      <Modal
        isOpen={removeVaultConfirm !== null}
        onClose={() => setRemoveVaultConfirm(null)}
        title={lang === 'zh' ? '从工作区移除' : 'Remove from Workspace'}
      >
        <div className="modal-content">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: '16px' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <div>
              <p style={{ color: 'var(--text-primary)', fontSize: 'var(--text-base)', fontWeight: 500, marginBottom: '8px' }}>
                {lang === 'zh'
                  ? `确定要将「${removeVaultConfirm?.name || ''}」从工作区移除吗？`
                  : `Remove "${removeVaultConfirm?.name || ''}" from workspace?`}
              </p>
              <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
                {lang === 'zh'
                  ? '此操作只会将该文件夹从软件工作区中移除，不会删除原文件夹中的任何文件。您可以随时重新添加该文件夹。'
                  : 'This will only remove the folder from the workspace. No files in the original folder will be deleted. You can re-add this folder at any time.'}
              </p>
            </div>
          </div>
          <div style={{ background: 'var(--bg-tertiary)', padding: '12px', borderRadius: '8px', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            <strong style={{ color: 'var(--text-primary)' }}>{lang === 'zh' ? '提示：' : 'Tip: '}</strong>
            {lang === 'zh'
              ? '原文件夹及其中的所有文件将保持不变。'
              : 'The original folder and all its files will remain unchanged.'}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setRemoveVaultConfirm(null)}>
            {lang === 'zh' ? '取消' : 'Cancel'}
          </button>
          <button className="btn btn-danger" onClick={onHandleRemoveVault}>
            {lang === 'zh' ? '移除' : 'Remove'}
          </button>
        </div>
      </Modal>

      {/* Clear Directory Confirmation Modal */}
      <Modal
        isOpen={clearDirectoryConfirm !== null}
        onClose={() => setClearDirectoryConfirm(null)}
        title={lang === 'zh' ? '清空目录' : 'Clear Directory'}
      >
        <div className="modal-content">
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', marginBottom: '16px' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <div>
              <p style={{ color: 'var(--text-primary)', fontSize: 'var(--text-base)', fontWeight: 500, marginBottom: '8px' }}>
                {lang === 'zh'
                  ? `确定要清空「${clearDirectoryConfirm?.node.name || ''}」下的 ${clearDirectoryConfirm?.fileCount || 0} 篇笔记吗？`
                  : `Clear ${clearDirectoryConfirm?.fileCount || 0} notes under "${clearDirectoryConfirm?.node.name || ''}"?`}
              </p>
              <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
                {lang === 'zh'
                  ? '这将从文件系统和数据库中删除这些笔记，且不可恢复。'
                  : 'This will delete them from filesystem and database, and cannot be undone.'}
              </p>
            </div>
          </div>
          <div style={{ background: 'var(--bg-tertiary)', padding: '12px', borderRadius: '8px', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
            <strong style={{ color: 'var(--text-primary)' }}>{lang === 'zh' ? '警告：' : 'Warning: '}</strong>
            {lang === 'zh'
              ? '此操作不可撤销，所有笔记将被永久删除。'
              : 'This action cannot be undone. All notes will be permanently deleted.'}
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={() => setClearDirectoryConfirm(null)}>
            {lang === 'zh' ? '取消' : 'Cancel'}
          </button>
          <button className="btn btn-danger" onClick={onHandleClearDirectory}>
            {lang === 'zh' ? '清空目录' : 'Clear Directory'}
          </button>
        </div>
      </Modal>
    </>
  );
}