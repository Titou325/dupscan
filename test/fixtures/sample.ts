export function add(a: number, b: number): number {
  return a + b;
}

class Calculator {
  multiply(a: number, b: number): number {
    let acc = 0;
    for (let i = 0; i < b; i++) {
      if (a > 0) {
        acc += a;
      }
    }
    return acc;
  }
}
