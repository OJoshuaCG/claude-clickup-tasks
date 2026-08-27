// Optional direct ClickUp REST access, used only by the installer.
//
// Why this exists at all: the MCP connector Claude Code exposes is an OAuth integration with no
// token on disk, so nothing outside a Claude session can call it. That leaves the installer
// unable to answer the one question that matters most — "which numeric ClickUp user is this
// person?" — and an unresolved identity is exactly the bug this whole tool is meant to kill.
//
// So: if the developer happens to have a personal API token (`pk_…`), we finish the job during
// install. If they do not, we record the identity as UNRESOLVED and the first Claude session
// resolves it through MCP and writes it back. Both paths end at a confirmed numeric id; neither
// path ever falls back to "me".
//
// Every function returns `{ ok, data, error }`. No throwing: a network failure during install
// must degrade to "resolve it later", not abort the installation.

const API = 'https://api.clickup.com/api/v2';
const TIMEOUT_MS = 15_000;

async function call(token, endpoint) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}${endpoint}`, {
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const detail = body?.err || body?.ECODE || text?.slice(0, 200) || `HTTP ${res.status}`;
      return { ok: false, data: null, error: `${res.status} — ${detail}` };
    }
    return { ok: true, data: body, error: null };
  } catch (err) {
    const message =
      err?.name === 'AbortError'
        ? `sin respuesta en ${TIMEOUT_MS / 1000}s`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, data: null, error: message };
  } finally {
    clearTimeout(timer);
  }
}

export function looksLikeToken(value) {
  return typeof value === 'string' && /^pk_[A-Za-z0-9_]{10,}$/.test(value.trim());
}

/** Workspaces (ClickUp calls them "teams") with their member lists. */
export async function listWorkspaces(token) {
  const res = await call(token, '/team');
  if (!res.ok) return res;
  const teams = Array.isArray(res.data?.teams) ? res.data.teams : [];
  return {
    ok: true,
    error: null,
    data: teams.map((t) => ({
      id: String(t.id),
      name: t.name,
      members: (Array.isArray(t.members) ? t.members : [])
        .map((m) => m?.user)
        .filter(Boolean)
        .map((u) => ({
          id: String(u.id),
          username: u.username ?? null,
          email: u.email ?? null,
        })),
    })),
  };
}

/**
 * Find the member matching an email or username.
 *
 * Returns ALL plausible candidates rather than a single guess, and marks whether the match was
 * exact. That distinction is the whole point: an exact email match can be trusted, while "the
 * surname looks right" is a guess, and a guess that silently assigns work to the wrong colleague
 * is the failure mode this replaces. Ambiguity is handed to the human, not resolved by ranking.
 */
export function matchMember(members, needle) {
  const q = String(needle ?? '').trim().toLowerCase();
  if (!q) return { exact: [], fuzzy: [] };

  const exact = members.filter(
    (m) => m.email?.toLowerCase() === q || m.username?.toLowerCase() === q,
  );
  if (exact.length) return { exact, fuzzy: [] };

  const local = q.includes('@') ? q.split('@')[0] : q;
  const fuzzy = members.filter((m) => {
    const email = m.email?.toLowerCase() ?? '';
    const user = m.username?.toLowerCase() ?? '';
    if (!local) return false;
    return (
      email.startsWith(`${local}@`) ||
      email.includes(local) ||
      user.includes(local) ||
      local.includes(user.replace(/\s+/g, ''))
    );
  });
  return { exact: [], fuzzy };
}

export async function listSpaces(token, workspaceId) {
  const res = await call(token, `/team/${workspaceId}/space?archived=false`);
  if (!res.ok) return res;
  const spaces = Array.isArray(res.data?.spaces) ? res.data.spaces : [];
  return {
    ok: true,
    error: null,
    data: spaces.map((s) => ({ id: String(s.id), name: s.name })),
  };
}

export async function listFolders(token, spaceId) {
  const res = await call(token, `/space/${spaceId}/folder?archived=false`);
  if (!res.ok) return res;
  const folders = Array.isArray(res.data?.folders) ? res.data.folders : [];
  return {
    ok: true,
    error: null,
    data: folders.map((f) => ({
      id: String(f.id),
      name: f.name,
      lists: (Array.isArray(f.lists) ? f.lists : []).map((l) => ({
        id: String(l.id),
        name: l.name,
      })),
    })),
  };
}

/** Lists sitting directly in a space, i.e. not inside any folder. */
export async function listFolderlessLists(token, spaceId) {
  const res = await call(token, `/space/${spaceId}/list?archived=false`);
  if (!res.ok) return res;
  const lists = Array.isArray(res.data?.lists) ? res.data.lists : [];
  return {
    ok: true,
    error: null,
    data: lists.map((l) => ({ id: String(l.id), name: l.name })),
  };
}

/** Confirms a task id exists and is usable as an umbrella parent. */
export async function getTask(token, taskId) {
  const res = await call(token, `/task/${taskId}`);
  if (!res.ok) return res;
  const t = res.data;
  return {
    ok: true,
    error: null,
    data: {
      id: String(t?.id ?? taskId),
      name: t?.name ?? null,
      status: t?.status?.status ?? null,
      list_id: t?.list?.id ? String(t.list.id) : null,
      list_name: t?.list?.name ?? null,
      space_id: t?.space?.id ? String(t.space.id) : null,
    },
  };
}
