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

/** 한 scope의 메타정보. locals 명령 처리 시 사용. */
export interface ScopeInfo {
  /** 'local' | 'closure' | 'block' | 'catch' | 'global' | 'with' | 'eval' | 'module' | 'script' */
  readonly type: string;
  /** scope 객체를 가리키는 CDP ID — Runtime.getProperties로 변수 목록 얻기 */
  readonly objectId: string;
  /** 사람용 이름 (closure는 함수명) */
  readonly name?: string;
}

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
  /** 이 프레임의 스코프 체인 (가장 가까운 local부터 바깥쪽 global까지) */
  readonly scopes: readonly ScopeInfo[];
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
      // scopeChain 추출 — 각 scope의 objectId로 나중에 변수 펼치기
      const rawScopes = (f['scopeChain'] as Array<Record<string, unknown>>) ?? [];
      const scopes: ScopeInfo[] = rawScopes.map((s) => {
        const obj = (s['object'] as Record<string, unknown>) ?? {};
        return {
          type: (s['type'] as string) ?? 'unknown',
          objectId: (obj['objectId'] as string) ?? '',
          name: s['name'] as string | undefined,
        };
      }).filter((s) => s.objectId);
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
        scopes,
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

  /** 특정 breakpoint 제거. */
  public async removeBreakpoint(id: string): Promise<void> {
    await this.sendCdp('Debugger.removeBreakpoint', { breakpointId: id });
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
  public async setBreakpoint(absPath: string, oneBasedLine: number, condition?: string): Promise<{ id: string; resolvedLine?: number; scriptId?: string }> {
    // 1) source map 기반 — 트랜스파일된 스크립트의 정확한 위치로 변환.
    const mapped = originalToGenerated(absPath, oneBasedLine, Array.from(this.scriptMaps.values()));
    if (mapped.length > 0) {
      const chosen = mapped[0]!;
      const params: Record<string, unknown> = { location: chosen };
      if (condition) params['condition'] = condition;
      const result = await this.sendCdp('Debugger.setBreakpoint', params) as { breakpointId: string; actualLocation: { lineNumber: number } };
      return { id: result.breakpointId, resolvedLine: oneBasedLine, scriptId: chosen.scriptId };
    }
    // 2) source map 없을 때 URL 기반 fallback
    const url = `file://${absPath}`;
    const params: Record<string, unknown> = { url, lineNumber: oneBasedLine - 1 };
    if (condition) params['condition'] = condition;
    const result = await this.sendCdp('Debugger.setBreakpointByUrl', params) as { breakpointId: string; locations: Array<{ lineNumber: number }> };
    const resolvedLine = result.locations[0]?.lineNumber !== undefined ? result.locations[0]!.lineNumber + 1 : undefined;
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

  /**
   * 멈춤만 해제하고 응답 즉시 반환 (다음 paused 대기 안 함).
   *
   * @remarks
   * 영원히 안 멈출 수도 있는 서버 같은 케이스용.
   * entry pause 풀어 서버 부팅 시작시키고, breakpoint는 그 후 걸고, 외부에서 요청 보낸 뒤
   * `waitForNextPause()`로 다음 멈춤 확인하는 흐름.
   */
  public async resumeOnly(): Promise<{ wasPaused: boolean }> {
    if (this.exited) return { wasPaused: false };
    if (!this.currentPaused) return { wasPaused: false };
    await this.sendCdp('Debugger.resume');
    return { wasPaused: true };
  }

  /**
   * 현재 paused면 즉시 반환, 아니면 다음 paused 또는 종료까지 대기.
   * 옵션 timeoutMs를 주면 그 시간 안에 안 멈추면 'running' 반환.
   */
  public async waitForNextPause(timeoutMs?: number): Promise<PausedInfo | null | 'timeout'> {
    if (this.exited) return null;
    if (this.currentPaused) return this.currentPaused;
    if (!timeoutMs) return await this.waitForPaused();
    return await new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        // pausedWaiters에서 자기 자신 제거
        const idx = this.pausedWaiters.indexOf(handler);
        if (idx >= 0) this.pausedWaiters.splice(idx, 1);
        resolve('timeout');
      }, timeoutMs);
      const handler = (p: PausedInfo | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(p);
      };
      this.pausedWaiters.push(handler);
    });
  }

  /** 다음 paused 이벤트 또는 종료까지 대기. */
  private waitForPaused(): Promise<PausedInfo | null> {
    return new Promise((resolve) => {
      this.pausedWaiters.push(resolve);
    });
  }

  /**
   * 현재 멈춤을 step over로 진행 (다음 줄까지, 함수 호출은 건너뜀).
   * 다음 paused 또는 종료까지 await.
   */
  public async stepOver(): Promise<PausedInfo | null> {
    return await this.stepAndWait('Debugger.stepOver');
  }

  /** step into — 다음 함수 호출 안으로 들어감. */
  public async stepInto(): Promise<PausedInfo | null> {
    return await this.stepAndWait('Debugger.stepInto');
  }

  /** step out — 현재 함수 빠져나가서 호출자로 돌아갈 때까지. */
  public async stepOut(): Promise<PausedInfo | null> {
    return await this.stepAndWait('Debugger.stepOut');
  }

  /** step 계열 공통 — CDP step 명령 보내고 다음 paused 또는 종료 대기. */
  private async stepAndWait(method: 'Debugger.stepOver' | 'Debugger.stepInto' | 'Debugger.stepOut'): Promise<PausedInfo | null> {
    if (this.exited) return null;
    if (!this.currentPaused) throw new Error('not paused — step requires a paused state');
    const waitPromise = this.waitForPaused();
    await this.sendCdp(method);
    return await waitPromise;
  }

  /**
   * 지정 프레임의 모든 스코프 변수 한 번에 펼친다.
   *
   * @remarks
   * scopeChain의 각 scope에 대해 Runtime.getProperties를 호출해서 변수 목록을 모음.
   * local scope만 보고 싶으면 caller가 결과에서 필터.
   *
   * @returns scope별 변수 목록
   */
  public async getFrameLocals(frameIndex: number = 0): Promise<Array<{ scope: string; variables: Array<{ name: string; value: unknown }> }>> {
    if (!this.currentPaused) throw new Error('not paused');
    const frame = this.currentPaused.frames[frameIndex];
    if (!frame) throw new Error(`no frame ${frameIndex}`);
    const out: Array<{ scope: string; variables: Array<{ name: string; value: unknown }> }> = [];
    for (const scope of frame.scopes) {
      // global은 너무 노이즈가 크니 건너뜀
      if (scope.type === 'global') continue;
      const result = await this.sendCdp('Runtime.getProperties', {
        objectId: scope.objectId,
        ownProperties: true,
        accessorPropertiesOnly: false,
        generatePreview: true,
      }) as { result: Array<{ name: string; value?: { type: string; value?: unknown; description?: string }; get?: unknown }> };
      const variables = result.result
        // accessor(get만 있고 value 없음)는 호출 비용 있어서 v0에선 제외
        .filter((p) => p.value !== undefined)
        .map((p) => ({
          name: p.name,
          value: p.value?.value !== undefined ? p.value.value : (p.value?.description ?? `[${p.value?.type}]`),
        }));
      out.push({ scope: scope.name ? `${scope.type}(${scope.name})` : scope.type, variables });
    }
    return out;
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
