/** 输入别名采用表格列名，避免第 27 个输入与已有别名重复。 */
export function inputAlias(index: number): string {
  let value = index + 1, result = '';
  while (value > 0) { value -= 1; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); }
  return result;
}

const keywords = new Set(['AND', 'OR', 'XOR', 'NOT']);
const aliasIndex = (alias: string) => [...alias.toUpperCase()].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0) - 1;
const tokenize = (expression: string) => expression.match(/[A-Za-z]+|&&|\|\||[!^()]|\S/g) ?? [];

/** 只解析受限的逻辑语法，不执行用户输入代码；全部输入必须显式参与运算。 */
export function validateExpression(expression: string, inputCount: number): string | null {
  if (!Number.isInteger(inputCount) || inputCount < 1 || inputCount > 256) return '逻辑表达式需要 1～256 个输入';
  if (!expression.trim()) return '请输入逻辑表达式';
  if (expression.length > 4096) return '逻辑表达式不能超过 4096 个字符';
  if ([...expression].some((char) => { const code = char.charCodeAt(0); return !(code >= 32 && code <= 126) && !(code >= 9 && code <= 13); })) return '逻辑表达式仅支持英文字母、逻辑符号和半角空白';
  const tokens = tokenize(expression).map((token) => token.toUpperCase());
  const referenced = new Set<number>();
  let position = 0;
  const peek = () => tokens[position];
  const consume = () => tokens[position++];
  const unary = (depth: number): void => {
    if (depth > 64) throw new Error('逻辑表达式嵌套不能超过 64 层');
    if (peek() === 'NOT' || peek() === '!') { consume(); unary(depth + 1); return; }
    if (peek() === '(') { consume(); disjunction(depth + 1); if (consume() !== ')') throw new Error('逻辑表达式缺少右括号'); return; }
    const token = consume();
    if (!token || !/^[A-Z]+$/.test(token) || keywords.has(token)) throw new Error('逻辑表达式缺少输入或存在非法符号');
    const index = aliasIndex(token);
    if (index >= inputCount) throw new Error(`逻辑表达式引用了不存在的输入 ${token}`);
    referenced.add(index);
  };
  const conjunction = (depth: number): void => { unary(depth); while (peek() === 'AND' || peek() === '&&') { consume(); unary(depth); } };
  const exclusive = (depth: number): void => { conjunction(depth); while (peek() === 'XOR' || peek() === '^') { consume(); conjunction(depth); } };
  const disjunction = (depth: number): void => { exclusive(depth); while (peek() === 'OR' || peek() === '||') { consume(); exclusive(depth); } };
  try {
    disjunction(0);
    if (position !== tokens.length) return '逻辑表达式存在多余符号或缺少运算符';
    for (let index = 0; index < inputCount; index += 1) if (!referenced.has(index)) return `逻辑表达式未引用输入 ${inputAlias(index)}，请补充引用或移除该输入`;
    return null;
  } catch (error) { return error instanceof Error ? error.message : '逻辑表达式格式不正确'; }
}

export function expressionPreview(expression: string): string {
  const labels: Record<string, string> = { AND: '与', OR: '或', XOR: '异或', NOT: '非' };
  const symbols: Record<string, string> = { '&&': '与', '||': '或', '!': '非', '^': '异或' };
  return expression.replace(/[A-Za-z]+|&&|\|\||[!^]/g, (token) => labels[token.toUpperCase()] ?? symbols[token] ?? token.toUpperCase());
}

/** 删除未引用输入后同步移动后续别名，拒绝静默删除已引用点。 */
export function removeExpressionInput(expression: string, index: number): string | null {
  let used = false;
  const next = expression.replace(/[A-Za-z]+/g, (token) => {
    if (keywords.has(token.toUpperCase())) return token;
    const current = aliasIndex(token);
    if (current === index) used = true;
    return current > index ? inputAlias(current - 1) : token;
  });
  return used ? null : next;
}
