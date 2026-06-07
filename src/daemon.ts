/**
 * nd 데몬 본체.
 *
 * @remarks
 * 한 세션당 하나의 프로세스. 시작 시:
 *  1. Unix 소켓 열기
 *  2. CdpClient.launch(script)로 자식 Node 띄우고 CDP 연결
 *  3. CLI 명령 수신 → CDP 명령으로 변환
 */

import { listen, type IpcRequest, type IpcResponse } from './ipc.js';
import { CdpClient, type PausedInfo } from './cdp.js';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';

function socketPathFor(session: string): string {
  return join(homedir(), '.nd', `${session}.sock`);
}

function parseArgs(argv: readonly string[]): { session: string; script?: string; cwd?: string } {
  let session = 'default';
  let script: string | undefined;
  let cwd: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session' && argv[i + 1]) { session = argv[i + 1] as string; i++; }
    else if (argv[i] === '--script' && argv[i + 1]) { script = argv[i + 1] as string; i++; }
    else if (argv[i] === '--cwd' && argv[i + 1]) { cwd = argv[i + 1] as string; i++; }
  }
  return { session, script, cwd };
}

/** PausedInfo를 IPC 응답에 담기 좋은 모양으로 정리. */
function summarizePaused(p: PausedInfo | null): unknown {
  if (!p) return null;
  return {
    reason: p.reason,
    hitBreakpoints: p.hitBreakpoints,
    frames: p.frames.slice(0, 5).map((f) => {
      const orig = f.originalLocation;
      if (orig) {
        // source map으로 원본 좌표를 알면 그걸 우선 보여줌
        return {
          functionName: f.functionName || '<anonymous>',
          file: orig.source,
          line: orig.line,
          column: orig.column,
        };
      }
      // source map 없는 스크립트(internal Node 모듈 등)는 원본 좌표 그대로
      return {
        functionName: f.functionName || '<anonymous>',
        file: f.location.url,
        line: f.location.lineNumber + 1,
        column: f.location.columnNumber + 1,
      };
    }),
  };
}

async function main(): Promise<void> {
  const { session, script, cwd } = parseArgs(process.argv.slice(2));
  if (!script) {
    process.stderr.write('[nd-daemon] --script required\n');
    process.exit(1);
  }
  const socketPath = socketPathFor(session);
  const startedAt = new Date().toISOString();

  // 스크립트 절대경로 보정
  const baseCwd = cwd ?? process.cwd();
  const absScript = isAbsolute(script) ? script : resolve(baseCwd, script);

  process.stderr.write(`[nd-daemon] starting session=${session} pid=${process.pid} script=${absScript}\n`);

  let cdp: CdpClient;
  try {
    cdp = await CdpClient.launch(absScript);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[nd-daemon] failed to launch CDP: ${msg}\n`);
    process.exit(1);
  }
  process.stderr.write(`[nd-daemon] CDP attached. program paused at entry.\n`);

  let stopServer: (() => void) | null = null;

  const handler = async (req: IpcRequest): Promise<IpcResponse> => {
    try {
      switch (req.cmd) {
        case 'ping':
          return { status: 'ok', data: {
            session, pid: process.pid, startedAt, script: absScript,
            paused: summarizePaused(cdp.getPaused()),
            exit: cdp.getExitState(),
          }};

        case 'source': {
          const scriptId = req.args?.['scriptId'] as string | undefined;
          if (!scriptId) return { status: 'error', message: 'source requires args.scriptId' };
          const src = await cdp.getScriptSource(scriptId);
          // 줄번호 붙여서 처음 20줄만
          const lines = src.split('\n').slice(0, 30);
          const numbered = lines.map((l, i) => `${String(i + 1).padStart(3, ' ')}: ${l}`).join('\n');
          return { status: 'ok', data: { scriptId, preview: numbered, totalLines: src.split('\n').length }};
        }

        case 'scripts': {
          // 디버깅용 — CDP가 인식한 모든 스크립트 URL
          const all = cdp.listScripts();
          const filter = (req.args?.['filter'] as string | undefined) ?? '';
          const matched = filter ? all.filter((s) => s.url.includes(filter)) : all;
          return { status: 'ok', data: { count: matched.length, total: all.length, scripts: matched.slice(0, 20) }};
        }

        case 'break': {
          const file = req.args?.['file'] as string | undefined;
          const line = req.args?.['line'] as number | undefined;
          if (!file || !line) return { status: 'error', message: 'break requires args.file and args.line' };
          const absFile = isAbsolute(file) ? file : resolve(baseCwd, file);
          const r = await cdp.setBreakpoint(absFile, line);
          return { status: 'ok', data: { breakpointId: r.id, file: absFile, requestedLine: line, resolvedLine: r.resolvedLine }};
        }

        case 'continue': {
          const p = await cdp.continueAndWait();
          if (!p) return { status: 'ok', data: { exited: true, exit: cdp.getExitState() }};
          return { status: 'ok', data: { paused: summarizePaused(p) }};
        }

        case 'eval': {
          const expr = req.args?.['expr'] as string | undefined;
          const frameIndex = (req.args?.['frame'] as number | undefined) ?? 0;
          if (!expr) return { status: 'error', message: 'eval requires args.expr' };
          const result = await cdp.evalInFrame(expr, frameIndex);
          return { status: 'ok', data: result };
        }

        case 'stop':
          await cdp.stop();
          setTimeout(() => { if (stopServer) stopServer(); process.exit(0); }, 50);
          return { status: 'ok', data: { stopping: true }};

        default:
          return { status: 'error', message: `unknown cmd: ${req.cmd}` };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: 'error', message: msg };
    }
  };

  stopServer = listen(socketPath, handler);
  process.stderr.write(`[nd-daemon] listening on ${socketPath}\n`);

  const cleanup = (): void => { if (stopServer) stopServer(); };
  process.on('SIGTERM', () => { cleanup(); void cdp.stop(); process.exit(0); });
  process.on('SIGINT', () => { cleanup(); void cdp.stop(); process.exit(0); });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[nd-daemon] fatal: ${msg}\n`);
  process.exit(1);
});
