/** Shared account POST transport; never retries a write with an uncertain result. */
export async function accountRequest(path: string, payload: Record<string, unknown>) {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), cache: 'no-store' });
  const data = await response.json() as { error?: string; redirect?: string; message?: string };
  if (!response.ok) throw new Error(data.error || 'Your request could not be completed. Please try again.');
  return data;
}
