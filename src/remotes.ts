import type { Repository } from './git';

export interface RemoteAddress { remote: string; direction: 'Fetch' | 'Push'; url: string }

// Keep embedded HTTP credentials out of the picker and copied display address.
// Existing Git configuration is never modified.
export function displayRemoteUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    let changed = !!url.username || !!url.password;
    url.username = ''; url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/token|password|secret|credential|signature|(^|_)key$/i.test(key)) { url.searchParams.set(key, 'REDACTED'); changed = true; }
    }
    return changed ? url.toString() : value;
  } catch { return value.replace(/^(https?:\/\/)[^/]*@/i, '$1'); }
}

export async function remoteAddresses(repo: Repository): Promise<RemoteAddress[]> {
  const names = (await repo.run(['remote'])).split('\n').filter(Boolean);
  const results = await Promise.all(names.map(async remote => {
    const [fetch, push] = await Promise.all([
      repo.run(['remote', 'get-url', '--all', '--', remote]),
      repo.run(['remote', 'get-url', '--push', '--all', '--', remote]),
    ]);
    return ([['Fetch', fetch], ['Push', push]] as const).flatMap(([direction, output]) => output.replace(/\n$/, '').split('\n').filter(Boolean).map(url => ({ remote, direction, url: displayRemoteUrl(url) })));
  }));
  return results.flat();
}
