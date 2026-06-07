# nd usage guide

## 세션 라이프사이클

`nd`는 **세션 단위 일회성**이다. 한 번 `nd run`으로 띄운 디버그 세션은 `nd stop`(또는 자식 프로세스 종료)으로 끝나면 완전히 정리된다. 다음 테스트는 처음부터 다시 시작한다.

이렇게 설계한 이유:
- **코드 수정 반영**: 데몬·자식 모두 메모리에 옛 코드를 들고 있다. 코드 바뀌면 재기동이 정답.
- **깨끗한 state**: 이전 테스트의 breakpoint·paused state가 다음 테스트에 새지 않음.
- **세션 격리**: 여러 디버그 세션을 동시에 돌리려면 `--session <name>` 으로 분리.

```
nd run <script>       # ① 데몬 fork → 자식 Node 띄움 → CDP 연결 → entry-paused
nd resume             # ② entry pause 해제 → 자식 실행 시작
nd break / preset     # ③ breakpoint 등록 (source-map aware)
nd wait / continue    # ④ 다음 paused 또는 종료까지 대기
nd locals / eval / step  # ⑤ inspect & 진행
nd stop               # ⑥ 자식·데몬·소켓 전부 정리
```

세션 끝나면 `~/.nd/<session>.sock`이 사라지고 다음 `nd run`이 깨끗히 새 데몬을 띄운다.

## 흔한 실수와 회피

### TDZ (Temporal Dead Zone)

```ts
const result = await fetchSomething();  // ← line 42
console.log(result);                    // ← line 43
```

`nd break ...:42` 로 line 42에 멈추면 `result`는 **아직 할당 전**. `eval "result"` → `ReferenceError: Cannot access 'result'`.

회피: 할당 직후 line(여기선 43)에 break, 또는 멈춘 뒤 `nd step over` 한 번.

### 객체 내부 구조를 추측해서 eval

```ts
nd eval "JSON.stringify(graph.nodes)"
// → {} 또는 [] — 진짜 비어서일 수도 있고, `nodes` 속성 자체가 없어서일 수도
```

내부가 Map/Set 같은 자료구조면 spread 결과로 직접 보지 못한다. `Object.keys(graph)`, `graph.constructor.name`으로 구조 먼저 확인:

```bash
nd eval "Object.getOwnPropertyNames(graph)"
nd eval "[...graph.forward.entries()]"   # forward가 Map인 걸 알았으면
```

### 데몬·코드 캐시 mismatch

`nd` 자체 코드(src/cdp.ts, daemon.ts 등)를 수정해도, **이미 실행 중인 데몬은 옛 코드를 들고 있다**. 새 동작 보려면 `nd stop` → `nd run` 재기동.

### 서버처럼 안 멈추는 프로그램에 `nd continue`

`nd continue`는 다음 paused 또는 종료까지 **무한 대기**한다. 서버가 listen 상태로 영원히 안 멈추면 CLI가 hang.

서버 같은 long-running 프로세스는:
1. `nd resume` (즉시 반환, 단순 풀기만)
2. 외부에서 요청 보냄 → breakpoint hit
3. `nd wait --timeout 60` 으로 잡기

## TypeScript + tsx 자동 처리

`nd run`은 자식을 `node --import tsx --inspect-brk=127.0.0.1:0 <script>` 로 띄운다. tsx가 `.ts`를 즉석 트랜스파일하면서 **inline source map**을 박는다.

`nd`는 모든 `Debugger.scriptParsed` 이벤트에서 소스를 가져와 inline source map을 자동 파싱한다. 그래서 `nd break src/foo.ts:42` 처럼 **원본 .ts 좌표**로 걸어도 V8가 보는 트랜스파일된 위치로 알아서 매핑된다.

paused 이벤트도 마찬가지로 트랜스파일된 좌표를 원본 .ts 좌표로 역변환해서 보고한다.

## breakpoint preset

매 테스트마다 `nd break A:10 / nd break B:20 / nd break C:30` 치는 게 귀찮으면 JSON으로 묶어두고 한 번에 적용:

```json
// .nd/checkpoints.json
[
  { "file": "src/api/handler.ts", "line": 42, "label": "after-fetch" },
  { "file": "src/api/handler.ts", "line": 80, "label": "before-response" },
  { "file": "src/db/query.ts",    "line": 15, "label": "query-built", "condition": "userId > 0" }
]
```

```bash
nd run server.ts
nd resume
# 서버 부팅 끝나면
nd preset .nd/checkpoints.json
nd wait --timeout 30
```

`condition`은 V8 break condition (JS 표현식). true일 때만 멈춤.

## 명령 한눈에

```
세션 제어
  nd run <script>            : 시작 (entry-paused)
  nd resume                  : entry pause 해제, 다음 paused 대기 안 함
  nd stop                    : 세션 종료

흐름 제어
  nd continue                : 멈춤 해제 + 다음 paused 또는 종료까지 대기
  nd wait [--timeout <sec>]  : 이미 paused면 즉시, 아니면 대기. 안 멈추면 'running' 반환
  nd step [over|in|out]      : 한 줄/한 호출 단위 진행

브레이크포인트
  nd break <file>:<line> [--if "<expr>"]   : 하나 등록
  nd preset <json>                         : 여러 개 일괄
  nd unbreak <breakpointId>                : 제거

inspect
  nd locals [--frame N] [--all]    : 현재 프레임 scope 변수
  nd eval "<expr>" [--frame N]     : 표현식 평가

introspection
  nd ping                          : 데몬 상태, 현재 paused 위치
  nd scripts [filter]              : CDP가 인식한 스크립트 URL 목록
  nd source <scriptId>             : 그 스크립트의 트랜스파일된 소스 미리보기
```

모든 명령에 `--session <name>` 사용 가능. 기본 `default`.

## 세션 별 보조 파일

```
~/.nd/<session>.sock         : Unix 도메인 소켓 (데몬↔CLI 통신)
~/.nd/logs/<session>.log     : 데몬 stderr 로그 (디버그 시 참고)
```
