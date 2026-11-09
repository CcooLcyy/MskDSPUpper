import { inputAlias, validateExpression } from './logic-expression.ts';

type Input = {
  sourceKind: number;
  constantValue: boolean | number | string;
  sources: readonly { module_name: string; conn_name: string; tag: string }[];
};

function countNames(names: readonly (string | undefined)[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of names) if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
}

/** 优先保留单点原名，仅在同名时加连接、模块或编号。 */
export function namedInputs(inputs: readonly Input[]): string[] {
  const points = inputs.map((input) => input.sourceKind !== 2 && input.sources.length === 1 ? input.sources[0] : undefined);
  const tags = countNames(points.map((point) => point?.tag));
  const qualified = points.map((point) => point && `${point.conn_name} / ${point.tag}`);
  const connections = countNames(qualified);
  const candidates = inputs.map((input, index) => {
    if (input.sourceKind === 2) {
      const value = input.constantValue;
      return `常量（${value === true ? '真' : value === false ? '假' : value}）`;
    }
    const point = points[index];
    if (!point) return input.sources.length ? `多来源输入（${input.sources.length} 个点位）` : '未选择点位';
    if (tags.get(point.tag) === 1) return point.tag;
    const connection = `${point.conn_name} / ${point.tag}`;
    return connections.get(connection) === 1 ? connection : `${point.module_name} / ${connection}`;
  });
  const reserved = new Set([...tags.keys(), ...candidates]);
  const used = new Set<string>();
  return candidates.map((candidate, index) => {
    const originalTag = points[index]?.tag;
    const usesOriginal = originalTag === candidate && tags.get(candidate) === 1;
    let name = candidate;
    if (used.has(name) || (!usesOriginal && tags.has(name))) {
      let suffix = 2;
      do { name = `${candidate}（${suffix++}）`; } while (used.has(name) || reserved.has(name));
    }
    used.add(name);
    return name;
  });
}

const operators = new Map<string, string>([
  ['AND', '&&'], ['与', '&&'], ['&&', '&&'],
  ['OR', '||'], ['或', '||'], ['||', '||'],
  ['XOR', '^'], ['异或', '^'], ['^', '^'],
  ['NOT', '!'], ['非', '!'], ['!', '!'],
  ['(', '('], [')', ')'], ['（', '('], ['）', ')'],
]);
const operatorLabels = new Map([['&&', '与'], ['||', '或'], ['^', '异或'], ['!', '非'], ['(', '('], [')', ')']]);

type QuotedToken = { start: number; end: number; name?: string; closed: boolean };

/** 先按引号和反斜杠划出边界，再由 JSON 校验和解码转义。 */
function readQuoted(text: string, start: number): QuotedToken {
  for (let position = start + 1; position < text.length; position += 1) {
    if (text[position] === '\\') { position += 1; continue; }
    if (text[position] === '"') {
      const end = position + 1;
      try { return { start, end, closed: true, name: JSON.parse(text.slice(start, end)) as string }; }
      catch { return { start, end, closed: true }; }
    }
  }
  return { start, end: text.length, closed: false };
}

function* quotedTokens(text: string): Iterable<QuotedToken> {
  let position = 0;
  while (position < text.length) {
    const start = text.indexOf('"', position);
    if (start < 0) return;
    const token = readQuoted(text, start);
    yield token;
    position = token.end;
  }
}

function formatTokens(tokens: readonly string[]): string {
  return tokens.map((token, index) => index === 0 || tokens[index - 1] === '(' || token === ')' ? token : ` ${token}`).join('');
}

/** 将协议中的位置别名转换为用户当前选择的点名。 */
export function displayNamedExpression(canonical: string, names: readonly string[]): string {
  const byAlias = new Map(names.map((name, index) => [inputAlias(index), name]));
  const tokens = canonical.match(/[A-Za-z]+|&&|\|\||[!^()]|\S/g) ?? [];
  return formatTokens(tokens.map((token) => {
    const upper = token.toUpperCase();
    const operator = operators.get(upper);
    if (operator !== undefined) return operatorLabels.get(operator) ?? token;
    const name = byAlias.get(upper);
    return name === undefined ? token : JSON.stringify(name);
  }));
}

/** 编译点名为协议别名，语法和操作数校验复用原有解析器。 */
export function compileNamedExpression(text: string, names: readonly string[]): { expression: string; error: string | null } {
  const aliases = new Map(names.map((name, index) => [name, inputAlias(index)]));
  const tokens: string[] = [];
  const nextToken = /\s+|[A-Za-z]+|异或|[与或非（）()!^]|&&|\|\|/y;
  const fail = (error: string) => ({ expression: '', error });
  let position = 0;
  while (position < text.length) {
    if (text[position] === '"') {
      const token = readQuoted(text, position);
      if (!token.closed) return fail('点位名称缺少结束双引号');
      if (token.name === undefined) return fail('点位名称的引号或转义格式不正确');
      const alias = aliases.get(token.name);
      if (alias === undefined) return fail(`逻辑表达式引用了不存在的输入 ${JSON.stringify(token.name)}`);
      tokens.push(alias);
      position = token.end;
      continue;
    }
    nextToken.lastIndex = position;
    const token = nextToken.exec(text)?.[0];
    if (!token) return fail(`第 ${position + 1} 个字符附近无法识别，请使用双引号引用点位名称`);
    position += token.length;
    if (!token.trim()) continue;
    const operator = operators.get(token.toUpperCase());
    if (operator === undefined) return fail(`请使用双引号引用点位名称：${token}`);
    tokens.push(operator);
  }

  let expression = formatTokens(tokens);
  if (expression.length > 4096) {
    // 使用符号并压缩空格，保留相邻变量的分隔以便检查缺少运算符的错误。
    const isAlias = (token: string) => /^[A-Z]+$/.test(token);
    expression = tokens.map((token, index) => index > 0 && isAlias(tokens[index - 1]) && isAlias(token) ? ` ${token}` : token).join('');
  }
  const error = validateExpression(expression, names.length);
  if (!error) return { expression, error: null };
  const byAlias = new Map(names.map((name, index) => [inputAlias(index), name]));
  return fail(error.replace(/输入 ([A-Z]+)\b/g, (text, alias: string) => {
    const name = byAlias.get(alias);
    return name === undefined ? text : `输入 ${JSON.stringify(name)}`;
  }));
}

export function hasNamedReference(text: string, name: string): boolean {
  for (const token of quotedTokens(text)) if (token.name === name) return true;
  return false;
}

/** 按原行映射一次替换名称，避免改名互换时级联覆盖。 */
export function renameNamedReferences(text: string, before: readonly string[], after: readonly (string | undefined)[]): string {
  const changes = new Map(before.map((name, index) => [name, after[index]]));
  let result = '';
  let offset = 0;
  for (const token of quotedTokens(text)) {
    if (token.name === undefined) continue;
    const replacement = changes.get(token.name);
    if (replacement === undefined || replacement === token.name) continue;
    result += text.slice(offset, token.start) + JSON.stringify(replacement);
    offset = token.end;
  }
  return result + text.slice(offset);
}
