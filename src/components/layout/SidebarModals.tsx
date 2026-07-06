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
  inputName: string;
  setInputName: (v: string) => void;
  onHandleCreateFile: () => void;
  onHandleCreateFolder: () => void;
  onHandleRename: () => void;
  onHandleDelete: () => void;
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
  inputName,
  setInputName,
  onHandleCreateFile,
  onHandleCreateFolder,
  onHandleRename,
  onHandleDelete,
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
    </>
  );
}