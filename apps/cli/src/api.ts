const BASE_URL = process.env.OPENBRIDGE_URL ?? 'http://localhost:8582'

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`)
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${await res.text()}`)
  }
  return res.json() as Promise<T>
}

export async function checkDaemon(): Promise<boolean> {
  try {
    await apiGet('/api/health')
    return true
  } catch {
    return false
  }
}
