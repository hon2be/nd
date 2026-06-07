// 디버그 타겟 — 실제로 nd가 잘 붙는지 확인할 용도

function add(a: number, b: number): number {
  const sum = a + b;
  console.log(`add(${a}, ${b}) = ${sum}`);
  return sum;
}

console.log('hello from test-target');
const r1 = add(1, 2);
const r2 = add(r1, 10);
console.log(`final: ${r2}`);
