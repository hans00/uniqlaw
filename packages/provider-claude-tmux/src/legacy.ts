// v2 → UniQlaw takeover: a migrated session may still be running in a v2
// `claudeclaw-*` tmux session on the user's DEFAULT tmux socket. Two claude
// processes appending to one session jsonl would corrupt it, so before we
// `--resume` on the instance socket we find and kill any default-socket tmux
// session whose pane process tree runs claude with this session id.

export interface PaneInfo { session: string; pid: number }
export interface ProcInfo { pid: number; ppid: number; args: string }

export interface LegacyDeps {
  listDefaultPanes(): Promise<PaneInfo[]>;
  listProcs(): Promise<ProcInfo[]>;
  killDefaultSession(name: string): Promise<void>;
}

/** Pure: which default-socket tmux sessions run `claude … <sessionId>`. */
export function findLegacySessions(sessionId: string, panes: PaneInfo[], procs: ProcInfo[]): string[] {
  const children = new Map<number, ProcInfo[]>();
  for (const p of procs) {
    const list = children.get(p.ppid) ?? [];
    list.push(p);
    children.set(p.ppid, list);
  }
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const runsSession = (args: string) => /\bclaude\b/.test(args) && args.includes(sessionId);
  const hits = new Set<string>();
  for (const pane of panes) {
    const stack: number[] = [pane.pid];
    const seen = new Set<number>();
    while (stack.length) {
      const pid = stack.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const self = byPid.get(pid);
      if (self && runsSession(self.args)) { hits.add(pane.session); break; }
      for (const c of children.get(pid) ?? []) stack.push(c.pid);
    }
  }
  return [...hits];
}

export async function killLegacySessions(sessionId: string, deps: LegacyDeps): Promise<string[]> {
  const [panes, procs] = await Promise.all([deps.listDefaultPanes(), deps.listProcs()]);
  const hits = findLegacySessions(sessionId, panes, procs);
  for (const s of hits) await deps.killDefaultSession(s);
  return hits;
}

async function run(argv: string[], env: Record<string, string | undefined>): Promise<{ out: string; code: number }> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: env as Record<string, string> });
  const out = await new Response(p.stdout).text();
  return { out, code: await p.exited };
}

/** Real implementation against the user's default tmux socket and `ps`. */
export function systemLegacyDeps(env: Record<string, string | undefined> = process.env): LegacyDeps {
  // Drop TMUX so `tmux` without -L targets the default server even if the daemon runs inside tmux.
  const e = { ...env, TMUX: undefined };
  return {
    async listDefaultPanes() {
      const r = await run(["tmux", "list-panes", "-a", "-F", "#{session_name}\t#{pane_pid}"], e);
      if (r.code !== 0) return [];
      return r.out.split("\n").filter(Boolean).map((l) => {
        const [session, pid] = l.split("\t");
        return { session, pid: Number(pid) };
      });
    },
    async listProcs() {
      const r = await run(["ps", "-eo", "pid=,ppid=,args="], e);
      return r.out.split("\n").map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => !!m)
        .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));
    },
    async killDefaultSession(name) {
      await run(["tmux", "kill-session", "-t", `=${name}`], e);
    },
  };
}
