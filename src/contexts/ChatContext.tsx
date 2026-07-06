import { createContext, useContext, useState, ReactNode, useCallback } from 'react';
import { SearchMode } from '../lib/tauri';

export interface NoteAttachment {
  name: string;
  path: string;
}

export interface ChatState {
  isChatOpen: boolean;
  searchQuery: string;
  searchMode: SearchMode;
  pendingAttachments: NoteAttachment[];
  pendingChatPrompt: string | null;
}

export interface ChatContextType {
  state: ChatState;
  setState: React.Dispatch<React.SetStateAction<ChatState>>;
  toggleChat: () => void;
  setSearchQuery: (query: string) => void;
  setSearchMode: (mode: SearchMode) => void;
  attachNoteToChat: (name: string, path: string) => void;
  clearPendingAttachments: () => void;
  setPendingChatPrompt: (prompt: string) => void;
  clearPendingChatPrompt: () => void;
}

export const ChatContext = createContext<ChatContextType | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ChatState>({
    isChatOpen: false,
    searchQuery: '',
    searchMode: 'fts',
    pendingAttachments: [],
    pendingChatPrompt: null,
  });

  const toggleChat = useCallback(() => {
    setState((s) => ({ ...s, isChatOpen: !s.isChatOpen }));
  }, []);

  const setSearchQuery = useCallback((query: string) => {
    setState((s) => ({ ...s, searchQuery: query }));
  }, []);

  const setSearchMode = useCallback((mode: SearchMode) => {
    setState((s) => ({ ...s, searchMode: mode }));
  }, []);

  const attachNoteToChat = useCallback((name: string, path: string) => {
    setState((s) => {
      // Avoid duplicates
      if (s.pendingAttachments.some(a => a.path === path)) return s;
      return {
        ...s,
        isChatOpen: true,  // Auto-open chat when attaching
        pendingAttachments: [...s.pendingAttachments, { name, path }],
      };
    });
  }, []);

  const clearPendingAttachments = useCallback(() => {
    setState((s) => ({ ...s, pendingAttachments: [] }));
  }, []);

  const setPendingChatPrompt = useCallback((prompt: string) => {
    setState((s) => ({ ...s, pendingChatPrompt: prompt, isChatOpen: true }));
  }, []);

  const clearPendingChatPrompt = useCallback(() => {
    setState((s) => ({ ...s, pendingChatPrompt: null }));
  }, []);

  return (
    <ChatContext.Provider
      value={{
        state,
        setState,
        toggleChat,
        setSearchQuery,
        setSearchMode,
        attachNoteToChat,
        clearPendingAttachments,
        setPendingChatPrompt,
        clearPendingChatPrompt,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used within a ChatProvider');
  }
  return context;
}
