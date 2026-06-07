/**
 * CDP 클라이언트 — Node 자식을 띄우고 WebSocket으로 디버거에 붙어 명령을 보낸다.
 *
 * @remarks
 * 이 클래스 한 인스턴스 = 한 디버그 세션. 자식 프로세스 + WS + 멈춤 상태를 모두 보유.
 * 데몬이 살아있는 동안 이 인스턴스도 살아있다.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { buildScriptMap, originalToGenerated, generatedToOriginal, type ScriptMap } from './source-map-index.js';

/** 멈췄을 때 호출 프레임 한 개. */
export interface CallFrame {
  /** CDP가 부여한 프레임 ID — Runtime.evaluate 호출 시 callFrameId로 사용 */
  readonly callFrameId: string;
  /** 함수 이름 (anonymous면 빈 문자열) */
  readonly functionName: string;
  /** 멈춘 위치 (V8가 보는 트랜스파일된 좌표) */
  readonly location: {
    readonly scriptId: string;
    readonly url: string;
    readonly lineNumber: number;
    readonly columnNumber: number;
  };
  /** source map으로 변환된 원본 위치. 없으면 null. */
  readonly originalLocation: {
    readonly source: string;
    readonly line: number;
    readonly column: number;
  } | null;
}

/** Debugger.paused 이벤트의 정리된 형태. */
export interface PausedInfo {
  /** 'breakpoint' | 'Break on start' | 'step' | 'exception' | ... */
  readonly reason: string;
  /** 호출 스택 (frame 0이 현재) */
  readonly frames: readonly CallFrame[];
  /** 부가 데이터 (예: 어떤 breakpointId에 의해 멈췄는지) */
  readonly hitBreakpoints?: readonly string[];
}

interface PendingRequest {
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: Error) => void;
}

/**
 * 한 Node 자식 프로세스에 대한 CDP 디버그 세션.
 *
 * @example
 * const sess = await CdpClient.launch('/abs/path/server.ts');
 * await sess.setBreakpoint('/abs/path/server.ts', 42);
 * const paused = await sess.continueAndWait();
 * console.log(paused?.frames[0].location);
 */
export class CdpClient {
  private readonly child: ChildProcess;
  private readonly ws: WebSocket;
  private nextId: number = 1;
  private readonly pending: Map<number, PendingRequest> = new Map();

  /** CDP가 인식한 스크립트들 (scriptParsed 이벤트로 수집). */
  private readonly scripts: Map<string, { scriptId: string; url: string }> = new Map();
  /** scriptId → 트랜스파일된 스크립트의 source map. setBreakpoint 시 좌표 변환에 사용. */
  private readonly scriptMaps: Map<string, ScriptMap> = new Map();
  /** 현재 멈춰있는 상태 (null이면 실행 중 또는 종료). */
  private currentPaused: PausedInfo | null = null;
  /** continueAndWait()가 다음 paused 이벤트를 기다리는 큐. */
  private readonly pausedWaiters: Array<(p: PausedInfo | null) => void> = [];
  /** 프로그램이 종료됐는가. */
  private exited: boolean = false;
  /** 종료 코드. */
  private exitCode: number | null = null;

  private constructor(child: ChildProcess, ws: WebSocket) {
    this.child = child;
    this.ws = ws;
  }

  /**
   * 자식 Node를 띄우고 CDP에 붙는다. entry pause 상태에서 리턴.
   *
   * @param script - 실행할 .ts 또는 .js 절대경로
   * @returns 핸드셰이크 완료된 세션
   */
  public static async launch(script: string): Promise<CdpClient> {
    const child = spawn('node', [
      '--inspect-brk=127.0.0.1:0',
      '--import', 'tsx',
      script,
    ], { stdio: ['inherit', 'pipe', 'pipe'] });

    // stderr 파싱해 ws URL 추출
    const wsUrl = await new Promise<string>((resolve, reject) => {
      let buf = '';
      const onData = (chunk: Buffer): void => {
        const text = chunk.toString('utf-8');
        buf += text;
        const match = buf.match(/Debugger listening on (ws:\/\/[^\s]+)/);
        if (match && match[1]) {
          child.stderr?.off('data', onData);
          resolve(match[1]);
        }
      };
      child.stderr?.on('data', onData);
      child.on('exit', (code) => reject(new Error(`child exited before debugger ready, code=${code ?? 'null'}`)));
      setTimeout(() => reject(new Error('timed out waiting for debugger URL')), 10_000);
    });

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    const sess = new CdpClient(child, ws);
    sess.attachHandlers();
    await sess.handshake();
    return sess;
  }

