/**
 * V8가 보는 트랜스파일된 스크립트와 원본 .ts 사이 좌표 변환.
 *
 * @remarks
 * 트랜스파일러(tsx, esbuild 등)는 보통 트랜스파일된 JS 끝에 inline source map을 박는다:
 *   //# sourceMappingURL=data:application/json;base64,<base64>
 *
 * 이걸 디코딩해서 SourceMapConsumer로 만들어두면
 *   (원본 ts file, line, column) → (transpiled js line, column) 로 변환 가능.
 */

import { SourceMapConsumer } from 'source-map';
import type { RawSourceMap } from 'source-map';

export interface ScriptMap {
  /** V8가 부여한 scriptId */
  readonly scriptId: string;
  /** 스크립트의 URL (V8에 등록된) */
  readonly url: string;
  /** source map의 sources 배열 — 어떤 원본 파일들과 연결돼있는지 */
  readonly sources: readonly string[];
  /** 좌표 변환기 */
  readonly consumer: SourceMapConsumer;
}

/**
 * 트랜스파일된 스크립트 소스에서 inline source map(base64)을 뽑아 SourceMapConsumer를 만든다.
 *
 * @returns source map 없으면 null
 */
export async function buildScriptMap(
  scriptId: string,
  url: string,
  source: string,
): Promise<ScriptMap | null> {
  const match = source.match(/\/\/# sourceMappingURL=data:application\/json(?:;charset=utf-?8)?;base64,([A-Za-z0-9+/=]+)/);
  if (!match || !match[1]) return null;
  const raw = JSON.parse(Buffer.from(match[1], 'base64').toString('utf-8')) as RawSourceMap;
  const consumer = await new SourceMapConsumer(raw);
  const sources = (raw.sources ?? []) as readonly string[];
  return { scriptId, url, sources, consumer };
}

/**
 * 원본 (file, line) 위치를 트랜스파일된 (scriptId, line, column) 위치로 변환.
 *
 * @param absSourcePath - 원본 파일 절대경로
 * @param oneBasedLine - 원본 줄번호 (1-based)
 * @param maps - 후보 ScriptMap들 (보통 하나)
 * @returns 매칭되는 트랜스파일된 위치들. 보통 1개. 없으면 빈 배열.
 */
/**
 * 트랜스파일된 위치 → 원본 위치.
 * paused 이벤트에서 사용자에게 .ts 좌표를 보여주려면 이걸 거꾸로 호출.
 *
 * @returns 원본 파일/줄. 매칭 실패하면 null.
 */
export function generatedToOriginal(
  scriptId: string,
  generatedLineZeroBased: number,
  generatedColumn: number,
  maps: readonly ScriptMap[],
): { source: string; line: number; column: number } | null {
  const map = maps.find((m) => m.scriptId === scriptId);
  if (!map) return null;
  const pos = map.consumer.originalPositionFor({
    line: generatedLineZeroBased + 1,  // source-map은 1-based
    column: generatedColumn,
  });
  if (pos.source === null || pos.line === null) return null;
  return { source: pos.source, line: pos.line, column: pos.column ?? 0 };
}

export function originalToGenerated(
  absSourcePath: string,
  oneBasedLine: number,
  maps: readonly ScriptMap[],
): Array<{ scriptId: string; lineNumber: number; columnNumber: number }> {
  const out: Array<{ scriptId: string; lineNumber: number; columnNumber: number }> = [];
  for (const m of maps) {
    // source map의 sources 배열에 절대경로 또는 상대경로로 들어있을 수 있음.
    // 우리는 absSourcePath로 비교 — sources의 항목이 절대/상대 둘 다 매칭되도록 처리.
    const sourceMatch = m.sources.find((s) => {
      if (s === absSourcePath) return true;
      // 상대경로일 경우 경로 끝부분으로 매칭 시도
      return absSourcePath.endsWith(s.replace(/^\.\//, ''));
    });
    if (!sourceMatch) continue;
    const pos = m.consumer.generatedPositionFor({
      source: sourceMatch,
      line: oneBasedLine,        // source-map은 1-based line 사용
      column: 0,
      bias: SourceMapConsumer.LEAST_UPPER_BOUND,
    });
    if (pos.line !== null && pos.column !== null) {
      out.push({
        scriptId: m.scriptId,
        lineNumber: pos.line - 1,  // CDP는 0-based
        columnNumber: pos.column,
      });
    }
  }
  return out;
}
