import { render, screen, waitFor } from '@testing-library/react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { useApp } from '../../../contexts/AppContext';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

vi.mock('../../../contexts/AppContext', () => ({
  useApp: vi.fn(),
}));

// Mock mermaid library
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockImplementation((_id, content) => {
      if (content.includes('error')) {
        return Promise.reject(new Error('Syntax error'));
      }
      return Promise.resolve({ svg: '<svg>Diagram SVG</svg>' });
    }),
  },
}));

describe('MarkdownRenderer with Mermaid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useApp).mockReturnValue({
      state: {
        vaultPath: '/vault',
      },
    } as any);
  });

  it('renders normal markdown text', () => {
    render(<MarkdownRenderer content="# Hello World" />);
    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('intercepts language-mermaid pre/code blocks and renders with MermaidRenderer', async () => {
    const content = `\`\`\`mermaid
graph TD
  A --> B
\`\`\``;
    
    render(<MarkdownRenderer content={content} />);
    
    await waitFor(() => {
      const container = document.querySelector('.mermaid-render-container');
      expect(container).toBeInTheDocument();
      expect(container?.innerHTML).toContain('<svg>Diagram SVG</svg>');
    });
  });

  it('renders syntax error box when mermaid compilation fails', async () => {
    const content = `\`\`\`mermaid
error graph TD
  A --> B
\`\`\``;
    
    render(<MarkdownRenderer content={content} />);
    
    await waitFor(() => {
      expect(screen.getByText('Mermaid Error: Syntax error')).toBeInTheDocument();
    });
  });
});
