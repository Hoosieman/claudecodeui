import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { authenticatedFetch } from '../utils/api';

export type Plugin = {
  name: string;
  displayName: string;
  version: string;
  description: string;
  author: string;
  icon: string;
  type: 'react' | 'module';
  slot: 'tab';
  entry: string;
  server: string | null;
  permissions: string[];
  enabled: boolean;
  serverRunning: boolean;
  dirName: string;
  repoUrl: string | null;
};

type PluginsContextValue = {
  plugins: Plugin[];
  loading: boolean;
  pluginsError: string | null;
  refreshPlugins: () => Promise<void>;
  installPlugin: (url: string) => Promise<{ success: boolean; error?: string }>;
  uninstallPlugin: (name: string) => Promise<{ success: boolean; error?: string }>;
  updatePlugin: (name: string) => Promise<{ success: boolean; error?: string }>;
  togglePlugin: (name: string, enabled: boolean) => Promise<{ success: boolean; error: string | null }>;
};

const PluginsContext = createContext<PluginsContextValue | null>(null);

/**
 * Pull a displayable string out of a failed plugin API response.
 *
 * The server's error envelope is `{ success: false, error: { code, message,
 * details } }`, so `error` is an object rather than a string. Handing that
 * straight to a caller ends with an object in JSX, which throws during render
 * and — with no boundary around Settings — unmounts the whole app.
 */
async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json();
    const error = data?.error;
    if (typeof error === 'string' && error) return error;
    if (error && typeof error === 'object') {
      if (typeof error.message === 'string' && error.message) return error.message;
      if (typeof error.details === 'string' && error.details) return error.details;
    }
    if (typeof data?.details === 'string' && data.details) return data.details;
    if (typeof data?.message === 'string' && data.message) return data.message;
  } catch {
    // Body wasn't JSON — fall through to the status text.
  }
  return response.statusText || fallback;
}

export function usePlugins() {
  const context = useContext(PluginsContext);
  if (!context) {
    throw new Error('usePlugins must be used within a PluginsProvider');
  }
  return context;
}

export function PluginsProvider({ children }: { children: ReactNode }) {
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [pluginsError, setPluginsError] = useState<string | null>(null);

  const refreshPlugins = useCallback(async () => {
    try {
      const res = await authenticatedFetch('/api/plugins');
      if (res.ok) {
        const data = await res.json();
        setPlugins(data.plugins || []);
        setPluginsError(null);
      } else {
        setPluginsError(await readErrorMessage(res, `Failed to fetch plugins (${res.status})`));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch plugins';
      setPluginsError(message);
      console.error('[Plugins] Failed to fetch plugins:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshPlugins();
  }, [refreshPlugins]);

  const installPlugin = useCallback(async (url: string) => {
    try {
      const res = await authenticatedFetch('/api/plugins/install', {
        method: 'POST',
        body: JSON.stringify({ url }),
      });
      if (res.ok) {
        await refreshPlugins();
        return { success: true };
      }
      return { success: false, error: await readErrorMessage(res, 'Install failed') };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Install failed' };
    }
  }, [refreshPlugins]);

  const uninstallPlugin = useCallback(async (name: string) => {
    try {
      const res = await authenticatedFetch(`/api/plugins/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        await refreshPlugins();
        return { success: true };
      }
      return { success: false, error: await readErrorMessage(res, 'Uninstall failed') };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Uninstall failed' };
    }
  }, [refreshPlugins]);

  const updatePlugin = useCallback(async (name: string) => {
    try {
      const res = await authenticatedFetch(`/api/plugins/${encodeURIComponent(name)}/update`, {
        method: 'POST',
      });
      if (res.ok) {
        await refreshPlugins();
        return { success: true };
      }
      return { success: false, error: await readErrorMessage(res, 'Update failed') };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Update failed' };
    }
  }, [refreshPlugins]);

  const togglePlugin = useCallback(async (name: string, enabled: boolean): Promise<{ success: boolean; error: string | null }> => {
    try {
      const res = await authenticatedFetch(`/api/plugins/${encodeURIComponent(name)}/enable`, {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        return { success: false, error: await readErrorMessage(res, `Toggle failed (${res.status})`) };
      }
      await refreshPlugins();
      return { success: true, error: null };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Toggle failed' };
    }
  }, [refreshPlugins]);

  return (
    <PluginsContext.Provider value={{ plugins, loading, pluginsError, refreshPlugins, installPlugin, uninstallPlugin, updatePlugin, togglePlugin }}>
      {children}
    </PluginsContext.Provider>
  );
}