  /** WS 메시지 라우터 + 자식 exit 핸들러 등록. */
  private attachHandlers(): void {
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf-8')) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: { message: string };
      };
      if (typeof msg.id === 'number') {
        const slot = this.pending.get(msg.id);
        if (!slot) return;
        this.pending.delete(msg.id);
        if (msg.error) slot.reject(new Error(msg.error.message));
        else slot.resolve(msg.result);
      } else if (msg.method === 'Debugger.paused') {
        this.onPaused(msg.params ?? {});
      } else if (msg.method === 'Debugger.resumed') {
        this.currentPaused = null;
      } else if (msg.method === 'Debugger.scriptParsed') {
        const p = msg.params ?? {};
        const scriptId = p['scriptId'] as string;
        const url = (p['url'] as string) ?? '';
        if (scriptId) {
          this.scripts.set(scriptId, { scriptId, url });
          // 비동기로 소스 가져와서 source map 파싱. 실패하면 무시 (source map 없는 스크립트).
          void this.loadScriptMap(scriptId, url);
        }
      }
      // 다른 이벤트(scriptParsed, consoleAPICalled 등)는 일단 무시
    });

    this.child.on('exit', (code) => {
      this.exited = true;
      this.exitCode = code ?? null;
      // paused를 기다리고 있던 호출자들에게 null로 깨움 (=종료)
      for (const w of this.pausedWaiters) w(null);
      this.pausedWaiters.length = 0;
      try { this.ws.close(); } catch { /* ignore */ }
    });
  }

  /** Debugger.enable + Runtime.enable + Runtime.runIfWaitingForDebugger. */
  private async handshake(): Promise<void> {
    await this.sendCdp('Debugger.enable');
    await this.sendCdp('Runtime.enable');
    await this.sendCdp('Runtime.runIfWaitingForDebugger');
    // 이 시점에서 V8가 "Break on start"로 paused 이벤트를 보냄 → onPaused가 currentPaused에 저장
  }

  /** Debugger.paused 이벤트 처리. */
  private onPaused(params: Record<string, unknown>): void {
    const reason = (params['reason'] as string | undefined) ?? '?';
    const rawFrames = (params['callFrames'] as Array<Record<string, unknown>>) ?? [];
    const maps = Array.from(this.scriptMaps.values());
    const frames: CallFrame[] = rawFrames.map((f) => {
      const loc = f['location'] as Record<string, unknown>;
      const fn = f['functionName'] as string;
      const scriptId = loc['scriptId'] as string;
      const lineNumber = loc['lineNumber'] as number;
      const columnNumber = loc['columnNumber'] as number;
      const orig = generatedToOriginal(scriptId, lineNumber, columnNumber, maps);
      return {
        callFrameId: f['callFrameId'] as string,
        functionName: fn,
        location: {
          scriptId,
          url: (f['url'] as string) ?? '',
          lineNumber,
          columnNumber,
        },
        originalLocation: orig,
      };
    });
    const info: PausedInfo = {
      reason,
      frames,
      hitBreakpoints: params['hitBreakpoints'] as readonly string[] | undefined,
    };
    this.currentPaused = info;
    // 기다리던 사람 깨움 (한 명씩)
    const w = this.pausedWaiters.shift();
    if (w) w(info);
  }

  /** CDP 명령 한 개 보내고 응답 await. */
  public sendCdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 현재 멈춤 상태. 실행 중이면 null. */
  public getPaused(): PausedInfo | null {
    return this.currentPaused;
  }

  /** CDP가 인식한 스크립트 URL 목록 (디버깅용). */
  public listScripts(): readonly { scriptId: string; url: string }[] {
    return Array.from(this.scripts.values());
  }

  /** V8가 보는 스크립트의 원본 소스를 그대로 가져온다. */
  public async getScriptSource(scriptId: string): Promise<string> {
    const result = await this.sendCdp('Debugger.getScriptSource', { scriptId }) as { scriptSource: string };
    return result.scriptSource;
  }

  /** scriptId의 트랜스파일된 소스에서 inline source map을 뽑아 보관. */
  private async loadScriptMap(scriptId: string, url: string): Promise<void> {
    try {
      const src = await this.getScriptSource(scriptId);
      const map = await buildScriptMap(scriptId, url, src);
      if (map) this.scriptMaps.set(scriptId, map);
    } catch {
      // 소스 못 가져오거나 source map 없으면 그냥 패스
    }
  }

  /** 종료 여부 + 코드. */
  public getExitState(): { exited: boolean; code: number | null } {
    return { exited: this.exited, code: this.exitCode };
  }

  /**
   * 파일·라인 기준 브레이크포인트 추가.
   *
   * @remarks
   * Node CDP는 url: 'file:///abs/path' 또는 urlRegex 받음. 우린 file:// URL 씀.
   * Node가 source map을 자동으로 풀어주므로 .ts 파일의 줄 번호 그대로 사용 가능.
   * lineNumber는 0-based임에 주의 (사람이 쓰는 줄번호는 1-based이니 -1).
   */
  public async setBreakpoint(absPath: string, oneBasedLine: number): Promise<{ id: string; resolvedLine?: number; scriptId?: string }> {
    // 1) 우리가 가진 모든 source map에서 (absPath, line) → (scriptId, jsLine, jsColumn) 변환 시도.
    //    트랜스파일된 스크립트는 보통 한 줄로 압축돼있으므로 source map 없이는 정확한 위치 못 찾음.
    const mapped = originalToGenerated(absPath, oneBasedLine, Array.from(this.scriptMaps.values()));
    if (mapped.length > 0) {
      const chosen = mapped[0]!;
      const result = await this.sendCdp('Debugger.setBreakpoint', {
        location: chosen,
      }) as { breakpointId: string; actualLocation: { lineNumber: number } };
      return {
        id: result.breakpointId,
        resolvedLine: oneBasedLine,  // 원본 기준 줄
        scriptId: chosen.scriptId,
      };
    }
    // 2) source map이 없으면 (예: 순수 .js 파일) URL 기반 fallback
    const url = `file://${absPath}`;
    const result = await this.sendCdp('Debugger.setBreakpointByUrl', {
      url,
      lineNumber: oneBasedLine - 1,
    }) as { breakpointId: string; locations: Array<{ lineNumber: number }> };
    const resolvedLine = result.locations[0]?.lineNumber !== undefined
      ? result.locations[0]!.lineNumber + 1
      : undefined;
    return { id: result.breakpointId, resolvedLine };
  }

  /**
   * 현재 멈춤 상태를 해제하고, 다음 멈춤(또는 종료)까지 기다린다.
   *
   * @returns 다음 paused 정보. 프로그램이 끝났으면 null.
   */
  public async continueAndWait(): Promise<PausedInfo | null> {
    if (this.exited) return null;
    if (!this.currentPaused) {
      // 이미 실행 중. 그냥 다음 paused만 기다림.
      return await this.waitForPaused();
    }
    const waitPromise = this.waitForPaused();
    await this.sendCdp('Debugger.resume');
    return await waitPromise;
  }

  /** 다음 paused 이벤트 또는 종료까지 대기. */
  private waitForPaused(): Promise<PausedInfo | null> {
    return new Promise((resolve) => {
      this.pausedWaiters.push(resolve);
    });
  }

  /**
   * 현재 멈춰있는 프레임에서 표현식을 평가한다.
   *
   * @param expr - JS 표현식
   * @param frameIndex - 콜스택 인덱스 (0 = 최상단)
   * @returns 평가 결과 (CDP RemoteObject)
   */
  public async evalInFrame(expr: string, frameIndex: number = 0): Promise<unknown> {
    if (!this.currentPaused) throw new Error('not paused');
    const frame = this.currentPaused.frames[frameIndex];
    if (!frame) throw new Error(`no frame ${frameIndex}`);
    const result = await this.sendCdp('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression: expr,
      returnByValue: true,
    });
    return result;
  }

  /** 세션 종료: WS 닫고 자식 프로세스 죽임. */
  public async stop(): Promise<void> {
    try { this.ws.close(); } catch { /* ignore */ }
    if (!this.exited) {
      try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
      // 강제 종료 backstop
      setTimeout(() => {
        if (!this.exited) try { this.child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 1000);
    }
  }
}
