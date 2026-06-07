/**
 * CLI ↔ 데몬 사이 Unix 소켓 통신 헬퍼.
 *
 * @remarks
 * 프로토콜은 단순:
 *   - 한 요청 = JSON 한 줄 + '\n'
 *   - 한 응답 = JSON 한 줄 + '\n'
 *   - 한 연결 = 한 요청 + 한 응답 후 닫음 (persistent 안 함)
 *
 * 단순한 명령엔 충분. 나중에 streaming(예: 로그 tail)을 원하면 별도 채널.
 */

import { createServer, createConnection, type Socket } from 'node:net';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

/** CLI → 데몬으로 보내는 요청. */
export interface IpcRequest {
  /** 명령 이름. 'ping' | 'break' | 'continue' | 'eval' | 'stop' 등 */
  readonly cmd: string;
  /** 명령별 추가 인자 (자유 형식) */
  readonly args?: Record<string, unknown>;
}

/** 데몬 → CLI 로 가는 응답. */
export interface IpcResponse {
  /** 'ok' or 'error' */
  readonly status: 'ok' | 'error';
  /** 명령 결과 (자유 형식) */
  readonly data?: unknown;
  /** error일 때 메시지 */
  readonly message?: string;
}

/**
 * Unix 소켓에 한 요청 보내고 한 응답 받는다.
 *
 * @param socketPath - 데몬이 듣고 있는 .sock 경로
 * @param req - 요청 객체
 * @throws 데몬이 안 떠있거나 응답 형식이 깨졌을 때
 */
export async function sendRequest(socketPath: string, req: IpcRequest): Promise<IpcResponse> {
  return await new Promise<IpcResponse>((resolve, reject) => {
    const conn = createConnection(socketPath);
    let buf = '';
    conn.on('connect', () => {
      conn.write(JSON.stringify(req) + '\n');
    });
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf-8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        conn.end();
        try {
          resolve(JSON.parse(line) as IpcResponse);
        } catch (e) {
          reject(new Error(`malformed response: ${line}`));
        }
      }
    });
    conn.on('error', (err) => reject(err));
    conn.on('close', () => {
      if (!buf) reject(new Error('connection closed with no response'));
    });
  });
}

/**
 * 데몬 측에서 Unix 소켓 서버를 띄워 요청을 받는다.
 *
 * @param socketPath - 바인드할 .sock 경로
 * @param handler - 각 요청을 받아 응답을 만드는 함수
 * @returns 서버 종료 함수
 */
export function listen(
  socketPath: string,
  handler: (req: IpcRequest) => Promise<IpcResponse>,
): () => void {
  // 상위 디렉토리 보장
  mkdirSync(dirname(socketPath), { recursive: true });
  // 기존 stale 소켓 파일이 있으면 제거 (정상 종료 못 했을 때 남음)
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* ignore */ }
  }

  const server = createServer((conn: Socket) => {
    let buf = '';
    conn.on('data', async (chunk) => {
      buf += chunk.toString('utf-8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let req: IpcRequest;
      try {
        req = JSON.parse(line) as IpcRequest;
      } catch {
        conn.write(JSON.stringify({ status: 'error', message: 'invalid JSON' } as IpcResponse) + '\n');
        conn.end();
        return;
      }
      try {
        const resp = await handler(req);
        conn.write(JSON.stringify(resp) + '\n');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        conn.write(JSON.stringify({ status: 'error', message: msg } as IpcResponse) + '\n');
      } finally {
        conn.end();
      }
    });
  });
  server.listen(socketPath);
  return () => {
    server.close();
    try { unlinkSync(socketPath); } catch { /* ignore */ }
  };
}
