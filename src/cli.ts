/**
 * nd CLI 진입점.
 *
 * @remarks
 * 서브커맨드를 받아 적절한 동작 수행.
 *  - `nd run <script>` → 데몬 fork + 자식 Node 띄움
 *  - `nd ping`         → 데몬에 ping 요청
 *  - `nd stop`         → 데몬 종료
 *  - 그 외 (`break`, `continue`, ...) → 다음 조각에서 추가
 *
 * 공통 옵션: `--session <name>` (기본 'default')
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sendRequest, type IpcRequest } from './ipc.js';

/** 데몬에 요청 보내고 응답 JSON으로 출력. 에러면 종료. */
async function passThrough(socketPath: string, req: IpcRequest): Promise<void> {
  try {
    const resp = await sendRequest(socketPath, req);
    process.stdout.write(JSON.stringify(resp, null, 2) + '\n');
    if (resp.status === 'error') process.exit(1);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[nd] ${req.cmd} failed: ${msg}\n`);
    process.exit(1);
  }
}

/** 세션 이름에서 Unix 소켓 경로 만들기. 데몬과 동일 로직. */
function socketPathFor(session: string): string {
  return join(homedir(), '.nd', `${session}.sock`);
}

/** argv에서 --session 값 뽑고 나머지 인자 반환. */
function extractSession(argv: readonly string[]): { session: string; rest: string[] } {
  let session = 'default';
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session' && argv[i + 1]) {
      session = argv[i + 1] as string;
      i++;
    } else {
      rest.push(argv[i] as string);
    }
  }
  return { session, rest };
}

/**
 * 데몬을 detached로 fork하고 부모는 바로 리턴.
 * 데몬은 부모 사망과 무관하게 계속 살아있는다.
 */
function forkDaemon(session: string, script: string | undefined): void {
  // 이 CLI 파일이 있는 디렉토리에서 daemon.ts 위치 추정
  const here = dirname(fileURLToPath(import.meta.url));
  const daemonPath = join(here, 'daemon.ts');

  const args = ['--import', 'tsx', daemonPath, '--session', session, '--cwd', process.cwd()];
  if (script) args.push('--script', script);

  const logDir = join(homedir(), '.nd', 'logs');
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${session}.log`);

  // detached: true + stdio 'ignore' (또는 파일로) + child.unref()
  // 이 셋이 모이면 부모 종료 후에도 자식이 살아남음
  const out = openLogFd(logPath);
  const child = spawn('node', args, {
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  process.stdout.write(`[nd] daemon forked pid=${child.pid} session=${session} log=${logPath}\n`);
}

/** 로그 파일을 추가-쓰기 모드로 열어 fd 반환. */
function openLogFd(path: string): number {
  return openSync(path, 'a');
}

async function main(): Promise<void> {
  const { session, rest } = extractSession(process.argv.slice(2));
  const sub = rest[0];

  if (!sub) {
    process.stderr.write('usage: nd <subcommand> [--session <name>] [args...]\n');
    process.stderr.write('subcommands: run, ping, stop\n');
    process.exit(1);
  }

  const socketPath = socketPathFor(session);

  switch (sub) {
    case 'run': {
      const script = rest[1];
      if (!script) {
        process.stderr.write('usage: nd run <script>\n');
        process.exit(1);
      }
      // 이미 같은 세션 데몬이 떠있는지 확인
      if (existsSync(socketPath)) {
        process.stderr.write(`[nd] session "${session}" already has a daemon (socket exists). Use 'nd stop' first.\n`);
        process.exit(1);
      }
      forkDaemon(session, script);
      // 데몬이 일어날 시간 잠깐 줌 (다음 명령이 connect 시도하면 race일 수 있어서)
      // 더 견고하게 하려면 데몬 ready를 기다리는 로직이 필요하지만 v0에선 간단히
      process.stdout.write('[nd] (data: ping in 1~2s to verify)\n');
      break;
    }
    case 'ping': {
      await passThrough(socketPath, { cmd: 'ping' });
      break;
    }
    case 'break': {
      // 형식: nd break <file>:<line> [--if "<expr>"]
      const spec = rest[1];
      if (!spec) {
        process.stderr.write('usage: nd break <file>:<line> [--if "<expr>"]\n');
        process.exit(1);
      }
      const colon = spec.lastIndexOf(':');
      if (colon <= 0) {
        process.stderr.write('break spec must be <file>:<line>\n');
        process.exit(1);
      }
      const file = spec.slice(0, colon);
      const line = Number(spec.slice(colon + 1));
      if (!Number.isFinite(line)) {
        process.stderr.write('line must be a number\n');
        process.exit(1);
      }
      // --if 옵션 파싱
      let condition: string | undefined;
      const ifIdx = rest.indexOf('--if');
      if (ifIdx >= 0 && rest[ifIdx + 1]) condition = rest[ifIdx + 1] as string;
      await passThrough(socketPath, { cmd: 'break', args: { file, line, ...(condition ? { condition } : {}) }});
      break;
    }
    case 'continue': {
      await passThrough(socketPath, { cmd: 'continue' });
      break;
    }
    case 'step': {
      // nd step [over|in|out], 기본 over
      const mode = rest[1] ?? 'over';
      if (!['over', 'in', 'out'].includes(mode)) {
        process.stderr.write('usage: nd step [over|in|out]\n');
        process.exit(1);
      }
      await passThrough(socketPath, { cmd: 'step', args: { mode }});
      break;
    }
    case 'locals': {
      // nd locals [--frame N] [--all]
      let frame = 0;
      let all = false;
      const fi = rest.indexOf('--frame');
      if (fi >= 0 && rest[fi + 1]) frame = Number(rest[fi + 1]);
      if (rest.includes('--all')) all = true;
      await passThrough(socketPath, { cmd: 'locals', args: { frame, ...(all ? { all: true } : {}) }});
      break;
    }
    case 'scripts': {
      // 디버깅용 — CDP가 인식한 스크립트 URL 목록
      const filter = rest[1];
      await passThrough(socketPath, { cmd: 'scripts', args: filter ? { filter } : {} });
      break;
    }
    case 'source': {
      const scriptId = rest[1];
      if (!scriptId) { process.stderr.write('usage: nd source <scriptId>\n'); process.exit(1); }
      await passThrough(socketPath, { cmd: 'source', args: { scriptId }});
      break;
    }
    case 'eval': {
      const expr = rest.slice(1).join(' ');
      if (!expr) {
        process.stderr.write('usage: nd eval "<expr>"\n');
        process.exit(1);
      }
      await passThrough(socketPath, { cmd: 'eval', args: { expr }});
      break;
    }
    case 'stop': {
      await passThrough(socketPath, { cmd: 'stop' });
      break;
    }
    default:
      process.stderr.write(`[nd] unknown subcommand: ${sub}\n`);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[nd] fatal: ${msg}\n`);
  process.exit(1);
});
