/**
 * The API-key storage-protection warning in the AI settings tab.
 *
 * The one thing that must never regress: when the key is NOT in the OS
 * credential store, the user has to be told, in as many words. Silence would let
 * them assume a protection level that isn't there.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom';

import { AiSettingsTab } from '../AiSettingsTab';
import { getSecretStatus } from '../../../lib/storage';
import type { SecretStatus } from '../../../lib/secrets';

vi.mock('../../../lib/storage', () => ({
  getSecretStatus: vi.fn(),
}));

const statusMock = getSecretStatus as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => statusMock.mockReset());

function renderTab() {
  const noop = () => {};
  return render(
    <AiSettingsTab
      isZh={false}
      llmConfig={{ apiUrl: 'https://api.example.com', apiKey: '', model: 'gpt-4o-mini', providerId: 'openai' }}
      localApiUrl="https://api.example.com"
      setLocalApiUrl={noop}
      localApiKey=""
      setLocalApiKey={noop}
      localModel="gpt-4o-mini"
      setLocalModel={noop}
      customModel=""
      setCustomModel={noop}
      localSupportsThinking={false}
      setLocalSupportsThinking={noop}
      saved={false}
      hasChanges={false}
      handleProviderChange={noop}
      handleModelChange={noop}
      handleSaveConfig={noop}
      onConfigDirty={noop}
    />,
  );
}

describe('API key protection status', () => {
  it('warns loudly when the key is stored but NOT protected by the OS', async () => {
    const status: SecretStatus = {
      backend: 'unprotected-file',
      protected: false,
      has_key: true,
      fallback_reason: 'The OS credential store is unavailable (no Secret Service).',
    };
    statusMock.mockResolvedValue(status);

    renderTab();

    await waitFor(() => {
      expect(screen.getByTestId('api-key-unprotected-warning')).toBeInTheDocument();
    });
    // The reason travels through to the user, not just a generic line.
    expect(screen.getByText(/no Secret Service/)).toBeInTheDocument();
    // And it must NOT claim protection.
    expect(screen.queryByTestId('api-key-protected-note')).not.toBeInTheDocument();
  });

  it('confirms protection only when the OS credential store actually holds the key', async () => {
    const status: SecretStatus = {
      backend: 'os-keyring',
      protected: true,
      has_key: true,
      fallback_reason: null,
    };
    statusMock.mockResolvedValue(status);

    renderTab();

    await waitFor(() => {
      expect(screen.getByTestId('api-key-protected-note')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('api-key-unprotected-warning')).not.toBeInTheDocument();
  });

  it('stays silent when there is no key at all', async () => {
    const status: SecretStatus = {
      backend: 'none',
      protected: false,
      has_key: false,
      fallback_reason: null,
    };
    statusMock.mockResolvedValue(status);

    renderTab();

    // Give the effect a chance to resolve, then assert neither banner appeared.
    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    expect(screen.queryByTestId('api-key-unprotected-warning')).not.toBeInTheDocument();
    expect(screen.queryByTestId('api-key-protected-note')).not.toBeInTheDocument();
  });
});
